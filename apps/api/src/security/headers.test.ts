import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type HarnessOptions } from '../testing/harness';

const WEB_CSP =
  "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; " +
  "form-action 'self'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; " +
  "script-src 'self'; script-src-attr 'none'; style-src 'self'";
const HOSTED_WEB_CSP = `${WEB_CSP}; upgrade-insecure-requests`;
// Byte for byte what the api sent before this slice (helmet's join), so other pins still hold.
const API_CSP = "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";
const PERMISSIONS_POLICY = 'camera=(), geolocation=(), microphone=(), payment=(), usb=()';
const HSTS = 'max-age=31536000; includeSubDomains';

const harnesses: Harness[] = [];

/** A harness with stand-in web routes (P1 serves the real ones) and a route that throws. */
function harness(options: HarnessOptions = {}): Harness {
  const made = createHarness({ logLevel: 'silent', ...options });
  harnesses.push(made);
  for (const url of ['/', '/assessment', '/apix', '/apix/page']) {
    made.app.get(url, (_request, reply) =>
      reply.type('text/html; charset=utf-8').send('<!doctype html><title>stand-in</title>'),
    );
  }
  made.app.get('/api/test/boom', () => {
    throw new Error('boom');
  });
  made.app.get('/test/boom', () => {
    throw new Error('boom');
  });
  return made;
}

afterEach(async () => {
  for (const made of harnesses.splice(0)) await made.close();
});

function csp(response: LightMyRequestResponse): unknown {
  return response.headers['content-security-policy'];
}

describe('security headers', () => {
  it('web paths get the strict web CSP', async () => {
    const { app } = harness();
    for (const url of ['/', '/assessment', '/assessment?family=AC&req=AC.L2-3.1.20', '/nope']) {
      const response = await app.inject({ url });
      expect(csp(response), url).toBe(WEB_CSP);
      const value = String(csp(response));
      expect(value, url).not.toContain('unsafe-inline');
      expect(value, url).not.toContain('unsafe-eval');
      expect(value, url).not.toContain('data:');
      expect(value, url).not.toContain('nonce-');
    }
    // A web 500 keeps the web CSP too.
    const boom = await app.inject({ url: '/test/boom' });
    expect(boom.statusCode).toBe(500);
    expect(csp(boom)).toBe(WEB_CSP);
  });

  it('the CSP is chosen by path at its edges', async () => {
    const { app } = harness();
    const apiPaths = [
      '/api',
      '/api/',
      '/api/health',
      '/api/health?x=1',
      '/api?next=/assessment',
      '/api/nope',
      '/api/test/boom',
    ];
    for (const url of apiPaths) {
      expect(csp(await app.inject({ url })), url).toBe(API_CSP);
    }
    const webPaths = ['/apix', '/apix/page', '/apix?x=/api/health', '/?/api', '/assessment?/api/'];
    for (const url of webPaths) {
      expect(csp(await app.inject({ url })), url).toBe(WEB_CSP);
    }
    // The same path asked twice keeps its choice (no state leaks between requests).
    expect(csp(await app.inject({ url: '/' }))).toBe(WEB_CSP);
    expect(csp(await app.inject({ url: '/api/health' }))).toBe(API_CSP);
    expect(csp(await app.inject({ url: '/' }))).toBe(WEB_CSP);
  });

  it('common headers on every response', async () => {
    const { app } = harness();
    const cases: { name: string; status: number; request: InjectOptions }[] = [
      { name: 'api 200', status: 200, request: { url: '/api/health' } },
      { name: 'web 200', status: 200, request: { url: '/assessment' } },
      { name: 'api 404', status: 404, request: { url: '/api/nope' } },
      { name: 'web 404', status: 404, request: { url: '/nope.js' } },
      {
        name: '415',
        status: 415,
        request: {
          method: 'POST',
          url: '/api/session',
          headers: { 'content-type': 'text/plain' },
          payload: 'hello',
        },
      },
      { name: 'api 500', status: 500, request: { url: '/api/test/boom' } },
      { name: 'web 500', status: 500, request: { url: '/test/boom' } },
    ];
    for (const { name, status, request } of cases) {
      const response = await app.inject(request);
      expect(response.statusCode, name).toBe(status);
      expect(response.headers['x-content-type-options'], name).toBe('nosniff');
      expect(response.headers['x-frame-options'], name).toBe('DENY');
      expect(response.headers['referrer-policy'], name).toBe('no-referrer');
      expect(response.headers['permissions-policy'], name).toBe(PERMISSIONS_POLICY);
      expect(response.headers['cross-origin-opener-policy'], name).toBe('same-origin');
      expect(response.headers['cross-origin-resource-policy'], name).toBe('same-origin');
      expect(response.headers['x-powered-by'], name).toBeUndefined();
      expect(typeof csp(response), name).toBe('string');
    }
  });

  it('HSTS and upgrade only when hosted', async () => {
    const local = harness();
    for (const url of ['/', '/api/health', '/api/nope']) {
      const response = await local.app.inject({ url });
      expect(response.headers['strict-transport-security'], url).toBeUndefined();
    }
    expect(String(csp(await local.app.inject({ url: '/' })))).not.toContain(
      'upgrade-insecure-requests',
    );

    const hosted = harness({ env: { HOSTED: 'true' } });
    for (const url of ['/', '/assessment', '/api/health', '/api/nope', '/api/test/boom']) {
      const response = await hosted.app.inject({ url });
      expect(response.headers['strict-transport-security'], url).toBe(HSTS);
      expect(response.headers['permissions-policy'], url).toBe(PERMISSIONS_POLICY);
    }
    expect(csp(await hosted.app.inject({ url: '/' }))).toBe(HOSTED_WEB_CSP);
    expect(csp(await hosted.app.inject({ url: '/apix' }))).toBe(HOSTED_WEB_CSP);
    // The api CSP is the same hosted: it loads nothing, so there is nothing to upgrade.
    expect(csp(await hosted.app.inject({ url: '/api/health' }))).toBe(API_CSP);
  });
});
