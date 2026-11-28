import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, runMigrations, type DbHandle } from '../../db/client';
import { assessment, auditEvent, user } from '../../db/schema';
import { auditHash, chainAuditLog, type AuditRow, type HashedAuditFields } from './chain';
import { recordAudit, type AuditEventInput } from './record';

const AT = new Date('2026-11-23T22:30:00.000Z');

let handle: DbHandle;

beforeEach(() => {
  handle = openDb(':memory:');
  runMigrations(handle.db);
  handle.db.insert(assessment).values({ id: 'a1', catalogVersion: 'nist-800-171-r2@1.0.0' }).run();
  handle.db
    .insert(user)
    .values({
      id: 'u1',
      email: 'admin@example.com',
      displayName: 'Admin',
      role: 'admin',
      passwordHash: '$argon2id$fake',
    })
    .run();
});

afterEach(() => {
  handle.sqlite.close();
});

function event(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    at: AT,
    actorUserId: 'u1',
    assessmentId: 'a1',
    action: 'objective_result.updated',
    entityType: 'objective_result',
    entityId: '3.1.1[a]',
    before: { status: 'met', note: null },
    after: { status: 'not_met', note: 'Gap found' },
    requestId: 'req-1',
    ...overrides,
  };
}

function rows(): AuditRow[] {
  return handle.db.select().from(auditEvent).orderBy(asc(auditEvent.id)).all();
}

/** A row as the code before the chain wrote it: no prev_hash, no hash. */
function legacy(id: number, i: number) {
  return {
    id,
    at: new Date(AT.getTime() + i * 1000).toISOString(),
    actorUserId: i % 3 === 0 ? null : 'u1',
    assessmentId: i % 2 === 0 ? 'a1' : null,
    action: 'objective_result.updated',
    entityType: 'objective_result',
    entityId: `3.1.${String(i % 7)}[a]`,
    before: i % 5 === 0 ? null : JSON.stringify({ status: 'met', n: i }),
    after: JSON.stringify({ status: 'not_met', note: `n${String(i)}` }),
    requestId: i % 4 === 0 ? null : `req-${String(i)}`,
  };
}

/** Records every UPDATE on audit_event, in order, in a temp table only this connection sees. */
function watchUpdates(): () => number[] {
  handle.sqlite.exec(`
    CREATE TEMP TABLE seen_update (row_id INTEGER);
    CREATE TEMP TRIGGER watch_update AFTER UPDATE ON main.audit_event
    BEGIN INSERT INTO seen_update VALUES (NEW.id); END;
  `);
  return () =>
    (
      handle.sqlite.prepare('select row_id from seen_update order by rowid').all() as {
        row_id: number;
      }[]
    ).map((row) => row.row_id);
}

describe('auditHash', () => {
  it('auditHash matches the pinned vector', () => {
    // Computed independently, outside this code:
    // node -e "const c=require('crypto');console.log(c.createHash('sha256').update(JSON.stringify(
    //   ['rampart-audit-v1',null,'2026-11-23T22:30:00.000Z',null,'a1','objective_result.updated',
    //    'objective_result','3.1.1[a]','{\"status\":\"met\",\"note\":null}',
    //    '{\"status\":\"not_met\",\"note\":\"Gap found\"}',null])).digest('hex'))"
    const row: HashedAuditFields = {
      prevHash: null,
      at: '2026-11-23T22:30:00.000Z',
      actorUserId: null,
      assessmentId: 'a1',
      action: 'objective_result.updated',
      entityType: 'objective_result',
      entityId: '3.1.1[a]',
      before: '{"status":"met","note":null}',
      after: '{"status":"not_met","note":"Gap found"}',
      requestId: null,
    };
    // nosemgrep: generic.secrets.security.detected-generic-secret — a pinned SHA-256 test vector, not a secret
    const pinned = '4c5fe67b88e57fb607cb07134e81cf3026dd13e6ad70a7c8eaebc287757f54d5';
    expect(auditHash(row)).toBe(pinned);

    // Every field is in the hash: changing any one, or the link, changes it.
    const changed: Partial<HashedAuditFields>[] = [
      { prevHash: pinned },
      { at: '2026-11-23T22:30:00.001Z' },
      { actorUserId: 'u1' },
      { assessmentId: null },
      { action: 'objective_result.created' },
      { entityType: 'requirement_state' },
      { entityId: '3.1.1[b]' },
      { before: null },
      { after: '{"note":"Gap found","status":"not_met"}' },
      { requestId: 'req-1' },
    ];
    for (const change of changed) {
      expect(auditHash({ ...row, ...change }), JSON.stringify(change)).not.toBe(pinned);
    }
    // A null and the text "null" differ, so stored JSON is hashed as text, never re-parsed.
    expect(auditHash({ ...row, before: 'null' })).not.toBe(auditHash({ ...row, before: null }));
  });
});

