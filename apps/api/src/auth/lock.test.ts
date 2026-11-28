import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, session, user } from '../../db/schema';
import { errorEnvelopeSchema, sessionResponseSchema } from '../contract';
import { ADMIN, createHarness, type Client, type Harness } from '../testing/harness';

const MINUTE = 60_000;
const LOCK = '/api/session/lock';
const UNLOCK = '/api/session/unlock';
const CARL = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'carl contributor password',
} as const;

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function world(): Promise<{ h: Harness; admin: Client; carl: Client }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  expect((await admin.post('/api/users', CARL)).statusCode).toBe(201);
  const carl = await h.signIn(CARL.email, CARL.password);
  return { h, admin, carl };
}

function code(response: { json: () => unknown }): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

function eventsOf(h: Harness, action: string) {
  return h.db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.action, action))
    .orderBy(asc(auditEvent.id))
    .all();
}

function sessionRow(h: Harness, userId: string | undefined) {
  return h.db
    .select()
    .from(session)
    .all()
    .find((row) => row.userId === userId);
}

function adminRow(h: Harness) {
  const row = h.db.select().from(user).where(eq(user.email, ADMIN.email)).get();
  if (!row) throw new Error('no admin');
  return row;
}

function status(response: { json: () => unknown }) {
  return sessionResponseSchema.parse(response.json());
}

describe('lock is idempotent and audited', () => {
  it('gives 204 and one auth.session_locked; a repeat gives 204 with no event', async () => {
    const { h, admin } = await world();
    const locked = await admin.post(LOCK);
    expect(locked.statusCode).toBe(204);
    expect(locked.body).toBe('');
    expect(locked.headers['set-cookie']).toBeUndefined();
    const lockedAt = sessionRow(h, admin.user?.id)?.lockedAt;
    expect(lockedAt).toBe(h.clock.now().toISOString());
    const events = eventsOf(h, 'auth.session_locked');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: admin.user?.id,
      entityType: 'user',
      entityId: admin.user?.id,
      before: null,
      after: null,
    });

    h.clock.advance(MINUTE);
    const again = await admin.post(LOCK);
    expect(again.statusCode).toBe(204);
    expect(eventsOf(h, 'auth.session_locked')).toHaveLength(1);
    expect(sessionRow(h, admin.user?.id)?.lockedAt).toBe(lockedAt);
  });

  it('needs a session and the CSRF token', async () => {
    const { h, admin } = await world();
    const anon = await h.client().post(LOCK);
    expect(anon.statusCode).toBe(401);
    expect(code(anon)).toBe('unauthenticated');
    const noCsrf = await admin.post(LOCK, undefined, { headers: { 'x-csrf-token': null } });
    expect(noCsrf.statusCode).toBe(403);
    expect(code(noCsrf)).toBe('csrf_failed');
    expect(sessionRow(h, admin.user?.id)?.lockedAt).toBeNull();
    expect(eventsOf(h, 'auth.session_locked')).toHaveLength(0);
  });
});

describe('locked session is gated', () => {
  it('answers 423 on guarded reads and writes, while lock, unlock and session status work', async () => {
    const { h, admin, carl } = await world();
    expect((await admin.post(LOCK)).statusCode).toBe(204);
    for (const response of [
      await admin.get('/api/users'),
      await admin.get('/api/assessment'),
      await admin.get('/api/audit'),
      await admin.patch('/api/system-profile', { systemName: 'X' }),
      await admin.post('/api/users', { ...CARL, email: 'x@example.com' }),
    ]) {
      expect(response.statusCode).toBe(423);
      expect(errorEnvelopeSchema.parse(response.json()).error).toMatchObject({
        code: 'session_locked',
        message: 'Your session is locked. Enter your password to unlock it.',
      });
    }
    // A contributor's admin-only write: the lock comes before the role.
    expect((await carl.post(LOCK)).statusCode).toBe(204);
    expect(code(await carl.post('/api/users', { bad: true }))).toBe('session_locked');

    const report = status(await admin.get('/api/session'));
    expect(report).toMatchObject({ setupRequired: false, locked: true, mustChangePassword: false });
    expect(report.user?.email).toBe(ADMIN.email);
    expect(report.csrfToken).toBe(admin.csrfToken);
    expect((await admin.post(LOCK)).statusCode).toBe(204);
    expect((await admin.post(UNLOCK, { password: ADMIN.password })).statusCode).toBe(200);
    expect((await admin.get('/api/users')).statusCode).toBe(200);
    // Sign-out is public, so a locked session can always leave.
    expect((await carl.delete('/api/session')).statusCode).toBe(204);
    expect(sessionRow(h, carl.user?.id)).toBeUndefined();
  });

  it('only the locked session is gated, not the user’s other sessions', async () => {
    const { h, admin } = await world();
    const other = await h.signIn(ADMIN.email, ADMIN.password);
    expect((await admin.post(LOCK)).statusCode).toBe(204);
    expect((await other.get('/api/users')).statusCode).toBe(200);
    expect(status(await other.get('/api/session')).locked).toBe(false);
  });
});

