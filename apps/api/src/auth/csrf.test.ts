import { afterEach, describe, expect, it } from 'vitest';
import { errorEnvelopeSchema } from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';

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

  it('leaves health public and unknown routes 404', async () => {
    const { h } = await world();
    const anon = h.client();
    expect((await anon.get('/api/health')).statusCode).toBe(200);
    const unknown = await anon.post('/api/nope', { a: 1 });
    expect(unknown.statusCode).toBe(404);
    expect(code(unknown.body)).toBe('not_found');
  });
});
