import { randomUUID } from 'node:crypto';
import { loadCatalog } from '@rampart/catalog';
import { asc, count, eq, sql } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import {
  asset,
  assessment,
  diagramLink,
  evidenceItem,
  evidenceVersion,
  poamItem,
  policy,
  policyVersion,
  serviceProvider,
  sspApproval,
  systemRole,
} from '../../db/schema';
import type { RouteEntry } from './route-table';

/**
 * The access-control regression matrix: one entry per `/api` route, saying who may call it, a
 * valid sample request, and how to name another assessment's row in its url. The matrix test
 * (`route-matrix.test.ts`) fails, naming the route, when a route has no entry or an entry has no
 * route, so a new route can't ship without its access being declared and tested.
 */

/** Who may call a route: anyone, any signed-in user, or an admin. */
export type Access = 'public' | 'session' | 'admin';

/** A request the route accepts. `url` fills the route's params; ids may name no row. */
export interface SampleRequest {
  url: string;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as a raw `application/octet-stream` upload with the name in `x-file-name`. */
  upload?: { bytes: Uint8Array; fileName: string };
}

/**
 * A second assessment, created after the active one so it never becomes active, and helpers that
 * insert its rows straight into the database (the api only ever creates one assessment).
 */
export interface SeedContext {
  db: AppDb;
  assessmentId: string;
  /** The user every seeded row is created and updated by. */
  userId: string;
  /** The timestamp every seeded row carries. */
  at: string;
  /** An evidence item; `withFile` also adds version 1 as a stored file. */
  evidence(options: { containsCui: boolean; withFile?: boolean }): string;
  provider(): string;
}

/** Creates a row under the second assessment and returns the route's url naming it. */
export type IdorSeeder = (ctx: SeedContext) => string;

export interface MatrixEntry {
  access: Access;
  sample: SampleRequest;
  /** A seeder for a route whose url names an assessment's row, or why the route has none. */
  idor: IdorSeeder | { notApplicable: string };
}

/** The only `/api` routes outside the session guard. */
export const UNGUARDED_API_ROUTES: readonly string[] = ['GET /api/health'];

/** The only writes without a CSRF token: no session exists yet to hold one. */
export const CSRF_EXEMPT: readonly string[] = ['POST /api/setup', 'POST /api/session'];

/** An id that names no row, for sample urls. */
const NO_ROW = '00000000-0000-4000-8000-000000000000';
const REQUIREMENT = 'AC.L2-3.1.1';
const OBJECTIVE = encodeURIComponent('3.1.1[a]');
const UPLOAD = { bytes: new TextEncoder().encode('matrix sample file'), fileName: 'matrix.txt' };
/** A SHA-256 shape for seeded file versions; the 404 comes before the store is read. */
const FAKE_SHA = 'a'.repeat(64);

const NO_URL_ID = { notApplicable: 'no row id in the url: it acts on the active assessment' };
const SESSION_ROUTE = { notApplicable: 'the caller’s own session, not an assessment’s row' };
const USERS_GLOBAL = { notApplicable: 'users are global, not per assessment' };
const CATALOG_ID = {
  notApplicable: 'catalog ids are the same for every assessment; the row is the active one’s',
};

const stamps = (ctx: SeedContext) => ({
  createdBy: ctx.userId,
  createdAt: ctx.at,
  updatedBy: ctx.userId,
  updatedAt: ctx.at,
});

/** An open item on the next requirement without one: one open item per requirement is allowed. */
function seedPoam(ctx: SeedContext): string {
  const id = randomUUID();
  const [held] = ctx.db
    .select({ n: count() })
    .from(poamItem)
    .where(eq(poamItem.assessmentId, ctx.assessmentId))
    .all();
  const requirement = loadCatalog().requirements[held?.n ?? 0];
  if (requirement === undefined) throw new Error('seedPoam ran out of requirements');
  ctx.db
    .insert(poamItem)
    .values({
      id,
      assessmentId: ctx.assessmentId,
      requirementId: requirement.id,
      plan: 'Another assessment’s plan',
      due: '2027-01-01',
      ...stamps(ctx),
    })
    .run();
  return id;
}

