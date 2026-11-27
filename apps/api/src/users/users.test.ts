import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, session, user } from '../../db/schema';
import {
  errorEnvelopeSchema,
  userResponseSchema,
  usersResponseSchema,
  type User,
} from '../contract';
import { ADMIN, START, createHarness, type Client, type Harness } from '../testing/harness';

const PASSWORD = 'a long enough password';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

function harness(): Harness {
  const h = createHarness();
  harnesses.push(h);
  return h;
}

function code(body: string): string {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error.code;
}

async function create(
  admin: Client,
  fields: { email: string; displayName: string; role?: 'admin' | 'contributor' },
): Promise<User> {
  const response = await admin.post('/api/users', {
    role: 'contributor',
    password: PASSWORD,
    ...fields,
  });
  expect(response.statusCode, response.body).toBe(201);
  return userResponseSchema.parse(response.json()).user;
}

function events(h: Harness) {
  return h.db
    .select()
    .from(auditEvent)
    .orderBy(asc(auditEvent.id))
    .all()
    .map((event) => ({
      action: event.action,
      entityId: event.entityId,
      actorUserId: event.actorUserId,
      before: JSON.parse(event.before ?? 'null') as unknown,
      after: JSON.parse(event.after ?? 'null') as unknown,
    }));
}

function sessionsOf(h: Harness, userId: string) {
  return h.db.select().from(session).where(eq(session.userId, userId)).all();
}

