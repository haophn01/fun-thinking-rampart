import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, passwordHistory, session, user } from '../../db/schema';
import { errorEnvelopeSchema, sessionResponseSchema } from '../contract';
import { ADMIN, START, createHarness, type Client, type Harness } from '../testing/harness';

const MINUTE = 60_000;
const TEMPORARY = 'a temporary password';
const CHOSEN = 'carl chose this himself';
const RESET = 'a reset temporary password';
const COMMON = 'PassWord1234';
const CARL = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: TEMPORARY,
} as const;

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

function harness(): Harness {
  const h = createHarness();
  harnesses.push(h);
  return h;
}

function code(response: { json: () => unknown }): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

function userRow(h: Harness, email: string) {
  const row = h.db.select().from(user).where(eq(user.email, email)).get();
  if (!row) throw new Error(`no ${email}`);
  return row;
}

/**
 * Signs in through the api, keeping any must-change flag; the harness completes the MFA step,
 * which comes before the password change (the guard order is pinned in `auth/csrf.test.ts`).
 */
async function signInAsUser(h: Harness, email: string, password: string): Promise<Client> {
  return h.signIn(email, password, { temporary: true });
}

/** Everything a refused request must leave as it was. */
function state(h: Harness) {
  return {
    users: h.db.select().from(user).orderBy(asc(user.email)).all(),
    sessions: h.db.select().from(session).orderBy(asc(session.id)).all(),
    history: h.db.select().from(passwordHistory).orderBy(asc(passwordHistory.id)).all(),
    events: h.db.select().from(auditEvent).orderBy(asc(auditEvent.id)).all(),
  };
}