function seedPolicy(ctx: SeedContext, withFile = false): string {
  const id = randomUUID();
  ctx.db
    .insert(policy)
    .values({ id, assessmentId: ctx.assessmentId, title: 'Another policy', ...stamps(ctx) })
    .run();
  if (withFile) {
    ctx.db
      .insert(policyVersion)
      .values({
        policyId: id,
        version: 1,
        fileName: 'other-policy.txt',
        size: 5,
        sha256: FAKE_SHA,
        storageKey: 'other-policy',
        createdBy: ctx.userId,
        createdAt: ctx.at,
      })
      .run();
  }
  return id;
}

function seedRole(ctx: SeedContext): string {
  const id = randomUUID();
  ctx.db
    .insert(systemRole)
    .values({
      id,
      assessmentId: ctx.assessmentId,
      title: 'Another role',
      userCount: 1,
      privileged: false,
      ...stamps(ctx),
    })
    .run();
  return id;
}

function seedAsset(ctx: SeedContext): string {
  const id = randomUUID();
  ctx.db
    .insert(asset)
    .values({
      id,
      assessmentId: ctx.assessmentId,
      name: 'Another laptop',
      category: 'cui',
      ...stamps(ctx),
    })
    .run();
  return id;
}

function seedDiagram(ctx: SeedContext): string {
  const id = randomUUID();
  const evidenceId = ctx.evidence({ containsCui: false, withFile: true });
  ctx.db
    .insert(diagramLink)
    .values({
      id,
      assessmentId: ctx.assessmentId,
      evidenceId,
      version: null,
      kind: 'network',
      caption: 'Another network',
      ...stamps(ctx),
    })
    .run();
  return id;
}

function seedApproval(ctx: SeedContext): string {
  const id = randomUUID();
  ctx.db
    .insert(sspApproval)
    .values({
      id,
      assessmentId: ctx.assessmentId,
      name: 'Another Approver',
      title: 'CEO',
      approvedOn: null,
      ...stamps(ctx),
    })
    .run();
  return id;
}

