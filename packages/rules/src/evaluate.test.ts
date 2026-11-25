import { loadCatalog } from '@rampart/catalog';
import type { Catalog, RequirementId } from '@rampart/catalog';
import { describe, expect, it } from 'vitest';
import { checkConditional, REGULATION } from './poam';
import type { AssessmentInput, ObjectiveResult, ObjectiveStatus, Regulation } from './types';
import {
  applyWhatIf,
  compareEvaluations,
  computeScore,
  deriveRequirementOutcomes,
  evaluateAssessment,
  RulesInputError,
  type WhatIfChanges,
} from './index';
import { fixtureCatalog } from './testing/fixture-catalog';

const fixture = fixtureCatalog();
const real = loadCatalog();
const SSP = 'CA.L2-3.12.4';
const PASSWORD = 'IA.L2-3.5.3';

/** Every objective takes `status`, except the requirements in `overrides`; `null` drops them. */
function inputOf(
  catalog: Catalog,
  overrides: Partial<Record<RequirementId, ObjectiveStatus | null>> = {},
  status: ObjectiveStatus = 'met',
): AssessmentInput {
  const objectiveResults: ObjectiveResult[] = catalog.requirements.flatMap((r) => {
    const s = r.id in overrides ? overrides[r.id] : status;
    if (s === null || s === undefined) return [];
    return r.objectives.map((o) => ({ objectiveId: o.id, status: s }));
  });
  return { objectiveResults, implementationLevels: {} };
}

function separately(catalog: Catalog, input: AssessmentInput, regulation?: Regulation) {
  const outcomes = deriveRequirementOutcomes(catalog, input);
  const score = computeScore(catalog, input);
  return { outcomes, score, conditional: checkConditional(catalog, outcomes, score, regulation) };
}

const firstWithPoints = (catalog: Catalog, points: number): RequirementId => {
  const r = catalog.requirements.find(
    (x) =>
      x.scoring.kind === 'points' &&
      x.scoring.points === points &&
      x.scoring.partialCredit === null,
  );
  if (r === undefined) throw new Error(`no ${String(points)}-point requirement`);
  return r.id;
};

