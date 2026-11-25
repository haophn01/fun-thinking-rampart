import { getRequirement, loadCatalog } from '@rampart/catalog';
import type { RequirementId } from '@rampart/catalog';
import { describe, expect, it } from 'vitest';
import { checkConditional, checkPoamEligibility, REGULATION } from './poam';
import type { ImplementationLevel, ObjectiveResult } from './types';
import { computeScore, deriveRequirementOutcomes, scoreFloor, scoreMax } from './index';

// R1 and R2 run against the real catalog. Scenarios are built from catalog data and
// requirements are picked by their points, not by ID, except the IDs the plan names:
// 3.12.4 (SSP prerequisite), 3.5.3 and 3.13.11 (partial credit), 3.1.20 (barred, main flow).
const catalog = loadCatalog();
const SSP = 'CA.L2-3.12.4';
const BARRED_FIRST = 'AC.L2-3.1.20';
const ENCRYPTION = 'SC.L2-3.13.11';
const PASSWORD = 'IA.L2-3.5.3';

const pointsOf = (id: RequirementId): number => {
  const r = getRequirement(catalog, id);
  if (r === undefined || r.scoring.kind !== 'points') throw new Error(`${id} has no points`);
  return r.scoring.points;
};

/** Points requirements (not the prerequisite) with this point value, in catalog order. */
const withPoints = (points: 1 | 3 | 5): RequirementId[] =>
  catalog.requirements
    .filter((r) => r.scoring.kind === 'points' && r.scoring.points === points)
    .map((r) => r.id);

interface Scenario {
  notMet?: readonly RequirementId[];
  levels?: Partial<Record<RequirementId, ImplementationLevel>>;
}

/** Every objective of every requirement is met, except all objectives of the `notMet` ones. */
function build({ notMet = [], levels = {} }: Scenario) {
  const failing = new Set(notMet);
  const objectiveResults: ObjectiveResult[] = catalog.requirements.flatMap((r) =>
    r.objectives.map((o) => ({
      objectiveId: o.id,
      status: failing.has(r.id) ? 'not_met' : 'met',
    })),
  );
  const input = { objectiveResults, implementationLevels: levels };
  const outcomes = deriveRequirementOutcomes(catalog, input);
  const score = computeScore(catalog, input);
  return { input, outcomes, score, conditional: checkConditional(catalog, outcomes, score) };
}

const scoreOf = (s: Scenario): number => {
  const { score } = build(s);
  if (score.kind !== 'scored') throw new Error('expected a scored result');
  return score.score;
};

/** Barred requirements, which can never be on a POA&M. */
const BARRED = new Set(REGULATION.poamBarred.value);

/** `count` one-point requirements that a POA&M accepts, in catalog order. */
const eligibleOnePointers = (count: number): RequirementId[] => {
  const ids = withPoints(1).filter((id) => !BARRED.has(id));
  if (ids.length < count) throw new Error('the catalog has too few one-point requirements');
  return ids.slice(0, count);
};

describe('extremes on the real catalog', () => {
  it('scores 110 when everything is met', () => {
    expect(scoreMax(catalog)).toBe(110);
    expect(build({}).score).toMatchObject({ kind: 'scored', score: 110, max: 110, deductions: [] });
  });

  it('scores -203 when every points requirement is not met and 3.12.4 is met', () => {
    const pointsIds = catalog.requirements
      .filter((r) => r.scoring.kind === 'points')
      .map((r) => r.id);
    const { score } = build({ notMet: pointsIds });
    expect(score).toMatchObject({ kind: 'scored', score: -203 });
    expect(scoreFloor(catalog)).toBe(-203);
    if (score.kind === 'scored') expect(score.score).toBe(score.floor);
  });
});

describe('missing SSP is incomplete', () => {
  it('gives incomplete with 3.12.4 as the unmet prerequisite and a cited blocker', () => {
    const { score, conditional } = build({ notMet: [SSP] });
    expect(score).toMatchObject({
      kind: 'incomplete',
      reason: 'prerequisite_not_met',
      prerequisites: [SSP],
    });
    expect(conditional.status).toBe('incomplete');
    const ssp = getRequirement(catalog, SSP);
    expect(ssp?.scoring.citation).toBe('32 CFR 170.24(c)(2)(i)(B)(5)');
    expect(conditional.blockers).toContainEqual({
      code: 'prerequisite_not_met',
      requirementId: SSP,
      citation: ssp?.scoring.citation,
    });
  });
});

