import { loadCatalog, type RequirementId } from '@rampart/catalog';
import { describe, expect, it } from 'vitest';
import { evaluateAssessment } from '../evaluate';
import type { AssessmentInput, ImplementationLevel, ObjectiveStatus, Regulation } from '../types';
import { checkConditional } from './conditional';
import { fixtureCatalog, IDS, incomplete, outcome, outcomesWith, scored } from './fixtures';
import { REGULATION } from './regulation';

// 32 CFR 170.24(c)(2)(i)(B)(6): "For each NOT MET security requirement the OSA must have a POA&M".
const catalog = fixtureCatalog();
// evaluateAssessment scores against the requirement count, so it runs on the real catalog,
// which has every fixture ID with the same points.
const real = loadCatalog();
const REQUIRED = REGULATION.poamRequiredForNotMet.citation;
const BARRED = REGULATION.poamBarred.citation;
const LIMIT = REGULATION.poamMaxItemPoints.citation;
const THRESHOLD = REGULATION.conditionalMinScore.citation;
const SSP = '32 CFR 170.24(c)(2)(i)(B)(5)';

const missing = (requirementId: RequirementId) => ({
  code: 'poam_missing' as const,
  requirementId,
  citation: REQUIRED,
});

/** Every real objective Met, except `overrides`; levels and the POA&M list as given. */
function inputOf(
  overrides: Partial<Record<RequirementId, ObjectiveStatus>>,
  implementationLevels: Partial<Record<RequirementId, ImplementationLevel>> = {},
  openPoamRequirementIds?: RequirementId[],
): AssessmentInput {
  const input: AssessmentInput = {
    objectiveResults: real.requirements.flatMap((r) =>
      r.objectives.map((o) => ({ objectiveId: o.id, status: overrides[r.id] ?? 'met' })),
    ),
    implementationLevels,
  };
  return openPoamRequirementIds === undefined ? input : { ...input, openPoamRequirementIds };
}

