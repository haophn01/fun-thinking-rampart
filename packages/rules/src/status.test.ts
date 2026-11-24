import { describe, expect, it } from 'vitest';
import type { AssessmentInput, ObjectiveResult, ObjectiveStatus } from './types';
import { RulesInputError } from './errors';
import { deriveRequirementOutcomes } from './index';
import {
  CFR_SCORING,
  PLAN_OBJECTIVES,
  fixtureCatalog,
  objectiveIds,
  type FixtureSpec,
} from './testing/fixture-catalog';

const catalog = fixtureCatalog();

function input(
  objectiveResults: ObjectiveResult[],
  implementationLevels: AssessmentInput['implementationLevels'] = {},
): AssessmentInput {
  return { objectiveResults, implementationLevels };
}

/** Results for 3.1.1[a], [b], [c] in order; `undefined` leaves that objective without a result. */
function on311(...statuses: (ObjectiveStatus | undefined)[]): ObjectiveResult[] {
  return objectiveIds('AC.L2-3.1.1', 3).flatMap((objectiveId, i) => {
    const status = statuses[i];
    return status === undefined ? [] : [{ objectiveId, status }];
  });
}

function outcomeOf311(results: ObjectiveResult[]) {
  return deriveRequirementOutcomes(catalog, input(results)).find(
    (o) => o.requirementId === 'AC.L2-3.1.1',
  );
}

describe('derives requirement status', () => {
  const table: {
    name: string;
    cite: string;
    statuses: (ObjectiveStatus | undefined)[];
    status: 'met' | 'not_met' | 'not_assessed';
    allNa: boolean;
  }[] = [
    {
      name: 'all met',
      cite: PLAN_OBJECTIVES,
      statuses: ['met', 'met', 'met'],
      status: 'met',
      allNa: false,
    },
    {
      name: 'one not_met among met',
      cite: PLAN_OBJECTIVES,
      statuses: ['met', 'not_met', 'met'],
      status: 'not_met',
      allNa: false,
    },
    {
      name: 'not_met wins over not_assessed',
      cite: PLAN_OBJECTIVES,
      statuses: ['not_assessed', 'not_met', 'met'],
      status: 'not_met',
      allNa: false,
    },
    {
      name: 'not_met wins over a missing result',
      cite: PLAN_OBJECTIVES,
      statuses: ['not_met', undefined, undefined],
      status: 'not_met',
      allNa: false,
    },
    {
      name: 'not_met wins over na',
      cite: PLAN_OBJECTIVES,
      statuses: ['na', 'na', 'not_met'],
      status: 'not_met',
      allNa: false,
    },
    {
      name: 'one not_assessed among met',
      cite: PLAN_OBJECTIVES,
      statuses: ['met', 'not_assessed', 'met'],
      status: 'not_assessed',
      allNa: false,
    },
    {
      name: 'one missing result among met',
      cite: PLAN_OBJECTIVES,
      statuses: ['met', 'met', undefined],
      status: 'not_assessed',
      allNa: false,
    },
    {
      name: 'no results at all',
      cite: PLAN_OBJECTIVES,
      statuses: [],
      status: 'not_assessed',
      allNa: false,
    },
    {
      name: 'na plus a missing result',
      cite: PLAN_OBJECTIVES,
      statuses: ['na', 'na', undefined],
      status: 'not_assessed',
      allNa: false,
    },
    {
      name: 'met plus na',
      cite: PLAN_OBJECTIVES,
      statuses: ['met', 'na', 'met'],
      status: 'met',
      allNa: false,
    },
    {
      name: 'all na counts as met',
      cite: `${PLAN_OBJECTIVES}; ${CFR_SCORING}`,
      statuses: ['na', 'na', 'na'],
      status: 'met',
      allNa: true,
    },
  ];

  it.each(table)('$name gives $status ($cite)', ({ statuses, status, allNa }) => {
    expect(outcomeOf311(on311(...statuses))).toMatchObject({ status, allNa });
  });

  it(`counts each objective once, a missing result as not_assessed (${PLAN_OBJECTIVES})`, () => {
    expect(outcomeOf311(on311('met', 'na', undefined))?.counts).toEqual({
      met: 1,
      not_met: 0,
      na: 1,
      not_assessed: 1,
    });
    expect(outcomeOf311(on311('not_met', 'not_assessed', 'not_met'))?.counts).toEqual({
      met: 0,
      not_met: 2,
      na: 0,
      not_assessed: 1,
    });
  });

  it(`returns one outcome per requirement in catalog order, 3.1.9 before 3.1.10 (${PLAN_OBJECTIVES})`, () => {
    const outcomes = deriveRequirementOutcomes(catalog, input([]));
    expect(outcomes.map((o) => o.requirementId)).toEqual(catalog.requirements.map((r) => r.id));
    expect(outcomes.map((o) => o.requirementId)).toEqual([
      'AC.L2-3.1.1',
      'AC.L2-3.1.5',
      'AC.L2-3.1.9',
      'AC.L2-3.1.10',
      'IA.L2-3.5.3',
      'CA.L2-3.12.4',
    ]);
  });

  it(`reads results for every requirement, whatever order they arrive in (${PLAN_OBJECTIVES})`, () => {
    const outcomes = deriveRequirementOutcomes(
      catalog,
      input([
        { objectiveId: '3.12.4[b]', status: 'met' },
        { objectiveId: '3.1.10[a]', status: 'not_met' },
        { objectiveId: '3.12.4[a]', status: 'met' },
        { objectiveId: '3.1.9[a]', status: 'na' },
      ]),
    );
    expect(Object.fromEntries(outcomes.map((o) => [o.requirementId, o.status]))).toEqual({
      'AC.L2-3.1.1': 'not_assessed',
      'AC.L2-3.1.5': 'not_assessed',
      'AC.L2-3.1.9': 'met',
      'AC.L2-3.1.10': 'not_met',
      'IA.L2-3.5.3': 'not_assessed',
      'CA.L2-3.12.4': 'met',
    });
  });

  it(`a requirement with no objectives in the data is not_assessed, never a vacuous met (${PLAN_OBJECTIVES})`, () => {
    const specs: FixtureSpec[] = [{ id: 'AC.L2-3.1.1', kind: 'points', points: 1, objectives: 0 }];
    const [outcome] = deriveRequirementOutcomes(fixtureCatalog(specs), input([]));
    expect(outcome?.status).toBe('not_assessed');
    expect(outcome?.allNa).toBe(false);
  });

  it(`records the implementation level of a partial-credit requirement, null otherwise (${CFR_SCORING})`, () => {
    const levels = (implementationLevels: AssessmentInput['implementationLevels']) =>
      Object.fromEntries(
        deriveRequirementOutcomes(catalog, input([], implementationLevels)).map((o) => [
          o.requirementId,
          o.implementationLevel,
        ]),
      );
    expect(levels({ 'IA.L2-3.5.3': 'partial' })['IA.L2-3.5.3']).toBe('partial');
    expect(levels({ 'IA.L2-3.5.3': 'none' })['IA.L2-3.5.3']).toBe('none');
    expect(levels({})['IA.L2-3.5.3']).toBeNull();
    expect(levels({ 'IA.L2-3.5.3': 'partial' })['AC.L2-3.1.1']).toBeNull();
  });
});

