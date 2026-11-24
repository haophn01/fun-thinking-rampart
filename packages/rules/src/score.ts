import type { Catalog } from '@rampart/catalog';
import { deductionFor, deriveRequirementOutcomes } from './status';
import type { AssessmentInput, Deduction, ScoreResult } from './types';

// SPRS scoring, 32 CFR 170.24(c)(2): the score starts at the requirement count and each
// not_met requirement deducts its points. Max and floor come from the catalog's data.

/** The highest score: one point per catalog requirement. */
export function scoreMax(catalog: Catalog): number {
  return catalog.requirements.length;
}

/** The lowest score: max minus every points requirement's worst-case deduction. */
export function scoreFloor(catalog: Catalog): number {
  const worstCase = catalog.requirements.reduce(
    (sum, requirement) => sum + deductionFor(requirement, 'not_met', null),
    0,
  );
  return scoreMax(catalog) - worstCase;
}

/**
 * The SPRS score of an assessment. If any prerequisite requirement (the SSP) does not have every
 * objective met, the assessment cannot be completed and the result is `incomplete`, with no
 * score. Throws RulesInputError on invalid input.
 */
export function computeScore(catalog: Catalog, input: AssessmentInput): ScoreResult {
  const outcomes = deriveRequirementOutcomes(catalog, input);
  const max = scoreMax(catalog);
  const floor = scoreFloor(catalog);
  const notAssessed = outcomes
    .filter((o) => o.status === 'not_assessed')
    .map((o) => o.requirementId);

  const prerequisites = catalog.requirements.flatMap((requirement, i) => {
    if (requirement.scoring.kind !== 'prerequisite') return [];
    const outcome = outcomes[i];
    const total = requirement.objectives.length;
    const allMet = outcome !== undefined && total > 0 && outcome.counts.met === total;
    return allMet ? [] : [requirement.id];
  });
  if (prerequisites.length > 0) {
    return {
      kind: 'incomplete',
      reason: 'prerequisite_not_met',
      prerequisites,
      max,
      floor,
      notAssessed,
    };
  }

  const deductions: Deduction[] = outcomes
    .filter((o) => o.deduction > 0)
    .map((o) => ({ requirementId: o.requirementId, points: o.deduction }));
  const score = deductions.reduce((total, d) => total - d.points, max);
  return { kind: 'scored', score, max, floor, deductions, notAssessed };
}
