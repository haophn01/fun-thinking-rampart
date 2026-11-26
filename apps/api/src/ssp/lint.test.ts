import { loadCatalog } from '@rampart/catalog';
import { SSP_LINT_VERSION, lintSspFrom, type SspLintFinding } from '@rampart/rules';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { pngOf } from '../../ssp/testing/docx-text';
import {
  SSP_LARGE_IMAGE_BYTES,
  SSP_MAX_EMBEDDED_IMAGES,
  assessmentViewSchema,
  assetsResponseSchema,
  diagramResponseSchema,
  diagramsResponseSchema,
  documentControlSchema,
  errorEnvelopeSchema,
  evidenceItemResponseSchema,
  sspLintResponseSchema,
  userResponseSchema,
  type DiagramLink,
  type EvidenceItem,
  type SspLintResponse,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';

const URL = '/api/ssp/lint';
const START = new Date('2026-11-25T12:00:00.000Z');
const LIMITS = {
  maxEmbeddedImages: SSP_MAX_EMBEDDED_IMAGES,
  largeImageBytes: SSP_LARGE_IMAGE_BYTES,
};
const catalog = loadCatalog();

/** Not Met with no POA&M item. */
const UNPLANNED = 'AC.L2-3.1.3';
/** An open POA&M item, then marked Met: the SSP and the POA&M disagree. */
const MISMATCHED = 'AU.L2-3.3.3';
const FUTURE = 'AC.L2-3.1.1';
const PARTLY_NA = 'AC.L2-3.1.2';

const CONTRIBUTOR = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'a long enough password',
};

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness({ start: START });
  harnesses.push(h);
  const admin = await h.setupAdmin();
  return { h, admin };
}

function ok(response: LightMyRequestResponse, status = 200): LightMyRequestResponse {
  expect(response.statusCode, response.body).toBe(status);
  return response;
}

function code(response: LightMyRequestResponse): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

async function lint(client: Client): Promise<SspLintResponse> {
  return sspLintResponseSchema.parse(ok(await client.get(URL)).json());
}

function rulesOf(findings: readonly SspLintFinding[]): string[] {
  return [...new Set(findings.map((f) => f.rule))];
}

/** Every stored row, so a read can be shown to change none. */
function snapshot(h: Harness): unknown {
  const tables = h.handle.sqlite
    .prepare(`select name from sqlite_master where type = 'table' order by name`)
    .pluck()
    .all() as string[];
  return Object.fromEntries(
    tables.map((table) => [table, h.handle.sqlite.prepare(`select * from "${table}"`).all()]),
  );
}

function objectivesOf(requirementId: string) {
  const requirement = catalog.requirements.find((r) => r.id === requirementId);
  if (!requirement) throw new Error(`no ${requirementId}`);
  return requirement.objectives;
}

async function mark(
  client: Client,
  requirementId: string,
  status: 'met' | 'not_met' | 'na',
  only?: number,
): Promise<void> {
  const objectives = objectivesOf(requirementId);
  for (const objective of only === undefined ? objectives : objectives.slice(0, only)) {
    ok(
      await client.put(`/api/assessment/objectives/${encodeURIComponent(objective.id)}`, {
        status,
        note: null,
      }),
    );
  }
}

async function poam(client: Client, requirementId: string): Promise<void> {
  ok(await client.post('/api/poam', { requirementId, plan: 'Fix', due: '2026-12-31' }), 201);
}

async function fileItem(client: Client, title: string, bytes: Uint8Array, name: string) {
  const created = ok(
    await client.post('/api/evidence', { title, description: null, containsCui: false }),
    201,
  );
  const item = evidenceItemResponseSchema.parse(created.json()).item;
  const response = ok(await client.upload(`/api/evidence/${item.id}/versions`, bytes, name), 201);
  return evidenceItemResponseSchema.parse(response.json()).item;
}

async function link(
  client: Client,
  item: EvidenceItem,
  kind: DiagramLink['kind'],
  caption: string,
): Promise<DiagramLink> {
  const response = ok(
    await client.post('/api/ssp/diagrams', { evidenceId: item.id, kind, caption, version: null }),
    201,
  );
  return diagramResponseSchema.parse(response.json()).diagram;
}

/** A PNG whose stored size is just over the large-image limit: its header, then padding. */
function largePng(): Uint8Array {
  const head = pngOf(4, 4);
  const bytes = new Uint8Array(SSP_LARGE_IMAGE_BYTES + 1);
  bytes.set(head);
  return bytes;
}

/**
 * A workspace that fires every rule the api lets data reach (an out-of-scope asset needs its
 * justification, so `out_of_scope_unjustified` can't): 3.12.4 not assessed, no assets, only an
 * "other" diagram, the review overdue, blank statements, a Not Met with no POA&M item, N/A with
 * no rationale, a future-tense statement, a POA&M item on a Met requirement, a large image and
 * one embeddable link past the limit.
 */