export const ROUTE_MATRIX: Readonly<Record<string, MatrixEntry>> = {
  'GET /api/health': { access: 'public', sample: { url: '/api/health' }, idor: NO_URL_ID },

  // Auth: public, so they answer signed out; sign-out still needs the token on a session.
  'POST /api/setup': {
    access: 'public',
    sample: {
      url: '/api/setup',
      body: { email: 'matrix@example.com', displayName: 'Matrix', password: 'matrix password 1' },
    },
    idor: NO_URL_ID,
  },
  'GET /api/session': { access: 'public', sample: { url: '/api/session' }, idor: SESSION_ROUTE },
  'POST /api/session': {
    access: 'public',
    sample: { url: '/api/session', body: { email: 'matrix@example.com', password: 'wrong' } },
    idor: SESSION_ROUTE,
  },
  'DELETE /api/session': {
    access: 'public',
    sample: { url: '/api/session' },
    idor: SESSION_ROUTE,
  },
  // The signed-in session's own routes: any session, with its CSRF token.
  'POST /api/session/lock': {
    access: 'session',
    sample: { url: '/api/session/lock' },
    idor: SESSION_ROUTE,
  },
  'POST /api/session/unlock': {
    access: 'session',
    sample: { url: '/api/session/unlock', body: { password: 'not the password' } },
    idor: SESSION_ROUTE,
  },
  'POST /api/session/password': {
    access: 'session',
    sample: {
      url: '/api/session/password',
      body: { currentPassword: 'not the password', newPassword: 'matrix password 3' },
    },
    idor: SESSION_ROUTE,
  },
  // Two-step sign-in (sec-mfa): the caller's own enrollment and challenge.
  'POST /api/session/mfa/enroll': {
    access: 'session',
    sample: { url: '/api/session/mfa/enroll' },
    idor: SESSION_ROUTE,
  },
  'POST /api/session/mfa/enroll/confirm': {
    access: 'session',
    sample: { url: '/api/session/mfa/enroll/confirm', body: { code: '123456' } },
    idor: SESSION_ROUTE,
  },
  'POST /api/session/mfa/verify': {
    access: 'session',
    sample: { url: '/api/session/mfa/verify', body: { code: '123456' } },
    idor: SESSION_ROUTE,
  },

  // Users and the audit log.
  'GET /api/users': { access: 'session', sample: { url: '/api/users' }, idor: USERS_GLOBAL },
  'POST /api/users': {
    access: 'admin',
    sample: {
      url: '/api/users',
      body: {
        email: 'matrix.user@example.com',
        displayName: 'Matrix User',
        role: 'contributor',
        password: 'matrix password 2',
      },
    },
    idor: USERS_GLOBAL,
  },
  'PATCH /api/users/:id': {
    access: 'admin',
    sample: { url: `/api/users/${NO_ROW}`, body: { displayName: 'Matrix Renamed' } },
    idor: USERS_GLOBAL,
  },
  'GET /api/audit': { access: 'session', sample: { url: '/api/audit' }, idor: NO_URL_ID },

  // App-wide settings.
  'PUT /api/settings/sign-in-notice': {
    access: 'admin',
    sample: { url: '/api/settings/sign-in-notice', body: { text: 'Matrix notice.' } },
    idor: { notApplicable: 'one global setting' },
  },

  // The assessment.
  'GET /api/assessment': { access: 'session', sample: { url: '/api/assessment' }, idor: NO_URL_ID },
  'PATCH /api/assessment': {
    access: 'admin',
    sample: { url: '/api/assessment', body: { type: 'self' } },
    idor: NO_URL_ID,
  },
  'PUT /api/assessment/objectives/:objectiveId': {
    access: 'session',
    sample: {
      url: `/api/assessment/objectives/${OBJECTIVE}`,
      body: { status: 'met', note: null },
    },
    idor: CATALOG_ID,
  },
  'PATCH /api/assessment/requirements/:requirementId': {
    access: 'session',
    sample: {
      url: `/api/assessment/requirements/${REQUIREMENT}`,
      body: { implementationStatement: 'Matrix statement.' },
    },
    idor: CATALOG_ID,
  },

  // POA&M.
  'GET /api/poam': { access: 'session', sample: { url: '/api/poam' }, idor: NO_URL_ID },
  'POST /api/poam': {
    access: 'session',
    sample: {
      url: '/api/poam',
      body: { requirementId: REQUIREMENT, plan: 'Matrix plan.', due: '2027-01-01' },
    },
    idor: NO_URL_ID,
  },
  'PATCH /api/poam/:id': {
    access: 'session',
    sample: { url: `/api/poam/${NO_ROW}`, body: { plan: 'Changed by the matrix.' } },
    idor: (ctx) => `/api/poam/${seedPoam(ctx)}`,
  },
  'POST /api/poam/:id/closeout': {
    access: 'admin',
    sample: { url: `/api/poam/${NO_ROW}/closeout`, body: { closedOn: '2026-11-23', note: null } },
    idor: (ctx) => `/api/poam/${seedPoam(ctx)}/closeout`,
  },

  // Evidence.
  'GET /api/evidence': { access: 'session', sample: { url: '/api/evidence' }, idor: NO_URL_ID },
  'POST /api/evidence': {
    access: 'session',
    sample: {
      url: '/api/evidence',
      body: { title: 'Matrix evidence', description: null, containsCui: false },
    },
    idor: NO_URL_ID,
  },
  'PATCH /api/evidence/:id': {
    access: 'session',
    sample: { url: `/api/evidence/${NO_ROW}`, body: { title: 'Changed by the matrix' } },
    idor: (ctx) => `/api/evidence/${ctx.evidence({ containsCui: false })}`,
  },
  'PUT /api/evidence/:id/objectives': {
    access: 'session',
    sample: { url: `/api/evidence/${NO_ROW}/objectives`, body: { objectiveIds: ['3.1.1[a]'] } },
    idor: (ctx) => `/api/evidence/${ctx.evidence({ containsCui: false })}/objectives`,
  },
  'POST /api/evidence/:id/references': {
    access: 'session',
    sample: {
      url: `/api/evidence/${NO_ROW}/references`,
      body: { location: 'Matrix vault, shelf 2', note: null },
    },
    idor: (ctx) => `/api/evidence/${ctx.evidence({ containsCui: true })}/references`,
  },
  'POST /api/evidence/:id/versions': {
    access: 'session',
    sample: { url: `/api/evidence/${NO_ROW}/versions`, upload: UPLOAD },
    idor: (ctx) => `/api/evidence/${ctx.evidence({ containsCui: false })}/versions`,
  },
  'GET /api/evidence/:id/versions/:version/file': {
    access: 'session',
    sample: { url: `/api/evidence/${NO_ROW}/versions/1/file` },
    idor: (ctx) =>
      `/api/evidence/${ctx.evidence({ containsCui: false, withFile: true })}/versions/1/file`,
  },

  // Policies.
  'GET /api/policies': { access: 'session', sample: { url: '/api/policies' }, idor: NO_URL_ID },
  'POST /api/policies': {
    access: 'session',
    sample: { url: '/api/policies', body: { title: 'Matrix policy', description: null } },
    idor: NO_URL_ID,
  },
  'PATCH /api/policies/:id': {
    access: 'session',
    sample: { url: `/api/policies/${NO_ROW}`, body: { title: 'Changed by the matrix' } },
    idor: (ctx) => `/api/policies/${seedPolicy(ctx)}`,
  },
  'PUT /api/policies/:id/requirements': {
    access: 'session',
    sample: {
      url: `/api/policies/${NO_ROW}/requirements`,
      body: { requirementIds: [REQUIREMENT] },
    },
    idor: (ctx) => `/api/policies/${seedPolicy(ctx)}/requirements`,
  },
  'POST /api/policies/:id/versions': {
    access: 'session',
    sample: { url: `/api/policies/${NO_ROW}/versions`, upload: UPLOAD },
    idor: (ctx) => `/api/policies/${seedPolicy(ctx)}/versions`,
  },
  'GET /api/policies/:id/versions/:version/file': {
    access: 'session',
    sample: { url: `/api/policies/${NO_ROW}/versions/1/file` },
    idor: (ctx) => `/api/policies/${seedPolicy(ctx, true)}/versions/1/file`,
  },

  // The system profile.
  'GET /api/system-profile': {
    access: 'session',
    sample: { url: '/api/system-profile' },
    idor: NO_URL_ID,
  },
  'PATCH /api/system-profile': {
    access: 'session',
    sample: { url: '/api/system-profile', body: { systemName: 'Matrix System' } },
    idor: NO_URL_ID,
  },

  // The SSP: export, lint and its data.
  'GET /api/ssp/export': { access: 'session', sample: { url: '/api/ssp/export' }, idor: NO_URL_ID },
  'GET /api/ssp/lint': { access: 'session', sample: { url: '/api/ssp/lint' }, idor: NO_URL_ID },
  'GET /api/ssp/profile': {
    access: 'session',
    sample: { url: '/api/ssp/profile' },
    idor: NO_URL_ID,
  },
  'PATCH /api/ssp/profile': {
    access: 'session',
    sample: { url: '/api/ssp/profile', body: { cuiCategories: 'Matrix categories' } },
    idor: NO_URL_ID,
  },

  'GET /api/ssp/roles': { access: 'session', sample: { url: '/api/ssp/roles' }, idor: NO_URL_ID },
  'POST /api/ssp/roles': {
    access: 'session',
    sample: {
      url: '/api/ssp/roles',
      body: { title: 'Matrix role', userCount: 1, privileged: false },
    },
    idor: NO_URL_ID,
  },
  'PATCH /api/ssp/roles/:id': {
    access: 'session',
    sample: { url: `/api/ssp/roles/${NO_ROW}`, body: { title: 'Changed by the matrix' } },
    idor: (ctx) => `/api/ssp/roles/${seedRole(ctx)}`,
  },
  'DELETE /api/ssp/roles/:id': {
    access: 'session',
    sample: { url: `/api/ssp/roles/${NO_ROW}` },
    idor: (ctx) => `/api/ssp/roles/${seedRole(ctx)}`,
  },

  'GET /api/ssp/assets': { access: 'session', sample: { url: '/api/ssp/assets' }, idor: NO_URL_ID },
  'POST /api/ssp/assets': {
    access: 'session',
    sample: { url: '/api/ssp/assets', body: { name: 'Matrix laptop', category: 'cui' } },
    idor: NO_URL_ID,
  },
  'PATCH /api/ssp/assets/:id': {
    access: 'session',
    sample: { url: `/api/ssp/assets/${NO_ROW}`, body: { name: 'Changed by the matrix' } },
    idor: (ctx) => `/api/ssp/assets/${seedAsset(ctx)}`,
  },
  'DELETE /api/ssp/assets/:id': {
    access: 'session',
    sample: { url: `/api/ssp/assets/${NO_ROW}` },
    idor: (ctx) => `/api/ssp/assets/${seedAsset(ctx)}`,
  },

  'GET /api/ssp/diagrams': {
    access: 'session',
    sample: { url: '/api/ssp/diagrams' },
    idor: NO_URL_ID,
  },
  'POST /api/ssp/diagrams': {
    access: 'session',
    sample: {
      url: '/api/ssp/diagrams',
      body: { evidenceId: NO_ROW, kind: 'network', caption: 'Matrix network', version: null },
    },
    idor: NO_URL_ID,
  },
  'PATCH /api/ssp/diagrams/:id': {
    access: 'session',
    sample: { url: `/api/ssp/diagrams/${NO_ROW}`, body: { caption: 'Changed by the matrix' } },
    idor: (ctx) => `/api/ssp/diagrams/${seedDiagram(ctx)}`,
  },
  'DELETE /api/ssp/diagrams/:id': {
    access: 'session',
    sample: { url: `/api/ssp/diagrams/${NO_ROW}` },
    idor: (ctx) => `/api/ssp/diagrams/${seedDiagram(ctx)}`,
  },

  'GET /api/ssp/providers': {
    access: 'session',
    sample: { url: '/api/ssp/providers' },
    idor: NO_URL_ID,
  },
  'POST /api/ssp/providers': {
    access: 'session',
    sample: { url: '/api/ssp/providers', body: { name: 'Matrix Cloud', providerType: 'cloud' } },
    idor: NO_URL_ID,
  },
  'PATCH /api/ssp/providers/:id': {
    access: 'session',
    sample: { url: `/api/ssp/providers/${NO_ROW}`, body: { name: 'Changed by the matrix' } },
    idor: (ctx) => `/api/ssp/providers/${ctx.provider()}`,
  },
  'DELETE /api/ssp/providers/:id': {
    access: 'session',
    sample: { url: `/api/ssp/providers/${NO_ROW}` },
    idor: (ctx) => `/api/ssp/providers/${ctx.provider()}`,
  },

  'GET /api/ssp/responsibilities': {
    access: 'session',
    sample: { url: '/api/ssp/responsibilities' },
    idor: NO_URL_ID,
  },
  'PUT /api/ssp/responsibilities/:requirementId': {
    access: 'session',
    sample: {
      url: `/api/ssp/responsibilities/${REQUIREMENT}`,
      body: { party: 'organization', providerId: null, note: null },
    },
    idor: CATALOG_ID,
  },

  'GET /api/ssp/document-control': {
    access: 'session',
    sample: { url: '/api/ssp/document-control' },
    idor: NO_URL_ID,
  },
  'POST /api/ssp/revisions': {
    access: 'session',
    sample: {
      url: '/api/ssp/revisions',
      body: { date: '2026-11-23', description: 'Matrix entry' },
    },
    idor: NO_URL_ID,
  },
  'POST /api/ssp/approvals': {
    access: 'admin',
    sample: {
      url: '/api/ssp/approvals',
      body: { name: 'Matrix Approver', title: 'CEO', approvedOn: null },
    },
    idor: NO_URL_ID,
  },
  'PATCH /api/ssp/approvals/:id': {
    access: 'admin',
    sample: { url: `/api/ssp/approvals/${NO_ROW}`, body: { title: 'Changed by the matrix' } },
    idor: (ctx) => `/api/ssp/approvals/${seedApproval(ctx)}`,
  },
  'DELETE /api/ssp/approvals/:id': {
    access: 'admin',
    sample: { url: `/api/ssp/approvals/${NO_ROW}` },
    idor: (ctx) => `/api/ssp/approvals/${seedApproval(ctx)}`,
  },
};

