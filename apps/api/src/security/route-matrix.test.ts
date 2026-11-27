import { getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { createHarness, type Client, type Harness } from '../testing/harness';
import { listRoutes, type RouteEntry } from './route-table';
import {
  CSRF_EXEMPT,
  ROUTE_MATRIX,
  UNGUARDED_API_ROUTES,
  matrixMismatches,
  routeKey,
  seedOtherAssessment,
  urlMatchesPattern,
  type MatrixEntry,
  type SeedContext,
} from './route-matrix';

const WRITES: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CONTRIBUTOR = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'contributor password',
} as const;

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const made of harnesses.splice(0)) await made.close();
});

function harness(): Harness {
  const h = createHarness();
  harnesses.push(h);
  return h;
}

/** The `/api` routes of a ready harness app. */
async function apiRoutes(h: Harness): Promise<RouteEntry[]> {
  await h.app.ready();
  return listRoutes(h.app).filter((route) => route.url === '/api' || route.url.startsWith('/api/'));
}

/** The route's matrix entry; fails the test, naming the route, when there is none. */
function entryOf(route: RouteEntry): MatrixEntry {
  const key = routeKey(route);
  const entry = ROUTE_MATRIX[key];
  expect(entry, `no matrix entry for ${key}`).toBeDefined();
  if (entry === undefined) throw new Error(`no matrix entry for ${key}`);
  return entry;
}

/** Sends the entry's sample request (or `url` in its place) as `client`. */
function send(
  client: Client,
  route: RouteEntry,
  entry: MatrixEntry,
  headers: Record<string, string | null> = {},
  url: string = entry.sample.url,
): Promise<LightMyRequestResponse> {
  const method = route.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  const { upload, body } = entry.sample;
  if (upload !== undefined) return client.upload(url, upload.bytes, upload.fileName, { headers });
  return client.request(method, url, { ...(body === undefined ? {} : { body }), headers });
}

