// Plans an assessment's results from the catalog and regulation data, so no spec spells a point
// value: which requirements to mark Not Met to land on a score, and which of them can go on a
// POA&M.
import type { Catalog, Requirement, RequirementId } from '@rampart/catalog';
import { scoreMax } from '@rampart/rules';
import { checkPoamEligibility } from '@rampart/rules/poam';

/** The points a requirement deducts when it is Not Met at its worst level (0 for the SSP). */
export function pointsOf(requirement: Requirement): number {
  return requirement.scoring.kind === 'points' ? requirement.scoring.points : 0;
}

/** The catalog requirement with this NIST number, such as `3.1.20`. Throws when there is none. */
export function requirementByNist(catalog: Catalog, nistId: string): Requirement {
  const requirement = catalog.requirements.find((r) => r.nistId === nistId);
  if (requirement === undefined) throw new Error(`No requirement ${nistId} in the catalog`);
  return requirement;
}

/** The catalog requirement with this ID. Throws when there is none. */
export function requirementById(catalog: Catalog, id: RequirementId): Requirement {
  const requirement = catalog.requirements.find((r) => r.id === id);
  if (requirement === undefined) throw new Error(`No requirement ${id} in the catalog`);
  return requirement;
}

/** A requirement's first objective: setting it Not Met makes the requirement Not Met. */
export function firstObjectiveId(requirement: Requirement): string {
  const objective = requirement.objectives[0];
  if (objective === undefined) throw new Error(`${requirement.id} has no objectives`);
  return objective.id;
}

/** Whether a requirement, once Not Met, may go on a POA&M (the rules package decides). */
export function poamEligibleWhenNotMet(catalog: Catalog, requirement: Requirement): boolean {
  return checkPoamEligibility(catalog, { requirementId: requirement.id, status: 'not_met' })
    .eligible;
}

export interface HoldPlan {
  /** Mark these Not Met (through the API) while every other objective is Met. */
  notMet: RequirementId[];
  /** The POA&M-eligible ones among `notMet`; they stay Not Met when the rest are fixed. */
  poamTargets: RequirementId[];
}

export interface HoldPlanOptions {
  /** The score once `uiRequirement` is also marked Not Met. */
  score: number;
  /** Left Met by the plan: the spec marks it Not Met in the UI. */
  uiRequirement: Requirement;
  /** How many POA&M-eligible requirements `notMet` must hold. */
  poamCount: number;
}

/**
 * The Not Met set that, with every other objective Met and `uiRequirement` then marked Not Met,
 * scores exactly `score`. It holds `poamCount` POA&M-eligible requirements (catalog order) and
 * fills the rest of the deficit with the largest point values first. The SSP and the
 * partial-credit requirements are left out, so the score never depends on an implementation
 * level. Throws when the catalog can't make the score.
 */
export function planHold(catalog: Catalog, options: HoldPlanOptions): HoldPlan {
  const { score, uiRequirement, poamCount } = options;
  const deficit = scoreMax(catalog) - score - pointsOf(uiRequirement);
  const usable = catalog.requirements.filter(
    (r) =>
      r.id !== uiRequirement.id && r.scoring.kind === 'points' && r.scoring.partialCredit === null,
  );

  const poamTargets = usable.filter((r) => poamEligibleWhenNotMet(catalog, r)).slice(0, poamCount);
  if (poamTargets.length < poamCount) {
    throw new Error(`The catalog has fewer than ${String(poamCount)} POA&M-eligible requirements`);
  }

  let remaining = deficit - poamTargets.reduce((sum, r) => sum + pointsOf(r), 0);
  const rest: Requirement[] = [];
  const byPoints = usable
    .filter((r) => !poamTargets.includes(r))
    .toSorted((a, b) => pointsOf(b) - pointsOf(a));
  for (const requirement of byPoints) {
    if (remaining === 0) break;
    if (pointsOf(requirement) <= remaining) {
      rest.push(requirement);
      remaining -= pointsOf(requirement);
    }
  }
  if (remaining !== 0) throw new Error(`No Not Met set scores exactly ${String(score)}`);

  const chosen = new Set([...poamTargets, ...rest].map((r) => r.id));
  return {
    notMet: catalog.requirements.filter((r) => chosen.has(r.id)).map((r) => r.id),
    poamTargets: poamTargets.map((r) => r.id),
  };
}

/** Today's UTC date plus `days`, as `YYYY-MM-DD` (the api's dates are UTC). */
export function utcDatePlus(days: number, now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
