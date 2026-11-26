import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../testing/harness';
import { listRoutes, type RouteEntry } from './route-table';

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const made of harnesses.splice(0)) await made.close();
});

/** A ready harness app; `routes` adds test-only routes on the root before it is ready. */
async function routesOf(routes: (h: Harness) => void = () => undefined): Promise<RouteEntry[]> {
  const h = createHarness();
  harnesses.push(h);
  routes(h);
  await h.app.ready();
  return listRoutes(h.app);
}

function find(entries: RouteEntry[], method: string, url: string): RouteEntry | undefined {
  return entries.find((entry) => entry.method === method && entry.url === url);
}

const key = (entry: RouteEntry) => `${entry.method} ${entry.url}`;

describe('lists every route with its guard flags', () => {
  it('health is unguarded and public', async () => {
    const entries = await routesOf();
    expect(find(entries, 'GET', '/api/health')).toEqual({
      method: 'GET',
      url: '/api/health',
      guarded: false,
      public: true,
      skipCsrf: false,
      role: null,
    });
  });

  it('the auth routes are guarded, with their own flags', async () => {
    const entries = await routesOf();
    const flags = (method: string, url: string) => {
      const entry = find(entries, method, url);
      expect(entry, `${method} ${url}`).toBeDefined();
      return entry && { guarded: entry.guarded, public: entry.public, skipCsrf: entry.skipCsrf };
    };
    expect(flags('GET', '/api/session')).toEqual({ guarded: true, public: true, skipCsrf: false });
    expect(flags('POST', '/api/setup')).toEqual({ guarded: true, public: true, skipCsrf: true });
    expect(flags('POST', '/api/session')).toEqual({ guarded: true, public: true, skipCsrf: true });
    expect(flags('DELETE', '/api/session')).toEqual({
      guarded: true,
      public: true,
      skipCsrf: false,
    });
  });

  it('roles come from the route config', async () => {
    const entries = await routesOf();
    expect(find(entries, 'POST', '/api/users')).toMatchObject({
      guarded: true,
      public: false,
      skipCsrf: false,
      role: 'admin',
    });
    expect(find(entries, 'GET', '/api/users')).toMatchObject({
      guarded: true,
      public: false,
      role: null,
    });
  });

  it('routes in a child plugin inside the guarded plugin are guarded too', async () => {
    const entries = await routesOf();
    // Evidence and policies register their routes in a child scope of their own.
    for (const url of ['/api/evidence', '/api/policies']) {
      expect(find(entries, 'POST', url), url).toMatchObject({ guarded: true, public: false });
    }
    expect(find(entries, 'POST', '/api/evidence/:id/versions')).toMatchObject({ guarded: true });
  });

  it('lists no automatic HEAD route, one entry per method, sorted by url then method', async () => {
    const entries = await routesOf();
    expect(entries.length).toBeGreaterThan(40);
    expect(entries.filter((entry) => entry.method === 'HEAD')).toEqual([]);
    const keys = entries.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    const sorted = [...entries].sort((a, b) =>
      a.url === b.url ? (a.method < b.method ? -1 : 1) : a.url < b.url ? -1 : 1,
    );
    expect(keys).toEqual(sorted.map(key));
  });

  it('a route with several methods gets one entry each; an explicit HEAD is kept', async () => {
    const entries = await routesOf((h) => {
      h.app.route({ method: ['GET', 'POST'], url: '/test/multi', handler: () => ({}) });
      h.app.head('/test/head-only', (_request, reply) => reply.send());
      h.app.get('/test/plain', () => ({}));
    });
    expect(find(entries, 'GET', '/test/multi')).toMatchObject({ guarded: false, public: true });
    expect(find(entries, 'POST', '/test/multi')).toMatchObject({ guarded: false, public: true });
    expect(find(entries, 'HEAD', '/test/head-only')).toMatchObject({ guarded: false });
    expect(find(entries, 'GET', '/test/plain')).toBeDefined();
    expect(find(entries, 'HEAD', '/test/plain')).toBeUndefined();
    expect(find(entries, 'HEAD', '/test/multi')).toBeUndefined();
  });

  it('each app has its own table', async () => {
    const first = await routesOf((h) => h.app.get('/test/only-first', () => ({})));
    const second = await routesOf();
    expect(find(first, 'GET', '/test/only-first')).toBeDefined();
    expect(find(second, 'GET', '/test/only-first')).toBeUndefined();
  });

  it('an app built without the table is refused, not listed as empty', async () => {
    const bare = Fastify();
    bare.get('/x', () => ({}));
    await bare.ready();
    expect(() => listRoutes(bare)).toThrow(/route table/);
    await bare.close();
  });
});
