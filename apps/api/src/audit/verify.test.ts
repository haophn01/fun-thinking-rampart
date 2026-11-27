import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from '../../db/client';
import { auditEvent } from '../../db/schema';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { auditVerifyResponseSchema, type AuditVerifyResponse } from '../contract';
import { createMemoryStore } from '../../storage';
import {
  ADMIN,
  HARNESS_SECRET_KEY,
  START,
  createHarness,
  signInThroughApi,
  type Client,
  type Harness,
  type MfaSecrets,
} from '../testing/harness';
import { auditHash, type AuditRow } from './chain';
import { prepareDatabase } from './prepare';
import { recordAudit } from './record';

const apiRoot = resolve(import.meta.dirname, '..', '..');
const VERIFY = '/api/audit/verify';

const harnesses: Harness[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function rows(h: { db: Harness['db'] }): AuditRow[] {
  return h.db.select().from(auditEvent).orderBy(asc(auditEvent.id)).all();
}

/** A signed-in admin, setup's events, and `extra` more written through recordAudit. */
async function world(extra = 3): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  for (let i = 0; i < extra; i += 1) {
    recordAudit(h.db, {
      at: new Date(START.getTime() + i * 1000),
      actorUserId: admin.user?.id ?? null,
      action: 'objective_result.updated',
      entityType: 'objective_result',
      entityId: '3.1.1[a]',
      before: i === 0 ? null : { status: 'met', n: i - 1 },
      after: { status: 'met', n: i },
      requestId: `req-${String(i)}`,
    });
  }
  return { h, admin };
}

async function verify(c: Client): Promise<AuditVerifyResponse> {
  const response = await c.get(VERIFY);
  expect(response.statusCode, response.body).toBe(200);
  return auditVerifyResponseSchema.parse(response.json());
}

/** Lets this connection change audit_event, as someone with the DB file could. */
function dropTrigger(h: { handle: DbHandle }, which: 'update' | 'delete'): void {
  h.handle.sqlite.exec(`DROP TRIGGER audit_event_no_${which}`);
}

