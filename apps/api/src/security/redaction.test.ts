import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionCookieName } from '../auth/cookie';
import {
  ADMIN,
  createHarness,
  type Client,
  type Harness,
  type HarnessOptions,
} from '../testing/harness';
import { MIN_SECRET_LENGTH, expectNoSecrets } from '../testing/redaction';

const harnesses: Harness[] = [];

function harness(options: HarnessOptions): Harness {
  const made = createHarness(options);
  harnesses.push(made);
  return made;
}

afterEach(async () => {
  for (const made of harnesses.splice(0)) await made.close();
});

const WRONG_PASSWORD = 'not the right password';
const USER_EMAIL = 'casey@example.com';
const USER_PASSWORD = 'contributor first password';
const RESET_PASSWORD = 'contributor reset password';
/** On the bundled blocklist, so the change refuses it. */
const TOO_COMMON_PASSWORD = 'QwertyUiop12';
const CHANGED_PASSWORD = 'contributor chosen password';
const NOTICE = 'Authorised use only. Use of this system is monitored and recorded.';

/** The routes of sec-auth's flows, each of which must show in the logs it scans. */
const NEW_FLOW_ROUTES = [
  'POST /api/session/password',
  'POST /api/session/lock',
  'POST /api/session/unlock',
  'PUT /api/settings/sign-in-notice',
];

/** Every value a log line must never hold, gathered as the flows run. */
class Secrets {
  readonly values = new Set<string>([
    ADMIN.password,
    WRONG_PASSWORD,
    USER_PASSWORD,
    RESET_PASSWORD,
    TOO_COMMON_PASSWORD,
    CHANGED_PASSWORD,
  ]);

  /** Keeps the client's session token and CSRF token as they are now. */
  client(c: Client): void {
    if (c.cookie !== null) this.values.add(c.cookie);
    if (c.csrfToken !== null) this.values.add(c.csrfToken);
  }

  /** Keeps every Set-Cookie line and the value it sets. */
  response(response: LightMyRequestResponse): LightMyRequestResponse {
    const header = response.headers['set-cookie'];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    for (const line of lines) {
      this.values.add(line);
      const value = /^[^=]+=([^;]*)/.exec(line)?.[1] ?? '';
      if (value !== '') this.values.add(value);
    }
    return response;
  }
}

/**
 * The auth flows: setup, sign-in right and wrong, creating a user with a temporary password,
 * their forced change (refused as too common, refused as reused, then done), resetting their
 * password, lock and unlock (wrong, then right), setting the sign-in notice and an acknowledged
 * sign-in, a CSRF-checked write, sign-out, and a 500. Returns every secret they used or were
 * handed.
 */
