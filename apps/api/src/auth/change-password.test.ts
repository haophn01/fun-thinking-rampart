import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, passwordHistory, session, user } from '../../db/schema';
import { errorEnvelopeSchema, sessionResponseSchema } from '../contract';
import { ADMIN, START, createHarness, type Client, type Harness } from '../testing/harness';
import { verifyPassword } from './password';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CHANGE = '/api/session/password';
const NEW_PASSWORD = 'a fresh admin password';
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

function userRow(h: Harness, email: string) {
  const row = h.db.select().from(user).where(eq(user.email, email)).get();
  if (!row) throw new Error(`no ${email}`);
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

/** Everything a refused change must leave as it was. */
function state(h: Harness) {
  return {
    users: h.db.select().from(user).orderBy(asc(user.email)).all(),
    sessions: h.db.select().from(session).orderBy(asc(session.id)).all(),
    history: h.db.select().from(passwordHistory).all(),
    events: actions(h),
  };
}

function signInStatus(h: Harness, email: string, password: string) {
  return h
    .client()
    .post('/api/session', { email, password })
    .then((response) => response.statusCode);
}

describe('change password rotates and signs out everywhere', () => {
  it('rotates the cookie, ends every other session and records the change', async () => {
    const { h, admin, carl } = await world();
    const other = await h.signIn(ADMIN.email, ADMIN.password);
    const oldToken = admin.cookie;
    const oldCsrf = admin.csrfToken;
    const oldHash = userRow(h, ADMIN.email).passwordHash;
    const signedInAt = h.db
      .select()
      .from(session)
      .all()
      .find((row) => row.userId === admin.user?.id)?.createdAt;
    h.clock.advance(MINUTE);

    const changed = await admin.post(CHANGE, {
      currentPassword: ADMIN.password,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const body = sessionResponseSchema.parse(changed.json());
    expect(body).toMatchObject({
      setupRequired: false,
      user: { email: ADMIN.email, role: 'admin' },
      locked: false,
      mustChangePassword: false,
      signInNotice: null,
    });
    const setCookie = changed.cookies.find((item) => item.name === 'rampart_session');
    expect(setCookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', maxAge: 28800 });
    expect(admin.cookie).not.toBeNull();
    expect(admin.cookie).not.toBe(oldToken);
    expect(body.csrfToken).not.toBe(oldCsrf);

    // The old token, and the user's other session, are dead; another user's session is not.
    const stale = h.client();
    stale.cookie = oldToken;
    expect((await stale.get('/api/users')).statusCode).toBe(401);
    expect((await other.get('/api/users')).statusCode).toBe(401);
    expect((await carl.get('/api/users')).statusCode).toBe(200);
    expect((await admin.get('/api/users')).statusCode).toBe(200);

    // Rotation keeps created_at, so the 8 h still count from sign-in.
    const adminSessions = h.db
      .select()
      .from(session)
      .all()
      .filter((row) => row.userId === admin.user?.id);
    expect(adminSessions).toHaveLength(1);
    expect(adminSessions[0]?.createdAt).toBe(signedInAt);

    const row = userRow(h, ADMIN.email);
    expect(row).toMatchObject({
      mustChangePassword: false,
      passwordChangedAt: h.clock.now().toISOString(),
      failedSignIns: 0,
      lockedUntil: null,
    });
    expect(await verifyPassword(row.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(h.db.select().from(passwordHistory).all()).toMatchObject([
      { userId: row.id, passwordHash: oldHash, createdAt: h.clock.now().toISOString() },
    ]);

    const events = h.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, 'auth.password_changed'))
      .all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: row.id,
      entityType: 'user',
      entityId: row.id,
      before: null,
      after: null,
    });

    expect(await signInStatus(h, ADMIN.email, NEW_PASSWORD)).toBe(200);
    expect(await signInStatus(h, ADMIN.email, ADMIN.password)).toBe(401);
  });

  it('a rotated session still ends 8 h after sign-in', async () => {
    const { h, admin } = await world();
    // Kept alive every 20 minutes, so only the absolute limit can end it.
    for (let at = 20 * MINUTE; at <= 7 * HOUR + 40 * MINUTE; at += 20 * MINUTE) {
      h.clock.set(new Date(START.getTime() + at));
      expect((await admin.get('/api/users')).statusCode).toBe(200);
    }
    const changed = await admin.post(CHANGE, {
      currentPassword: ADMIN.password,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.statusCode).toBe(200);
    h.clock.set(new Date(START.getTime() + 8 * HOUR - 1));
    expect((await admin.get('/api/users')).statusCode).toBe(200);
    h.clock.set(new Date(START.getTime() + 8 * HOUR));
    expect((await admin.get('/api/users')).statusCode).toBe(401);
  });
});

describe('change password refusals', () => {
  it('refuses a wrong current password, a common one and a reused one, changing nothing', async () => {
    const { h, admin } = await world();
    const cookie = admin.cookie;

    const before = state(h);
    const wrong = await admin.post(CHANGE, {
      currentPassword: 'not my password',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.statusCode).toBe(401);
    expect(code(wrong)).toBe('invalid_credentials');
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect(userRow(h, ADMIN.email).failedSignIns).toBe(1);
    expect(state(h).history).toEqual(before.history);
    expect(state(h).events).toEqual(before.events);

    const refusals: [string, Record<string, unknown>, number, string][] = [
      [
        'common',
        { currentPassword: ADMIN.password, newPassword: 'PassWord1234' },
        400,
        'password_too_common',
      ],
      [
        'the current one',
        { currentPassword: ADMIN.password, newPassword: ADMIN.password },
        400,
        'password_reused',
      ],
      [
        'too short',
        { currentPassword: ADMIN.password, newPassword: 'x'.repeat(11) },
        400,
        'validation_failed',
      ],
      [
        'extra key',
        { currentPassword: ADMIN.password, newPassword: NEW_PASSWORD, x: 1 },
        400,
        'validation_failed',
      ],
      // The current password is checked before the blocklist.
      [
        'wrong and common',
        { currentPassword: 'nope nope', newPassword: 'password1234' },
        401,
        'invalid_credentials',
      ],
    ];
    for (const [label, body, status, expected] of refusals) {
      const snapshot = state(h);
      const response = await admin.post(CHANGE, body);
      expect(response.statusCode, label).toBe(status);
      expect(code(response), label).toBe(expected);
      expect(response.headers['set-cookie'], label).toBeUndefined();
      if (expected !== 'invalid_credentials') expect(state(h), label).toEqual(snapshot);
    }
    expect(admin.cookie).toBe(cookie);
    expect((await admin.get('/api/users')).statusCode).toBe(200);
  });

  it('after P1 to P6, P2 to P6 are refused and P1 is accepted', async () => {
    const { h, admin } = await world();
    const passwords = [
      ADMIN.password,
      'second password two',
      'third password three',
      'fourth password four',
      'fifth password five',
      'sixth password six',
    ];
    for (let i = 1; i < passwords.length; i += 1) {
      const response = await admin.post(CHANGE, {
        currentPassword: passwords[i - 1],
        newPassword: passwords[i],
      });
      expect(response.statusCode, `to P${String(i + 1)}: ${response.body}`).toBe(200);
    }
    expect(h.db.select().from(passwordHistory).all()).toHaveLength(4);
    const current = passwords[5] ?? '';
    for (const reused of passwords.slice(1)) {
      const before = state(h);
      const response = await admin.post(CHANGE, { currentPassword: current, newPassword: reused });
      expect(code(response), reused).toBe('password_reused');
      expect(state(h), reused).toEqual(before);
    }
    const back = await admin.post(CHANGE, { currentPassword: current, newPassword: passwords[0] });
    expect(back.statusCode, back.body).toBe(200);
  });

  it('a locked account gives 429 without counting, even with the right password', async () => {
    const { h, admin } = await world();
    for (let i = 0; i < 5; i += 1) {
      await h.client().post('/api/session', { email: ADMIN.email, password: 'wrong password!' });
    }
    expect(userRow(h, ADMIN.email).lockedUntil).not.toBeNull();
    const before = state(h);
    const response = await admin.post(CHANGE, {
      currentPassword: ADMIN.password,
      newPassword: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(429);
    expect(code(response)).toBe('too_many_attempts');
    expect(response.headers['retry-after']).toBe(String(15 * 60));
    expect(state(h)).toEqual(before);
  });

  it('the 5th failure from a change ends every session of the user and locks the account', async () => {
    const { h, admin, carl } = await world();
    const other = await h.signIn(ADMIN.email, ADMIN.password);
    for (let i = 0; i < 4; i += 1) {
      const response = await h
        .client()
        .post('/api/session', { email: ADMIN.email, password: 'wrong password!' });
      expect(response.statusCode).toBe(401);
    }
    const fifth = await admin.post(CHANGE, {
      currentPassword: 'still the wrong one',
      newPassword: NEW_PASSWORD,
    });
    expect(fifth.statusCode).toBe(401);
    expect(code(fifth)).toBe('unauthenticated');
    expect(admin.cookie).toBeNull();
    const adminId = userRow(h, ADMIN.email).id;
    expect(h.db.select().from(session).where(eq(session.userId, adminId)).all()).toHaveLength(0);
    expect((await other.get('/api/users')).statusCode).toBe(401);
    expect((await carl.get('/api/users')).statusCode).toBe(200);
    expect(userRow(h, ADMIN.email).lockedUntil).toBe(
      new Date(h.clock.now().getTime() + 15 * MINUTE).toISOString(),
    );
    expect(actions(h).filter((action) => action === 'auth.locked_out')).toHaveLength(1);
  });
});

describe('password change gate', () => {
  it('a must-change user gets only the session routes until the change, which clears the flag', async () => {
    const { h, carl } = await world();
    h.db.update(user).set({ mustChangePassword: true }).where(eq(user.email, CARL.email)).run();

    // Sign-in reports the flag.
    const fresh = h.client();
    const signedIn = await fresh.post('/api/session', {
      email: CARL.email,
      password: CARL.password,
    });
    expect(sessionResponseSchema.parse(signedIn.json()).mustChangePassword).toBe(true);

    for (const client of [carl, fresh]) {
      const status = sessionResponseSchema.parse((await client.get('/api/session')).json());
      expect(status).toMatchObject({ mustChangePassword: true, locked: false });
      expect(status.user?.email).toBe(CARL.email);
      for (const response of [
        await client.get('/api/assessment'),
        await client.get('/api/users'),
        await client.get('/api/audit'),
        await client.patch('/api/system-profile', { systemName: 'X' }),
      ]) {
        expect(response.statusCode).toBe(403);
        expect(errorEnvelopeSchema.parse(response.json()).error).toMatchObject({
          code: 'password_change_required',
          message: 'Change your password to continue.',
        });
      }
    }

    // Lock and unlock still work, and unlock reports the flag.
    expect((await carl.post('/api/session/lock')).statusCode).toBe(204);
    const unlocked = await carl.post('/api/session/unlock', { password: CARL.password });
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    expect(sessionResponseSchema.parse(unlocked.json())).toMatchObject({
      locked: false,
      mustChangePassword: true,
    });

    const changed = await carl.post(CHANGE, {
      currentPassword: CARL.password,
      newPassword: 'carl chose his own',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(sessionResponseSchema.parse(changed.json()).mustChangePassword).toBe(false);
    expect(userRow(h, CARL.email).mustChangePassword).toBe(false);
    expect((await carl.get('/api/assessment')).statusCode).toBe(200);
    expect(sessionResponseSchema.parse((await carl.get('/api/session')).json())).toMatchObject({
      mustChangePassword: false,
    });
    // The change ended the other session.
    expect((await fresh.get('/api/assessment')).statusCode).toBe(401);
    // Sign-out is public, so never gated.
    expect((await carl.delete('/api/session')).statusCode).toBe(204);
  });

  it('an existing account is never asked to change its password', async () => {
    const { h, admin } = await world();
    expect(userRow(h, ADMIN.email).mustChangePassword).toBe(false);
    expect(sessionResponseSchema.parse((await admin.get('/api/session')).json())).toMatchObject({
      mustChangePassword: false,
    });
    expect((await admin.get('/api/assessment')).statusCode).toBe(200);
  });
});