/** A route's matrix key, `<METHOD> <url>`. */
export const routeKey = (route: Pick<RouteEntry, 'method' | 'url'>): string =>
  `${route.method} ${route.url}`;

/** The routes with no matrix entry, and the entries with no route, each sorted. */
export function matrixMismatches(
  routes: readonly Pick<RouteEntry, 'method' | 'url'>[],
  matrix: Readonly<Record<string, MatrixEntry>>,
): { missing: string[]; extra: string[] } {
  const keys = new Set(routes.map(routeKey));
  const declared = new Set(Object.keys(matrix));
  return {
    missing: [...keys].filter((key) => !declared.has(key)).sort(),
    extra: [...declared].filter((key) => !keys.has(key)).sort(),
  };
}

/**
 * Whether a concrete url (its query aside) fits a Fastify url pattern: each `:param` takes one
 * non-empty path segment, everything else matches exactly.
 */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  const path = url.split('?')[0] ?? '';
  const urlParts = path.split('/');
  const patternParts = pattern.split('/');
  if (urlParts.length !== patternParts.length) return false;
  return patternParts.every((part, i) => {
    const actual = urlParts[i] ?? '';
    return part.startsWith(':') ? actual.length > 0 : part === actual;
  });
}

/**
 * Inserts a second assessment, created a day after the active one so the active one stays
 * active, and returns the context its seeders write in. Call it after setup.
 */