function codeOf(response: LightMyRequestResponse): string | undefined {
  try {
    return (JSON.parse(response.body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

/** `status code` of a response, so a mismatch names both. */
const outcome = (response: LightMyRequestResponse) =>
  `${String(response.statusCode)} ${codeOf(response) ?? '-'}`;

/** Every row of every table, the session table aside (its rows track sign-ins, not data). */
function snapshot(h: Harness): Record<string, unknown[]> {
  const rows: Record<string, unknown[]> = {};
  for (const table of Object.values(schema)) {
    if (!is(table, SQLiteTable) || table === schema.session) continue;
    rows[getTableName(table)] = h.db.select().from(table).all();
  }
  return rows;
}

async function signedInContributor(h: Harness, admin: Client): Promise<Client> {
  const created = await admin.post('/api/users', CONTRIBUTOR);
  expect(created.statusCode, created.body).toBe(201);
  return h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
}

/** A second assessment, created after the active one, and the context its seeders write in. */
function otherAssessment(h: Harness, admin: Client): SeedContext {
  const userId = admin.user?.id;
  if (userId === undefined) throw new Error('the admin client has no user');
  return seedOtherAssessment(h.db, userId);
}

describe('the matrix covers every api route', () => {
  it('every api route has exactly one matrix entry', async () => {
    const routes = await apiRoutes(harness());
    expect(Object.keys(ROUTE_MATRIX).sort()).toEqual(routes.map(routeKey).sort());
    // sec-mfa: the three session MFA routes and the admin reset.
    expect(ROUTE_MATRIX).toMatchObject({
      'POST /api/session/mfa/enroll': { access: 'session' },
      'POST /api/session/mfa/enroll/confirm': { access: 'session' },
      'POST /api/session/mfa/verify': { access: 'session' },
      'POST /api/users/:id/mfa/reset': { access: 'admin' },
    });
    expect(matrixMismatches(routes, ROUTE_MATRIX)).toEqual({ missing: [], extra: [] });
  });

  it('a route added without an entry, or an entry without its route, is named', async () => {
    const h = harness();
    h.app.get('/api/zz-unlisted', () => ({}));
    const routes = await apiRoutes(h);
    const withoutHealth = routes.filter((route) => routeKey(route) !== 'GET /api/health');
    expect(matrixMismatches(withoutHealth, ROUTE_MATRIX)).toEqual({
      missing: ['GET /api/zz-unlisted'],
      extra: ['GET /api/health'],
    });
  });

  it('declared access matches the guard', async () => {
    const routes = await apiRoutes(harness());
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const key = routeKey(route);
      const entry = entryOf(route);
      const expected = route.public ? 'public' : (route.role ?? 'session');
      expect(entry.access, key).toBe(expected);
      expect(!route.guarded, `${key} unguarded`).toBe(UNGUARDED_API_ROUTES.includes(key));
      expect(route.skipCsrf, `${key} skips CSRF`).toBe(CSRF_EXEMPT.includes(key));
      expect(urlMatchesPattern(entry.sample.url, route.url), `${key} sample url`).toBe(true);
    }
    expect([...UNGUARDED_API_ROUTES]).toEqual(['GET /api/health']);
    expect([...CSRF_EXEMPT]).toEqual(['POST /api/setup', 'POST /api/session']);
  });

  it('a sample url only matches its own pattern', () => {
    expect(urlMatchesPattern('/api/poam/abc', '/api/poam/:id')).toBe(true);
    expect(urlMatchesPattern('/api/poam/abc/closeout', '/api/poam/:id')).toBe(false);
    expect(urlMatchesPattern('/api/poam', '/api/poam/:id')).toBe(false);
    expect(urlMatchesPattern('/api/poam/', '/api/poam/:id')).toBe(false);
    expect(urlMatchesPattern('/api/poam/a?x=1', '/api/poam/:id')).toBe(true);
    expect(urlMatchesPattern('/api/poamx', '/api/poam')).toBe(false);
  });
});

describe('every api route refuses the wrong caller', () => {
  it('401 when signed out', async () => {
    const h = harness();
    const routes = await apiRoutes(h);
    await h.setupAdmin();
    const guarded = routes.filter((route) => !route.public);
    expect(guarded.length).toBeGreaterThan(0);
    for (const route of guarded) {
      const entry = entryOf(route);
      expect(entry.access, routeKey(route)).not.toBe('public');
      const response = await send(h.client(), route, entry);
      expect(outcome(response), routeKey(route)).toBe('401 unauthenticated');
    }
  });

  it('403 without CSRF on writes', async () => {
    const h = harness();
    const routes = await apiRoutes(h);
    const admin = await h.setupAdmin();
    const writes = routes.filter(
      (route) => WRITES.has(route.method) && !CSRF_EXEMPT.includes(routeKey(route)),
    );
    expect(writes.length).toBeGreaterThan(0);
    const token = admin.csrfToken ?? '';
    const wrong =
      token.length > 0 ? `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}` : 'x';
    for (const route of writes) {
      const entry = entryOf(route);
      const key = routeKey(route);
      const missing = await send(admin, route, entry, { 'x-csrf-token': null });
      expect(outcome(missing), `${key} without the header`).toBe('403 csrf_failed');
      const forged = await send(admin, route, entry, { 'x-csrf-token': wrong });
      expect(outcome(forged), `${key} with a wrong one`).toBe('403 csrf_failed');
    }
    // The refusals above came from the token: the right one gets past it on every write.
    for (const route of writes) {
      if (routeKey(route) === 'DELETE /api/session') continue;
      const response = await send(admin, route, entryOf(route));
      expect(codeOf(response), `${routeKey(route)} with the right token`).not.toBe('csrf_failed');
    }
    expect(outcome(await admin.delete('/api/session'))).not.toBe('403 csrf_failed');
  });

  it('403 for the wrong role', async () => {
    const h = harness();
    const routes = await apiRoutes(h);
    const admin = await h.setupAdmin();
    const contributor = await signedInContributor(h, admin);
    const adminOnly = routes.filter((route) => route.role === 'admin');
    expect(adminOnly.length).toBeGreaterThan(0);
    for (const route of adminOnly) {
      const entry = entryOf(route);
      expect(entry.access, routeKey(route)).toBe('admin');
      const response = await send(contributor, route, entry);
      expect(outcome(response), routeKey(route)).toBe('403 forbidden');
    }
    // The refusals above came from the role: an admin gets past it on the same requests.
    for (const route of adminOnly) {
      const response = await send(admin, route, entryOf(route));
      expect(codeOf(response), `${routeKey(route)} as admin`).not.toBe('forbidden');
    }
  });
});

describe('another assessment stays out of reach', () => {
  it('the second assessment is not the active one', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const before = await admin.get('/api/assessment');
    const other = otherAssessment(h, admin);
    const after = await admin.get('/api/assessment');
    expect(after.body).toBe(before.body);
    expect(after.body).not.toContain(other.assessmentId);
  });

  it("404 for another assessment's id", async () => {
    const h = harness();
    const routes = await apiRoutes(h);
    const admin = await h.setupAdmin();
    const ctx = otherAssessment(h, admin);
    let checked = 0;
    for (const route of routes) {
      const entry = entryOf(route);
      if (typeof entry.idor !== 'function') continue;
      const key = routeKey(route);
      const url = entry.idor(ctx);
      expect(urlMatchesPattern(url, route.url), `${key} seeded url`).toBe(true);
      const before = snapshot(h);
      const response = await send(admin, route, entry, {}, url);
      expect(outcome(response), key).toBe('404 not_found');
      expect(snapshot(h), `${key} left every row unchanged`).toEqual(before);
      checked += 1;
    }
    // Every route with an id in its url names its seeder or says why it has none.
    for (const route of routes) {
      if (!route.url.includes(':')) continue;
      const { idor } = entryOf(route);
      if (typeof idor !== 'function') {
        expect(idor.notApplicable.trim().length, `${routeKey(route)} reason`).toBeGreaterThan(0);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("lists never show another assessment's rows", async () => {
    const h = harness();
    const routes = await apiRoutes(h);
    const admin = await h.setupAdmin();
    const ctx = otherAssessment(h, admin);
    const seededIds = new Set<string>([ctx.assessmentId]);
    for (const route of routes) {
      const { idor } = entryOf(route);
      if (typeof idor !== 'function') continue;
      for (const id of idor(ctx).match(/[0-9a-f]{8}-[0-9a-f-]{27}/g) ?? []) seededIds.add(id);
    }
    expect(seededIds.size).toBeGreaterThan(1);
    const reads = routes.filter(
      (route) => route.method === 'GET' && !route.url.includes(':') && !route.public,
    );
    for (const route of reads) {
      const response = await send(admin, route, entryOf(route));
      expect(response.statusCode, `${routeKey(route)}: ${response.body}`).toBe(200);
      for (const id of seededIds) expect(response.body, routeKey(route)).not.toContain(id);
    }
  });

  it("a body naming another assessment's row is refused and changes nothing", async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const ctx = otherAssessment(h, admin);
    const evidenceId = ctx.evidence({ containsCui: false });
    const providerId = ctx.provider();
    const attempts: [string, () => Promise<LightMyRequestResponse>][] = [
      [
        'POST /api/ssp/diagrams',
        () =>
          admin.post('/api/ssp/diagrams', {
            evidenceId,
            kind: 'network',
            caption: 'Borrowed diagram',
            version: null,
          }),
      ],
      [
        'PUT /api/ssp/responsibilities/:requirementId',
        () =>
          admin.put('/api/ssp/responsibilities/AC.L2-3.1.1', {
            party: 'esp',
            providerId,
            note: null,
          }),
      ],
    ];
    for (const [key, attempt] of attempts) {
      const before = snapshot(h);
      const response = await attempt();
      expect(outcome(response), key).toBe('400 validation_failed');
      expect(snapshot(h), `${key} left every row unchanged`).toEqual(before);
    }
  });
});
