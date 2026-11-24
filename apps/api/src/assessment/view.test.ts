import { randomUUID } from 'node:crypto';
import { catalogKey, loadCatalog } from '@rampart/catalog';
import { evaluateAssessment, type AssessmentInput, type ImplementationLevel } from '@rampart/rules';
import { REGULATION } from '@rampart/rules/poam';
import { afterEach, describe, expect, it } from 'vitest';
import { assessment, objectiveResult, requirementState } from '../../db/schema';
import { assessmentViewSchema, errorEnvelopeSchema, type AssessmentView } from '../contract';
import { createHarness, type Harness } from '../testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const catalog = loadCatalog();

function view(body: string): AssessmentView {
  return assessmentViewSchema.parse(JSON.parse(body));
}

/** The rules input built straight from the stored rows, without the api. */
function storedInput(h: Harness): AssessmentInput {
  const results = h.db.select().from(objectiveResult).all();
  const states = h.db.select().from(requirementState).all();
  const implementationLevels: Record<string, ImplementationLevel> = {};
  for (const state of states) {
    if (state.implementationLevel !== null) {
      implementationLevels[state.requirementId] = state.implementationLevel;
    }
  }
  return {
    objectiveResults: results.map((r) => ({ objectiveId: r.objectiveId, status: r.status })),
    implementationLevels,
  };
}

const objective = (id: string) => `/api/assessment/objectives/${encodeURIComponent(id)}`;
const requirement = (id: string) => `/api/assessment/requirements/${encodeURIComponent(id)}`;

describe('view uses the shared evaluation', () => {
  it('shows a fresh assessment with every requirement not assessed and the score incomplete', async () => {
    const h = createHarness();
    harnesses.push(h);
    const admin = await h.setupAdmin();

    const response = await admin.get('/api/assessment');
    expect(response.statusCode).toBe(200);
    const body = view(response.body);

    expect(body.assessment).toMatchObject({
      type: 'self',
      conditionalStatusDate: null,
      catalogVersion: catalogKey(catalog),
    });
    expect(body.objectiveResults).toEqual([]);
    expect(body.requirementStates).toEqual([]);
    expect(body.closeout).toBeNull();
    expect(body.evaluation.outcomes).toHaveLength(catalog.requirements.length);
    expect(body.evaluation.outcomes.map((o) => o.requirementId)).toEqual(
      catalog.requirements.map((r) => r.id),
    );
    expect(body.evaluation.outcomes.every((o) => o.status === 'not_assessed')).toBe(true);
    expect(body.evaluation.score.kind).toBe('incomplete');
    expect(body.evaluation.conditional.status).toBe('incomplete');
    expect(body.evaluation).toEqual(
      evaluateAssessment(catalog, { objectiveResults: [], implementationLevels: {} }, REGULATION),
    );
  });

  it('after writes, deep-equals evaluateAssessment over the stored rows, lists in catalog order', async () => {
    const h = createHarness();
    harnesses.push(h);
    const admin = await h.setupAdmin();

    // Written out of catalog order on purpose.
    const writes: [string, string][] = [
      ['3.13.11[a]', 'not_met'],
      ['3.12.4[a]', 'met'],
      ['3.1.1[b]', 'na'],
      ['3.1.1[a]', 'met'],
      ['3.5.3[a]', 'not_met'],
      ['3.1.2[a]', 'not_assessed'],
    ];
    for (const [id, status] of writes) {
      expect((await admin.put(objective(id), { status, note: null })).statusCode, id).toBe(200);
    }
    for (const [id, body] of [
      ['SC.L2-3.13.11', { implementationLevel: 'partial' }],
      ['AC.L2-3.1.1', { implementationStatement: 'We use SSO.' }],
      ['IA.L2-3.5.3', { implementationLevel: 'none' }],
    ] as const) {
      expect((await admin.patch(requirement(id), body)).statusCode, id).toBe(200);
    }

    const body = view((await admin.get('/api/assessment')).body);
    expect(body.evaluation).toEqual(evaluateAssessment(catalog, storedInput(h), REGULATION));

    const catalogObjectives = catalog.requirements.flatMap((r) => r.objectives.map((o) => o.id));
    const listed = body.objectiveResults.map((r) => r.objectiveId);
    expect(listed).toEqual(catalogObjectives.filter((id) => listed.includes(id)));
    expect(new Set(listed)).toEqual(new Set(writes.map(([id]) => id)));

    const catalogRequirements = catalog.requirements.map((r) => r.id);
    const states = body.requirementStates.map((s) => s.requirementId);
    expect(states).toEqual(['AC.L2-3.1.1', 'IA.L2-3.5.3', 'SC.L2-3.13.11']);
    expect(states).toEqual(catalogRequirements.filter((id) => states.includes(id)));

    const encryption = body.evaluation.outcomes.find((o) => o.requirementId === 'SC.L2-3.13.11');
    expect(encryption?.implementationLevel).toBe('partial');
    expect(body.objectiveResults[0]).toMatchObject({
      objectiveId: '3.1.1[a]',
      status: 'met',
      note: null,
      updatedBy: { id: admin.user?.id, displayName: 'Ada Admin' },
    });
  });

  it('gives 404 when there is no assessment row', async () => {
    const h = createHarness();
    harnesses.push(h);
    const admin = await h.setupAdmin();
    expect((await admin.get('/api/assessment')).statusCode).toBe(200);
    // Setup always creates the assessment; remove it to reach the state the route guards against.
    h.handle.sqlite.pragma('foreign_keys = OFF');
    h.handle.sqlite.exec('DELETE FROM assessment');
    h.handle.sqlite.pragma('foreign_keys = ON');

    const response = await admin.get('/api/assessment');
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('not_found');

    // Writes have nothing to write to either.
    const put = await admin.put(objective('3.1.1[a]'), { status: 'met', note: null });
    expect(put.statusCode).toBe(404);
    const patch = await admin.patch(requirement('AC.L2-3.1.1'), { implementationStatement: 'x' });
    expect(patch.statusCode).toBe(404);
    const settings = await admin.patch('/api/assessment', { type: 'c3pao' });
    expect(settings.statusCode).toBe(404);
  });

  it('uses the assessment with the earliest created_at', async () => {
    const h = createHarness();
    harnesses.push(h);
    const admin = await h.setupAdmin();
    const first = view((await admin.get('/api/assessment')).body).assessment;
    h.db
      .insert(assessment)
      .values({
        id: randomUUID(),
        type: 'c3pao',
        catalogVersion: first.catalogVersion,
        createdAt: '2999-01-01T00:00:00.000Z',
        updatedAt: '2999-01-01T00:00:00.000Z',
      })
      .run();
    expect(view((await admin.get('/api/assessment')).body).assessment.id).toBe(first.id);
  });

  it('needs a session', async () => {
    const h = createHarness();
    harnesses.push(h);
    await h.setupAdmin();
    const response = await h.client().get('/api/assessment');
    expect(response.statusCode).toBe(401);
  });
});