async function busyWorld(): Promise<{ h: Harness; admin: Client }> {
  const { h, admin } = await world();
  ok(await admin.patch('/api/ssp/profile', { nextReviewDate: '2026-11-22' }));
  ok(
    await admin.patch(`/api/assessment/requirements/${FUTURE}`, {
      implementationStatement: 'We will enforce MFA. TBD.',
    }),
  );
  await mark(admin, UNPLANNED, 'not_met', 1);
  await mark(admin, MISMATCHED, 'not_met', 1);
  await poam(admin, MISMATCHED);
  await mark(admin, MISMATCHED, 'met');
  await mark(admin, PARTLY_NA, 'na', 1);
  const big = await fileItem(admin, 'Big map', largePng(), 'big.png');
  await link(admin, big, 'other', 'Big map');
  for (let i = 0; i < SSP_MAX_EMBEDDED_IMAGES; i += 1) {
    const item = await fileItem(admin, `Map ${String(i)}`, pngOf(2 + i, 2), `map-${String(i)}.png`);
    await link(admin, item, 'data_flow', `Map ${String(i).padStart(2, '0')}`);
  }
  return { h, admin };
}

describe('GET /api/ssp/lint', () => {
  it('lint route', async () => {
    const { h, admin } = await world();

    // Signed out.
    const signedOut = await h.client().get(URL);
    expect(signedOut.statusCode).toBe(401);
    expect(code(signedOut)).toBe('unauthenticated');

    // Admin and contributor read the same answer, and the read writes nothing.
    const created = userResponseSchema.parse(
      ok(await admin.post('/api/users', CONTRIBUTOR), 201).json(),
    );
    expect(created.user.role).toBe('contributor');
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
    const before = snapshot(h);
    const forAdmin = await lint(admin);
    const forCarl = await lint(carl);
    expect(forCarl).toEqual(forAdmin);
    expect(snapshot(h)).toEqual(before);

    expect(forAdmin.version).toBe(SSP_LINT_VERSION);
    const errors = forAdmin.findings.filter((f) => f.severity === 'error').length;
    const warnings = forAdmin.findings.filter((f) => f.severity === 'warning').length;
    expect(forAdmin.counts).toEqual({ errors, warnings });
    // A fresh assessment: 3.12.4 not assessed, no assets, no network diagram, blank statements.
    expect(rulesOf(forAdmin.findings)).toEqual([
      'ssp_requirement_not_met',
      'no_assets',
      'no_network_diagram',
      'empty_statement',
    ]);
    expect(errors).toBe(forAdmin.findings.length);

    // No assessment: 404.
    h.handle.sqlite.pragma('foreign_keys = OFF');
    h.handle.sqlite.exec('DELETE FROM assessment');
    h.handle.sqlite.pragma('foreign_keys = ON');
    const missing = await admin.get(URL);
    expect(missing.statusCode).toBe(404);
    expect(code(missing)).toBe('not_found');
  });

  it('web and api agree', async () => {
    const { admin } = await busyWorld();

    const view = assessmentViewSchema.parse(ok(await admin.get('/api/assessment')).json());
    const { assets } = assetsResponseSchema.parse(ok(await admin.get('/api/ssp/assets')).json());
    const { diagrams } = diagramsResponseSchema.parse(
      ok(await admin.get('/api/ssp/diagrams')).json(),
    );
    const review = documentControlSchema.parse(
      ok(await admin.get('/api/ssp/document-control')).json(),
    );
    const expected = lintSspFrom(catalog, { view, assets, diagrams, review }, LIMITS);

    const answer = await lint(admin);
    expect(answer.findings).toEqual(expected);
    expect(rulesOf(answer.findings)).toEqual([
      'ssp_requirement_not_met',
      'no_assets',
      'no_network_diagram',
      'review_overdue',
      'empty_statement',
      'not_met_without_poam',
      'na_without_rationale',
      'future_tense',
      'ssp_poam_mismatch',
      'large_image',
      'image_limit',
    ]);
    expect(answer.counts).toEqual({
      errors: expected.filter((f) => f.severity === 'error').length,
      warnings: expected.filter((f) => f.severity === 'warning').length,
    });
    expect(answer.counts.warnings).toBe(5);
  });

  it('lint follows the data', async () => {
    const { admin } = await busyWorld();
    const unplanned = (findings: readonly SspLintFinding[]) =>
      findings.filter((f) => f.rule === 'not_met_without_poam').map((f) => f.requirementId);
    const diagramRule = (findings: readonly SspLintFinding[]) =>
      findings.filter((f) => f.rule === 'no_network_diagram');

    const first = await lint(admin);
    expect(unplanned(first.findings)).toEqual([UNPLANNED]);
    expect(diagramRule(first.findings)).toHaveLength(1);

    await poam(admin, UNPLANNED);
    const second = await lint(admin);
    expect(unplanned(second.findings)).toEqual([]);
    expect(diagramRule(second.findings)).toHaveLength(1);

    const map = await fileItem(admin, 'Network map', pngOf(8, 8), 'network.png');
    await link(admin, map, 'network', 'Boundary');
    const third = await lint(admin);
    expect(diagramRule(third.findings)).toEqual([]);
    expect(third.counts.errors).toBe(second.counts.errors - 1);
  });
});
