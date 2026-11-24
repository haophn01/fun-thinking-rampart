import type { Catalog, Requirement } from '@rampart/catalog';
import type {
  AssessmentInput,
  ImplementationLevel,
  ObjectiveStatus,
  RequirementOutcome,
  RequirementStatus,
} from './types';
import { validateInput } from './validate';

/**
 * Points a requirement deducts (32 CFR 170.24(c)(2)). Only not_met deducts. A partial-credit
 * requirement deducts its partial deduction at level `partial`, and its full points at `none`
 * or with no level (the worst case). The prerequisite has no points, so it deducts 0.
 */
export function deductionFor(
  requirement: Requirement,
  status: RequirementStatus,
  level: ImplementationLevel | null,
): number {
  if (status !== 'not_met' || requirement.scoring.kind !== 'points') return 0;
  const { points, partialCredit } = requirement.scoring;
  return partialCredit !== null && level === 'partial' ? partialCredit.deduction : points;
}

/**
 * Requirement status from objective results (plan: Objectives are first-class): any not_met
 * objective gives not_met; otherwise any not_assessed or missing result gives not_assessed;
 * otherwise met, with allNa when every objective is na. A requirement with no objectives in
 * the data has nothing assessed, so it is not_assessed.
 */
function statusFrom(counts: Record<ObjectiveStatus, number>, total: number): RequirementStatus {
  if (counts.not_met > 0) return 'not_met';
  if (counts.not_assessed > 0 || total === 0) return 'not_assessed';
  return 'met';
}

/** One outcome per catalog requirement, in catalog order. Throws RulesInputError on bad input. */
export function deriveRequirementOutcomes(
  catalog: Catalog,
  input: AssessmentInput,
): RequirementOutcome[] {
  const { statuses, levels } = validateInput(catalog, input);
  return catalog.requirements.map((requirement) => {
    const counts: Record<ObjectiveStatus, number> = { met: 0, not_met: 0, na: 0, not_assessed: 0 };
    for (const objective of requirement.objectives) {
      counts[statuses.get(objective.id) ?? 'not_assessed'] += 1;
    }
    const total = requirement.objectives.length;
    const status = statusFrom(counts, total);
    const implementationLevel = levels.get(requirement.id) ?? null;
    return {
      requirementId: requirement.id,
      status,
      allNa: total > 0 && counts.na === total,
      counts,
      implementationLevel,
      deduction: deductionFor(requirement, status, implementationLevel),
    };
  });
}
