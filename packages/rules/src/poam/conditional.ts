import type { Catalog, RequirementId } from '@rampart/catalog';
import type {
  Blocker,
  ConditionalResult,
  Regulation,
  RequirementOutcome,
  ScoreResult,
} from '../types';
import { checkPoamEligibility, findRequirement } from './eligibility';
import { REGULATION } from './regulation';

/**
 * Whether Conditional or Final Level 2 status is reachable (32 CFR 170.21(a)(2)).
 *
 * Blockers come in the order prerequisite_not_met, not_assessed, below_threshold, then one
 * poam_ineligible per ineligible Not Met requirement in catalog order. A requirement with no
 * outcome counts as not assessed. The not_assessed blocker is a tool rule: a Conditional or
 * Final claim needs every requirement assessed.
 */
export function checkConditional(
  catalog: Catalog,
  outcomes: readonly RequirementOutcome[],
  score: ScoreResult,
  regulation: Regulation = REGULATION,
): ConditionalResult {
  const byId = new Map<RequirementId, RequirementOutcome>();
  for (const o of outcomes) {
    findRequirement(catalog, o.requirementId);
    if (!byId.has(o.requirementId)) byId.set(o.requirementId, o);
  }

  const blockers: Blocker[] = [];

  if (score.kind === 'incomplete') {
    for (const requirementId of score.prerequisites) {
      const { scoring } = findRequirement(catalog, requirementId);
      blockers.push({ code: 'prerequisite_not_met', requirementId, citation: scoring.citation });
    }
  }

  const notAssessed = catalog.requirements
    .filter((r) => (byId.get(r.id)?.status ?? 'not_assessed') === 'not_assessed')
    .map((r) => r.id);
  if (notAssessed.length > 0) blockers.push({ code: 'not_assessed', requirementIds: notAssessed });

  const threshold = regulation.conditionalMinScore;
  if (score.kind === 'scored' && score.score < threshold.value) {
    blockers.push({
      code: 'below_threshold',
      score: score.score,
      threshold: threshold.value,
      citation: threshold.citation,
    });
  }

  let anyNotMet = false;
  for (const requirement of catalog.requirements) {
    const o = byId.get(requirement.id);
    if (o?.status !== 'not_met') continue;
    anyNotMet = true;
    const eligibility = checkPoamEligibility(
      catalog,
      { requirementId: o.requirementId, status: o.status, implementationLevel: o.implementationLevel },
      regulation,
    );
    if (!eligibility.eligible) {
      const [first] = eligibility.reasons;
      blockers.push({
        code: 'poam_ineligible',
        requirementId: o.requirementId,
        reasons: eligibility.reasons.map((r) => r.code),
        citation: first?.citation ?? regulation.poamMaxItemPoints.citation,
      });
    }
  }

  if (score.kind === 'incomplete') return { status: 'incomplete', blockers };
  if (blockers.length > 0) return { status: 'not_eligible', blockers };
  return { status: anyNotMet ? 'conditional' : 'final', blockers };
}
