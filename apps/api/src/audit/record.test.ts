import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from '../../db/client';
import { assessment, auditEvent, user } from '../../db/schema';
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

function rows() {
  return handle.db.select().from(auditEvent).orderBy(asc(auditEvent.id)).all();
}

function count(): number {
  return rows().length;
}

describe('recordAudit', () => {
  describe('records changes', () => {
    it('stores before and after as JSON, with before null on create', () => {
      // A create: before is null, after is stored as JSON, and every column is filled.
      const createdId = recordAudit(
        handle.db,
        event({
          action: 'user.created',
          entityType: 'user',
          entityId: 'u1',
          assessmentId: null,
          before: null,
          after: { email: 'admin@example.com', role: 'admin', active: true },
        }),
      );
      expect(createdId).toBe(1);
      expect(rows()).toEqual([
        {
          id: 1,
          at: '2026-11-23T22:30:00.000Z',
          actorUserId: 'u1',
          assessmentId: null,
          action: 'user.created',
          entityType: 'user',
          entityId: 'u1',
          before: null,
          after: '{"email":"admin@example.com","role":"admin","active":true}',
          requestId: 'req-1',
          // The first event links to nothing. Its hash, computed independently:
          // node -e "const c=require('crypto');console.log(c.createHash('sha256').update(
          //   JSON.stringify(['rampart-audit-v1',null,'2026-11-23T22:30:00.000Z','u1',null,
          //   'user.created','user','u1',null,
          //   '{\"email\":\"admin@example.com\",\"role\":\"admin\",\"active\":true}',
          //   'req-1'])).digest('hex'))"
          prevHash: null,
          // nosemgrep: generic.secrets.security.detected-generic-secret — a pinned SHA-256 test vector, not a secret
          hash: '026bffef5807e80e6b583c99d83cff90155b7f2f419eeb9b68c0ac39bb63cff7',
        },
      ]);

      // An update stores both sides; ids keep growing.
      const updatedId = recordAudit(handle.db, event());
      expect(updatedId).toBe(2);
      const updated = rows()[1];
      expect(JSON.parse(updated?.before ?? 'null')).toEqual({ status: 'met', note: null });
      expect(JSON.parse(updated?.after ?? 'null')).toEqual({
        status: 'not_met',
        note: 'Gap found',
      });
      expect(updated?.assessmentId).toBe('a1');

      // Optional fields default to null.
      const bare: AuditEventInput = {
        at: AT,
        actorUserId: null,
        action: 'auth.signed_out',
        entityType: 'user',
        entityId: 'u1',
        before: null,
        after: null,
      };
      const bareId = recordAudit(handle.db, bare);
      expect(bareId).toBe(3);
      expect(rows()[2]).toMatchObject({ actorUserId: null, assessmentId: null, requestId: null });
    });

    it('writes nothing when before deep-equals after', () => {
      const same = recordAudit(
        handle.db,
        event({
          before: { status: 'met', note: null, nested: { a: [1, 2] } },
          // Key order differs and an undefined key is dropped, as JSON would store it.
          after: { nested: { a: [1, 2] }, note: null, status: 'met', extra: undefined },
        }),
      );
      expect(same).toBeNull();
      expect(count()).toBe(0);

      // Array order matters, and so does a value's type.
      expect(recordAudit(handle.db, event({ before: { a: [1, 2] }, after: { a: [2, 1] } }))).toBe(
        1,
      );
      expect(recordAudit(handle.db, event({ before: { a: 1 }, after: { a: '1' } }))).toBe(2);
      expect(recordAudit(handle.db, event({ before: { a: null }, after: {} }))).toBe(3);
      expect(count()).toBe(3);
    });

    it('records an event with no field data, where before and after are both null', () => {
      // A password reset or a sign-in has nothing to diff, but still happened.
      const id = recordAudit(
        handle.db,
        event({
          action: 'user.password_reset',
          entityType: 'user',
          entityId: 'u1',
          before: null,
          after: null,
        }),
      );
      expect(id).toBe(1);
      expect(rows()[0]).toMatchObject({ action: 'user.password_reset', before: null, after: null });
    });

    it('strips password, passwordHash, token and csrfToken at any depth', () => {
      const before = {
        role: 'contributor',
        password: 'hunter2-hunter2',
        passwordHash: '$argon2id$old',
        profile: { token: 'tok', csrfToken: 'csrf', name: 'Old' },
        sessions: [{ token: 'a', keep: 1 }, { csrfToken: 'b' }],
      };
      const after = {
        role: 'admin',
        password: 'correct-horse-battery',
        passwordHash: '$argon2id$new',
        profile: { token: 'tok2', csrfToken: 'csrf2', name: 'New' },
        sessions: [{ token: 'c', keep: 2 }],
      };
      const beforeCopy = structuredClone(before);
      const id = recordAudit(handle.db, event({ before, after }));
      expect(id).toBe(1);
      const row = rows()[0];
      expect(JSON.parse(row?.before ?? 'null')).toEqual({
        role: 'contributor',
        profile: { name: 'Old' },
        sessions: [{ keep: 1 }, {}],
      });
      expect(JSON.parse(row?.after ?? 'null')).toEqual({
        role: 'admin',
        profile: { name: 'New' },
        sessions: [{ keep: 2 }],
      });
      for (const secret of ['hunter2', 'argon2id', 'tok', 'csrf', 'correct-horse']) {
        expect(JSON.stringify(row)).not.toContain(secret);
      }
      // The caller's objects are not changed.
      expect(before).toEqual(beforeCopy);
    });

    it('a change only to a secret field is still recorded, with the secret stripped', () => {
      const id = recordAudit(
        handle.db,
        event({
          before: { passwordHash: '$argon2id$old' },
          after: { passwordHash: '$argon2id$new' },
        }),
      );
      expect(id).toBe(1);
      expect(rows()[0]).toMatchObject({ before: '{}', after: '{}' });
    });
  });

  it("shares the caller's transaction", () => {
    // Rolled back: neither the change nor its event is stored.
    expect(() =>
      handle.db.transaction((tx) => {
        tx.update(assessment).set({ type: 'c3pao' }).where(eq(assessment.id, 'a1')).run();
        expect(recordAudit(tx, event({ action: 'assessment.updated' }))).toBe(1);
        throw new Error('later step failed');
      }),
    ).toThrow('later step failed');
    expect(count()).toBe(0);
    expect(handle.db.select().from(assessment).get()?.type).toBe('self');

    // A failing audit insert (here a foreign key) rolls the change back too.
    expect(() => {
      handle.db.transaction((tx) => {
        tx.update(assessment).set({ type: 'c3pao' }).where(eq(assessment.id, 'a1')).run();
        recordAudit(tx, event({ actorUserId: 'ghost' }));
      });
    }).toThrow(/FOREIGN KEY constraint failed/);
    expect(count()).toBe(0);
    expect(handle.db.select().from(assessment).get()?.type).toBe('self');

    // Committed: both are stored.
    const id = handle.db.transaction((tx) => {
      tx.update(assessment).set({ type: 'c3pao' }).where(eq(assessment.id, 'a1')).run();
      return recordAudit(
        tx,
        event({
          action: 'assessment.updated',
          entityType: 'assessment',
          entityId: 'a1',
          before: { type: 'self' },
          after: { type: 'c3pao' },
        }),
      );
    });
    expect(id).toBe(1);
    expect(count()).toBe(1);
    expect(handle.db.select().from(assessment).get()?.type).toBe('c3pao');
  });

  it('rejects a value it cannot store without writing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => recordAudit(handle.db, event({ after: cyclic }))).toThrow(TypeError);
    expect(() => recordAudit(handle.db, event({ at: new Date('nope') }))).toThrow(RangeError);
    expect(count()).toBe(0);
  });
});