describe('admin-only user management', () => {
  it('creates users, refuses contributors and duplicate emails, and lists them sorted', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    h.clock.advance(60_000);
    const carl = await create(admin, { email: ' Carl@Example.com ', displayName: 'carl' });
    expect(carl).toEqual({
      id: expect.any(String) as string,
      email: 'carl@example.com',
      displayName: 'carl',
      role: 'contributor',
      active: true,
      createdAt: new Date(START.getTime() + 60_000).toISOString(),
      mfaEnrolled: false,
    });
    await create(admin, { email: 'bob@example.com', displayName: 'Bob' });
    await create(admin, { email: 'abe2@example.com', displayName: 'Bob' });
    await create(admin, { email: 'zed@example.com', displayName: 'Zed', role: 'admin' });

    const created = events(h).filter((event) => event.action === 'user.created');
    expect(created.at(-1)).toMatchObject({
      before: null,
      after: { email: 'zed@example.com', displayName: 'Zed', role: 'admin', active: true },
    });

    const dup = await admin.post('/api/users', {
      email: 'CARL@example.COM',
      displayName: 'Carl Two',
      role: 'contributor',
      password: PASSWORD,
    });
    expect(dup.statusCode).toBe(409);
    expect(code(dup.body)).toBe('email_taken');

    const carlClient = await h.signIn('carl@example.com', PASSWORD);
    const tryCreate = await carlClient.post('/api/users', {
      email: 'x@example.com',
      displayName: 'X',
      role: 'admin',
      password: PASSWORD,
    });
    expect(tryCreate.statusCode).toBe(403);
    expect(code(tryCreate.body)).toBe('forbidden');
    const tryPatch = await carlClient.patch(`/api/users/${carl.id}`, { role: 'admin' });
    expect(tryPatch.statusCode).toBe(403);
    expect(code(tryPatch.body)).toBe('forbidden');

    // Contributors can read the list; it is sorted by display name (ignoring case), then email.
    const list = await carlClient.get('/api/users');
    expect(list.statusCode).toBe(200);
    const users = usersResponseSchema.parse(list.json()).users;
    expect(users.map((u) => [u.displayName, u.email])).toEqual([
      ['Ada Admin', ADMIN.email],
      ['Bob', 'abe2@example.com'],
      ['Bob', 'bob@example.com'],
      ['carl', 'carl@example.com'],
      ['Zed', 'zed@example.com'],
    ]);
    expect(list.body).not.toMatch(/password|hash|argon|failedSignIns|lockedUntil/i);
    for (const raw of list.json<{ users: Record<string, unknown>[] }>().users) {
      expect(Object.keys(raw).sort()).toEqual(
        ['active', 'createdAt', 'displayName', 'email', 'id', 'mfaEnrolled', 'role'].sort(),
      );
    }
  });

  it('rejects a bad create body with 400', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    for (const body of [
      { email: 'a@example.com', displayName: 'A', role: 'owner', password: PASSWORD },
      { email: 'a@example.com', displayName: 'A', role: 'admin', password: 'short' },
      { email: 'a@example.com', displayName: 'A', role: 'admin' },
      { email: 'a@example.com', displayName: 'A', role: 'admin', password: PASSWORD, x: 1 },
    ]) {
      const response = await admin.post('/api/users', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('last admin and revocation', () => {
  it('keeps one active admin, and allows the change when there are two', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const adminId = admin.user?.id ?? '';

    for (const change of [{ role: 'contributor' }, { active: false }]) {
      const response = await admin.patch(`/api/users/${adminId}`, change);
      expect(response.statusCode, JSON.stringify(change)).toBe(409);
      expect(code(response.body)).toBe('last_admin');
    }

    // An inactive admin does not count.
    const dormant = await create(admin, {
      email: 'dormant@example.com',
      displayName: 'Dormant',
      role: 'admin',
    });
    expect((await admin.patch(`/api/users/${dormant.id}`, { active: false })).statusCode).toBe(200);
    const stillLast = await admin.patch(`/api/users/${adminId}`, { role: 'contributor' });
    expect(code(stillLast.body)).toBe('last_admin');

    // With a second active admin, demoting yourself works.
    const bea = await create(admin, {
      email: 'bea@example.com',
      displayName: 'Bea',
      role: 'admin',
    });
    const demoted = await admin.patch(`/api/users/${adminId}`, { role: 'contributor' });
    expect(demoted.statusCode).toBe(200);
    expect(userResponseSchema.parse(demoted.json()).user.role).toBe('contributor');

    // Bea is now the last one.
    const beaClient = await h.signIn('bea@example.com', PASSWORD);
    const beaOff = await beaClient.patch(`/api/users/${bea.id}`, { active: false });
    expect(code(beaOff.body)).toBe('last_admin');
    // Reactivating the dormant admin makes room again.
    expect((await beaClient.patch(`/api/users/${dormant.id}`, { active: true })).statusCode).toBe(
      200,
    );
    expect((await beaClient.patch(`/api/users/${bea.id}`, { active: false })).statusCode).toBe(200);
  });

  it('ends every session on deactivation and on password reset', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const carl = await create(admin, { email: 'carl@example.com', displayName: 'Carl' });
    const laptop = await h.signIn('carl@example.com', PASSWORD);
    const phone = await h.signIn('carl@example.com', PASSWORD);
    expect(sessionsOf(h, carl.id)).toHaveLength(2);

    const reset = await admin.patch(`/api/users/${carl.id}`, { password: 'a brand new password' });
    expect(reset.statusCode).toBe(200);
    expect(sessionsOf(h, carl.id)).toHaveLength(0);
    expect((await laptop.get('/api/users')).statusCode).toBe(401);
    expect((await phone.get('/api/users')).statusCode).toBe(401);
    // The admin's own session is untouched, and the new password works.
    expect((await admin.get('/api/users')).statusCode).toBe(200);
    const fresh = await h.signIn('carl@example.com', 'a brand new password');
    expect(
      (await h.client().post('/api/session', { email: 'carl@example.com', password: PASSWORD }))
        .statusCode,
    ).toBe(401);

    const off = await admin.patch(`/api/users/${carl.id}`, { active: false });
    expect(off.statusCode).toBe(200);
    expect(userResponseSchema.parse(off.json()).user.active).toBe(false);
    expect(sessionsOf(h, carl.id)).toHaveLength(0);
    expect((await fresh.get('/api/users')).statusCode).toBe(401);
  });

  it('clears a lockout when an admin resets the password', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const carl = await create(admin, { email: 'carl@example.com', displayName: 'Carl' });
    for (let i = 0; i < 5; i += 1) {
      await h
        .client()
        .post('/api/session', { email: 'carl@example.com', password: 'wrong guess!!' });
    }
    const locked = h.db.select().from(user).where(eq(user.id, carl.id)).get();
    expect(locked?.lockedUntil).not.toBeNull();
    await admin.patch(`/api/users/${carl.id}`, { password: 'a brand new password' });
    expect((await h.signIn('carl@example.com', 'a brand new password')).user?.id).toBe(carl.id);
  });

  it('answers 404 for an unknown user', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const response = await admin.patch('/api/users/00000000-0000-4000-8000-000000000000', {
      active: false,
    });
    expect(response.statusCode).toBe(404);
    expect(code(response.body)).toBe('not_found');
  });
});

