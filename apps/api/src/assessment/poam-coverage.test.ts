import { loadCatalog } from '@rampart/catalog';
import { evaluateAssessment, type Blocker } from '@rampart/rules';
import { REGULATION } from '@rampart/rules/poam';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessmentViewSchema,
  objectiveWriteResponseSchema,
  poamItemResponseSchema,
  requirementWriteResponseSchema,
  type AssessmentView,
  type PoamItem,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const catalog = loadCatalog();
// Two eligible 1-point requirements, in catalog order.
const FIRST = 'AC.L2-3.1.3';
const SECOND = 'AU.L2-3.3.3';
const ENCRYPTION = 'SC.L2-3.13.11';

const missing = (requirementId: string): Blocker => ({
  code: 'poam_missing',
  requirementId,
  citation: REGULATION.poamRequiredForNotMet.citation,
});
const missingIds = (blockers: readonly Blocker[]) =>
  blockers.filter((b) => b.code === 'poam_missing').map((b) => b.requirementId);

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  return { h, admin: await h.setupAdmin() };
}

function objectivesOf(requirementId: string) {
  const requirement = catalog.requirements.find((r) => r.id === requirementId);
  if (!requirement) throw new Error(`no ${requirementId}`);
  return requirement.objectives;
}

/** Marks a requirement Met (every objective) or Not Met (its first objective). */
async function mark(client: Client, requirementId: string, status: 'met' | 'not_met') {
  const objectives = objectivesOf(requirementId);
  let last: unknown;
  for (const objective of status === 'met' ? objectives : objectives.slice(0, 1)) {
    const response = await client.put(
      `/api/assessment/objectives/${encodeURIComponent(objective.id)}`,
      { status, note: null },
    );
    expect(response.statusCode, response.body).toBe(200);
    last = response.json();
  }
  return objectiveWriteResponseSchema.parse(last);
}

async function create(client: Client, requirementId: string): Promise<PoamItem> {
  const response = await client.post('/api/poam', {
    requirementId,
    plan: 'Fix',
    due: '2026-12-31',
  });
  expect(response.statusCode, response.body).toBe(201);
  return poamItemResponseSchema.parse(response.json()).item;
}

async function readView(client: Client): Promise<AssessmentView> {
  const response = await client.get('/api/assessment');
  expect(response.statusCode, response.body).toBe(200);
  return assessmentViewSchema.parse(response.json());
}

/** The view's evaluation, recomputed from its own rows and list: the web does the same. */
function recomputed(view: AssessmentView) {
  const implementationLevels: Record<string, 'none' | 'partial'> = {};
  for (const s of view.requirementStates) {
    if (s.implementationLevel !== null)
      implementationLevels[s.requirementId] = s.implementationLevel;
  }
  return evaluateAssessment(
    catalog,
    {
      objectiveResults: view.objectiveResults.map((r) => ({
        objectiveId: r.objectiveId,
        status: r.status,
      })),
      implementationLevels,
      openPoamRequirementIds: view.openPoamRequirementIds ?? [],
    },
    REGULATION,
  );
}

describe('POA&M coverage in the assessment evaluation', () => {
  it('only open items cover', async () => {
    const { admin } = await world();
    // A fresh assessment always sends the list, empty.
    expect((await readView(admin)).openPoamRequirementIds).toEqual([]);

    await mark(admin, SECOND, 'not_met');
    await mark(admin, FIRST, 'not_met');
    // Created out of catalog order on purpose.
    await create(admin, SECOND);
    const first = await create(admin, FIRST);

    let view = await readView(admin);
    expect(view.openPoamRequirementIds).toEqual([FIRST, SECOND]);
    expect(missingIds(view.evaluation.conditional.blockers)).toEqual([]);
    expect(view.evaluation).toEqual(recomputed(view));

    // Met again and closed out: the closed item is history and covers nothing.
    await mark(admin, FIRST, 'met');
    const closed = await admin.post(`/api/poam/${first.id}/closeout`, {
      closedOn: '2026-11-23',
      note: null,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    view = await readView(admin);
    expect(view.openPoamRequirementIds).toEqual([SECOND]);

    // Not Met again: the closed item doesn't cover it, so poam_missing is back.
    const write = await mark(admin, FIRST, 'not_met');
    expect(missingIds(write.evaluation.conditional.blockers)).toEqual([FIRST]);
    view = await readView(admin);
    expect(view.openPoamRequirementIds).toEqual([SECOND]);
    expect(view.evaluation.conditional.blockers).toContainEqual(missing(FIRST));
    expect(view.evaluation).toEqual(recomputed(view));

    // A new open item on it covers it again.
    await create(admin, FIRST);
    view = await readView(admin);
    expect(view.openPoamRequirementIds).toEqual([FIRST, SECOND]);
    expect(missingIds(view.evaluation.conditional.blockers)).toEqual([]);
  });

  it('evaluation follows POA&M items', async () => {
    const { admin } = await world();
    // Every requirement Met, then one eligible 1-point requirement Not Met: 109 and HOLD.
    for (const requirement of catalog.requirements) await mark(admin, requirement.id, 'met');
    const write = await mark(admin, FIRST, 'not_met');
    expect(write.evaluation.score).toMatchObject({ kind: 'scored', score: 109 });
    expect(write.evaluation.conditional).toEqual({
      status: 'not_eligible',
      blockers: [missing(FIRST)],
    });
    expect((await readView(admin)).evaluation.conditional.blockers).toEqual([missing(FIRST)]);

    // An open item clears it in the next GET and the next objective write: Conditional.
    await create(admin, FIRST);
    const view = await readView(admin);
    expect(view.evaluation.conditional).toEqual({ status: 'conditional', blockers: [] });
    const [objective] = objectivesOf(SECOND);
    if (!objective) throw new Error('no objective');
    const next = await admin.put(`/api/assessment/objectives/${encodeURIComponent(objective.id)}`, {
      status: 'met',
      note: 'checked again',
    });
    expect(next.statusCode, next.body).toBe(200);
    expect(objectiveWriteResponseSchema.parse(next.json()).evaluation.conditional).toEqual({
      status: 'conditional',
      blockers: [],
    });

    // 3.13.11 Not Met at partial is eligible, so it needs an item; the requirement write shows it.
    await mark(admin, ENCRYPTION, 'not_met');
    const level = await admin.patch(`/api/assessment/requirements/${ENCRYPTION}`, {
      implementationLevel: 'partial',
    });
    expect(level.statusCode, level.body).toBe(200);
    expect(
      requirementWriteResponseSchema.parse(level.json()).evaluation.conditional.blockers,
    ).toEqual([missing(ENCRYPTION)]);
    await create(admin, ENCRYPTION);
    expect((await readView(admin)).evaluation.conditional).toEqual({
      status: 'conditional',
      blockers: [],
    });
  });
});
