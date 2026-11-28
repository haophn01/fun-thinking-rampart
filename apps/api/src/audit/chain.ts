import { createHash } from 'node:crypto';
import { asc, count, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { auditEvent } from '../../db/schema';
import type { AuditVerifyResponse } from '../contract';

/** One stored audit row, as its columns hold it. */
export type AuditRow = typeof auditEvent.$inferSelect;

/** What the hash covers: every stored column except `id` and the hash itself. */
export type HashedAuditFields = Omit<AuditRow, 'id' | 'hash'>;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Rows read per query when walking the whole log. */
const BATCH = 500;

/**
 * The event's hash in the chain: lowercase SHA-256 hex of the UTF-8 JSON of the stored column
 * values in a fixed order, after a version tag. `before` and `after` are the stored JSON text,
 * never re-parsed. `id` is left out: the hash is set before the row has one, and the `prev_hash`
 * links keep the order.
 */
export function auditHash(row: HashedAuditFields): string {
  const form = JSON.stringify([
    'rampart-audit-v1',
    row.prevHash,
    row.at,
    row.actorUserId,
    row.assessmentId,
    row.action,
    row.entityType,
    row.entityId,
    row.before,
    row.after,
    row.requestId,
  ]);
  return createHash('sha256').update(form, 'utf8').digest('hex');
}

/** The hash of the newest event that has one, or null when none has: what the next event links to. */
export function latestAuditHash(db: Pick<AppDb, 'select'>): string | null {
  const row = db
    .select({ hash: auditEvent.hash })
    .from(auditEvent)
    .where(isNotNull(auditEvent.hash))
    .orderBy(desc(auditEvent.id))
    .limit(1)
    .get();
  return row?.hash ?? null;
}

export interface ChainResult {
  /** Events this run filled. */
  chained: number;
  /** Events with no hash left after this run. */
  unchained: number;
}

function unhashedCount(db: Pick<AppDb, 'select'>): number {
  return db.select({ n: count() }).from(auditEvent).where(isNull(auditEvent.hash)).get()?.n ?? 0;
}

/**
 * The one-time backfill of events written before the chain existed. In one transaction, and only
 * while no event has a hash: walks every row in id order and fills its `prev_hash` and `hash`
 * with one UPDATE each, changing nothing else (migration 0006's trigger allows exactly that,
 * once). After the chain has started it fills nothing and reports the rows with no hash, so a row
 * slipped in later by raw SQL is never blessed into the chain. A failure rolls back every fill.
 */
export function chainAuditLog(db: AppDb): ChainResult {
  return db.transaction(
    (tx) => {
      const started = tx
        .select({ id: auditEvent.id })
        .from(auditEvent)
        .where(isNotNull(auditEvent.hash))
        .limit(1)
        .get();
      if (started !== undefined) return { chained: 0, unchained: unhashedCount(tx) };

      let chained = 0;
      let prevHash: string | null = null;
      let last = 0;
      for (;;) {
        const batch = tx
          .select()
          .from(auditEvent)
          .where(gt(auditEvent.id, last))
          .orderBy(asc(auditEvent.id))
          .limit(BATCH)
          .all();
        for (const row of batch) {
          const hash = auditHash({ ...row, prevHash });
          tx.update(auditEvent).set({ prevHash, hash }).where(eq(auditEvent.id, row.id)).run();
          prevHash = hash;
          chained += 1;
        }
        const end = batch.at(-1);
        if (end === undefined || batch.length < BATCH) break;
        last = end.id;
      }
      return { chained, unchained: 0 };
    },
    // Takes the write lock up front, so another connection can't append mid-walk.
    { behavior: 'immediate' },
  );
}

/**
 * Walks every event in id order and stops at the first broken one: no hash (`unchained`), a
 * `prev_hash` that isn't the previous event's hash (`prev_mismatch`: an earlier event was changed
 * or removed), or a hash that doesn't match the row (`hash_mismatch`: it was changed). One read
 * transaction, so the walk sees one snapshot. It can't detect removal of the newest events: the
 * head isn't anchored outside the DB, so `headHash` is returned for the user to record.
 */
export function verifyAuditChain(db: AppDb, now: Date): AuditVerifyResponse {
  return db.transaction((tx) => {
    const total = tx.select({ n: count() }).from(auditEvent).get()?.n ?? 0;
    const head = tx
      .select({ hash: auditEvent.hash })
      .from(auditEvent)
      .orderBy(desc(auditEvent.id))
      .limit(1)
      .get();

    let checked = 0;
    let expected: string | null = null;
    let firstBroken: AuditVerifyResponse['firstBroken'] = null;
    let last = 0;
    walk: for (;;) {
      const batch = tx
        .select()
        .from(auditEvent)
        .where(gt(auditEvent.id, last))
        .orderBy(asc(auditEvent.id))
        .limit(BATCH)
        .all();
      for (const row of batch) {
        const problem =
          row.hash === null
            ? 'unchained'
            : row.prevHash !== expected
              ? 'prev_mismatch'
              : row.hash !== auditHash(row)
                ? 'hash_mismatch'
                : null;
        if (problem !== null) {
          firstBroken = { id: row.id, at: row.at, action: row.action, problem };
          break walk;
        }
        checked += 1;
        expected = row.hash;
      }
      const end = batch.at(-1);
      if (end === undefined || batch.length < BATCH) break;
      last = end.id;
    }

    return {
      ok: firstBroken === null,
      checked,
      total,
      // A tampered head that isn't a SHA-256 at all is already broken; show no hash for it.
      headHash: head?.hash != null && SHA256_HEX.test(head.hash) ? head.hash : null,
      firstBroken,
      verifiedAt: now.toISOString(),
    };
  });
}
