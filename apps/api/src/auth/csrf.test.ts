import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { user } from '../../db/schema';
import { errorEnvelopeSchema, mfaEnrollmentResponseSchema } from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';
import { base32Decode } from './mfa/base32';
import { totpAt } from './mfa/totp';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const NEW_USER = {
  email: 'new@example.com',
  displayName: 'New',
  role: 'contributor',
  password: 'a long enough password',
};

function code(body: string): string {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error.code;
}

async function world(): Promise<{ h: Harness; admin: Client; carl: Client }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  await admin.post('/api/users', { ...NEW_USER, email: 'carl@example.com' });
  const carl = await h.signIn('carl@example.com', NEW_USER.password);
  return { h, admin, carl };
}

describe('csrf and check order', () => {
  it('refuses a write with no token, a wrong token or another session’s token', async () => {
    const { h, admin, carl } = await world();
    const otherAdmin = await h.signIn('admin@example.com', 'correct horse battery');
    const adminToken = admin.csrfToken ?? '';
    expect(otherAdmin.csrfToken).not.toBe(adminToken);

    const tries: [string, Record<string, string | null>][] = [
      ['missing', { 'x-csrf-token': null }],
      ['empty', { 'x-csrf-token': '' }],
      ['wrong', { 'x-csrf-token': 'x'.repeat(adminToken.length) }],
      ['short', { 'x-csrf-token': adminToken.slice(1) }],
      ['other session', { 'x-csrf-token': otherAdmin.csrfToken ?? '' }],
      ['other user', { 'x-csrf-token': carl.csrfToken ?? '' }],
    ];
    for (const [label, headers] of tries) {
      const response = await admin.post('/api/users', NEW_USER, { headers });
      expect(response.statusCode, label).toBe(403);
      expect(code(response.body), label).toBe('csrf_failed');
      const patch = await admin.patch(
        `/api/users/${carl.user?.id ?? ''}`,
        { displayName: 'X' },
        {
          headers,
        },
      );
      expect(patch.statusCode, label).toBe(403);
      expect(code(patch.body), label).toBe('csrf_failed');
    }
    // Nothing was created.
    const list = (await admin.get('/api/users')).json<{ users: { email: string }[] }>();
    expect(list.users.map((u) => u.email)).not.toContain(NEW_USER.email);

    // The right token works.
    expect((await admin.post('/api/users', NEW_USER)).statusCode).toBe(201);
  });

  it('needs no token on reads', async () => {
    const { admin } = await world();
    const headers = { 'x-csrf-token': null };
    for (const url of ['/api/session', '/api/users', '/api/audit']) {
      expect((await admin.get(url, { headers })).statusCode, url).toBe(200);
    }
  });

  it('checks session, then csrf, then role, then body, then existence', async () => {
    const { h, admin, carl } = await world();
    const anon = h.client();
    const noCsrf = { 'x-csrf-token': null };

    // No session: 401 whatever else is wrong, even a body the api would refuse to parse.
    const unauth = await anon.post('/api/users', { bad: true });
    expect(unauth.statusCode).toBe(401);
    expect(code(unauth.body)).toBe('unauthenticated');
    const unauthText = await anon.request('POST', '/api/users', {
      body: 'hello',
      headers: { 'content-type': 'text/plain' },
    });
    expect(unauthText.statusCode).toBe(401);
    const unauthGet = await anon.get('/api/audit?limit=0');
    expect(unauthGet.statusCode).toBe(401);

    // Contributor without csrf: csrf comes before the role check.
    const carlNoCsrf = await carl.post('/api/users', { bad: true }, { headers: noCsrf });
    expect(code(carlNoCsrf.body)).toBe('csrf_failed');
    // Contributor with csrf and a bad body: the role check comes before the body.
    const carlBad = await carl.post('/api/users', { bad: true });
    expect(carlBad.statusCode).toBe(403);
    expect(code(carlBad.body)).toBe('forbidden');
    const carlPatch = await carl.patch('/api/users/missing', { bad: true });
    expect(code(carlPatch.body)).toBe('forbidden');

    // Admin with a bad body on a missing user: the body comes before existence.
    const adminBad = await admin.patch('/api/users/missing', { bad: true });
    expect(adminBad.statusCode).toBe(400);
    expect(code(adminBad.body)).toBe('validation_failed');
    const adminMissing = await admin.patch('/api/users/missing', { displayName: 'Ok' });
    expect(adminMissing.statusCode).toBe(404);
    expect(code(adminMissing.body)).toBe('not_found');

    // A wrong media type from a signed-in admin is still a 415.
    const adminText = await admin.request('POST', '/api/users', {
      body: 'hello',
      headers: { 'content-type': 'text/plain' },
    });
    expect(adminText.statusCode).toBe(415);
  });

  it('guard order with lock and password gates', async () => {
    const { h, admin, carl } = await world();
    const noCsrf = { 'x-csrf-token': null };

    // Signed out: 401 before any gate.
    expect(code((await h.client().post('/api/session/lock')).body)).toBe('unauthenticated');

    // Locked without CSRF: the token is checked before the lock.
    expect((await admin.post('/api/session/lock')).statusCode).toBe(204);
    const lockedNoCsrf = await admin.post('/api/users', NEW_USER, { headers: noCsrf });
    expect(lockedNoCsrf.statusCode).toBe(403);
    expect(code(lockedNoCsrf.body)).toBe('csrf_failed');
    const lockedWrite = await admin.post('/api/users', NEW_USER);
    expect(lockedWrite.statusCode).toBe(423);
    expect(code(lockedWrite.body)).toBe('session_locked');

    // Locked and must-change: the lock wins.
    h.db.update(user).set({ mustChangePassword: true }).run();
    expect(code((await admin.get('/api/assessment')).body)).toBe('session_locked');
    expect(code((await admin.post('/api/session/password', {})).body)).toBe('session_locked');

    // Must-change on an admin route as a contributor: the password change comes before the role.
    const carlAdminRoute = await carl.post('/api/users', { bad: true });
    expect(carlAdminRoute.statusCode).toBe(403);
    expect(code(carlAdminRoute.body)).toBe('password_change_required');
    const carlNoCsrf = await carl.post('/api/users', { bad: true }, { headers: noCsrf });
    expect(code(carlNoCsrf.body)).toBe('csrf_failed');
    // On its own routes the body is checked: 400, not a gate.
    const carlBadBody = await carl.post('/api/session/password', { bad: true });
    expect(carlBadBody.statusCode).toBe(400);
    expect(code(carlBadBody.body)).toBe('validation_failed');
    // Public routes are never gated.
    expect((await carl.get('/api/session')).statusCode).toBe(200);
    expect((await h.client().get('/api/health')).statusCode).toBe(200);
  });

  it('guard order with MFA', async () => {
    const { h, admin } = await world();
    const noCsrf = { 'x-csrf-token': null };
    // Pending sessions, as sign-in leaves them: Dana is unenrolled (enroll), the admin enrolled
    // (challenge).
    const dana = { ...NEW_USER, email: 'dana@example.com' };
    expect((await admin.post('/api/users', dana)).statusCode).toBe(201);
    h.db.update(user).set({ mustChangePassword: false }).run();
    const pendingDana = h.client();
    expect(
      (await pendingDana.post('/api/session', { email: dana.email, password: dana.password }))
        .statusCode,
    ).toBe(200);
    const pendingAdmin = h.client();
    const adminSignIn = { email: 'admin@example.com', password: 'correct horse battery' };
    expect((await pendingAdmin.post('/api/session', adminSignIn)).statusCode).toBe(200);

    // Pending without CSRF: the token is checked before the MFA gate.
    for (const c of [pendingDana, pendingAdmin]) {
      const noToken = await c.post('/api/users', NEW_USER, { headers: noCsrf });
      expect(noToken.statusCode).toBe(403);
      expect(code(noToken.body)).toBe('csrf_failed');
      const onMfaRoute = await c.post('/api/session/mfa/enroll', undefined, { headers: noCsrf });
      expect(code(onMfaRoute.body)).toBe('csrf_failed');
    }

    // Pending as a contributor on an admin route: MFA comes before the role.
    const carlAdminRoute = await pendingDana.post('/api/users', { bad: true });
    expect(carlAdminRoute.statusCode).toBe(403);
    expect(code(carlAdminRoute.body)).toBe('mfa_required');
    // On its own routes the body is checked: 400, not a gate.
    const badBody = await pendingAdmin.post('/api/session/mfa/verify', { bad: true });
    expect(badBody.statusCode).toBe(400);
    expect(code(badBody.body)).toBe('validation_failed');

    // Locked and pending: the lock wins, and only lock and unlock answer.
    expect((await pendingAdmin.post('/api/session/lock')).statusCode).toBe(204);
    expect(code((await pendingAdmin.get('/api/assessment')).body)).toBe('session_locked');
    expect(code((await pendingAdmin.post('/api/session/mfa/verify', {})).body)).toBe(
      'session_locked',
    );

    // Pending with a temporary password: MFA first, then the password change.
    h.db.update(user).set({ mustChangePassword: true }).where(eq(user.email, dana.email)).run();
    expect(code((await pendingDana.get('/api/assessment')).body)).toBe('mfa_required');
    expect(code((await pendingDana.post('/api/session/password', {})).body)).toBe('mfa_required');
    const started = await pendingDana.post('/api/session/mfa/enroll');
    expect(started.statusCode, started.body).toBe(200);
    const secret = mfaEnrollmentResponseSchema.parse(started.json()).secret;
    const confirmed = await pendingDana.post('/api/session/mfa/enroll/confirm', {
      code: totpAt(base32Decode(secret), h.clock.now()),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const read = await pendingDana.get('/api/assessment');
    expect(read.statusCode).toBe(403);
    expect(code(read.body)).toBe('password_change_required');
    const changed = await pendingDana.post('/api/session/password', {
      currentPassword: NEW_USER.password,
      newPassword: 'another long enough password',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await pendingDana.get('/api/assessment')).statusCode).toBe(200);

    // Public routes are never gated; the full admin session is untouched.
    expect((await pendingAdmin.get('/api/session')).statusCode).toBe(200);
    expect((await admin.get('/api/users')).statusCode).toBe(200);
  });

  it('leaves health public and unknown routes 404', async () => {
    const { h } = await world();
    const anon = h.client();
    expect((await anon.get('/api/health')).statusCode).toBe(200);
    const unknown = await anon.post('/api/nope', { a: 1 });
    expect(unknown.statusCode).toBe(404);
    expect(code(unknown.body)).toBe('not_found');
  });
});