describe('locked session does not refresh idle', () => {
  it('still ends 30 min after the last unlocked request, however often it polls', async () => {
    const { h, admin } = await world();
    h.clock.advance(5 * MINUTE);
    expect((await admin.get('/api/users')).statusCode).toBe(200);
    const lastUnlocked = h.clock.now();
    expect((await admin.post(LOCK)).statusCode).toBe(204);
    for (let minute = 1; minute < 30; minute += 1) {
      h.clock.set(new Date(lastUnlocked.getTime() + minute * MINUTE));
      const polled = status(await admin.get('/api/session'));
      expect(polled.locked, `minute ${String(minute)}`).toBe(true);
      expect((await admin.get('/api/users')).statusCode).toBe(423);
      expect((await admin.post(LOCK)).statusCode).toBe(204);
      expect(sessionRow(h, admin.user?.id)?.lastSeenAt).toBe(lastUnlocked.toISOString());
    }
    h.clock.set(new Date(lastUnlocked.getTime() + 30 * MINUTE - 1));
    expect(status(await admin.get('/api/session')).user?.email).toBe(ADMIN.email);
    h.clock.set(new Date(lastUnlocked.getTime() + 30 * MINUTE));
    expect(status(await admin.get('/api/session'))).toMatchObject({ user: null, locked: false });
    expect(sessionRow(h, admin.user?.id)).toBeUndefined();
    expect((await admin.post(UNLOCK, { password: ADMIN.password })).statusCode).toBe(401);
  });
});

describe('unlock with the password', () => {
  it('unlocks with the same cookie and one event; unlocking an unlocked session writes none', async () => {
    const { h, admin } = await world();
    const cookie = admin.cookie;
    const csrf = admin.csrfToken;
    expect((await admin.post(LOCK)).statusCode).toBe(204);
    h.clock.advance(10 * MINUTE);

    const unlocked = await admin.post(UNLOCK, { password: ADMIN.password });
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    expect(unlocked.headers['set-cookie']).toBeUndefined();
    expect(status(unlocked)).toMatchObject({
      setupRequired: false,
      user: { email: ADMIN.email },
      csrfToken: csrf,
      locked: false,
      mustChangePassword: false,
      signInNotice: null,
    });
    expect(admin.cookie).toBe(cookie);
    const row = sessionRow(h, admin.user?.id);
    expect(row).toMatchObject({ lockedAt: null, lastSeenAt: h.clock.now().toISOString() });
    const events = eventsOf(h, 'auth.session_unlocked');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: admin.user?.id,
      entityType: 'user',
      entityId: admin.user?.id,
    });
    expect((await admin.get('/api/users')).statusCode).toBe(200);

    const again = await admin.post(UNLOCK, { password: ADMIN.password });
    expect(again.statusCode).toBe(200);
    expect(status(again).locked).toBe(false);
    expect(eventsOf(h, 'auth.session_unlocked')).toHaveLength(1);
  });

  it('refuses a bad body with 400 and needs the CSRF token', async () => {
    const { admin } = await world();
    expect((await admin.post(LOCK)).statusCode).toBe(204);
    for (const body of [{}, { password: '' }, { password: ADMIN.password, extra: 1 }]) {
      const response = await admin.post(UNLOCK, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(code(response)).toBe('validation_failed');
    }
    const noCsrf = await admin.post(
      UNLOCK,
      { password: ADMIN.password },
      { headers: { 'x-csrf-token': null } },
    );
    expect(code(noCsrf)).toBe('csrf_failed');
    expect(status(await admin.get('/api/session')).locked).toBe(true);
  });

  it('a right unlock restarts the run of failures', async () => {
    const { h, admin } = await world();
    for (let i = 0; i < 4; i += 1) await admin.post(UNLOCK, { password: 'wrong password!' });
    expect(adminRow(h).failedSignIns).toBe(4);
    expect((await admin.post(UNLOCK, { password: ADMIN.password })).statusCode).toBe(200);
    expect(adminRow(h).failedSignIns).toBe(0);
  });
});

