import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_MAX_AGE_SECONDS } from '../auth/sessions';
import { SESSION_COOKIE } from '../contract';
import { ADMIN, createHarness, type Harness, type HarnessOptions } from '../testing/harness';
import { WEB_CSP } from './headers';

const HOSTED_COOKIE = '__Host-rampart_session';
const API_CSP = "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";

const harnesses: Harness[] = [];

function harness(options: HarnessOptions = {}): Harness {
  const made = createHarness(options);
  harnesses.push(made);
  return made;
}

afterEach(async () => {
  for (const made of harnesses.splice(0)) await made.close();
});

interface SetCookie {
  name: string;
  value: string;
  /** Every attribute as sent, keyed by its lower-cased name. */
  attributes: Map<string, string>;
}

/** The response's Set-Cookie lines, parsed as a browser reads them. */
function setCookies(response: LightMyRequestResponse): SetCookie[] {
  const header = response.headers['set-cookie'];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  return lines.map((line) => {
    const [pair = '', ...rest] = line.split(';').map((part) => part.trim());
    const at = pair.indexOf('=');
    const attributes = new Map<string, string>();
    for (const part of rest) {
      const eq = part.indexOf('=');
      const key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
      attributes.set(key, eq === -1 ? '' : part.slice(eq + 1));
    }
    return { name: pair.slice(0, at), value: pair.slice(at + 1), attributes };
  });
}

function onlyCookie(response: LightMyRequestResponse): SetCookie {
  const cookies = setCookies(response);
  expect(cookies).toHaveLength(1);
  const [cookie] = cookies;
  if (cookie === undefined) throw new Error('no Set-Cookie');
  return cookie;
}

function expectCleared(cookie: SetCookie): void {
  expect(cookie.value).toBe('');
  const expires = cookie.attributes.get('expires');
  const maxAge = cookie.attributes.get('max-age');
  expect(maxAge === '0' || (expires !== undefined && Date.parse(expires) === 0)).toBe(true);
}

/** Registers a stand-in route that reports `request.ip`, before the app is ready. */
function addIpRoute(h: Harness): void {
  h.app.get('/test/ip', (request) => ({ ip: request.ip }));
}

describe('local behaviour is unchanged', () => {
  it('/api/health and an unknown route keep the api CSP, nosniff and DENY', async () => {
    const h = harness();
    for (const url of ['/api/health', '/api/nope', '/nope']) {
      const response = await h.app.inject({ url });
      // The CSP splits by path: api paths keep the api CSP, anything else gets the web CSP.
      expect(response.headers['content-security-policy'], url).toBe(
        url.startsWith('/api') ? API_CSP : WEB_CSP,
      );
      expect(response.headers['x-content-type-options'], url).toBe('nosniff');
      expect(response.headers['x-frame-options'], url).toBe('DENY');
      expect(response.headers['x-powered-by'], url).toBeUndefined();
      expect(response.headers['x-request-id'], url).toEqual(expect.any(String));
    }
    expect((await h.app.inject({ url: '/api/health' })).statusCode).toBe(200);
    expect((await h.app.inject({ url: '/api/nope' })).statusCode).toBe(404);
  });

  it('the app is in local mode by default', () => {
    const h = harness();
    expect(h.config.hosted).toBe(false);
    expect(h.config.serveWeb).toBe(false);
  });
});

describe('local cookie is unchanged', () => {
  it('setup sets rampart_session HttpOnly, SameSite=Strict, Path=/, Max-Age and no Secure', async () => {
    const h = harness();
    const response = await h.client().post('/api/setup', ADMIN);
    expect(response.statusCode).toBe(201);
    const cookie = onlyCookie(response);
    expect(cookie.name).toBe(SESSION_COOKIE);
    expect(cookie.value).not.toBe('');
    expect([...cookie.attributes.keys()].sort()).toEqual([
      'httponly',
      'max-age',
      'path',
      'samesite',
    ]);
    expect(cookie.attributes.get('max-age')).toBe(String(SESSION_MAX_AGE_SECONDS));
    expect(cookie.attributes.get('path')).toBe('/');
    expect(cookie.attributes.get('samesite')).toBe('Strict');
  });

  it('sign-out clears rampart_session without Secure', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const response = await admin.delete('/api/session');
    expect(response.statusCode).toBe(204);
    const cookie = onlyCookie(response);
    expect(cookie.name).toBe(SESSION_COOKIE);
    expectCleared(cookie);
    expect(cookie.attributes.has('secure')).toBe(false);
    expect(cookie.attributes.get('path')).toBe('/');
  });

  it('a __Host- cookie is not read locally', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const token = admin.cookie ?? '';
    const ownName = await h.app.inject({
      url: '/api/users',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(ownName.statusCode).toBe(200);
    const otherName = await h.app.inject({
      url: '/api/users',
      headers: { cookie: `${HOSTED_COOKIE}=${token}` },
    });
    expect(otherName.statusCode).toBe(401);
  });
});