describe('rejects invalid input', () => {
  const table: {
    name: string;
    cite: string;
    input: AssessmentInput;
    code: RulesInputError['code'];
  }[] = [
    {
      name: 'an objective ID not in the catalog',
      cite: PLAN_OBJECTIVES,
      input: input([{ objectiveId: '3.1.1[z]', status: 'met' }]),
      code: 'unknown_objective',
    },
    {
      name: 'an object-prototype key as an objective ID',
      cite: PLAN_OBJECTIVES,
      input: input([{ objectiveId: 'constructor', status: 'met' }]),
      code: 'unknown_objective',
    },
    {
      name: 'the same objective twice with different statuses',
      cite: PLAN_OBJECTIVES,
      input: input([
        { objectiveId: '3.1.1[a]', status: 'met' },
        { objectiveId: '3.1.1[a]', status: 'not_met' },
      ]),
      code: 'duplicate_objective',
    },
    {
      name: 'the same objective twice with the same status',
      cite: PLAN_OBJECTIVES,
      input: input([
        { objectiveId: '3.1.9[a]', status: 'met' },
        { objectiveId: '3.1.9[a]', status: 'met' },
      ]),
      code: 'duplicate_objective',
    },
    {
      name: 'a level on a points requirement without partial credit',
      cite: CFR_SCORING,
      input: input([], { 'AC.L2-3.1.1': 'partial' }),
      code: 'invalid_implementation_level',
    },
    {
      name: 'a level of none on a requirement without partial credit',
      cite: CFR_SCORING,
      input: input([], { 'AC.L2-3.1.5': 'none' }),
      code: 'invalid_implementation_level',
    },
    {
      name: 'a level on the prerequisite',
      cite: CFR_SCORING,
      input: input([], { 'CA.L2-3.12.4': 'partial' }),
      code: 'invalid_implementation_level',
    },
    {
      name: 'a level value outside none and partial',
      cite: CFR_SCORING,
      input: {
        objectiveResults: [],
        implementationLevels: JSON.parse(
          '{"IA.L2-3.5.3":"full"}',
        ) as AssessmentInput['implementationLevels'],
      },
      code: 'invalid_implementation_level',
    },
    {
      name: 'a level on an unknown requirement',
      cite: CFR_SCORING,
      input: input([], { 'SC.L2-3.13.11': 'partial' }),
      code: 'unknown_requirement',
    },
  ];

  it.each(table)('$name throws $code ($cite)', ({ input: bad, code }) => {
    let thrown: unknown;
    try {
      deriveRequirementOutcomes(catalog, bad);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RulesInputError);
    expect((thrown as RulesInputError).code).toBe(code);
    expect((thrown as RulesInputError).name).toBe('RulesInputError');
  });

  it(`accepts both levels on a partial-credit requirement (${CFR_SCORING})`, () => {
    expect(() =>
      deriveRequirementOutcomes(catalog, input([], { 'IA.L2-3.5.3': 'partial' })),
    ).not.toThrow();
    expect(() =>
      deriveRequirementOutcomes(catalog, input([], { 'IA.L2-3.5.3': 'none' })),
    ).not.toThrow();
  });
});