describe('verifies the audit log', () => {
  it('GET /api/audit/verify passes on a fresh log and an empty one', async () => {
    const { h, admin } = await world();
    // Setup, a setting change through the api, and the three written above.
    const notice = await admin.put('/api/settings/sign-in-notice', {
      text: 'Authorized use only.',
    });
    expect(notice.statusCode, notice.body).toBe(200);
    const stored = rows(h);
    expect(stored.length).toBeGreaterThanOrEqual(5);

    const result = await verify(admin);
    expect(result).toEqual({
      ok: true,
      checked: stored.length,
      total: stored.length,
      headHash: stored.at(-1)?.hash,
      firstBroken: null,
      verifiedAt: h.clock.now().toISOString(),
    });
    // Verify writes nothing, not even an event of its own.
    expect(rows(h)).toEqual(stored);

    // An empty log is intact, with nothing to check and no head.
    dropTrigger(h, 'delete');
    h.handle.sqlite.exec('DELETE FROM audit_event');
    expect(await verify(admin)).toMatchObject({
      ok: true,
      checked: 0,
      total: 0,
      headHash: null,
      firstBroken: null,
    });

    // Signed out, it's refused.
    expect((await h.client().get(VERIFY)).statusCode).toBe(401);
  });

  it('passes on a migrated DB', { timeout: 60_000 }, async () => {
    // A DB built by the code before sec-auth (migration 0005), holding audit events.
    const dir = mkdtempSync(join(tmpdir(), 'rampart-verify-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const folder = join(dir, 'migrations');
    cpSync(join(apiRoot, 'db', 'migrations'), folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((entry) => entry.tag <= '0005_ssp_data');
    writeFileSync(journalPath, JSON.stringify(journal));
    const path = join(dir, 'legacy.sqlite');
    const old = new Database(path);
    migrate(drizzle(old), { migrationsFolder: folder });
    const insert = old.prepare(
      'insert into audit_event (at, action, entity_type, entity_id, before, after, request_id) values (?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 7; i += 1) {
      insert.run(
        new Date(START.getTime() - (7 - i) * 60_000).toISOString(),
        'objective_result.updated',
        'objective_result',
        `3.1.${String(i)}[a]`,
        i % 2 === 0 ? null : '{"status":"met"}',
        '{"status":"not_met"}',
        i % 3 === 0 ? null : `old-${String(i)}`,
      );
    }
    old.close();

    const handle = openDb(path);
    cleanups.push(() => {
      handle.sqlite.close();
    });
    const log: { level: string; obj: unknown; msg: string }[] = [];
    prepareDatabase(handle.db, {
      info: (obj: unknown, msg: string) => log.push({ level: 'info', obj, msg }),
      warn: (obj: unknown, msg: string) => log.push({ level: 'warn', obj, msg }),
    } as never);
    expect(log).toEqual([{ level: 'info', obj: { chained: 7 }, msg: 'audit events chained' }]);

    // More writes through the running app, after the backfill.
    const app: FastifyInstance = buildApp({
      config: loadConfig({
        DATABASE_PATH: path,
        LOG_LEVEL: 'silent',
        RATE_LIMIT_MULTIPLIER: '1000',
        RAMPART_SECRET_KEY: HARNESS_SECRET_KEY,
      }),
      db: handle.db,
      now: () => START,
      secretKey: Buffer.from(HARNESS_SECRET_KEY, 'hex'),
      store: createMemoryStore(),
    });
    cleanups.push(async () => {
      await app.close();
    });
    const secrets: MfaSecrets = new Map();
    const headers = await signInThroughApi(app, '/api/setup', ADMIN, { at: START, secrets });
    const response = await app.inject({ method: 'GET', url: VERIFY, headers });
    expect(response.statusCode, response.body).toBe(200);
    const result = auditVerifyResponseSchema.parse(response.json());
    const stored = rows(handle);
    expect(stored.length).toBeGreaterThan(7);
    expect(stored[7]?.prevHash).toBe(stored[6]?.hash);
    expect(result).toMatchObject({
      ok: true,
      checked: stored.length,
      total: stored.length,
      headHash: stored.at(-1)?.hash,
      firstBroken: null,
    });
  });

  it('names the edited event', async () => {
    const { h, admin } = await world(4);
    const target = rows(h)[2] as AuditRow;
    dropTrigger(h, 'update');
    h.db
      .update(auditEvent)
      .set({ after: '{"status":"met","n":"forged"}' })
      .where(eq(auditEvent.id, target.id))
      .run();

    const result = await verify(admin);
    expect(result).toMatchObject({
      ok: false,
      checked: target.id - 1,
      total: rows(h).length,
      firstBroken: {
        id: target.id,
        at: target.at,
        action: target.action,
        problem: 'hash_mismatch',
      },
    });
  });

  it('names the event after a re-hashed or deleted one', async () => {
    // Re-hashed: the edited row's own hash is made to match, so the next row's link breaks.
    const edited = await world(4);
    const [, , third, fourth] = rows(edited.h);
    if (third === undefined || fourth === undefined) throw new Error('too few events');
    dropTrigger(edited.h, 'update');
    const forged = { ...third, after: '{"status":"met","n":"forged"}' };
    edited.h.db
      .update(auditEvent)
      .set({ after: forged.after, hash: auditHash(forged) })
      .where(eq(auditEvent.id, third.id))
      .run();
    expect(await verify(edited.admin)).toMatchObject({
      ok: false,
      checked: fourth.id - 1,
      firstBroken: { id: fourth.id, problem: 'prev_mismatch' },
    });

    // Deleted: the row after the gap links to a hash that is gone.
    const removed = await world(4);
    const [, , gone, next] = rows(removed.h);
    if (gone === undefined || next === undefined) throw new Error('too few events');
    dropTrigger(removed.h, 'delete');
    removed.h.db.delete(auditEvent).where(eq(auditEvent.id, gone.id)).run();
    expect(await verify(removed.admin)).toMatchObject({
      ok: false,
      checked: gone.id - 1,
      total: rows(removed.h).length,
      firstBroken: { id: next.id, at: next.at, action: next.action, problem: 'prev_mismatch' },
    });
  });

  it('names an event added outside Rampart', async () => {
    const { h, admin } = await world(2);
    const hashed = rows(h);
    const lastHashed = hashed.at(-1) as AuditRow;
    // Raw SQL leaves prev_hash and hash empty; nothing fills them later.
    h.handle.sqlite
      .prepare(
        "insert into audit_event (at, action, entity_type, entity_id, after) values (?, 'user.updated', 'user', 'x', '{}')",
      )
      .run('2026-01-01T00:00:00.000Z');
    const slipped = rows(h).at(-1) as AuditRow;

    // Events written after it link past it, to the last hashed one.
    const notice = await admin.put('/api/settings/sign-in-notice', {
      text: 'Authorized use only.',
    });
    expect(notice.statusCode, notice.body).toBe(200);
    const newest = rows(h).at(-1) as AuditRow;
    expect(newest.prevHash).toBe(lastHashed.hash);

    expect(await verify(admin)).toEqual({
      ok: false,
      checked: hashed.length,
      total: hashed.length + 2,
      headHash: newest.hash,
      firstBroken: {
        id: slipped.id,
        at: '2026-01-01T00:00:00.000Z',
        action: 'user.updated',
        problem: 'unchained',
      },
      verifiedAt: h.clock.now().toISOString(),
    });

    // A raw row as the newest shows no head hash, and a head that isn't a hash at all shows none.
    h.handle.sqlite
      .prepare(
        "insert into audit_event (at, action, entity_type, entity_id, hash) values ('x', 'y', 'z', 'w', 'not a hash')",
      )
      .run();
    expect((await verify(admin)).headHash).toBeNull();
  });

  it('a removed newest event is not detected (documented limit)', async () => {
    const { h, admin } = await world(3);
    const before = await verify(admin);
    expect(before.ok).toBe(true);
    const stored = rows(h);
    dropTrigger(h, 'delete');
    h.db
      .delete(auditEvent)
      .where(eq(auditEvent.id, (stored.at(-1) as AuditRow).id))
      .run();

    const after = await verify(admin);
    expect(after).toMatchObject({
      ok: true,
      checked: stored.length - 1,
      total: stored.length - 1,
      headHash: stored.at(-2)?.hash,
    });
    expect(after.headHash).not.toBe(before.headHash);
  });
});
