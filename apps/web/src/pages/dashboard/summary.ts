import type { Catalog } from '@rampart/catalog';
import type { ObjectiveStatus } from '@rampart/rules';

type Result = { objectiveId: string; status: ObjectiveStatus };

export interface ObjectiveCounts extends Record<ObjectiveStatus, number> {
  total: number;
}

/**
 * Counts every catalog objective by status. An objective with no stored result counts as not
 * assessed, and a result for an objective outside the catalog is ignored, so the four counts
 * always sum to `total`.
 */
export function objectiveCounts(results: readonly Result[], catalog: Catalog): ObjectiveCounts {
  const stored = new Map(results.map((r) => [r.objectiveId, r.status]));
  const counts: ObjectiveCounts = { met: 0, not_met: 0, na: 0, not_assessed: 0, total: 0 };
  for (const requirement of catalog.requirements) {
    for (const objective of requirement.objectives) {
      counts[stored.get(objective.id) ?? 'not_assessed'] += 1;
      counts.total += 1;
    }
  }
  return counts;
}

export interface FamilyRow {
  code: string;
  name: string;
  /** Objectives in the family. */
  objectives: number;
  /** Objectives with any result other than not assessed (N/A counts as assessed). */
  assessed: number;
  /** `assessed` over `objectives`, rounded to a whole percent. */
  percent: number;
  /** Requirements whose outcome is Met / Not Met. */
  met: number;
  notMet: number;
}

/** One row per family, in catalog order. */
export function familyRows(
  results: readonly Result[],
  outcomes: readonly { requirementId: string; status: string }[],
  catalog: Catalog,
): FamilyRow[] {
  const stored = new Map(results.map((r) => [r.objectiveId, r.status]));
  const outcomeOf = new Map(outcomes.map((o) => [o.requirementId, o.status]));
  return catalog.families.map((family) => {
    let objectives = 0;
    let assessed = 0;
    let met = 0;
    let notMet = 0;
    for (const requirement of catalog.requirements) {
      if (requirement.family !== family.code) continue;
      const status = outcomeOf.get(requirement.id);
      if (status === 'met') met += 1;
      if (status === 'not_met') notMet += 1;
      for (const objective of requirement.objectives) {
        objectives += 1;
        const result = stored.get(objective.id);
        if (result !== undefined && result !== 'not_assessed') assessed += 1;
      }
    }
    return {
      code: family.code,
      name: family.name,
      objectives,
      assessed,
      percent: objectives === 0 ? 0 : Math.round((assessed / objectives) * 100),
      met,
      notMet,
    };
  });
}