describe('hash on write', () => {
  it('recordAudit links each event to the one before', () => {
    expect(recordAudit(handle.db, event({ requestId: 'r1' }))).toBe(1);
    expect(recordAudit(handle.db, event({ requestId: 'r2', before: null }))).toBe(2);

    // Two events in one transaction chain in order.
    handle.db.transaction((tx) => {
      expect(recordAudit(tx, event({ requestId: 'r3' }))).toBe(3);
      expect(recordAudit(tx, event({ requestId: 'r4', after: { status: 'na' } }))).toBe(4);
    });

    const stored = rows();
    expect(stored.map((row) => row.id)).toEqual([1, 2, 3, 4]);
    expect(stored[0]?.prevHash).toBeNull();
    for (const [index, row] of stored.entries()) {
      expect(row.hash, `row ${String(row.id)}`).toMatch(/^[0-9a-f]{64}$/);
      expect(row.hash).toBe(auditHash(row));
      if (index > 0) expect(row.prevHash).toBe(stored[index - 1]?.hash);
    }
    expect(new Set(stored.map((row) => row.hash)).size).toBe(4);

    // A no-op reads and writes nothing.
    const select = vi.fn(handle.db.select.bind(handle.db));
    const insert = vi.fn(handle.db.insert.bind(handle.db));
    const watched = { select, insert } as unknown as Pick<typeof handle.db, 'insert' | 'select'>;
    expect(recordAudit(watched, event({ before: { a: 1 }, after: { a: 1 } }))).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(rows()).toEqual(stored);

    // The next real event still links to the newest one.
    expect(recordAudit(watched, event({ requestId: 'r5' }))).toBe(5);
    expect(select).toHaveBeenCalled();
    expect(rows()[4]?.prevHash).toBe(stored[3]?.hash);
  });

  it('a rolled-back event leaves the chain intact', () => {
    recordAudit(handle.db, event({ requestId: 'kept' }));
    const kept = rows()[0];

    expect(() =>
      handle.db.transaction((tx) => {
        recordAudit(tx, event({ requestId: 'lost-1' }));
        recordAudit(tx, event({ requestId: 'lost-2' }));
        throw new Error('later step failed');
      }),
    ).toThrow('later step failed');
    expect(rows()).toEqual([kept]);

    // A failing insert (a foreign key) also leaves nothing.
    expect(() => recordAudit(handle.db, event({ actorUserId: 'ghost' }))).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(rows()).toEqual([kept]);

    recordAudit(handle.db, event({ requestId: 'next' }));
    const after = rows();
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ requestId: 'next', prevHash: kept?.hash });
    expect(after[1]?.hash).toBe(auditHash(after[1] as AuditRow));
  });
});

describe('legacy backfill', () => {
  it('chains legacy events once, in id order, across batches', () => {
    // An empty log chains nothing.
    expect(chainAuditLog(handle.db)).toEqual({ chained: 0, unchained: 0 });

    // 1,201 rows across three batches of 500, inserted newest id first, with a gap at 600.
    const ids = Array.from({ length: 1201 }, (_, i) => (i < 599 ? i + 1 : i + 2));
    for (const [i, id] of [...ids.entries()].reverse()) {
      handle.db.insert(auditEvent).values(legacy(id, i)).run();
    }
    const before = rows();
    expect(before.every((row) => row.hash === null && row.prevHash === null)).toBe(true);
    const updates = watchUpdates();

    expect(chainAuditLog(handle.db)).toEqual({ chained: 1201, unchained: 0 });

    // One UPDATE per row, in id order.
    expect(updates()).toEqual(ids);
    const after = rows();
    expect(after.map((row) => row.id)).toEqual(ids);
    let prev: string | null = null;
    for (const [index, row] of after.entries()) {
      // Nothing else changes.
      expect({ ...row, prevHash: null, hash: null }).toEqual(before[index]);
      expect(row.prevHash, `row ${String(row.id)}`).toBe(prev);
      expect(row.hash).toBe(auditHash(row));
      prev = row.hash;
    }

    // A second run fills nothing and writes nothing.
    expect(chainAuditLog(handle.db)).toEqual({ chained: 0, unchained: 0 });
    expect(updates()).toHaveLength(1201);
    expect(rows()).toEqual(after);

    // New events link to the backfilled chain.
    recordAudit(handle.db, event());
    expect(rows().at(-1)?.prevHash).toBe(prev);
  });

  it('leaves unhashed events alone once the chain has started', () => {
    recordAudit(handle.db, event());
    handle.db.insert(auditEvent).values(legacy(2, 2)).run();
    handle.db.insert(auditEvent).values(legacy(3, 3)).run();
    const before = rows();
    const updates = watchUpdates();

    expect(chainAuditLog(handle.db)).toEqual({ chained: 0, unchained: 2 });
    expect(updates()).toEqual([]);
    expect(rows()).toEqual(before);
    expect(rows()[1]).toMatchObject({ prevHash: null, hash: null });
  });

  it('the backfill is one transaction', () => {
    for (let i = 1; i <= 5; i += 1) handle.db.insert(auditEvent).values(legacy(i, i)).run();
    handle.sqlite.exec(`
      CREATE TEMP TRIGGER stop_at_3 BEFORE UPDATE ON main.audit_event WHEN NEW.id = 3
      BEGIN SELECT RAISE(ABORT, 'stopped at row 3'); END;
    `);
    const updates = watchUpdates();

    expect(() => chainAuditLog(handle.db)).toThrow('stopped at row 3');
    // Rows 1 and 2 were filled inside the transaction, then rolled back with it.
    expect(updates()).toEqual([]);
    const after = rows();
    expect(after.map((row) => [row.id, row.prevHash, row.hash])).toEqual([
      [1, null, null],
      [2, null, null],
      [3, null, null],
      [4, null, null],
      [5, null, null],
    ]);

    // Once the cause is gone, a rerun chains them all.
    handle.sqlite.exec('DROP TRIGGER temp.stop_at_3');
    expect(chainAuditLog(handle.db)).toEqual({ chained: 5, unchained: 0 });
    expect(rows().find((row) => row.id === 1)?.hash).toBe(
      auditHash(rows().find((row) => row.id === 1) as AuditRow),
    );
    expect(handle.db.select().from(auditEvent).where(eq(auditEvent.id, 5)).get()?.prevHash).toBe(
      rows()[3]?.hash,
    );
  });
});
