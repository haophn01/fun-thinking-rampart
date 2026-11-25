import type { Catalog, Requirement, RequirementId } from '@rampart/catalog';
import { RulesInputError } from '../errors';
import type {
  EligibilityResult,
  ImplementationLevel,
  IneligibleCode,
  Regulation,
  RequirementStatus,
} from '../types';
import { REGULATION } from './regulation';

export interface PoamCandidate {
  requirementId: RequirementId;
  status: RequirementStatus;
  /** Only for requirements with partial credit. Unset or null means the worst case. */
  implementationLevel?: ImplementationLevel | null;
}

export function findRequirement(catalog: Catalog, requirementId: RequirementId): Requirement {
  const requirement = catalog.requirements.find((r) => r.id === requirementId);
  if (requirement === undefined) {
    throw new RulesInputError('unknown_requirement', `Unknown requirement ${requirementId}`);
  }
  return requirement;
}

/**
 * The points a Not Met requirement is worth at this level (32 CFR 170.24(c)(2)(i)(B)):
 * the partial-credit deduction at `partial`, otherwise its full points. A prerequisite
 * (the SSP) has no point value, so it returns null.
 */
function effectivePoints(
  requirement: Requirement,
  level: ImplementationLevel | null,
): number | null {
  const { scoring } = requirement;
  if (level !== null && (scoring.kind !== 'points' || scoring.partialCredit === null)) {
    throw new RulesInputError(
      'invalid_implementation_level',
      `${requirement.id} has no partial credit, so it takes no implementation level`,
    );
  }
  if (scoring.kind !== 'points') return null;
  if (level === 'partial' && scoring.partialCredit !== null) return scoring.partialCredit.deduction;
  return scoring.points;
}

/**
 * Whether a requirement may go on a POA&M (32 CFR 170.21(a)(2)). Every failing reason
 * is returned, in the order not_not_met, barred, exceeds_point_limit. not_not_met applies
 * only while `regulation.poamNotMetOnly.value` is true, and cites that rule.
 */
export function checkPoamEligibility(
  catalog: Catalog,
  candidate: PoamCandidate,
  regulation: Regulation = REGULATION,
): EligibilityResult {
  const requirement = findRequirement(catalog, candidate.requirementId);
  const level = candidate.implementationLevel ?? null;
  const points = effectivePoints(requirement, level);
  const reasons: { code: IneligibleCode; citation: string }[] = [];

  if (regulation.poamNotMetOnly.value && candidate.status !== 'not_met') {
    reasons.push({ code: 'not_not_met', citation: regulation.poamNotMetOnly.citation });
  }
  if (regulation.poamBarred.value.includes(requirement.id)) {
    reasons.push({ code: 'barred', citation: regulation.poamBarred.citation });
  }
  if (points !== null && points > regulation.poamMaxItemPoints.value) {
    const excepted = regulation.poamPointExceptions.some(
      (e) =>
        e.requirementId === requirement.id &&
        e.implementationLevel === level &&
        points <= e.maxPoints,
    );
    if (!excepted) {
      reasons.push({
        code: 'exceeds_point_limit',
        citation: regulation.poamMaxItemPoints.citation,
      });
    }
  }

  return reasons.length === 0 ? { eligible: true } : { eligible: false, reasons };
}