async function runFlows(h: Harness): Promise<string[]> {
  const secrets = new Secrets();
  const cookieName = sessionCookieName(h.config);

  const setup = h.client();
  const made = secrets.response(await setup.post('/api/setup', ADMIN));
  expect(made.statusCode).toBe(201);
  expect(setup.cookie).not.toBeNull();
  secrets.client(setup);

  const wrong = h.client();
  const refused = secrets.response(
    await wrong.post('/api/session', { email: ADMIN.email, password: WRONG_PASSWORD }),
  );
  expect(refused.statusCode).toBe(401);

  const admin = h.client();
  const signedIn = secrets.response(
    await admin.post('/api/session', { email: ADMIN.email, password: ADMIN.password }),
  );
  expect(signedIn.statusCode).toBe(200);
  expect(admin.cookie).not.toBeNull();
  expect(admin.csrfToken).not.toBeNull();
  expect(signedIn.cookies.map((c) => c.name)).toEqual([cookieName]);
  secrets.client(admin);

  const created = secrets.response(
    await admin.post('/api/users', {
      email: USER_EMAIL,
      displayName: 'Casey Contributor',
      role: 'contributor',
      password: USER_PASSWORD,
    }),
  );
  expect(created.statusCode).toBe(201);
  const userId = created.json<{ user: { id: string } }>().user.id;

  // The admin-set password is temporary: the user must change it before anything else.
  const user = await h.signIn(USER_EMAIL, USER_PASSWORD, { temporary: true });
  secrets.client(user);
  expect(user.user).not.toBeNull();
  const gated = secrets.response(await user.get('/api/assessment'));
  expect(gated.statusCode).toBe(403);
  expect(gated.json<{ error: { code: string } }>().error.code).toBe('password_change_required');
  const common = secrets.response(
    await user.post('/api/session/password', {
      currentPassword: USER_PASSWORD,
      newPassword: TOO_COMMON_PASSWORD,
    }),
  );
  expect(common.statusCode).toBe(400);
  expect(common.json<{ error: { code: string } }>().error.code).toBe('password_too_common');
  const reused = secrets.response(
    await user.post('/api/session/password', {
      currentPassword: USER_PASSWORD,
      newPassword: USER_PASSWORD,
    }),
  );
  expect(reused.statusCode).toBe(400);
  expect(reused.json<{ error: { code: string } }>().error.code).toBe('password_reused');
  const changed = secrets.response(
    await user.post('/api/session/password', {
      currentPassword: USER_PASSWORD,
      newPassword: CHANGED_PASSWORD,
    }),
  );
  expect(changed.statusCode).toBe(200);
  expect(changed.json<{ mustChangePassword: boolean }>().mustChangePassword).toBe(false);
  // The change rotates the session: keep the new token and CSRF token too.
  secrets.client(user);

  // A reset sets a new temporary password and ends the user's sessions.
  const reset = secrets.response(
    await admin.patch(`/api/users/${userId}`, { password: RESET_PASSWORD }),
  );
  expect(reset.statusCode).toBe(200);
  const again = await h.signIn(USER_EMAIL, RESET_PASSWORD);
  secrets.client(again);

  // Lock, a wrong unlock, then the right one.
  const locked = secrets.response(await again.post('/api/session/lock'));
  expect(locked.statusCode).toBe(204);
  const wrongUnlock = secrets.response(
    await again.post('/api/session/unlock', { password: WRONG_PASSWORD }),
  );
  expect(wrongUnlock.statusCode).toBe(401);
  const unlocked = secrets.response(
    await again.post('/api/session/unlock', { password: RESET_PASSWORD }),
  );
  expect(unlocked.statusCode).toBe(200);
  expect(unlocked.json<{ locked: boolean }>().locked).toBe(false);

  // The admin sets a sign-in notice; the next sign-in acknowledges it by its digest.
  const notice = secrets.response(
    await admin.put('/api/settings/sign-in-notice', { text: NOTICE }),
  );
  expect(notice.statusCode).toBe(200);
  const digest = notice.json<{ signInNotice: { digest: string } }>().signInNotice.digest;
  const acknowledging = h.client();
  const acknowledged = secrets.response(
    await acknowledging.post('/api/session', {
      email: USER_EMAIL,
      password: RESET_PASSWORD,
      noticeDigest: digest,
    }),
  );
  expect(acknowledged.statusCode).toBe(200);
  secrets.client(acknowledging);

  // A write that passes the CSRF check, and one sent with no token, which it refuses.
  const write = secrets.response(await admin.patch('/api/assessment', { type: 'c3pao' }));
  expect(write.statusCode).toBe(200);
  const forged = secrets.response(
    await admin.patch('/api/assessment', { type: 'self' }, { headers: { 'x-csrf-token': null } }),
  );
  expect(forged.statusCode).toBe(403);

  const signedOut = secrets.response(await again.delete('/api/session'));
  expect(signedOut.statusCode).toBeLessThan(300);

  // A 500: the database goes away under a signed-in request.
  h.handle.sqlite.close();
  const failed = secrets.response(await admin.get('/api/users'));
  expect(failed.statusCode).toBe(500);

  return [...secrets.values];
}

interface Line {
  msg?: string;
  level?: number;
  req?: { method?: string; url?: string; headers?: Record<string, unknown> };
  res?: { headers?: Record<string, unknown> };
}