describe('poam_missing: a Not Met requirement needs an open POA&M item', () => {
  it('missing item blocks, open item clears', () => {
    const outcomes = outcomesWith(catalog, { [IDS.onePoint]: outcome(IDS.onePoint, 'not_met') });

    // An empty list: the eligible Not Met requirement has no item, so HOLD.
    expect(checkConditional(catalog, outcomes, scored(109), REGULATION, [])).toEqual({
      status: 'not_eligible',
      blockers: [missing(IDS.onePoint)],
    });
    // Once its item is open, it is Conditional.
    expect(checkConditional(catalog, outcomes, scored(109), REGULATION, [IDS.onePoint])).toEqual({
      status: 'conditional',
      blockers: [],
    });

    // The same through evaluateAssessment, which passes the input's list.
    const blocked = evaluateAssessment(real, inputOf({ [IDS.onePoint]: 'not_met' }, {}, []));
    expect(blocked.conditional).toEqual({
      status: 'not_eligible',
      blockers: [missing(IDS.onePoint)],
    });
    const covered = evaluateAssessment(
      real,
      inputOf({ [IDS.onePoint]: 'not_met' }, {}, [IDS.onePoint]),
    );
    expect(covered.conditional).toEqual({ status: 'conditional', blockers: [] });

    // poam_missing sits beside the other blockers; with every requirement Met the list is moot.
    expect(checkConditional(catalog, outcomes, scored(80), REGULATION, []).blockers).toEqual([
      { code: 'below_threshold', score: 80, threshold: 88, citation: THRESHOLD },
      missing(IDS.onePoint),
    ]);
    expect(checkConditional(catalog, outcomesWith(catalog), scored(110), REGULATION, [])).toEqual({
      status: 'final',
      blockers: [],
    });

    // An incomplete score stays incomplete and still lists the missing item.
    const noSsp = outcomesWith(catalog, {
      [IDS.ssp]: outcome(IDS.ssp, 'not_met'),
      [IDS.onePoint]: outcome(IDS.onePoint, 'not_met'),
    });
    expect(checkConditional(catalog, noSsp, incomplete([IDS.ssp]), REGULATION, [])).toEqual({
      status: 'incomplete',
      blockers: [
        { code: 'prerequisite_not_met', requirementId: IDS.ssp, citation: SSP },
        { code: 'poam_ineligible', requirementId: IDS.ssp, reasons: ['barred'], citation: BARRED },
        missing(IDS.onePoint),
      ],
    });
  });

  it('absent list or rule off skips the check', () => {
    const outcomes = outcomesWith(catalog, { [IDS.onePoint]: outcome(IDS.onePoint, 'not_met') });
    // No list: the caller has no POA&M data, so today's behavior holds.
    expect(checkConditional(catalog, outcomes, scored(109))).toEqual({
      status: 'conditional',
      blockers: [],
    });
    expect(checkConditional(catalog, outcomes, scored(109), REGULATION, undefined)).toEqual({
      status: 'conditional',
      blockers: [],
    });
    expect(evaluateAssessment(real, inputOf({ [IDS.onePoint]: 'not_met' })).conditional).toEqual({
      status: 'conditional',
      blockers: [],
    });

    // The rule turned off in the regulation data: an empty list adds nothing either.
    const off: Regulation = {
      ...REGULATION,
      poamRequiredForNotMet: { ...REGULATION.poamRequiredForNotMet, value: false },
    };
    expect(checkConditional(catalog, outcomes, scored(109), off, [])).toEqual({
      status: 'conditional',
      blockers: [],
    });
    expect(
      evaluateAssessment(real, inputOf({ [IDS.onePoint]: 'not_met' }, {}, []), off).conditional,
    ).toEqual({ status: 'conditional', blockers: [] });
  });

  it('ineligible never doubles; 3.13.11 levels', () => {
    // Barred and over the point limit: only poam_ineligible, with or without the list.
    const outcomes = outcomesWith(catalog, {
      'AC.L2-3.1.20': outcome('AC.L2-3.1.20', 'not_met'),
      [IDS.threePoint]: outcome(IDS.threePoint, 'not_met'),
      [IDS.mfa]: outcome(IDS.mfa, 'not_met', 'partial'),
    });
    const blockers = checkConditional(catalog, outcomes, scored(100), REGULATION, []).blockers;
    expect(blockers.filter((b) => b.code === 'poam_missing')).toEqual([]);
    expect(
      blockers.filter((b) => b.code === 'poam_ineligible').map((b) => b.requirementId),
    ).toEqual(['AC.L2-3.1.20', IDS.threePoint, IDS.mfa]);

    // 3.13.11 at partial is eligible (3 points, the one exception), so it needs an item.
    const partial = outcomesWith(catalog, {
      [IDS.encryption]: outcome(IDS.encryption, 'not_met', 'partial'),
    });
    expect(checkConditional(catalog, partial, scored(107), REGULATION, [])).toEqual({
      status: 'not_eligible',
      blockers: [missing(IDS.encryption)],
    });
    expect(checkConditional(catalog, partial, scored(107), REGULATION, [IDS.encryption])).toEqual({
      status: 'conditional',
      blockers: [],
    });

    // At none (or with no level) it is ineligible only, even with an item listed.
    for (const level of ['none', null] as const) {
      const worst = outcomesWith(catalog, {
        [IDS.encryption]: outcome(IDS.encryption, 'not_met', level),
      });
      expect(checkConditional(catalog, worst, scored(105), REGULATION, [IDS.encryption])).toEqual({
        status: 'not_eligible',
        blockers: [
          {
            code: 'poam_ineligible',
            requirementId: IDS.encryption,
            reasons: ['exceeds_point_limit'],
            citation: LIMIT,
          },
        ],
      });
    }

    // The same levels through evaluateAssessment.
    const viaInput = (level: ImplementationLevel) =>
      evaluateAssessment(
        real,
        inputOf({ [IDS.encryption]: 'not_met' }, { [IDS.encryption]: level }, []),
      ).conditional.blockers.map((b) => b.code);
    expect(viaInput('partial')).toEqual(['poam_missing']);
    expect(viaInput('none')).toEqual(['poam_ineligible']);
  });

  it('blocker order', () => {
    const outcomes = outcomesWith(catalog, {
      // Listed out of catalog order on purpose: blockers follow the catalog.
      [IDS.encryption]: outcome(IDS.encryption, 'not_met', 'partial'),
      [IDS.onePointOther]: outcome(IDS.onePointOther, 'not_met'),
      [IDS.threePoint]: outcome(IDS.threePoint, 'not_met'),
      'AC.L2-3.1.20': outcome('AC.L2-3.1.20', 'not_met'),
      [IDS.onePoint]: outcome(IDS.onePoint, 'not_met'),
      [IDS.fivePoint]: outcome(IDS.fivePoint, 'not_assessed'),
    });
    // The list is out of order too, and covers nothing that matters here.
    const list = [IDS.fivePoint];
    expect(
      checkConditional(catalog, outcomes, scored(80, [IDS.fivePoint]), REGULATION, list),
    ).toEqual({
      status: 'not_eligible',
      blockers: [
        { code: 'not_assessed', requirementIds: [IDS.fivePoint] },
        { code: 'below_threshold', score: 80, threshold: 88, citation: THRESHOLD },
        {
          code: 'poam_ineligible',
          requirementId: 'AC.L2-3.1.20',
          reasons: ['barred'],
          citation: BARRED,
        },
        {
          code: 'poam_ineligible',
          requirementId: IDS.threePoint,
          reasons: ['exceeds_point_limit'],
          citation: LIMIT,
        },
        missing(IDS.onePoint),
        missing(IDS.onePointOther),
        missing(IDS.encryption),
      ],
    });
  });

  it('list edges', () => {
    const outcomes = outcomesWith(catalog, {
      [IDS.onePoint]: outcome(IDS.onePoint, 'not_met'),
      [IDS.fivePoint]: outcome(IDS.fivePoint, 'not_assessed'),
    });
    // Met (AU.L2-3.3.3) and Not Assessed (AC.L2-3.1.1) IDs are ignored; they cover nothing.
    expect(
      checkConditional(catalog, outcomes, scored(109, [IDS.fivePoint]), REGULATION, [
        IDS.onePointOther,
        IDS.fivePoint,
      ]).blockers,
    ).toEqual([{ code: 'not_assessed', requirementIds: [IDS.fivePoint] }, missing(IDS.onePoint)]);

    // Duplicates count once: one item covers, and nothing is added twice.
    const notMet = outcomesWith(catalog, { [IDS.onePoint]: outcome(IDS.onePoint, 'not_met') });
    expect(
      checkConditional(catalog, notMet, scored(109), REGULATION, [IDS.onePoint, IDS.onePoint]),
    ).toEqual({ status: 'conditional', blockers: [] });
    expect(
      evaluateAssessment(
        real,
        inputOf({ [IDS.onePoint]: 'not_met' }, {}, [IDS.onePoint, IDS.onePoint]),
      ).conditional,
    ).toEqual({ status: 'conditional', blockers: [] });

    // An ID the catalog doesn't have throws, whether it covers anything or not.
    const unknown = { name: 'RulesInputError', code: 'unknown_requirement' };
    expect(() =>
      checkConditional(catalog, notMet, scored(109), REGULATION, [IDS.onePoint, 'XX.L2-9.9.9']),
    ).toThrow(expect.objectContaining(unknown));
    expect(() => evaluateAssessment(real, inputOf({}, {}, ['XX.L2-9.9.9']))).toThrow(
      expect.objectContaining(unknown),
    );

    // The list is not mutated, and repeats give equal results.
    const list = [IDS.onePoint, IDS.onePointOther];
    const snapshot = [...list];
    const first = checkConditional(catalog, notMet, scored(109), REGULATION, list);
    expect(checkConditional(catalog, notMet, scored(109), REGULATION, list)).toEqual(first);
    expect(list).toEqual(snapshot);
  });
});
