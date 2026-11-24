import { describe, expect, it } from 'vitest';
import * as poam from './index';
import * as regulationModule from './regulation';
import { REGULATION } from './regulation';

const CITED = /^32 CFR 170\.(21|24)\(/;

describe('REGULATION', () => {
  it('values are cited data', () => {
    expect(REGULATION.id).toBe('cmmc-32-cfr-170');
    expect(REGULATION.version).toBe('1.1.0');

    const citations = [
      REGULATION.conditionalMinScore.citation,
      REGULATION.poamNotMetOnly.citation,
      REGULATION.poamMaxItemPoints.citation,
      REGULATION.poamBarred.citation,
      REGULATION.closeoutWindowDays.citation,
      REGULATION.closeoutConfirmedBy.citation,
      ...REGULATION.poamPointExceptions.map((e) => e.citation),
    ];
    for (const citation of citations) expect(citation).toMatch(CITED);

    // 32 CFR 170.21(a)(2)(i): score / 110 >= 0.8, so 88.
    expect(REGULATION.conditionalMinScore).toEqual({
      value: 88,
      citation: '32 CFR 170.21(a)(2)(i)',
    });
    // 32 CFR 170.21(a)(2)(ii): no POA&M item worth more than 1 point.
    expect(REGULATION.poamMaxItemPoints).toEqual({ value: 1, citation: '32 CFR 170.21(a)(2)(ii)' });
    // 32 CFR 170.21(a)(2)(ii): SC.L2-3.13.11 encryption, not FIPS-validated, worth 3.
    expect(REGULATION.poamPointExceptions).toEqual([
      {
        requirementId: 'SC.L2-3.13.11',
        implementationLevel: 'partial',
        maxPoints: 3,
        citation: '32 CFR 170.21(a)(2)(ii)',
      },
    ]);
    // 32 CFR 170.21(a)(2)(iii)(A)-(F).
    expect(REGULATION.poamBarred.citation).toBe('32 CFR 170.21(a)(2)(iii)');
    expect([...REGULATION.poamBarred.value].sort()).toEqual([
      'AC.L2-3.1.20',
      'AC.L2-3.1.22',
      'CA.L2-3.12.4',
      'PE.L2-3.10.3',
      'PE.L2-3.10.4',
      'PE.L2-3.10.5',
    ]);
    // 32 CFR 170.21(b): closeout within 180 days of the Conditional CMMC Status Date.
    expect(REGULATION.closeoutWindowDays).toEqual({ value: 180, citation: '32 CFR 170.21(b)' });
    // 32 CFR 170.21(b)(1) and (b)(2): the OSA for self, a C3PAO for certification.
    expect(REGULATION.closeoutConfirmedBy).toEqual({
      value: { self: 'organization', c3pao: 'c3pao' },
      citation: '32 CFR 170.21(b)(1) and (b)(2)',
    });
    // 32 CFR 170.24(c)(2)(i)(B)(6): a POA&M is for each NOT MET requirement.
    expect(REGULATION.poamNotMetOnly).toEqual({
      value: true,
      citation: '32 CFR 170.24(c)(2)(i)(B)(6)',
    });
    expect(Object.isFrozen(REGULATION.poamNotMetOnly)).toBe(true);

    expect(REGULATION.sources.map((s) => s.url)).toEqual([
      'https://www.law.cornell.edu/cfr/text/32/170.21',
      'https://www.law.cornell.edu/cfr/text/32/170.24',
    ]);
  });

  it('is frozen so callers cannot change the shared data', () => {
    expect(Object.isFrozen(REGULATION)).toBe(true);
    expect(Object.isFrozen(REGULATION.poamBarred.value)).toBe(true);
    expect(Object.isFrozen(REGULATION.poamPointExceptions[0])).toBe(true);
    expect(Object.isFrozen(REGULATION.closeoutConfirmedBy.value)).toBe(true);
  });

  it('exports', () => {
    // The Not Met citation is data on REGULATION now, not a separate constant.
    expect(Object.keys(regulationModule)).toEqual(['REGULATION']);
    expect(Object.keys(poam)).not.toContain('POAM_NOT_MET_CITATION');
    expect(poam.REGULATION).toBe(REGULATION);
  });
});