describe('role change signs out everywhere', () => {
  it('ends every session of the target, and applies the new role at the next sign-in', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const carl = await create(admin, { email: 'carl@example.com', displayName: 'Carl' });
    const dee = await create(admin, { email: 'dee@example.com', displayName: 'Dee' });
    const laptop = await h.signIn('carl@example.com', PASSWORD);
    const phone = await h.signIn('carl@example.com', PASSWORD);
    const deeClient = await h.signIn('dee@example.com', PASSWORD);

    const promoted = await admin.patch(`/api/users/${carl.id}`, { role: 'admin' });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(userResponseSchema.parse(promoted.json()).user.role).toBe('admin');
    expect(sessionsOf(h, carl.id)).toHaveLength(0);
    expect((await laptop.get('/api/users')).statusCode).toBe(401);
    expect((await phone.get('/api/users')).statusCode).toBe(401);
    // The acting admin and other users keep their sessions; the admin keeps the cookie.
    expect(promoted.headers['set-cookie']).toBeUndefined();
    expect((await admin.get('/api/users')).statusCode).toBe(200);
    expect((await deeClient.get('/api/users')).statusCode).toBe(200);
    expect(sessionsOf(h, dee.id)).toHaveLength(1);

    const again = await h.signIn('carl@example.com', PASSWORD);
    expect(again.user?.role).toBe('admin');
    const demoted = await admin.patch(`/api/users/${carl.id}`, { role: 'contributor' });
    expect(demoted.statusCode).toBe(200);
    expect(sessionsOf(h, carl.id)).toHaveLength(0);
    expect((await again.get('/api/users')).statusCode).toBe(401);
  });

  it('signs you out and clears your cookie when you change your own role', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    await create(admin, { email: 'bea@example.com', displayName: 'Bea', role: 'admin' });
    const adminId = admin.user?.id ?? '';
    const otherTab = await h.signIn(ADMIN.email, ADMIN.password);

    const demoted = await admin.patch(`/api/users/${adminId}`, { role: 'contributor' });
    expect(demoted.statusCode, demoted.body).toBe(200);
    expect(admin.cookie).toBeNull();
    expect(sessionsOf(h, adminId)).toHaveLength(0);
    expect((await otherTab.get('/api/users')).statusCode).toBe(401);
    expect((await h.signIn(ADMIN.email, ADMIN.password)).user?.role).toBe('contributor');
  });

  it('ends nothing for a display-name change, a reactivation, a same-value role or a refusal', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const adminId = admin.user?.id ?? '';
    const carl = await create(admin, { email: 'carl@example.com', displayName: 'Carl' });
    const dee = await create(admin, { email: 'dee@example.com', displayName: 'Dee' });
    expect((await admin.patch(`/api/users/${dee.id}`, { active: false })).statusCode).toBe(200);
    const carlClient = await h.signIn('carl@example.com', PASSWORD);
    const sessionsBefore = h.db.select().from(session).orderBy(asc(session.id)).all();

    const changes: [string, Record<string, unknown>, number][] = [
      [carl.id, { displayName: 'Carl Renamed' }, 200],
      [dee.id, { active: true }, 200],
      [carl.id, { role: 'contributor' }, 200],
      [adminId, { role: 'admin' }, 200],
      [adminId, { displayName: 'Ada Renamed', role: 'admin' }, 200],
      // The last admin can't be demoted, so nothing ends either.
      [adminId, { role: 'contributor' }, 409],
    ];
    for (const [id, body, status] of changes) {
      const response = await admin.patch(`/api/users/${id}`, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(status);
      expect(response.headers['set-cookie'], JSON.stringify(body)).toBeUndefined();
    }
    expect(h.db.select().from(session).orderBy(asc(session.id)).all()).toEqual(sessionsBefore);
    expect((await carlClient.get('/api/users')).statusCode).toBe(200);
    expect((await admin.get('/api/users')).statusCode).toBe(200);
  });
});

