import type { Regulation } from '../types';

/**
 * The CMMC POA&M and Conditional-status rules as cited data, transcribed from the
 * Cornell LII text of 32 CFR 170.21 and 170.24 (retrieved 2026-11-23).
 * This is the only place these values live: a regulatory change is an edit here,
 * a citation, and a test.
 */

/** 32 CFR 170.24(c)(2)(i)(B)(6): "For each NOT MET security requirement the OSA must have a POA&M". */
export const POAM_NOT_MET_CITATION = '32 CFR 170.24(c)(2)(i)(B)(6)';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const REGULATION: Regulation = deepFreeze<Regulation>({
  id: 'cmmc-32-cfr-170',
  version: '1.0.0',
  sources: [
    {
      title: '32 CFR 170.21 Plan of Action and Milestones requirements',
      url: 'https://www.law.cornell.edu/cfr/text/32/170.21',
    },
    {
      title: '32 CFR 170.24 CMMC Scoring Methodology',
      url: 'https://www.law.cornell.edu/cfr/text/32/170.24',
    },
  ],
  // "The assessment score divided by the total number of CMMC Level 2 security
  // requirements is greater than or equal to 0.8": 0.8 x 110 = 88.
  conditionalMinScore: { value: 88, citation: '32 CFR 170.21(a)(2)(i)' },
  // "None of the security requirements included in the POA&M have a point value of greater than 1".
  poamMaxItemPoints: { value: 1, citation: '32 CFR 170.21(a)(2)(ii)' },
  // "except SC.L2-3.13.11 CUI Encryption may be included on a POA&M if encryption is
  // employed but it is not FIPS-validated, which would result in a point value of 3".
  poamPointExceptions: [
    {
      requirementId: 'SC.L2-3.13.11',
      implementationLevel: 'partial',
      maxPoints: 3,
      citation: '32 CFR 170.21(a)(2)(ii)',
    },
  ],
  // (iii)(A) through (F).
  poamBarred: {
    value: [
      'AC.L2-3.1.20',
      'AC.L2-3.1.22',
      'CA.L2-3.12.4',
      'PE.L2-3.10.3',
      'PE.L2-3.10.4',
      'PE.L2-3.10.5',
    ],
    citation: '32 CFR 170.21(a)(2)(iii)',
  },
  // "confirmed by a POA&M closeout assessment within 180-days of the Conditional CMMC Status Date".
  closeoutWindowDays: { value: 180, citation: '32 CFR 170.21(b)' },
  // (b)(1): the OSA, "in the same manner as the initial self-assessment";
  // (b)(2): "must be performed by an authorized or accredited C3PAO".
  closeoutConfirmedBy: {
    value: { self: 'organization', c3pao: 'c3pao' },
    citation: '32 CFR 170.21(b)(1) and (b)(2)',
  },
});
