import type { Catalog, RequirementId } from '@rampart/catalog';
import { describe, expect, it } from 'vitest';
import type {
  AssessmentInput,
  ImplementationLevel,
  ObjectiveResult,
  ObjectiveStatus,
} from './types';
import { computeScore, scoreFloor, scoreMax } from './index';
import {
  CFR_SCORING,
  DEFAULT_SPECS,
  fixtureCatalog,
  type FixtureSpec,
} from './testing/fixture-catalog';

const catalog = fixtureCatalog();
// Default fixture: 6 requirements; worst case 5 + 3 + 1 + 1 + 5 = 15 points.
const MAX = 6;
const FLOOR = MAX - 15;

/**
 * Every objective met, except the requirements in `overrides`, whose objectives all take the
 * given status. `null` leaves a requirement with no results.
 */
function results(
  overrides: Partial<Record<RequirementId, ObjectiveStatus | null>> = {},
  from: Catalog = catalog,
): ObjectiveResult[] {
  return from.requirements.flatMap((requirement) => {
    const status = requirement.id in overrides ? overrides[requirement.id] : 'met';
    if (status === null || status === undefined) return [];
    return requirement.objectives.map((o) => ({ objectiveId: o.id, status }));
  });
}

function input(
  objectiveResults: ObjectiveResult[],
  implementationLevels: Partial<Record<RequirementId, ImplementationLevel>> = {},
): AssessmentInput {
  return { objectiveResults, implementationLevels };
}

describe('scores from requirement outcomes', () => {
  const table: {
    name: string;
    cite: string;
    overrides: Partial<Record<RequirementId, ObjectiveStatus | null>>;
    score: number;
    deductions: { requirementId: RequirementId; points: number }[];
    notAssessed: RequirementId[];
  }[] = [
    {
      name: 'all met scores max',
      cite: CFR_SCORING,
      overrides: {},
      score: MAX,
      deductions: [],
      notAssessed: [],
    },
    {
      name: 'a 5-point not_met deducts 5',
      cite: CFR_SCORING,
      overrides: { 'AC.L2-3.1.1': 'not_met' },
      score: MAX - 5,
      deductions: [{ requirementId: 'AC.L2-3.1.1', points: 5 }],
      notAssessed: [],
    },
    {
      name: 'a 3-point not_met deducts 3',
      cite: CFR_SCORING,
      overrides: { 'AC.L2-3.1.5': 'not_met' },
      score: MAX - 3,
      deductions: [{ requirementId: 'AC.L2-3.1.5', points: 3 }],
      notAssessed: [],
    },
    {
      name: 'a 1-point not_met deducts 1',
      cite: CFR_SCORING,
      overrides: { 'AC.L2-3.1.10': 'not_met' },
      score: MAX - 1,
      deductions: [{ requirementId: 'AC.L2-3.1.10', points: 1 }],
      notAssessed: [],
    },
    {
      name: 'every points requirement not_met reaches the floor',
      cite: CFR_SCORING,
      overrides: {
        'AC.L2-3.1.1': 'not_met',
        'AC.L2-3.1.5': 'not_met',
        'AC.L2-3.1.9': 'not_met',
        'AC.L2-3.1.10': 'not_met',
        'IA.L2-3.5.3': 'not_met',
      },
      score: FLOOR,
      deductions: [
        { requirementId: 'AC.L2-3.1.1', points: 5 },
        { requirementId: 'AC.L2-3.1.5', points: 3 },
        { requirementId: 'AC.L2-3.1.9', points: 1 },
        { requirementId: 'AC.L2-3.1.10', points: 1 },
        { requirementId: 'IA.L2-3.5.3', points: 5 },
      ],
      notAssessed: [],
    },
    {
      name: 'not_assessed deducts 0 and is listed',
      cite: CFR_SCORING,
      overrides: { 'AC.L2-3.1.1': 'not_assessed' },
      score: MAX,
      deductions: [],
      notAssessed: ['AC.L2-3.1.1'],
    },
    {
      name: 'a requirement with no results deducts 0 and is listed',
      cite: CFR_SCORING,
      overrides: { 'AC.L2-3.1.5': null },
      score: MAX,
      deductions: [],
      notAssessed: ['AC.L2-3.1.5'],
    },
    {
      name: 'an all-na requirement counts as met',
      cite: CFR_SCORING,
      overrides: { 'AC.L2-3.1.1': 'na' },
      score: MAX,
      deductions: [],
      notAssessed: [],
    },
    {
      name: 'not_met deducts while not_assessed is listed',
      cite: CFR_SCORING,
      overrides: { 'AC.L2-3.1.5': 'not_met', 'AC.L2-3.1.9': null, 'IA.L2-3.5.3': 'not_assessed' },
      score: MAX - 3,
      deductions: [{ requirementId: 'AC.L2-3.1.5', points: 3 }],
      notAssessed: ['AC.L2-3.1.9', 'IA.L2-3.5.3'],
    },
  ];

  it.each(table)('$name ($cite)', ({ overrides, score, deductions, notAssessed }) => {
    expect(computeScore(catalog, input(results(overrides)))).toEqual({
      kind: 'scored',
      score,
      max: MAX,
      floor: FLOOR,
      deductions,
      notAssessed,
    });
  });

  it(`a score can go below zero, down to the floor, with no clamp (${CFR_SCORING})`, () => {
    const result = computeScore(
      catalog,
      input(results({ 'AC.L2-3.1.1': 'not_met', 'AC.L2-3.1.5': 'not_met' })),
    );
    expect(result).toMatchObject({ kind: 'scored', score: -2 });
  });
});

