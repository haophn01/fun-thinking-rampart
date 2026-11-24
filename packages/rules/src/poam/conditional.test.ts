import { describe, expect, it } from 'vitest';
import type { Regulation } from '../types';
import { checkConditional } from './conditional';
import { fixtureCatalog, IDS, incomplete, outcome, outcomesWith, scored } from './fixtures';
import { REGULATION } from './regulation';

const catalog = fixtureCatalog();
const THRESHOLD = REGULATION.conditionalMinScore.citation; // 32 CFR 170.21(a)(2)(i)
const BARRED = REGULATION.poamBarred.citation; // 32 CFR 170.21(a)(2)(iii)
const LIMIT = REGULATION.poamMaxItemPoints.citation; // 32 CFR 170.21(a)(2)(ii)
const SSP = '32 CFR 170.24(c)(2)(i)(B)(5)';

describe('checkConditional', () => {
  // 32 CFR 170.21(a)(2)(i): score / 110 >= 0.8, so 88 passes and 87 fails.
  it('threshold and final: 88 with an eligible not_met item is conditional', () => {
    const outcomes = outcomesWith(catalog, { [IDS.onePoint]: outcome(IDS.onePoint, 'not_met') });
    expect(checkConditional(catalog, outcomes, scored(88))).toEqual({
      status: 'conditional',
      blockers: [],
    });
  });

  it('threshold and final: 87 gives below_threshold', () => {
    const outcomes = outcomesWith(catalog, { [IDS.onePoint]: outcome(IDS.onePoint, 'not_met') });
    expect(checkConditional(catalog, outcomes, scored(87))).toEqual({
      status: 'not_eligible',
      blockers: [{ code: 'below_threshold', score: 87, threshold: 88, citation: THRESHOLD }],
    });
  });

  it('threshold and final: all met at 110 is final', () => {
    expect(checkConditional(catalog, outcomesWith(catalog), scored(110))).toEqual({
      status: 'final',
      blockers: [],
    });
  });

  it('threshold and final: 3.13.11 not_met at partial is conditional', () => {
    const outcomes = outcomesWith(catalog, {
      [IDS.encryption]: outcome(IDS.encryption, 'not_met', 'partial'),
    });
    expect(checkConditional(catalog, outcomes, scored(107))).toEqual({
      status: 'conditional',
      blockers: [],
    });
  });

  // 32 CFR 170.24(c)(2)(i)(B)(5): no SSP means no score, so no Conditional status.
  it('blockers and order: an incomplete score gives incomplete with prerequisite_not_met', () => {
    const outcomes = outcomesWith(catalog, { [IDS.ssp]: outcome(IDS.ssp, 'not_met') });
    expect(checkConditional(catalog, outcomes, incomplete([IDS.ssp]))).toEqual({
      status: 'incomplete',
      blockers: [
        { code: 'prerequisite_not_met', requirementId: IDS.ssp, citation: SSP },
        { code: 'poam_ineligible', requirementId: IDS.ssp, reasons: ['barred'], citation: BARRED },
      ],
    });
  });

  it('blockers and order: not_assessed requirements give one blocker, in catalog order', () => {
    // AU.L2-3.3.3 is not assessed; AU.L2-3.3.2 has no outcome at all; AC.L2-3.1.10 is not assessed.
    const outcomes = outcomesWith(catalog, {
      [IDS.onePointOther]: outcome(IDS.onePointOther, 'not_assessed'),
      [IDS.onePoint]: outcome(IDS.onePoint, 'not_assessed'),
    }).filter((o) => o.requirementId !== IDS.threePoint);
    expect(checkConditional(catalog, outcomes, scored(110))).toEqual({
      status: 'not_eligible',
      blockers: [
        {
          code: 'not_assessed',
          requirementIds: [IDS.onePoint, IDS.threePoint, IDS.onePointOther],
        },
      ],
    });
  });

  it('blockers and order: blockers come in contract order', () => {
    const outcomes = outcomesWith(catalog, {
      // Listed out of catalog order on purpose: blockers follow the catalog.
      [IDS.threePoint]: outcome(IDS.threePoint, 'not_met'),
      'AC.L2-3.1.20': outcome('AC.L2-3.1.20', 'not_met'),
      [IDS.onePointOther]: outcome(IDS.onePointOther, 'not_assessed'),
    });
    expect(checkConditional(catalog, outcomes, scored(80, [IDS.onePointOther]))).toEqual({
      status: 'not_eligible',
      blockers: [
        { code: 'not_assessed', requirementIds: [IDS.onePointOther] },
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
      ],
    });
  });

  it('blockers and order: prerequisite comes before not_assessed when the score is incomplete', () => {
    const outcomes = outcomesWith(catalog, {
      [IDS.ssp]: outcome(IDS.ssp, 'not_assessed'),
      [IDS.onePoint]: outcome(IDS.onePoint, 'not_assessed'),
    });
    expect(
      checkConditional(catalog, outcomes, incomplete([IDS.ssp], [IDS.onePoint, IDS.ssp])),
    ).toEqual({
      status: 'incomplete',
      blockers: [
        { code: 'prerequisite_not_met', requirementId: IDS.ssp, citation: SSP },
        { code: 'not_assessed', requirementIds: [IDS.onePoint, IDS.ssp] },
      ],
    });
  });

  it('ineligible not_met blocks: a not_met barred requirement gives poam_ineligible', () => {
    const outcomes = outcomesWith(catalog, {
      'AC.L2-3.1.20': outcome('AC.L2-3.1.20', 'not_met'),
    });
    expect(checkConditional(catalog, outcomes, scored(109))).toEqual({
      status: 'not_eligible',
      blockers: [
        {
          code: 'poam_ineligible',
          requirementId: 'AC.L2-3.1.20',
          reasons: ['barred'],
          citation: BARRED,
        },
      ],
    });
  });

  it('ineligible not_met blocks: 3.13.11 not_met with no level is ineligible', () => {
    const outcomes = outcomesWith(catalog, {
      [IDS.encryption]: outcome(IDS.encryption, 'not_met'),
    });
    expect(checkConditional(catalog, outcomes, scored(105))).toEqual({
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
  });

  it('reads the threshold from regulation data', () => {
    const lower: Regulation = {
      ...REGULATION,
      conditionalMinScore: { ...REGULATION.conditionalMinScore, value: 80 },
    };
    const outcomes = outcomesWith(catalog, { [IDS.onePoint]: outcome(IDS.onePoint, 'not_met') });
    expect(checkConditional(catalog, outcomes, scored(85), lower).status).toBe('conditional');
    expect(checkConditional(catalog, outcomes, scored(85)).status).toBe('not_eligible');
  });

  it('throws unknown_requirement for an outcome not in the catalog', () => {
    const outcomes = [...outcomesWith(catalog), outcome('XX.L2-9.9.9', 'met')];
    expect(() => checkConditional(catalog, outcomes, scored(110))).toThrow(
      expect.objectContaining({ name: 'RulesInputError', code: 'unknown_requirement' }),
    );
  });

  it('does not mutate its inputs and repeats give equal results', () => {
    const outcomes = outcomesWith(catalog, {
      'AC.L2-3.1.20': outcome('AC.L2-3.1.20', 'not_met'),
    });
    const score = scored(80);
    const before = JSON.stringify([catalog, outcomes, score]);
    const first = checkConditional(catalog, outcomes, score);
    expect(checkConditional(catalog, outcomes, score)).toEqual(first);
    expect(JSON.stringify([catalog, outcomes, score])).toBe(before);
  });
});
