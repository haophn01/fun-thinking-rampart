import type { Catalog, FamilyCode, Requirement, RequirementId, Scoring } from '@rampart/catalog';
import type {
  ImplementationLevel,
  ObjectiveStatus,
  RequirementOutcome,
  RequirementStatus,
  ScoreResult,
} from '../types';

/**
 * A small catalog for the POA&M tests: the six barred requirements, both
 * partial-credit requirements, a 3-point and a 5-point requirement, and two
 * 1-point requirements that may go on a POA&M. Points follow 32 CFR 170.24(c)(2).
 */
const CFR = '32 CFR 170.24(c)(2)(i)(B)';

function points(value: 1 | 3 | 5, partialLabel?: string): Scoring {
  return {
    kind: 'points',
    points: value,
    citation: `${CFR}(${value === 5 ? '1' : value === 3 ? '2' : '3'})`,
    partialCredit:
      partialLabel === undefined
        ? null
        : { deduction: 3, label: partialLabel, citation: `${CFR}(4)` },
  };
}

function req(id: RequirementId, scoring: Scoring): Requirement {
  const nistId = id.slice(id.indexOf('-') + 1);
  return {
    id,
    nistId,
    family: id.slice(0, 2) as FamilyCode,
    type: 'derived',
    text: `Fixture requirement ${id}`,
    scoring,
    objectives: [{ id: `${nistId}[a]`, text: `Fixture objective for ${id}` }],
  };
}

export const IDS = {
  fivePoint: 'AC.L2-3.1.1',
  threePoint: 'AU.L2-3.3.2',
  onePoint: 'AC.L2-3.1.10',
  onePointOther: 'AU.L2-3.3.3',
  mfa: 'IA.L2-3.5.3',
  encryption: 'SC.L2-3.13.11',
  ssp: 'CA.L2-3.12.4',
} as const;

export const BARRED_IDS = [
  'AC.L2-3.1.20',
  'AC.L2-3.1.22',
  'CA.L2-3.12.4',
  'PE.L2-3.10.3',
  'PE.L2-3.10.4',
  'PE.L2-3.10.5',
] as const;

export function fixtureCatalog(): Catalog {
  const requirements: Requirement[] = [
    req(IDS.fivePoint, points(5)),
    req(IDS.onePoint, points(1)),
    req('AC.L2-3.1.20', points(1)),
    req('AC.L2-3.1.22', points(1)),
    req(IDS.threePoint, points(3)),
    req(IDS.onePointOther, points(1)),
    req(IDS.mfa, points(5, 'MFA covers remote and privileged users only')),
    req('PE.L2-3.10.3', points(1)),
    req('PE.L2-3.10.4', points(1)),
    req('PE.L2-3.10.5', points(1)),
    req(IDS.ssp, { kind: 'prerequisite', citation: `${CFR}(5)` }),
    req(IDS.encryption, points(5, 'Encryption employed but not FIPS-validated')),
  ];
  const families: Catalog['families'] = [
    { code: 'AC', nistSection: '3.1', name: 'Access Control', requirementIds: [] },
    { code: 'AU', nistSection: '3.3', name: 'Audit and Accountability', requirementIds: [] },
    {
      code: 'IA',
      nistSection: '3.5',
      name: 'Identification and Authentication',
      requirementIds: [],
    },
    { code: 'PE', nistSection: '3.10', name: 'Physical Protection', requirementIds: [] },
    { code: 'CA', nistSection: '3.12', name: 'Security Assessment', requirementIds: [] },
    {
      code: 'SC',
      nistSection: '3.13',
      name: 'System and Communications Protection',
      requirementIds: [],
    },
  ];
  for (const family of families) {
    family.requirementIds = requirements.filter((r) => r.family === family.code).map((r) => r.id);
  }
  return {
    id: 'nist-800-171-r2',
    version: '0.0.0-fixture',
    sources: [],
    families,
    requirements,
  };
}

/** A requirement outcome as R1 would derive it (one objective per fixture requirement). */
export function outcome(
  requirementId: RequirementId,
  status: RequirementStatus,
  implementationLevel: ImplementationLevel | null = null,
): RequirementOutcome {
  const counts: Record<ObjectiveStatus, number> = { met: 0, not_met: 0, na: 0, not_assessed: 0 };
  counts[status] = 1;
  return { requirementId, status, allNa: false, counts, implementationLevel, deduction: 0 };
}

/** Every fixture requirement met, with the given overrides. */
export function outcomesWith(
  catalog: Catalog,
  overrides: Readonly<Record<RequirementId, RequirementOutcome>> = {},
): RequirementOutcome[] {
  return catalog.requirements.map((r) => overrides[r.id] ?? outcome(r.id, 'met'));
}

export function scored(score: number, notAssessed: RequirementId[] = []): ScoreResult {
  return { kind: 'scored', score, max: 110, floor: -203, deductions: [], notAssessed };
}

export function incomplete(
  prerequisites: RequirementId[],
  notAssessed: RequirementId[] = [],
): ScoreResult {
  return {
    kind: 'incomplete',
    reason: 'prerequisite_not_met',
    prerequisites,
    max: 110,
    floor: -203,
    notAssessed,
  };
}