describe('partial credit levels', () => {
  const table: {
    name: string;
    cite: string;
    status: ObjectiveStatus;
    level: ImplementationLevel | undefined;
    deducted: number;
  }[] = [
    {
      name: 'not_met at partial deducts 3',
      cite: CFR_SCORING,
      status: 'not_met',
      level: 'partial',
      deducted: 3,
    },
    {
      name: 'not_met at none deducts 5',
      cite: CFR_SCORING,
      status: 'not_met',
      level: 'none',
      deducted: 5,
    },
    {
      name: 'not_met with no level deducts 5 (worst case)',
      cite: CFR_SCORING,
      status: 'not_met',
      level: undefined,
      deducted: 5,
    },
    {
      name: 'met at partial deducts 0',
      cite: CFR_SCORING,
      status: 'met',
      level: 'partial',
      deducted: 0,
    },
    { name: 'met at none deducts 0', cite: CFR_SCORING, status: 'met', level: 'none', deducted: 0 },
    {
      name: 'met with no level deducts 0',
      cite: CFR_SCORING,
      status: 'met',
      level: undefined,
      deducted: 0,
    },
    {
      name: 'not_assessed at partial deducts 0',
      cite: CFR_SCORING,
      status: 'not_assessed',
      level: 'partial',
      deducted: 0,
    },
    {
      name: 'all na at none deducts 0',
      cite: CFR_SCORING,
      status: 'na',
      level: 'none',
      deducted: 0,
    },
  ];

  it.each(table)('$name ($cite)', ({ status, level, deducted }) => {
    const levels: Partial<Record<RequirementId, ImplementationLevel>> =
      level === undefined ? {} : { 'IA.L2-3.5.3': level };
    const result = computeScore(catalog, input(results({ 'IA.L2-3.5.3': status }), levels));
    expect(result).toMatchObject({
      kind: 'scored',
      score: MAX - deducted,
      deductions: deducted === 0 ? [] : [{ requirementId: 'IA.L2-3.5.3', points: deducted }],
    });
  });

  it(`a level on a non-partial requirement still throws through computeScore (${CFR_SCORING})`, () => {
    expect(() =>
      computeScore(
        catalog,
        input(results({ 'AC.L2-3.1.1': 'not_met' }), { 'AC.L2-3.1.1': 'partial' }),
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_implementation_level' }));
  });
});

describe('prerequisite makes the result incomplete', () => {
  const table: {
    name: string;
    cite: string;
    objectiveResults: ObjectiveResult[];
    notAssessed: RequirementId[];
  }[] = [
    {
      name: 'the prerequisite not_met',
      cite: CFR_SCORING,
      objectiveResults: results({ 'CA.L2-3.12.4': 'not_met' }),
      notAssessed: [],
    },
    {
      name: 'one prerequisite objective not_met, the other met',
      cite: CFR_SCORING,
      objectiveResults: [
        ...results({ 'CA.L2-3.12.4': null }),
        { objectiveId: '3.12.4[a]', status: 'met' },
        { objectiveId: '3.12.4[b]', status: 'not_met' },
      ],
      notAssessed: [],
    },
    {
      name: 'the prerequisite not_assessed',
      cite: CFR_SCORING,
      objectiveResults: results({ 'CA.L2-3.12.4': 'not_assessed' }),
      notAssessed: ['CA.L2-3.12.4'],
    },
    {
      name: 'the prerequisite with no results',
      cite: CFR_SCORING,
      objectiveResults: results({ 'CA.L2-3.12.4': null }),
      notAssessed: ['CA.L2-3.12.4'],
    },
    {
      name: 'one prerequisite objective na (an SSP cannot be not applicable)',
      cite: CFR_SCORING,
      objectiveResults: [
        ...results({ 'CA.L2-3.12.4': null }),
        { objectiveId: '3.12.4[a]', status: 'met' },
        { objectiveId: '3.12.4[b]', status: 'na' },
      ],
      notAssessed: [],
    },
    {
      name: 'every prerequisite objective na',
      cite: CFR_SCORING,
      objectiveResults: results({ 'CA.L2-3.12.4': 'na' }),
      notAssessed: [],
    },
    {
      name: 'an empty assessment',
      cite: CFR_SCORING,
      objectiveResults: [],
      notAssessed: DEFAULT_SPECS.map((s) => s.id),
    },
  ];

  it.each(table)('$name gives incomplete ($cite)', ({ objectiveResults, notAssessed }) => {
    const result = computeScore(catalog, input(objectiveResults));
    expect(result).toEqual({
      kind: 'incomplete',
      reason: 'prerequisite_not_met',
      prerequisites: ['CA.L2-3.12.4'],
      max: MAX,
      floor: FLOOR,
      notAssessed,
    });
    expect(result).not.toHaveProperty('score');
  });

  it(`an incomplete result still lists other not_assessed requirements (${CFR_SCORING})`, () => {
    const result = computeScore(
      catalog,
      input(
        results({
          'CA.L2-3.12.4': 'not_met',
          'AC.L2-3.1.5': 'not_assessed',
          'AC.L2-3.1.1': 'not_met',
        }),
      ),
    );
    expect(result).toMatchObject({ kind: 'incomplete', notAssessed: ['AC.L2-3.1.5'] });
  });

  it(`every failing prerequisite is listed in catalog order (${CFR_SCORING})`, () => {
    const specs: FixtureSpec[] = [
      { id: 'AC.L2-3.1.1', kind: 'prerequisite', objectives: 1 },
      { id: 'AC.L2-3.1.2', kind: 'points', points: 1, objectives: 1 },
      { id: 'CA.L2-3.12.4', kind: 'prerequisite', objectives: 1 },
    ];
    const twoPrereqs = fixtureCatalog(specs);
    expect(computeScore(twoPrereqs, input([]))).toMatchObject({
      kind: 'incomplete',
      prerequisites: ['AC.L2-3.1.1', 'CA.L2-3.12.4'],
    });
    expect(
      computeScore(
        twoPrereqs,
        input(results({ 'AC.L2-3.1.1': 'met', 'CA.L2-3.12.4': 'not_met' }, twoPrereqs)),
      ),
    ).toMatchObject({ kind: 'incomplete', prerequisites: ['CA.L2-3.12.4'] });
  });

  it(`a prerequisite with no objectives in the data is never vacuously met (${CFR_SCORING})`, () => {
    const empty = fixtureCatalog([{ id: 'CA.L2-3.12.4', kind: 'prerequisite', objectives: 0 }]);
    expect(computeScore(empty, input([]))).toMatchObject({
      kind: 'incomplete',
      prerequisites: ['CA.L2-3.12.4'],
    });
  });

  it(`a fully met prerequisite gives a score and deducts nothing itself (${CFR_SCORING})`, () => {
    expect(computeScore(catalog, input(results()))).toMatchObject({ kind: 'scored', score: MAX });
  });
});

describe('max and floor are derived from data', () => {
  it(`max is the requirement count and floor is max minus the worst-case points (${CFR_SCORING})`, () => {
    expect(scoreMax(catalog)).toBe(MAX);
    expect(scoreFloor(catalog)).toBe(FLOOR);
  });

  it(`changing a fixture's points changes the floor (${CFR_SCORING})`, () => {
    const lighter = fixtureCatalog(
      DEFAULT_SPECS.map((spec) =>
        spec.id === 'AC.L2-3.1.1' ? { ...spec, kind: 'points', points: 1 } : spec,
      ),
    );
    expect(scoreMax(lighter)).toBe(MAX);
    expect(scoreFloor(lighter)).toBe(FLOOR + 4);
  });

  it(`adding a requirement raises max by one and the floor by one minus its points (${CFR_SCORING})`, () => {
    const bigger = fixtureCatalog([
      ...DEFAULT_SPECS,
      { id: 'SC.L2-3.13.1', kind: 'points', points: 5, objectives: 1 },
    ]);
    expect(scoreMax(bigger)).toBe(MAX + 1);
    expect(scoreFloor(bigger)).toBe(FLOOR + 1 - 5);
  });

  it(`the prerequisite counts toward max but adds no worst-case points (${CFR_SCORING})`, () => {
    const prereqOnly = fixtureCatalog([
      { id: 'CA.L2-3.12.4', kind: 'prerequisite', objectives: 1 },
    ]);
    expect(scoreMax(prereqOnly)).toBe(1);
    expect(scoreFloor(prereqOnly)).toBe(1);
  });

  it(`computeScore reports the same max and floor (${CFR_SCORING})`, () => {
    expect(computeScore(catalog, input(results()))).toMatchObject({ max: MAX, floor: FLOOR });
  });
});

describe('pure and deterministic', () => {
  function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
      for (const inner of Object.values(value)) deepFreeze(inner);
      Object.freeze(value);
    }
    return value;
  }

  const overrides = {
    'AC.L2-3.1.1': 'not_met',
    'AC.L2-3.1.5': 'not_assessed',
    'IA.L2-3.5.3': 'not_met',
    'AC.L2-3.1.10': 'not_met',
  } as const;

  it(`does not mutate the catalog or the input (${CFR_SCORING})`, () => {
    const frozenCatalog = deepFreeze(fixtureCatalog());
    const frozenInput = deepFreeze(input(results(overrides), { 'IA.L2-3.5.3': 'partial' }));
    const catalogBefore = structuredClone(frozenCatalog);
    const inputBefore = structuredClone(frozenInput);
    expect(() => computeScore(frozenCatalog, frozenInput)).not.toThrow();
    expect(frozenCatalog).toEqual(catalogBefore);
    expect(frozenInput).toEqual(inputBefore);
  });

  it(`repeat calls give equal results with deductions in catalog order (${CFR_SCORING})`, () => {
    const forward = input(results(overrides), { 'IA.L2-3.5.3': 'partial' });
    const reversed = input([...results(overrides)].reverse(), { 'IA.L2-3.5.3': 'partial' });
    const first = computeScore(catalog, forward);
    expect(computeScore(catalog, forward)).toEqual(first);
    expect(computeScore(catalog, reversed)).toEqual(first);
    expect(first).toMatchObject({
      kind: 'scored',
      deductions: [
        { requirementId: 'AC.L2-3.1.1', points: 5 },
        { requirementId: 'AC.L2-3.1.10', points: 1 },
        { requirementId: 'IA.L2-3.5.3', points: 3 },
      ],
      notAssessed: ['AC.L2-3.1.5'],
    });
  });

  it(`returns fresh arrays, so changing a result does not change the next one (${CFR_SCORING})`, () => {
    const assessment = input(results(overrides));
    const first = computeScore(catalog, assessment);
    if (first.kind !== 'scored') throw new Error('expected a scored result');
    first.deductions.push({ requirementId: 'AC.L2-3.1.9', points: 1 });
    first.notAssessed.length = 0;
    expect(computeScore(catalog, assessment)).toMatchObject({
      deductions: [
        { requirementId: 'AC.L2-3.1.1', points: 5 },
        { requirementId: 'AC.L2-3.1.10', points: 1 },
        { requirementId: 'IA.L2-3.5.3', points: 5 },
      ],
      notAssessed: ['AC.L2-3.1.5'],
    });
  });
});
