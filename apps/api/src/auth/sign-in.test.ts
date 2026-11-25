import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, session, user } from '../../db/schema';
import { errorEnvelopeSchema, sessionResponseSchema } from '../contract';
import { ADMIN, createHarness, type Client, type Harness } from '../testing/harness';

const MINUTE = 60_000;
const CARL = { email: 'carl@example.com', password: 'carl secret password' };

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** An app with an admin and a contributor, Carl. */
async function world(): Promise<{ h: Harness; admin: Client; carlId: string }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  const created = await admin.post('/api/users', {
    ...CARL,
    displayName: 'Carl',
    role: 'contributor',
  });
  expect(created.statusCode).toBe(201);
  const carlId = created.json<{ user: { id: string } }>().user.id;
  return { h, admin, carlId };
}

function attempt(h: Harness, password: string, email = CARL.email) {
  return h.client().post('/api/session', { email, password });
}

function carlRow(h: Harness, carlId: string) {
  const row = h.db.select().from(user).where(eq(user.id, carlId)).get();
  if (!row) throw new Error('carl is missing');
  return row;
}

function actions(h: Harness): string[] {
  return h.db
    .select()
    .from(auditEvent)
    .orderBy(asc(auditEvent.id))
    .all()
    .map((event) => event.action);
}

