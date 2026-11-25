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
 * poam_ineligible per ineligible Not Met requirement in catalog order, then one poam_missing per
 * eligible Not Met requirement with no open POA&M item, in catalog order. A requirement with no
 * outcome counts as not assessed. The not_assessed blocker is a tool rule: a Conditional or
 * Final claim needs every requirement assessed.
 *
 * `openPoamRequirementIds` lists the requirements with an open POA&M item. Without it (the caller
 * has no POA&M data), or with `regulation.poamRequiredForNotMet.value` false, no poam_missing is
 * added. IDs whose requirement isn't Not Met are ignored and duplicates count once; an ID not in
 * the catalog throws RulesInputError('unknown_requirement').
 */
export function checkConditional(
  catalog: Catalog,
  outcomes: readonly RequirementOutcome[],
  score: ScoreResult,
  regulation: Regulation = REGULATION,
  openPoamRequirementIds?: readonly RequirementId[],
): ConditionalResult {
  const covered = new Set<RequirementId>();
  for (const requirementId of openPoamRequirementIds ?? []) {
    findRequirement(catalog, requirementId);
    covered.add(requirementId);
  }
  const poamRequired =
    openPoamRequirementIds !== undefined && regulation.poamRequiredForNotMet.value;

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
  const missing: Blocker[] = [];
  for (const requirement of catalog.requirements) {
    const o = byId.get(requirement.id);
    if (o?.status !== 'not_met') continue;
    anyNotMet = true;
    const eligibility = checkPoamEligibility(
      catalog,
      {
        requirementId: o.requirementId,
        status: o.status,
        implementationLevel: o.implementationLevel,
      },
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
    } else if (poamRequired && !covered.has(o.requirementId)) {
      missing.push({
        code: 'poam_missing',
        requirementId: o.requirementId,
        citation: regulation.poamRequiredForNotMet.citation,
      });
    }
  }
  blockers.push(...missing);

  if (score.kind === 'incomplete') return { status: 'incomplete', blockers };
  if (blockers.length > 0) return { status: 'not_eligible', blockers };
  return { status: anyNotMet ? 'conditional' : 'final', blockers };
}