/** Proof the logs were really written and redaction really ran, so a clean scan means something. */
function expectRedactedTraffic(h: Harness): void {
  const lines = h.logs as Line[];
  const incoming = lines.filter((line) => line.msg === 'incoming request');
  expect(incoming.length).toBeGreaterThanOrEqual(10);
  // This sprint's routes were all logged: change password, lock, unlock and the notice.
  const routes = new Set(
    incoming.map((line) => `${line.req?.method ?? ''} ${line.req?.url ?? ''}`),
  );
  for (const route of NEW_FLOW_ROUTES) expect(routes, route).toContain(route);
  const withCookie = incoming.filter((line) => line.req?.headers?.cookie !== undefined);
  expect(withCookie.length).toBeGreaterThan(0);
  for (const line of withCookie) expect(line.req?.headers?.cookie).toBe('[Redacted]');
  const withCsrf = incoming.filter((line) => line.req?.headers?.['x-csrf-token'] !== undefined);
  expect(withCsrf.length).toBeGreaterThan(0);
  for (const line of withCsrf) expect(line.req?.headers?.['x-csrf-token']).toBe('[Redacted]');
  const setting = lines.filter((line) => line.res?.headers?.['set-cookie'] !== undefined);
  expect(setting.length).toBeGreaterThan(0);
  for (const line of setting) expect(line.res?.headers?.['set-cookie']).toBe('[Redacted]');
  // The 500 was logged with its error.
  expect(lines.some((line) => line.level === 50 && line.msg === 'request failed')).toBe(true);
}

describe('log redaction', () => {
  it('no secret reaches the logs in local mode', async () => {
    const h = harness({ logLevel: 'trace' });
    expect(h.config.hosted).toBe(false);
    expect(h.config.logLevel).toBe('trace');

    const secrets = await runFlows(h);
    expect(secrets.length).toBeGreaterThanOrEqual(10);
    expectRedactedTraffic(h);
    expectNoSecrets(h.logs, secrets);
  });

  it('no secret reaches the logs in hosted mode', async () => {
    // `info` is the most a hosted api logs: the startup check refuses `debug` and `trace`.
    const h = harness({ env: { HOSTED: 'true', LOG_LEVEL: 'info' } });
    expect(h.config.hosted).toBe(true);
    expect(h.config.logLevel).toBe('info');
    expect(sessionCookieName(h.config)).toBe('__Host-rampart_session');

    const secrets = await runFlows(h);
    expect(secrets.length).toBeGreaterThanOrEqual(10);
    expectRedactedTraffic(h);
    expectNoSecrets(h.logs, secrets);
  });

  it('a rejected request logs its error code, not hidden by the code redaction', async () => {
    const h = harness({ logLevel: 'info' });
    await h.app.ready();
    const res = await h.app.inject({ method: 'GET', url: '/api/assessment' });
    expect(res.statusCode).toBe(401);
    const rejected = h.logs.filter((line) => line.msg === 'request rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.at(-1)?.errorCode).toBe('unauthenticated');
  });

  it('expectNoSecrets catches and guards', () => {
    const secret = 'planted-session-token';
    const logs = [
      { msg: 'incoming request' },
      { msg: 'request completed', res: { headers: { 'set-cookie': `s=${secret}` } } },
    ];

    expect(() => {
      expectNoSecrets(logs, ['some-other-secret', secret]);
    }).toThrow(/log line 2/);
    // The failure names the line without printing the secret again.
    let message = '';
    try {
      expectNoSecrets(logs, [secret]);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('request completed');
    expect(message).not.toContain(secret);

    // Clean lines pass, including a value that only comes close.
    expect(() => {
      expectNoSecrets(logs, ['planted-session-tokem', 'another-secret']);
    }).not.toThrow();
    expect(() => {
      expectNoSecrets([], [secret]);
    }).not.toThrow();

    // A short secret would match by chance, so it is refused even when the logs are empty.
    expect(MIN_SECRET_LENGTH).toBe(8);
    expect(() => {
      expectNoSecrets([], ['x'.repeat(MIN_SECRET_LENGTH - 1)]);
    }).toThrow(/at least 8 characters/);
    expect(() => {
      expectNoSecrets([], ['x'.repeat(MIN_SECRET_LENGTH)]);
    }).not.toThrow();
  });
});