describe('credentials', () => {
  it('answers a wrong password, an unknown email and an inactive user the same way', async () => {
    const { h, admin, carlId } = await world();
    await admin.post('/api/users', {
      email: 'ivy@example.com',
      displayName: 'Ivy',
      role: 'contributor',
      password: 'ivy secret password',
    });
    const ivy = h.db.select().from(user).where(eq(user.email, 'ivy@example.com')).get();
    await admin.patch(`/api/users/${ivy?.id ?? ''}`, { active: false });

    const wrong = await attempt(h, 'not the password');
    const unknown = await attempt(h, CARL.password, 'nobody@example.com');
    const inactive = await attempt(h, 'ivy secret password', 'ivy@example.com');
    const strip = (body: string) => {
      const parsed = errorEnvelopeSchema.parse(JSON.parse(body));
      return {
        code: parsed.error.code,
        message: parsed.error.message,
        details: parsed.error.details,
      };
    };
    for (const response of [wrong, unknown, inactive]) {
      expect(response.statusCode).toBe(401);
      expect(strip(response.body)).toEqual({
        code: 'invalid_credentials',
        message: 'Email or password is incorrect.',
        details: undefined,
      });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    // Only the existing, active account counts a failure.
    expect(carlRow(h, carlId).failedSignIns).toBe(1);

    // The email is matched without case or surrounding space.
    const ok = await attempt(h, CARL.password, '  CARL@example.com ');
    expect(ok.statusCode).toBe(200);
    expect(sessionResponseSchema.parse(ok.json()).user?.email).toBe(CARL.email);
  });

  it('makes a new session on sign-in and deletes the one the cookie held', async () => {
    const { h, carlId } = await world();
    const c = await h.signIn(CARL.email, CARL.password);
    const first = c.cookie;
    const firstCsrf = c.csrfToken;
    expect(h.db.select().from(session).where(eq(session.userId, carlId)).all()).toHaveLength(1);

    const again = await c.post('/api/session', CARL, { headers: { 'x-csrf-token': null } });
    expect(again.statusCode).toBe(200);
    expect(c.cookie).not.toBeNull();
    expect(c.cookie).not.toBe(first);
    expect(c.csrfToken).not.toBe(firstCsrf);
    expect(h.db.select().from(session).where(eq(session.userId, carlId)).all()).toHaveLength(1);

    // The old token no longer works.
    const stale = h.client();
    stale.cookie = first;
    const status = sessionResponseSchema.parse((await stale.get('/api/session')).json());
    expect(status.user).toBeNull();
    expect((await stale.get('/api/users')).statusCode).toBe(401);

    expect(actions(h).filter((action) => action === 'auth.signed_in')).toHaveLength(2);
  });

  it('rejects a malformed body with 400', async () => {
    const { h } = await world();
    for (const body of [
      { email: CARL.email },
      { ...CARL, extra: 1 },
      { email: '', password: 'x' },
    ]) {
      const response = await h.client().post('/api/session', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('lockout edges', () => {
  it('locks on the 5th failure, refuses with 429 until locked_until, then counts from zero', async () => {
    const { h, carlId } = await world();
    for (let i = 1; i <= 4; i += 1) {
      const response = await attempt(h, `wrong ${String(i)} password`);
      expect(response.statusCode).toBe(401);
      expect(carlRow(h, carlId).failedSignIns).toBe(i);
      expect(carlRow(h, carlId).lockedUntil).toBeNull();
    }
    expect(actions(h)).not.toContain('auth.locked_out');

    const fifth = await attempt(h, 'wrong 5 password');
    expect(fifth.statusCode).toBe(401);
    expect(errorEnvelopeSchema.parse(fifth.json()).error.code).toBe('invalid_credentials');
    const lockedUntil = new Date(h.clock.now().getTime() + 15 * MINUTE);
    expect(carlRow(h, carlId).lockedUntil).toBe(lockedUntil.toISOString());
    const lockEvents = h.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, 'auth.locked_out'))
      .all();
    expect(lockEvents).toHaveLength(1);
    expect(lockEvents[0]).toMatchObject({ entityType: 'user', entityId: carlId });

    // While locked, even the right password is refused and nothing is counted.
    h.clock.advance(15 * MINUTE - 1500);
    const locked = await attempt(h, CARL.password);
    expect(locked.statusCode).toBe(429);
    const envelope = errorEnvelopeSchema.parse(locked.json());
    expect(envelope.error.code).toBe('too_many_attempts');
    expect(envelope.error.details).toEqual({ retryAfterSeconds: 2 });
    expect(locked.headers['retry-after']).toBe('2');
    expect(locked.headers['set-cookie']).toBeUndefined();
    const lockedWrong = await attempt(h, 'still wrong password');
    expect(lockedWrong.statusCode).toBe(429);
    expect(carlRow(h, carlId).failedSignIns).toBe(5);

    // One millisecond before the end still waits at least a second.
    h.clock.set(new Date(lockedUntil.getTime() - 1));
    const almost = await attempt(h, CARL.password);
    expect(almost.statusCode).toBe(429);
    expect(errorEnvelopeSchema.parse(almost.json()).error.details).toEqual({
      retryAfterSeconds: 1,
    });
    expect(almost.headers['retry-after']).toBe('1');

    // At locked_until the lock is over and the count restarts at zero.
    h.clock.set(lockedUntil);
    const after = await attempt(h, 'wrong again password');
    expect(after.statusCode).toBe(401);
    expect(carlRow(h, carlId).failedSignIns).toBe(1);
    expect(carlRow(h, carlId).lockedUntil).toBeNull();

    const ok = await attempt(h, CARL.password);
    expect(ok.statusCode).toBe(200);
    expect(carlRow(h, carlId).failedSignIns).toBe(0);
    expect(actions(h).filter((action) => action === 'auth.locked_out')).toHaveLength(1);
  });

  it('lets a right password in exactly at locked_until', async () => {
    const { h, carlId } = await world();
    for (let i = 0; i < 5; i += 1) await attempt(h, 'wrong password!!');
    const until = carlRow(h, carlId).lockedUntil ?? '';
    h.clock.set(new Date(until));
    const ok = await attempt(h, CARL.password);
    expect(ok.statusCode).toBe(200);
    expect(carlRow(h, carlId)).toMatchObject({ failedSignIns: 0, lockedUntil: null });
  });

  it('resets the count on success and never counts unknown emails', async () => {
    const { h, carlId } = await world();
    for (let i = 0; i < 4; i += 1) await attempt(h, 'wrong password!!');
    expect(carlRow(h, carlId).failedSignIns).toBe(4);
    expect((await attempt(h, CARL.password)).statusCode).toBe(200);
    expect(carlRow(h, carlId).failedSignIns).toBe(0);
    // Four more failures do not lock: the count restarted.
    for (let i = 0; i < 4; i += 1) await attempt(h, 'wrong password!!');
    expect(carlRow(h, carlId).lockedUntil).toBeNull();

    for (let i = 0; i < 10; i += 1) {
      const response = await attempt(h, 'whatever password', 'ghost@example.com');
      expect(response.statusCode).toBe(401);
    }
    expect(actions(h)).not.toContain('auth.locked_out');
    // The admin was never touched by Carl's failures.
    expect((await attempt(h, ADMIN.password, ADMIN.email)).statusCode).toBe(200);
  });
});
