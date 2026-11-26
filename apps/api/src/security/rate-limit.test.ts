import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { errorEnvelopeSchema } from '../contract';
import { ADMIN, createHarness, type Harness, type HarnessOptions } from '../testing/harness';
import { AUTH_LIMITED_ROUTES, RATE_LIMITS } from './rate-limit';
import { listRoutes } from './route-table';

const MESSAGE = 'Too many requests. Try again later.';
const SECOND = 1000;

const harnesses: Harness[] = [];

/** A harness with the real limits (multiplier 1) unless `env` says otherwise. */
function harness(options: HarnessOptions = {}): Harness {
  const made = createHarness({
    ...options,
    env: { RATE_LIMIT_MULTIPLIER: '1', ...options.env },
  });
  harnesses.push(made);
  return made;
}

afterEach(async () => {
  for (const made of harnesses.splice(0)) await made.close();
});

interface Send {
  method?: 'GET' | 'POST';
  url: string;
  body?: unknown;
  remoteAddress?: string;
  forwarded?: string;
}

function send(h: Harness, { method = 'GET', url, body, remoteAddress, forwarded }: Send) {
  return h.app.inject({
    method,
    url,
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

/** A sign-in for an account that doesn't exist: 401 when it gets through. */
function signIn(h: Harness, extra: Omit<Send, 'url' | 'method' | 'body'> = {}) {
  return send(h, {
    method: 'POST',
    url: '/api/session',
    body: { email: 'nobody@example.com', password: 'not the password' },
    ...extra,
  });
}

/** Sends `count` requests one after another and returns their status codes. */
async function statuses(
  count: number,
  make: (i: number) => Promise<LightMyRequestResponse>,
): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < count; i += 1) codes.push((await make(i)).statusCode);
  return codes;
}

/** Asserts the response is the rate limiter's 429 and returns its retry-after seconds. */
function expectLimited(response: LightMyRequestResponse): number {
  expect(response.statusCode).toBe(429);
  const envelope = errorEnvelopeSchema.parse(response.json());
  expect(envelope.error.code).toBe('too_many_attempts');
  expect(envelope.error.message).toBe(MESSAGE);
  const details = envelope.error.details as { retryAfterSeconds: number };
  expect(Object.keys(details)).toEqual(['retryAfterSeconds']);
  expect(Number.isInteger(details.retryAfterSeconds)).toBe(true);
  expect(details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  expect(response.headers['retry-after']).toBe(String(details.retryAfterSeconds));
  return details.retryAfterSeconds;
}

describe('sign-in is limited to 10 a minute', () => {
  it('passes 10 sign-ins and refuses the 11th with too_many_attempts and Retry-After', async () => {
    const h = harness();
    await h.setupAdmin();
    const codes = await statuses(10, () =>
      send(h, {
        method: 'POST',
        url: '/api/session',
        body: { email: ADMIN.email, password: ADMIN.password },
      }),
    );
    expect(codes).toEqual(Array.from({ length: 10 }, () => 200));
    const eleventh = await send(h, {
      method: 'POST',
      url: '/api/session',
      body: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(expectLimited(eleventh)).toBe(60);
    expect(eleventh.headers['set-cookie']).toBeUndefined();
  });

  it('a query string does not escape the sign-in bucket', async () => {
    const h = harness();
    expect(await statuses(10, () => signIn(h))).not.toContain(429);
    expectLimited(
      await send(h, {
        method: 'POST',
        url: '/api/session?again=1',
        body: { email: 'nobody@example.com', password: 'not the password' },
      }),
    );
  });

  it('a body the handler would refuse still counts', async () => {
    const h = harness();
    const bad = () => send(h, { method: 'POST', url: '/api/session', body: { email: 1 } });
    expect(await statuses(10, bad)).toEqual(Array.from({ length: 10 }, () => 400));
    expectLimited(await bad());
  });
});

describe('auth routes have their own buckets', () => {
  it('setup has its own bucket, apart from sign-in', async () => {
    const h = harness();
    expect(await statuses(10, () => signIn(h))).not.toContain(429);
    expectLimited(await signIn(h));
    // Setup with a bad body: 400 when it gets through, and nothing is created.
    const setup = () => send(h, { method: 'POST', url: '/api/setup', body: {} });
    expect(await statuses(10, setup)).toEqual(Array.from({ length: 10 }, () => 400));
    expectLimited(await setup());
  });

  it('sign-in requests do not use up the general bucket', async () => {
    const h = harness();
    expect(await statuses(10, () => signIn(h))).not.toContain(429);
    expectLimited(await signIn(h));
    // GET /api/session is the same url with another method: it is general, not sign-in.
    const general = await statuses(RATE_LIMITS.general.max, (i) =>
      send(h, { url: i % 2 === 0 ? '/api/session' : '/api/health' }),
    );
    expect(general).not.toContain(429);
    expectLimited(await send(h, { url: '/api/health' }));
    // And the general bucket being empty doesn't refuse an auth bucket that has room.
    const setup = await send(h, { method: 'POST', url: '/api/setup', body: {} });
    expect(setup.statusCode).toBe(400);
  });
});

describe('general limit counts every request', () => {
  it('passes 600 across guarded, health and unknown routes and refuses the 601st of each', async () => {
    expect(RATE_LIMITS).toEqual({
      general: { max: 600, windowMs: 60_000 },
      auth: { max: 10, windowMs: 60_000 },
    });
    const h = harness();
    const urls = ['/api/assessment', '/api/health', '/api/nope', '/nope'];
    const codes = await statuses(600, (i) => send(h, { url: urls[i % urls.length] ?? '/' }));
    expect(new Set(codes)).toEqual(new Set([401, 200, 404]));
    for (const url of urls) expectLimited(await send(h, { url }));
    // A write to an unknown route with a bad body is refused before it is read.
    const unknownPost = await h.app.inject({
      method: 'POST',
      url: '/api/nope',
      headers: { 'content-type': 'text/plain' },
      payload: 'x',
    });
    expectLimited(unknownPost);
  });
});

describe('window resets on the app clock', () => {
  it('at 59.5 s Retry-After is 1, and at 60 s the key passes again', async () => {
    const h = harness();
    expect(await statuses(10, () => signIn(h))).not.toContain(429);
    expect(expectLimited(await signIn(h))).toBe(60);
    h.clock.advance(59.5 * SECOND);
    expect(expectLimited(await signIn(h))).toBe(1);
    h.clock.advance(0.5 * SECOND);
    expect((await signIn(h)).statusCode).toBe(401);
    // A fresh window: 9 more pass, then the 11th of this window is refused again.
    expect(await statuses(9, () => signIn(h))).not.toContain(429);
    expect(expectLimited(await signIn(h))).toBe(60);
  });

  it('the window starts at the first counted request, not when the limit is hit', async () => {
    const h = harness();
    expect((await signIn(h)).statusCode).toBe(401);
    h.clock.advance(30 * SECOND);
    expect(await statuses(9, () => signIn(h))).not.toContain(429);
    expect(expectLimited(await signIn(h))).toBe(30);
    // Refused requests don't push the window out.
    h.clock.advance(29 * SECOND);
    expect(expectLimited(await signIn(h))).toBe(1);
    h.clock.advance(1 * SECOND);
    expect((await signIn(h)).statusCode).toBe(401);
  });

  it('the general window runs on the app clock too', async () => {
    const h = harness();
    expect(
      await statuses(RATE_LIMITS.general.max, () => send(h, { url: '/api/health' })),
    ).not.toContain(429);
    expectLimited(await send(h, { url: '/api/health' }));
    h.clock.advance(60 * SECOND);
    expect((await send(h, { url: '/api/health' })).statusCode).toBe(200);
  });
});

describe('limit runs before the guard', () => {
  it('a signed-out flood gets 429, not 401, with security headers and x-request-id', async () => {
    const h = harness();
    const codes = await statuses(RATE_LIMITS.general.max, () =>
      send(h, { url: '/api/assessment' }),
    );
    expect(new Set(codes)).toEqual(new Set([401]));
    const limited = await h.app.inject({
      url: '/api/assessment',
      headers: { 'x-request-id': 'flood-601' },
    });
    expectLimited(limited);
    expect(limited.headers['x-request-id']).toBe('flood-601');
    expect(errorEnvelopeSchema.parse(limited.json()).error.requestId).toBe('flood-601');
    expect(limited.headers['content-security-policy']).toContain("default-src 'none'");
    expect(limited.headers['x-content-type-options']).toBe('nosniff');
    expect(limited.headers['x-frame-options']).toBe('DENY');
    expect(limited.headers['content-type']).toMatch(/^application\/json/);
  });
});

describe('keyed per client, through the proxy when hosted', () => {
  it('locally a changing X-Forwarded-For shares one bucket', async () => {
    const h = harness();
    const codes = await statuses(10, (i) => signIn(h, { forwarded: `203.0.113.${String(i)}` }));
    expect(codes).not.toContain(429);
    expectLimited(await signIn(h, { forwarded: '198.51.100.1' }));
    // Another peer address is another client.
    expect((await signIn(h, { remoteAddress: '10.0.0.5' })).statusCode).toBe(401);
  });

  it('hosted, two forwarded clients get separate buckets', async () => {
    const h = harness({ env: { HOSTED: 'true' } });
    const a = { remoteAddress: '127.0.0.1', forwarded: '203.0.113.7' };
    const b = { remoteAddress: '127.0.0.1', forwarded: '203.0.113.8' };
    expect(await statuses(10, () => signIn(h, a))).not.toContain(429);
    expectLimited(await signIn(h, a));
    expect((await signIn(h, b)).statusCode).toBe(401);
    // A forwarded header from a peer that isn't the proxy is ignored: keyed by the peer.
    const c = { remoteAddress: '10.0.0.5' };
    expect(
      await statuses(10, (i) => signIn(h, { ...c, forwarded: `198.51.100.${String(i)}` })),
    ).not.toContain(429);
    expectLimited(await signIn(h, { ...c, forwarded: '198.51.100.99' }));
  });
});

describe('multiplier scales the limits', () => {
  it('a multiplier of 3 allows 30 sign-ins', async () => {
    const h = harness({ env: { RATE_LIMIT_MULTIPLIER: '3' } });
    expect(await statuses(30, () => signIn(h))).not.toContain(429);
    expectLimited(await signIn(h));
  });
});

describe('tight routes are pinned', () => {
  it('is exactly setup and sign-in, and each is a real route', async () => {
    expect(AUTH_LIMITED_ROUTES).toEqual(['POST /api/setup', 'POST /api/session']);
    const h = harness();
    await h.app.ready();
    const routes = new Set(listRoutes(h.app).map((entry) => `${entry.method} ${entry.url}`));
    for (const route of AUTH_LIMITED_ROUTES) expect(routes.has(route), route).toBe(true);
  });
});

describe('lockout is unchanged', () => {
  it('still locks the account at 5 failures, under the limit', async () => {
    const h = harness();
    await h.setupAdmin();
    const wrong = () =>
      send(h, {
        method: 'POST',
        url: '/api/session',
        body: { email: ADMIN.email, password: 'wrong password here' },
      });
    expect(await statuses(5, wrong)).toEqual([401, 401, 401, 401, 401]);
    const locked = await send(h, {
      method: 'POST',
      url: '/api/session',
      body: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(locked.statusCode).toBe(429);
    const envelope = errorEnvelopeSchema.parse(locked.json());
    expect(envelope.error.code).toBe('too_many_attempts');
    // The lockout's own message and 15-minute wait, not the rate limiter's.
    expect(envelope.error.message).toBe('Too many failed sign-ins. Try again later.');
    expect(envelope.error.details).toEqual({ retryAfterSeconds: 15 * 60 });
    expect(locked.headers['retry-after']).toBe(String(15 * 60));
  });
});
