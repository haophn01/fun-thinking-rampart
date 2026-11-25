import type { Catalog, ObjectiveId, RequirementId } from '@rampart/catalog';
import { RulesInputError } from './errors';
import type { AssessmentInput, ImplementationLevel, ObjectiveStatus } from './types';

/** An assessment input checked against a catalog, indexed for lookups. */
export interface ValidatedInput {
  statuses: ReadonlyMap<ObjectiveId, ObjectiveStatus>;
  levels: ReadonlyMap<RequirementId, ImplementationLevel>;
}

const LEVELS: readonly string[] = ['none', 'partial'] satisfies ImplementationLevel[];

/**
 * Checks the input against the catalog and throws RulesInputError on the first problem:
 * an objective not in the catalog, an objective listed twice, or an implementation level
 * on an unknown requirement or on one without partial credit (32 CFR 170.24(c)(2)), or an open
 * POA&M requirement ID that is not in the catalog.
 */
export function validateInput(catalog: Catalog, input: AssessmentInput): ValidatedInput {
  const objectiveIds = new Set<ObjectiveId>();
  for (const requirement of catalog.requirements) {
    for (const objective of requirement.objectives) objectiveIds.add(objective.id);
  }

  const statuses = new Map<ObjectiveId, ObjectiveStatus>();
  for (const { objectiveId, status } of input.objectiveResults) {
    if (!objectiveIds.has(objectiveId)) {
      throw new RulesInputError(
        'unknown_objective',
        `Objective ${objectiveId} is not in the catalog`,
      );
    }
    if (statuses.has(objectiveId)) {
      throw new RulesInputError('duplicate_objective', `Objective ${objectiveId} is listed twice`);
    }
    statuses.set(objectiveId, status);
  }

  const requirements = new Map(catalog.requirements.map((r) => [r.id, r]));
  const levels = new Map<RequirementId, ImplementationLevel>();
  for (const [requirementId, level] of Object.entries(input.implementationLevels)) {
    if (level === undefined) continue;
    const requirement = requirements.get(requirementId);
    if (requirement === undefined) {
      throw new RulesInputError(
        'unknown_requirement',
        `Requirement ${requirementId} is not in the catalog`,
      );
    }
    if (requirement.scoring.kind !== 'points' || requirement.scoring.partialCredit === null) {
      throw new RulesInputError(
        'invalid_implementation_level',
        `Requirement ${requirementId} has no partial credit, so it takes no implementation level`,
      );
    }
    if (!LEVELS.includes(level)) {
      throw new RulesInputError(
        'invalid_implementation_level',
        `Implementation level ${level} is not one of ${LEVELS.join(', ')}`,
      );
    }
    levels.set(requirementId, level);
  }

  for (const requirementId of input.openPoamRequirementIds ?? []) {
    if (!requirements.has(requirementId)) {
      throw new RulesInputError(
        'unknown_requirement',
        `Open POA&M requirement ${requirementId} is not in the catalog`,
      );
    }
  }

  return { statuses, levels };
}