const objectivesOf = (catalog: Catalog, id: RequirementId) => {
  const r = catalog.requirements.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no ${id}`);
  return r.objectives.map((o) => o.id);
};

function expectRulesError(fn: () => unknown, code: RulesInputError['code']): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(RulesInputError);
  expect((caught as RulesInputError).code).toBe(code);
}

describe('evaluateAssessment', () => {
  it('composes the three rules', () => {
    const fivePointer = firstWithPoints(real, 5);
    // A one-point requirement a POA&M accepts: the only way to reach Conditional status.
    const eligibleOnePointer = real.requirements.find(
      (r) =>
        r.scoring.kind === 'points' &&
        r.scoring.points === 1 &&
        !REGULATION.poamBarred.value.includes(r.id),
    )?.id;
    if (eligibleOnePointer === undefined) throw new Error('no eligible one-point requirement');
    const scenarios: [Catalog, AssessmentInput][] = [
      [fixture, inputOf(fixture)],
      [fixture, inputOf(fixture, { 'AC.L2-3.1.1': 'not_met', 'AC.L2-3.1.9': null })],
      [fixture, inputOf(fixture, { [SSP]: 'not_met' })],
      [
        fixture,
        {
          ...inputOf(fixture, { [PASSWORD]: 'not_met' }),
          implementationLevels: { [PASSWORD]: 'partial' },
        },
      ],
      [fixture, { objectiveResults: [], implementationLevels: {} }],
      [real, inputOf(real)],
      [real, inputOf(real, { [fivePointer]: 'not_met' })],
      [real, inputOf(real, { [eligibleOnePointer]: 'not_met' })],
      [real, inputOf(real, { [SSP]: 'not_met' })],
      [real, inputOf(real, {}, 'not_met')],
      [real, { objectiveResults: [], implementationLevels: {} }],
    ];
    for (const [catalog, input] of scenarios) {
      expect(evaluateAssessment(catalog, input)).toEqual(separately(catalog, input));
    }
    // The conditional half actually varies across these scenarios.
    const statuses = scenarios.map(([c, i]) => evaluateAssessment(c, i).conditional.status);
    expect(new Set(statuses)).toEqual(
      new Set(['final', 'conditional', 'not_eligible', 'incomplete']),
    );
  });

  it('passes the regulation through to the Conditional check', () => {
    const fivePointer = firstWithPoints(real, 5);
    const input = inputOf(real, { [fivePointer]: 'not_met' });
    const strict: Regulation = {
      ...REGULATION,
      conditionalMinScore: { ...REGULATION.conditionalMinScore, value: 110 },
    };
    const result = evaluateAssessment(real, input, strict);
    expect(result).toEqual(separately(real, input, strict));
    expect(result.conditional.blockers.map((b) => b.code)).toContain('below_threshold');
    expect(evaluateAssessment(real, input).conditional.blockers.map((b) => b.code)).not.toContain(
      'below_threshold',
    );
  });

  it('throws the same input errors as the rules underneath', () => {
    expectRulesError(
      () =>
        evaluateAssessment(fixture, {
          objectiveResults: [{ objectiveId: '9.9.9[a]', status: 'met' }],
          implementationLevels: {},
        }),
      'unknown_objective',
    );
    const [first] = inputOf(fixture).objectiveResults;
    if (first === undefined) throw new Error('empty fixture');
    expectRulesError(
      () =>
        evaluateAssessment(fixture, { objectiveResults: [first, first], implementationLevels: {} }),
      'duplicate_objective',
    );
  });
});

describe('applyWhatIf', () => {
  it('applies changes purely', () => {
    const base: AssessmentInput = {
      ...inputOf(fixture, { 'AC.L2-3.1.10': null }),
      implementationLevels: { [PASSWORD]: 'partial' },
    };
    const snapshot = structuredClone(base);

    // No changes: an equal input, and the argument is untouched.
    expect(applyWhatIf(fixture, base, {})).toEqual(base);
    expect(applyWhatIf(fixture, base, { objectiveStatuses: {}, implementationLevels: {} })).toEqual(
      base,
    );

    const [replaced] = objectivesOf(fixture, 'AC.L2-3.1.1');
    const missing = objectivesOf(fixture, 'AC.L2-3.1.10');
    if (replaced === undefined) throw new Error('fixture objective missing');
    const changes: WhatIfChanges = {
      objectiveStatuses: {
        [replaced]: 'not_met',
        ...Object.fromEntries(missing.map((id) => [id, 'na'])),
      },
      implementationLevels: { [PASSWORD]: null },
    };
    const next = applyWhatIf(fixture, base, changes);

    // The argument is not mutated.
    expect(base).toEqual(snapshot);
    expect(next).not.toBe(base);

    // Existing results are replaced in place, not duplicated.
    const ids = next.objectiveResults.map((r) => r.objectiveId);
    expect(new Set(ids).size).toBe(ids.length);
    const statusOf = (id: string) =>
      next.objectiveResults.find((r) => r.objectiveId === id)?.status;
    expect(statusOf(replaced)).toBe('not_met');
    expect(ids.indexOf(replaced)).toBe(
      base.objectiveResults.findIndex((r) => r.objectiveId === replaced),
    );

    // Missing results are added.
    for (const id of missing) expect(statusOf(id)).toBe('na');
    expect(next.objectiveResults).toHaveLength(base.objectiveResults.length + missing.length);

    // Untouched results keep their status.
    for (const r of base.objectiveResults) {
      if (r.objectiveId !== replaced) expect(statusOf(r.objectiveId)).toBe(r.status);
    }

    // null removes a level: the key is gone, not set to null.
    expect(PASSWORD in next.implementationLevels).toBe(false);
    expect(next.implementationLevels).toEqual({});

    // Setting a level adds it; null on a level that isn't set is a no-op.
    const withLevel = applyWhatIf(
      fixture,
      { ...base, implementationLevels: {} },
      { implementationLevels: { [PASSWORD]: 'none' } },
    );
    expect(withLevel.implementationLevels).toEqual({ [PASSWORD]: 'none' });
    expect(applyWhatIf(fixture, next, { implementationLevels: { [PASSWORD]: null } })).toEqual(
      next,
    );

    // The result feeds straight into evaluateAssessment.
    expect(
      evaluateAssessment(fixture, next).outcomes.find((o) => o.requirementId === 'AC.L2-3.1.1')
        ?.status,
    ).toBe('not_met');
  });

  it('works on the real catalog', () => {
    const base = inputOf(real);
    const ssp = objectivesOf(real, SSP);
    const next = applyWhatIf(real, base, {
      objectiveStatuses: Object.fromEntries(ssp.map((id) => [id, 'not_met'])),
      implementationLevels: { 'SC.L2-3.13.11': 'partial' },
    });
    expect(next.objectiveResults).toHaveLength(base.objectiveResults.length);
    expect(next.implementationLevels).toEqual({ 'SC.L2-3.13.11': 'partial' });
    expect(evaluateAssessment(real, next).score.kind).toBe('incomplete');
  });

  it('what-if keeps open POA&M list', () => {
    const covered = 'AC.L2-3.1.10';
    const uncovered = 'AU.L2-3.3.3';
    const list = [covered];
    const base: AssessmentInput = {
      ...inputOf(real, { [covered]: 'not_met' }),
      openPoamRequirementIds: list,
    };
    expect(evaluateAssessment(real, base).conditional).toEqual({
      status: 'conditional',
      blockers: [],
    });

    // The list survives a what-if as an equal copy, not the same array.
    const next = applyWhatIf(real, base, {
      objectiveStatuses: Object.fromEntries(
        objectivesOf(real, uncovered).map((id) => [id, 'not_met']),
      ),
    });
    expect(next.openPoamRequirementIds).toEqual([covered]);
    expect(next.openPoamRequirementIds).not.toBe(list);
    expect(applyWhatIf(real, base, {}).openPoamRequirementIds).toEqual([covered]);

    // Turning a requirement Not Met with no item shows poam_missing, in the what-if only.
    expect(evaluateAssessment(real, next).conditional).toEqual({
      status: 'not_eligible',
      blockers: [
        {
          code: 'poam_missing',
          requirementId: uncovered,
          citation: REGULATION.poamRequiredForNotMet.citation,
        },
      ],
    });
    expect(list).toEqual([covered]);

    // An input without the list gets none back: the key stays absent.
    const without = applyWhatIf(real, inputOf(real), {});
    expect('openPoamRequirementIds' in without).toBe(false);
  });

  it('rejects invalid changes', () => {
    const base = inputOf(fixture);
    const snapshot = structuredClone(base);
    expectRulesError(
      () => applyWhatIf(fixture, base, { objectiveStatuses: { '9.9.9[a]': 'met' } }),
      'unknown_objective',
    );
    expectRulesError(
      () => applyWhatIf(fixture, base, { implementationLevels: { 'AC.L2-3.1.1': 'partial' } }),
      'invalid_implementation_level',
    );
    // null on a requirement without partial credit is rejected too: it is never a valid target.
    expectRulesError(
      () => applyWhatIf(fixture, base, { implementationLevels: { 'AC.L2-3.1.1': null } }),
      'invalid_implementation_level',
    );
    expectRulesError(
      () => applyWhatIf(fixture, base, { implementationLevels: { 'ZZ.L2-9.9.9': 'none' } }),
      'unknown_requirement',
    );
    // The prerequisite has no points, so no partial credit.
    expectRulesError(
      () => applyWhatIf(real, inputOf(real), { implementationLevels: { [SSP]: 'partial' } }),
      'invalid_implementation_level',
    );
    expect(base).toEqual(snapshot);
  });
});

describe('compareEvaluations', () => {
  it('compares evaluations', () => {
    const base = inputOf(real);
    const saved = evaluateAssessment(real, base);

    // Identical next: delta 0, no changes.
    expect(compareEvaluations(saved, evaluateAssessment(real, base))).toEqual({
      scoreDelta: 0,
      changed: [],
    });

    // One Not Met 5-point requirement: -5, one change.
    const fivePointer = firstWithPoints(real, 5);
    const failFive = applyWhatIf(real, base, {
      objectiveStatuses: Object.fromEntries(
        objectivesOf(real, fivePointer).map((id) => [id, 'not_met']),
      ),
    });
    expect(compareEvaluations(saved, evaluateAssessment(real, failFive))).toEqual({
      scoreDelta: -5,
      changed: [{ requirementId: fivePointer, from: 'met', to: 'not_met' }],
    });

    // 3.12.4 not met: the next score is incomplete, so the delta is null.
    const failSsp = applyWhatIf(real, base, {
      objectiveStatuses: Object.fromEntries(objectivesOf(real, SSP).map((id) => [id, 'not_met'])),
    });
    const sspDiff = compareEvaluations(saved, evaluateAssessment(real, failSsp));
    expect(sspDiff).toEqual({
      scoreDelta: null,
      changed: [{ requirementId: SSP, from: 'met', to: 'not_met' }],
    });
    // And the other way round: an incomplete saved score also gives null.
    expect(compareEvaluations(evaluateAssessment(real, failSsp), saved).scoreDelta).toBeNull();
  });

  it('lists changes in catalog order and counts a level change in the delta', () => {
    const base = inputOf(real);
    const saved = evaluateAssessment(real, base);
    const ids = real.requirements.map((r) => r.id);
    const last = ids[ids.length - 1];
    const first = ids[0];
    if (first === undefined || last === undefined) throw new Error('empty catalog');
    // Changes given last-first still come back in catalog order.
    const next = applyWhatIf(real, base, {
      objectiveStatuses: Object.fromEntries([
        ...objectivesOf(real, last).map((id): [string, ObjectiveStatus] => [id, 'not_assessed']),
        ...objectivesOf(real, first).map((id): [string, ObjectiveStatus] => [id, 'not_met']),
      ]),
    });
    expect(compareEvaluations(saved, evaluateAssessment(real, next)).changed).toEqual([
      { requirementId: first, from: 'met', to: 'not_met' },
      { requirementId: last, from: 'met', to: 'not_assessed' },
    ]);

    // 3.5.3 Not Met with no level deducts 5; at partial it deducts 3: +2, no status change.
    const failPassword = applyWhatIf(real, base, {
      objectiveStatuses: Object.fromEntries(
        objectivesOf(real, PASSWORD).map((id) => [id, 'not_met']),
      ),
    });
    const partial = applyWhatIf(real, failPassword, {
      implementationLevels: { [PASSWORD]: 'partial' },
    });
    expect(
      compareEvaluations(evaluateAssessment(real, failPassword), evaluateAssessment(real, partial)),
    ).toEqual({
      scoreDelta: 2,
      changed: [],
    });
  });
});