describe('created users must change the temporary password', () => {
  it('signs in flagged, is gated, and works normally after changing', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    h.clock.advance(MINUTE);
    const created = await admin.post('/api/users', CARL);
    expect(created.statusCode, created.body).toBe(201);
    const row = userRow(h, CARL.email);
    expect(row.mustChangePassword).toBe(true);
    expect(row.passwordChangedAt).toBe(new Date(START.getTime() + MINUTE).toISOString());
    // A new user has no earlier password to remember.
    expect(h.db.select().from(passwordHistory).all()).toEqual([]);

    const carl = await signInAsUser(h, CARL.email, TEMPORARY);
    const signedIn = sessionResponseSchema.parse((await carl.get('/api/session')).json());
    expect(signedIn.mustChangePassword).toBe(true);
    const gated = await carl.get('/api/assessment');
    expect(gated.statusCode).toBe(403);
    expect(code(gated)).toBe('password_change_required');

    // Choosing the temporary password again is a reuse.
    const same = await carl.post('/api/session/password', {
      currentPassword: TEMPORARY,
      newPassword: TEMPORARY,
    });
    expect(code(same)).toBe('password_reused');

    h.clock.advance(MINUTE);
    const changed = await carl.post('/api/session/password', {
      currentPassword: TEMPORARY,
      newPassword: CHOSEN,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(sessionResponseSchema.parse(changed.json()).mustChangePassword).toBe(false);
    expect((await carl.get('/api/assessment')).statusCode).toBe(200);
    expect(userRow(h, CARL.email)).toMatchObject({
      mustChangePassword: false,
      passwordChangedAt: new Date(START.getTime() + 2 * MINUTE).toISOString(),
    });

    // A fresh sign-in with the chosen password is not gated.
    const again = await signInAsUser(h, CARL.email, CHOSEN);
    expect(sessionResponseSchema.parse((await again.get('/api/session')).json())).toMatchObject({
      mustChangePassword: false,
    });
  });
});

describe('reset is temporary and remembered', () => {
  it('flags another user, ends their sessions and keeps the old hash in history', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const carlId = (await admin.post('/api/users', CARL)).json<{ user: { id: string } }>().user.id;
    const first = await signInAsUser(h, CARL.email, TEMPORARY);
    await first.post('/api/session/password', { currentPassword: TEMPORARY, newPassword: CHOSEN });
    const laptop = await signInAsUser(h, CARL.email, CHOSEN);
    const phone = await signInAsUser(h, CARL.email, CHOSEN);
    const chosenHash = userRow(h, CARL.email).passwordHash;
    const historyBefore = h.db.select().from(passwordHistory).all().length;

    h.clock.advance(MINUTE);
    const reset = await admin.patch(`/api/users/${carlId}`, { password: RESET });
    expect(reset.statusCode, reset.body).toBe(200);
    // The admin keeps their session and cookie.
    expect(reset.headers['set-cookie']).toBeUndefined();
    expect((await admin.get('/api/users')).statusCode).toBe(200);

    expect(userRow(h, CARL.email)).toMatchObject({
      mustChangePassword: true,
      passwordChangedAt: new Date(START.getTime() + MINUTE).toISOString(),
    });
    expect(h.db.select().from(session).where(eq(session.userId, carlId)).all()).toEqual([]);
    for (const c of [first, laptop, phone]) {
      expect((await c.get('/api/users')).statusCode).toBe(401);
    }
    const history = h.db
      .select()
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, carlId))
      .orderBy(asc(passwordHistory.id))
      .all();
    expect(history).toHaveLength(historyBefore + 1);
    expect(history.at(-1)?.passwordHash).toBe(chosenHash);

    // Carl signs in with the reset password, is gated, and can't go back to his old one.
    const carl = await signInAsUser(h, CARL.email, RESET);
    expect(code(await carl.get('/api/assessment'))).toBe('password_change_required');
    const back = await carl.post('/api/session/password', {
      currentPassword: RESET,
      newPassword: CHOSEN,
    });
    expect(back.statusCode).toBe(400);
    expect(code(back)).toBe('password_reused');
    const fresh = await carl.post('/api/session/password', {
      currentPassword: RESET,
      newPassword: 'another one of carls own',
    });
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect((await carl.get('/api/assessment')).statusCode).toBe(200);
  });

  it('flags an admin who resets their own password and signs them out', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const other = await h.signIn(ADMIN.email, ADMIN.password);
    const adminId = admin.user?.id ?? '';
    const oldHash = userRow(h, ADMIN.email).passwordHash;

    const reset = await admin.patch(`/api/users/${adminId}`, { password: RESET });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(admin.cookie).toBeNull();
    expect(h.db.select().from(session).where(eq(session.userId, adminId)).all()).toEqual([]);
    expect((await other.get('/api/users')).statusCode).toBe(401);
    expect(userRow(h, ADMIN.email).mustChangePassword).toBe(true);
    expect(
      h.db
        .select()
        .from(passwordHistory)
        .where(eq(passwordHistory.userId, adminId))
        .all()
        .map((row) => row.passwordHash),
    ).toEqual([oldHash]);

    const back = await signInAsUser(h, ADMIN.email, RESET);
    expect(code(await back.get('/api/users'))).toBe('password_change_required');
    const toOld = await back.post('/api/session/password', {
      currentPassword: RESET,
      newPassword: ADMIN.password,
    });
    expect(code(toOld)).toBe('password_reused');
  });

  it('keeps only the newest history rows after repeated resets', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const carlId = (await admin.post('/api/users', CARL)).json<{ user: { id: string } }>().user.id;
    for (let i = 0; i < 6; i += 1) {
      h.clock.advance(MINUTE);
      const reset = await admin.patch(`/api/users/${carlId}`, {
        password: `${RESET} ${String(i)}`,
      });
      expect(reset.statusCode, reset.body).toBe(200);
    }
    const rows = h.db
      .select()
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, carlId))
      .all();
    expect(rows).toHaveLength(4);
    expect(userRow(h, CARL.email).mustChangePassword).toBe(true);
  });
});

describe('temporary passwords pass the blocklist', () => {
  it('refuses a common password on create and changes nothing', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const before = state(h);
    const refused = await admin.post('/api/users', { ...CARL, password: COMMON });
    expect(refused.statusCode).toBe(400);
    expect(code(refused)).toBe('password_too_common');
    expect(state(h)).toEqual(before);
  });

  it('refuses a common password on reset, even with other fields, and changes nothing', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const carlId = (await admin.post('/api/users', CARL)).json<{ user: { id: string } }>().user.id;
    const carl = await h.signIn(CARL.email, TEMPORARY);
    const before = state(h);

    for (const body of [
      { password: COMMON },
      { password: 'password1234', role: 'admin', displayName: 'Carl C' },
    ]) {
      const refused = await admin.patch(`/api/users/${carlId}`, body);
      expect(refused.statusCode, JSON.stringify(body)).toBe(400);
      expect(code(refused)).toBe('password_too_common');
      expect(refused.headers['set-cookie']).toBeUndefined();
    }
    // Your own reset is refused the same way, and keeps you signed in.
    const own = await admin.patch(`/api/users/${admin.user?.id ?? ''}`, { password: COMMON });
    expect(code(own)).toBe('password_too_common');
    expect(admin.cookie).not.toBeNull();

    expect(state(h)).toEqual(before);
    expect((await carl.get('/api/assessment')).statusCode).toBe(200);
  });
});