describe('partial credit on real data', () => {
  it.each([PASSWORD, ENCRYPTION])('%s deducts 3 at partial and 5 at none', (id) => {
    expect(pointsOf(id)).toBe(5);
    expect(scoreOf({ notMet: [id], levels: { [id]: 'partial' } })).toBe(110 - 3);
    expect(scoreOf({ notMet: [id], levels: { [id]: 'none' } })).toBe(110 - 5);
    expect(scoreOf({ notMet: [id] })).toBe(110 - 5);
  });

  it('only these two requirements take an implementation level', () => {
    const withPartial = catalog.requirements
      .filter((r) => r.scoring.kind === 'points' && r.scoring.partialCredit !== null)
      .map((r) => r.id);
    expect(withPartial.sort()).toEqual([PASSWORD, ENCRYPTION].sort());
  });
});

describe('threshold on real data', () => {
  it('a built 88 is conditional', () => {
    const { score, conditional } = build({ notMet: eligibleOnePointers(22) });
    expect(score).toMatchObject({ kind: 'scored', score: 88 });
    expect(conditional).toEqual({ status: 'conditional', blockers: [] });
  });

  it('a built 87 is below_threshold', () => {
    const { score, conditional } = build({ notMet: eligibleOnePointers(23) });
    expect(score).toMatchObject({ kind: 'scored', score: 87 });
    expect(conditional.status).toBe('not_eligible');
    expect(conditional.blockers).toEqual([
      {
        code: 'below_threshold',
        score: 87,
        threshold: 88,
        citation: REGULATION.conditionalMinScore.citation,
      },
    ]);
  });
});

describe('eligibility on real data', () => {
  const ask = (
    requirementId: RequirementId,
    implementationLevel: ImplementationLevel | null = null,
  ) => checkPoamEligibility(catalog, { requirementId, status: 'not_met', implementationLevel });

  it('rejects all six barred requirements', () => {
    expect(REGULATION.poamBarred.value).toHaveLength(6);
    for (const id of REGULATION.poamBarred.value) {
      const result = ask(id);
      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContainEqual({
          code: 'barred',
          citation: REGULATION.poamBarred.citation,
        });
      }
    }
  });

  it('rejects a real 3-point requirement other than 3.13.11', () => {
    const id = withPoints(3).find((x) => x !== ENCRYPTION);
    expect(id).toBeDefined();
    expect(ask(id as RequirementId)).toEqual({
      eligible: false,
      reasons: [{ code: 'exceeds_point_limit', citation: REGULATION.poamMaxItemPoints.citation }],
    });
  });

  it('accepts 3.13.11 at partial and rejects it at none', () => {
    expect(ask(ENCRYPTION, 'partial')).toEqual({ eligible: true });
    expect(ask(ENCRYPTION, 'none')).toMatchObject({ eligible: false });
  });

  it('accepts a real 1-point requirement', () => {
    expect(ask(eligibleOnePointers(1)[0] as RequirementId)).toEqual({ eligible: true });
  });
});

describe('main flow 72 with 3.1.20', () => {
  it('is not_eligible with below_threshold and poam_ineligible(3.1.20, barred)', () => {
    expect(pointsOf(BARRED_FIRST)).toBe(1);
    // 3.1.20 costs 1; 7 five-point requirements cost 35; two more one-pointers bring it to 38.
    const fives = withPoints(5).slice(0, 7);
    const ones = withPoints(1)
      .filter((id) => !BARRED.has(id))
      .slice(0, 2);
    const { score, conditional } = build({ notMet: [BARRED_FIRST, ...fives, ...ones] });
    expect(score).toMatchObject({ kind: 'scored', score: 72 });
    expect(conditional.status).toBe('not_eligible');
    expect(conditional.blockers).toContainEqual({
      code: 'below_threshold',
      score: 72,
      threshold: 88,
      citation: REGULATION.conditionalMinScore.citation,
    });
    expect(conditional.blockers).toContainEqual({
      code: 'poam_ineligible',
      requirementId: BARRED_FIRST,
      reasons: ['barred'],
      citation: REGULATION.poamBarred.citation,
    });
  });

  it('3.1.20 alone makes an otherwise perfect assessment not_eligible', () => {
    const { score, conditional } = build({ notMet: [BARRED_FIRST] });
    expect(score).toMatchObject({ kind: 'scored', score: 109 });
    expect(conditional.status).toBe('not_eligible');
  });
});

describe('regulation ids resolve', () => {
  it('every barred and exception ID in REGULATION exists in the catalog', () => {
    const ids = [
      ...REGULATION.poamBarred.value,
      ...REGULATION.poamPointExceptions.map((e) => e.requirementId),
    ];
    expect(ids.length).toBeGreaterThanOrEqual(7);
    for (const id of ids) expect(getRequirement(catalog, id), id).toBeDefined();
  });

  it('each exception requirement has a partial deduction equal to its excepted points', () => {
    for (const e of REGULATION.poamPointExceptions) {
      const r = getRequirement(catalog, e.requirementId);
      expect(r?.scoring.kind === 'points' && r.scoring.partialCredit?.deduction).toBe(e.maxPoints);
    }
  });
});