describe('unlock failures share the lockout', () => {
  it('a wrong unlock counts; the 5th failure, mixed with sign-ins, ends every session', async () => {
    const { h, admin, carl } = await world();
    const other = await h.signIn(ADMIN.email, ADMIN.password);
    expect((await admin.post(LOCK)).statusCode).toBe(204);
    const wrongSignIn = () =>
      h.client().post('/api/session', { email: ADMIN.email, password: 'wrong password!' });
    const wrongUnlock = () => admin.post(UNLOCK, { password: 'wrong password!' });

    const first = await wrongUnlock();
    expect(first.statusCode).toBe(401);
    expect(code(first)).toBe('invalid_credentials');
    expect(first.headers['set-cookie']).toBeUndefined();
    expect(adminRow(h).failedSignIns).toBe(1);
    expect((await wrongSignIn()).statusCode).toBe(401);
    expect((await wrongUnlock()).statusCode).toBe(401);
    expect((await wrongSignIn()).statusCode).toBe(401);
    expect(adminRow(h).failedSignIns).toBe(4);
    expect(eventsOf(h, 'auth.locked_out')).toHaveLength(0);

    const fifth = await wrongUnlock();
    expect(fifth.statusCode).toBe(401);
    expect(code(fifth)).toBe('unauthenticated');
    const cleared = fifth.cookies.find((item) => item.name === 'rampart_session');
    expect(cleared?.value).toBe('');
    expect(admin.cookie).toBeNull();
    expect(
      h.db
        .select()
        .from(session)
        .where(eq(session.userId, adminRow(h).id))
        .all(),
    ).toEqual([]);
    expect((await other.get('/api/users')).statusCode).toBe(401);
    expect((await carl.get('/api/users')).statusCode).toBe(200);
    expect(adminRow(h).lockedUntil).toBe(
      new Date(h.clock.now().getTime() + 15 * MINUTE).toISOString(),
    );
    expect(eventsOf(h, 'auth.locked_out')).toHaveLength(1);
  });

  it('while the account is locked, unlock gives 429 without counting', async () => {
    const { h, admin } = await world();
    expect((await admin.post(LOCK)).statusCode).toBe(204);
    for (let i = 0; i < 4; i += 1) await admin.post(UNLOCK, { password: 'wrong password!' });
    // The 5th failure comes from a sign-in, so this session lives on, locked.
    const fifth = await h
      .client()
      .post('/api/session', { email: ADMIN.email, password: 'wrong password!' });
    expect(fifth.statusCode).toBe(401);
    expect(adminRow(h).lockedUntil).not.toBeNull();
    expect(status(await admin.get('/api/session')).locked).toBe(true);

    for (const password of [ADMIN.password, 'wrong password!']) {
      const refused = await admin.post(UNLOCK, { password });
      expect(refused.statusCode).toBe(429);
      expect(code(refused)).toBe('too_many_attempts');
      expect(refused.headers['retry-after']).toBe(String(15 * 60));
    }
    expect(adminRow(h).failedSignIns).toBe(5);
    expect(eventsOf(h, 'auth.session_unlocked')).toHaveLength(0);
    expect(status(await admin.get('/api/session')).locked).toBe(true);
  });
});