export function seedOtherAssessment(db: AppDb, userId: string): SeedContext {
  const active = db
    .select()
    .from(assessment)
    .orderBy(asc(assessment.createdAt), sql`rowid`)
    .limit(1)
    .get();
  if (!active) throw new Error('seedOtherAssessment needs the active assessment: run setup first');
  const at = new Date(new Date(active.createdAt).getTime() + 86_400_000).toISOString();
  const assessmentId = randomUUID();
  db.insert(assessment)
    .values({
      id: assessmentId,
      catalogVersion: active.catalogVersion,
      createdAt: at,
      updatedAt: at,
    })
    .run();

  const ctx: SeedContext = {
    db,
    assessmentId,
    userId,
    at,
    evidence({ containsCui, withFile = false }) {
      const id = randomUUID();
      db.insert(evidenceItem)
        .values({ id, assessmentId, title: 'Another item', containsCui, ...stamps(ctx) })
        .run();
      if (withFile && !containsCui) {
        db.insert(evidenceVersion)
          .values({
            evidenceId: id,
            version: 1,
            containsCui: false,
            fileName: 'other.txt',
            size: 5,
            sha256: FAKE_SHA,
            storageKey: 'other-evidence',
            createdBy: userId,
            createdAt: at,
          })
          .run();
      }
      return id;
    },
    provider() {
      const id = randomUUID();
      db.insert(serviceProvider)
        .values({
          id,
          assessmentId,
          name: 'Another Cloud',
          providerType: 'cloud',
          ...stamps(ctx),
        })
        .run();
      return id;
    },
  };
  return ctx;
}