describe('hosted cookie is __Host- and Secure', () => {
  const hosted: HarnessOptions = { env: { HOSTED: 'true' } };

  function expectHostedAttributes(cookie: SetCookie): void {
    expect(cookie.name).toBe(HOSTED_COOKIE);
    expect(cookie.attributes.has('httponly')).toBe(true);
    expect(cookie.attributes.has('secure')).toBe(true);
    expect(cookie.attributes.get('samesite')).toBe('Strict');
    expect(cookie.attributes.get('path')).toBe('/');
    expect(cookie.attributes.has('domain')).toBe(false);
  }

  it('setup sets __Host-rampart_session with HttpOnly; Secure; SameSite=Strict; Path=/', async () => {
    const h = harness(hosted);
    const response = await h.client().post('/api/setup', ADMIN);
    expect(response.statusCode).toBe(201);
    const cookie = onlyCookie(response);
    expectHostedAttributes(cookie);
    expect(cookie.value).not.toBe('');
    expect(cookie.attributes.get('max-age')).toBe(String(SESSION_MAX_AGE_SECONDS));
  });

  it('sign-in sets the same cookie', async () => {
    const h = harness(hosted);
    await h.setupAdmin();
    const response = await h.client().post('/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    expect(response.statusCode).toBe(200);
    expectHostedAttributes(onlyCookie(response));
  });

  it('sign-out clears it with the same attributes', async () => {
    const h = harness(hosted);
    const admin = await h.setupAdmin();
    const response = await admin.delete('/api/session');
    expect(response.statusCode).toBe(204);
    const cookie = onlyCookie(response);
    expectHostedAttributes(cookie);
    expectCleared(cookie);
  });

  it('a self-reset of the password clears it with the same attributes', async () => {
    const h = harness(hosted);
    const admin = await h.setupAdmin();
    const id = admin.user?.id ?? '';
    const response = await admin.patch(`/api/users/${id}`, { password: 'a brand new passphrase' });
    expect(response.statusCode).toBe(200);
    const cookie = onlyCookie(response);
    expectHostedAttributes(cookie);
    expectCleared(cookie);
    expect(admin.cookie).toBeNull();
  });
});

describe('hosted mode reads only its own cookie name', () => {
  it('a rampart_session cookie is ignored and gives 401', async () => {
    const h = harness({ env: { HOSTED: 'true' } });
    const admin = await h.setupAdmin();
    const token = admin.cookie ?? '';
    expect(token).not.toBe('');
    const ownName = await h.app.inject({
      url: '/api/users',
      headers: { cookie: `${HOSTED_COOKIE}=${token}` },
    });
    expect(ownName.statusCode).toBe(200);
    const localName = await h.app.inject({
      url: '/api/users',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(localName.statusCode).toBe(401);
    const session = await h.app.inject({
      url: '/api/session',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect((JSON.parse(session.body) as { user: unknown }).user).toBeNull();
  });
});

describe('trustProxy only for the local proxy when hosted', () => {
  async function ipOf(h: Harness, remoteAddress: string, forwarded?: string): Promise<string> {
    const response = await h.app.inject({
      url: '/test/ip',
      remoteAddress,
      headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    });
    expect(response.statusCode).toBe(200);
    return (JSON.parse(response.body) as { ip: string }).ip;
  }

  it('locally X-Forwarded-For never changes request.ip', async () => {
    const h = harness();
    addIpRoute(h);
    expect(await ipOf(h, '127.0.0.1', '203.0.113.7')).toBe('127.0.0.1');
    expect(await ipOf(h, '10.0.0.5', '203.0.113.7')).toBe('10.0.0.5');
    expect(await ipOf(h, '127.0.0.1')).toBe('127.0.0.1');
  });

  it('hosted, it is honoured from 127.0.0.1 and not from 10.0.0.5', async () => {
    const h = harness({ env: { HOSTED: 'true' } });
    addIpRoute(h);
    expect(await ipOf(h, '127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(await ipOf(h, '10.0.0.5', '203.0.113.7')).toBe('10.0.0.5');
    expect(await ipOf(h, '127.0.0.1')).toBe('127.0.0.1');
  });

  it('hosted, a client-sent X-Forwarded-For cannot hide the address the proxy saw', async () => {
    const h = harness({ env: { HOSTED: 'true' } });
    addIpRoute(h);
    // The proxy appends the peer it saw, so only the last hop is the proxy's word.
    expect(await ipOf(h, '127.0.0.1', '198.51.100.9, 203.0.113.7')).toBe('203.0.113.7');
  });
});
