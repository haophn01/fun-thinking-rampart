import { describe, expect, it } from 'vitest';
import { RulesInputError } from '../errors';
import type { Regulation } from '../types';
import { checkPoamEligibility } from './eligibility';
import { BARRED_IDS, fixtureCatalog, IDS } from './fixtures';
import { REGULATION } from './regulation';

const catalog = fixtureCatalog();
const NOT_MET = REGULATION.poamNotMetOnly.citation; // 32 CFR 170.24(c)(2)(i)(B)(6)
const BARRED = REGULATION.poamBarred.citation; // 32 CFR 170.21(a)(2)(iii)
const LIMIT = REGULATION.poamMaxItemPoints.citation; // 32 CFR 170.21(a)(2)(ii)

describe('checkPoamEligibility', () => {
  // 32 CFR 170.21(a)(2)(iii)(A)-(F): these may never go on a POA&M.
  it.each(BARRED_IDS)('rejects barred requirements: %s', (requirementId) => {
    const result = checkPoamEligibility(catalog, { requirementId, status: 'not_met' });
    expect(result).toEqual({ eligible: false, reasons: [{ code: 'barred', citation: BARRED }] });
  });

  // 32 CFR 170.24(c)(2)(i)(B)(6): a POA&M addresses NOT MET requirements only.
  it.each([
    ['met', 'met'],
    ['not_assessed', 'not_assessed'],
  ] as const)('not met only: %s is rejected', (_label, status) => {
    const result = checkPoamEligibility(catalog, { requirementId: IDS.onePoint, status });
    expect(result).toEqual({
      eligible: false,
      reasons: [{ code: 'not_not_met', citation: NOT_MET }],
    });

    // The citation is read from the regulation passed in, not from a constant.
    const recited: Regulation = {
      ...REGULATION,
      poamNotMetOnly: { ...REGULATION.poamNotMetOnly, citation: '32 CFR 170.24(test)' },
    };
    expect(checkPoamEligibility(catalog, { requirementId: IDS.onePoint, status }, recited)).toEqual(
      {
        eligible: false,
        reasons: [{ code: 'not_not_met', citation: '32 CFR 170.24(test)' }],
      },
    );
  });

  it('not met only: a 1-point not_met requirement is accepted', () => {
    expect(
      checkPoamEligibility(catalog, { requirementId: IDS.onePoint, status: 'not_met' }),
    ).toEqual({ eligible: true });
  });

  // 32 CFR 170.21(a)(2)(ii): no item over 1 point, except SC.L2-3.13.11 at 3 when
  // encryption is employed but not FIPS-validated.
  it.each([
    ['3-point requirement', IDS.threePoint, undefined, false],
    ['5-point requirement', IDS.fivePoint, undefined, false],
    ['3.5.3 at partial', IDS.mfa, 'partial', false],
    ['3.5.3 at none', IDS.mfa, 'none', false],
    ['3.13.11 at partial', IDS.encryption, 'partial', true],
    ['3.13.11 at none', IDS.encryption, 'none', false],
    ['3.13.11 unset', IDS.encryption, undefined, false],
    ['3.13.11 with a null level', IDS.encryption, null, false],
  ] as const)('point limit and the 3.13.11 exception: %s', (_label, requirementId, level, ok) => {
    const result = checkPoamEligibility(catalog, {
      requirementId,
      status: 'not_met',
      ...(level === undefined ? {} : { implementationLevel: level }),
    });
    expect(result).toEqual(
      ok
        ? { eligible: true }
        : { eligible: false, reasons: [{ code: 'exceeds_point_limit', citation: LIMIT }] },
    );
  });

  it('not-met-only rule switched off', () => {
    const off: Regulation = {
      ...REGULATION,
      poamNotMetOnly: { ...REGULATION.poamNotMetOnly, value: false },
    };
    for (const status of ['met', 'not_assessed', 'not_met'] as const) {
      expect(checkPoamEligibility(catalog, { requirementId: IDS.onePoint, status }, off)).toEqual({
        eligible: true,
      });
    }
    // The other reasons still apply, in contract order.
    expect(
      checkPoamEligibility(catalog, { requirementId: 'AC.L2-3.1.20', status: 'met' }, off),
    ).toEqual({ eligible: false, reasons: [{ code: 'barred', citation: BARRED }] });
    expect(
      checkPoamEligibility(catalog, { requirementId: IDS.threePoint, status: 'met' }, off),
    ).toEqual({ eligible: false, reasons: [{ code: 'exceeds_point_limit', citation: LIMIT }] });
    const barredThreePoint: Regulation = {
      ...off,
      poamBarred: { ...REGULATION.poamBarred, value: [IDS.threePoint] },
    };
    expect(
      checkPoamEligibility(
        catalog,
        { requirementId: IDS.threePoint, status: 'met' },
        barredThreePoint,
      ),
    ).toEqual({
      eligible: false,
      reasons: [
        { code: 'barred', citation: BARRED },
        { code: 'exceeds_point_limit', citation: LIMIT },
      ],
    });
  });

  it('collects reasons in contract order', () => {
    const regulation: Regulation = {
      ...REGULATION,
      poamBarred: { ...REGULATION.poamBarred, value: [IDS.threePoint] },
    };
    const result = checkPoamEligibility(
      catalog,
      { requirementId: IDS.threePoint, status: 'met' },
      regulation,
    );
    expect(result).toEqual({
      eligible: false,
      reasons: [
        { code: 'not_not_met', citation: NOT_MET },
        { code: 'barred', citation: BARRED },
        { code: 'exceeds_point_limit', citation: LIMIT },
      ],
    });
  });

  it('collects reasons: an unknown requirement throws unknown_requirement', () => {
    expect(() =>
      checkPoamEligibility(catalog, { requirementId: 'XX.L2-9.9.9', status: 'not_met' }),
    ).toThrow(expect.objectContaining({ name: 'RulesInputError', code: 'unknown_requirement' }));
  });

  it('collects reasons: a level on a requirement without partial credit throws', () => {
    let error: unknown;
    try {
      checkPoamEligibility(catalog, {
        requirementId: IDS.threePoint,
        status: 'not_met',
        implementationLevel: 'partial',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RulesInputError);
    expect((error as RulesInputError).code).toBe('invalid_implementation_level');
  });

  it('rules read regulation data', () => {
    const raisedLimit: Regulation = {
      ...REGULATION,
      poamMaxItemPoints: { ...REGULATION.poamMaxItemPoints, value: 3 },
    };
    expect(
      checkPoamEligibility(catalog, { requirementId: IDS.threePoint, status: 'not_met' }),
    ).toMatchObject({ eligible: false });
    expect(
      checkPoamEligibility(
        catalog,
        { requirementId: IDS.threePoint, status: 'not_met' },
        raisedLimit,
      ),
    ).toEqual({ eligible: true });

    const unbarred: Regulation = {
      ...REGULATION,
      poamBarred: { ...REGULATION.poamBarred, value: ['AC.L2-3.1.22'] },
    };
    expect(
      checkPoamEligibility(catalog, { requirementId: 'AC.L2-3.1.20', status: 'not_met' }, unbarred),
    ).toEqual({ eligible: true });
    expect(
      checkPoamEligibility(catalog, { requirementId: 'AC.L2-3.1.22', status: 'not_met' }, unbarred),
    ).toMatchObject({ eligible: false });

    const noException: Regulation = { ...REGULATION, poamPointExceptions: [] };
    expect(
      checkPoamEligibility(
        catalog,
        { requirementId: IDS.encryption, status: 'not_met', implementationLevel: 'partial' },
        noException,
      ),
    ).toEqual({ eligible: false, reasons: [{ code: 'exceeds_point_limit', citation: LIMIT }] });
  });

  it('does not mutate its inputs', () => {
    const before = JSON.stringify(catalog);
    const input = {
      requirementId: IDS.encryption,
      status: 'not_met',
      implementationLevel: 'partial',
    } as const;
    const inputBefore = JSON.stringify(input);
    checkPoamEligibility(catalog, input);
    expect(JSON.stringify(catalog)).toBe(before);
    expect(JSON.stringify(input)).toBe(inputBefore);
  });
});