describe('audit of user changes', () => {
  it('writes only changed fields, nothing for a no-op, and null before/after on a reset', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const adminId = admin.user?.id ?? '';
    const carl = await create(admin, { email: 'carl@example.com', displayName: 'Carl' });
    const count = () => events(h).length;
    const start = count();

    const noop = await admin.patch(`/api/users/${carl.id}`, {
      displayName: ' Carl ',
      role: 'contributor',
      active: true,
    });
    expect(noop.statusCode).toBe(200);
    expect(userResponseSchema.parse(noop.json()).user.displayName).toBe('Carl');
    expect(count()).toBe(start);
    const unchanged = h.db.select().from(user).where(eq(user.id, carl.id)).get();
    expect(unchanged?.updatedAt).toBe(START.toISOString());

    h.clock.advance(1000);
    const renamed = await admin.patch(`/api/users/${carl.id}`, {
      displayName: 'Carl Carlsen',
      role: 'contributor',
    });
    expect(renamed.statusCode).toBe(200);
    expect(events(h).slice(start)).toEqual([
      {
        action: 'user.updated',
        entityId: carl.id,
        actorUserId: adminId,
        before: { displayName: 'Carl' },
        after: { displayName: 'Carl Carlsen' },
      },
    ]);
    const updated = h.db.select().from(user).where(eq(user.id, carl.id)).get();
    expect(updated?.updatedAt).toBe(h.clock.now().toISOString());

    await admin.patch(`/api/users/${carl.id}`, { role: 'admin', active: false });
    expect(events(h).at(-1)).toMatchObject({
      action: 'user.updated',
      before: { role: 'contributor', active: true },
      after: { role: 'admin', active: false },
    });

    const reset = await admin.patch(`/api/users/${carl.id}`, { password: 'a brand new password' });
    expect(reset.statusCode).toBe(200);
    expect(events(h).at(-1)).toEqual({
      action: 'user.password_reset',
      entityId: carl.id,
      actorUserId: adminId,
      before: null,
      after: null,
    });

    // A rename and a reset in one request write both events.
    const before = count();
    await admin.patch(`/api/users/${carl.id}`, {
      displayName: 'C',
      password: 'yet another password',
    });
    expect(
      events(h)
        .slice(before)
        .map((event) => event.action),
    ).toEqual(['user.updated', 'user.password_reset']);
    expect(JSON.stringify(events(h))).not.toMatch(/password"|hash/i);
  });

  it('rejects an empty patch with 400', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const response = await admin.patch(`/api/users/${admin.user?.id ?? ''}`, {});
    expect(response.statusCode).toBe(400);
  });

  it('rolls the change back with a 500 when the audit insert fails', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const carl = await create(admin, { email: 'carl@example.com', displayName: 'Carl' });
    await h.signIn('carl@example.com', PASSWORD);
    h.handle.sqlite.exec(
      "CREATE TRIGGER audit_fails BEFORE INSERT ON audit_event BEGIN SELECT RAISE(ABORT, 'no'); END",
    );
    const response = await admin.patch(`/api/users/${carl.id}`, { active: false });
    expect(response.statusCode).toBe(500);
    const row = h.db.select().from(user).where(eq(user.id, carl.id)).get();
    expect(row?.active).toBe(true);
    expect(sessionsOf(h, carl.id)).toHaveLength(1);
  });
});

describe('users report two-step status', () => {
  it('the user list and a user answer report mfaEnrolled per user', async () => {
    const h = harness();
    // The harness enrolls the admin it sets up, and anyone it signs in by default.
    const admin = await h.setupAdmin();
    const carl = await create(admin, { email: 'carl@example.com', displayName: 'Carl' });
    const dana = await create(admin, { email: 'dana@example.com', displayName: 'Dana' });
    expect(carl.mfaEnrolled).toBe(false);
    await h.signIn('dana@example.com', PASSWORD, { mfa: 'as_stored' });

    const enrolled = async () => {
      const list = usersResponseSchema.parse((await admin.get('/api/users')).json()).users;
      return Object.fromEntries(list.map((u) => [u.email, u.mfaEnrolled]));
    };
    expect(await enrolled()).toEqual({
      [ADMIN.email]: true,
      'carl@example.com': false,
      'dana@example.com': false,
    });

    await h.signIn('carl@example.com', PASSWORD);
    expect(await enrolled()).toEqual({
      [ADMIN.email]: true,
      'carl@example.com': true,
      'dana@example.com': false,
    });

    // A pending secret alone is not enrolled: only mfa_enrolled_at counts.
    h.db.update(user).set({ mfaSecretEnc: 'v1.a.b.c' }).where(eq(user.id, dana.id)).run();
    const patched = await admin.patch(`/api/users/${dana.id}`, { displayName: 'Dana D' });
    expect(userResponseSchema.parse(patched.json()).user.mfaEnrolled).toBe(false);
    const renamed = await admin.patch(`/api/users/${carl.id}`, { displayName: 'Carl C' });
    expect(userResponseSchema.parse(renamed.json()).user.mfaEnrolled).toBe(true);
  });
});
