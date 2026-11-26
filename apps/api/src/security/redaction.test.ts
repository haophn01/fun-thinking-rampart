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

/** Every value a log line must never hold, gathered as the flows run. */
class Secrets {
  readonly values = new Set<string>([
    ADMIN.password,
    WRONG_PASSWORD,
    USER_PASSWORD,
    RESET_PASSWORD,
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
 * This sprint's flows: setup, sign-in right and wrong, creating a user, resetting their password,
 * a CSRF-checked write, sign-out, and a 500. Returns every secret they used or were handed.
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

  const user = await h.signIn(USER_EMAIL, USER_PASSWORD);
  secrets.client(user);

  const reset = secrets.response(
    await admin.patch(`/api/users/${userId}`, { password: RESET_PASSWORD }),
  );
  expect(reset.statusCode).toBe(200);
  const again = await h.signIn(USER_EMAIL, RESET_PASSWORD);
  secrets.client(again);

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
  req?: { headers?: Record<string, unknown> };
  res?: { headers?: Record<string, unknown> };
}

/** Proof the logs were really written and redaction really ran, so a clean scan means something. */
function expectRedactedTraffic(h: Harness): void {
  const lines = h.logs as Line[];
  const incoming = lines.filter((line) => line.msg === 'incoming request');
  expect(incoming.length).toBeGreaterThanOrEqual(10);
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
