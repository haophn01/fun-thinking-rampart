import type { Catalog, ObjectiveId, RequirementId } from '@rampart/catalog';
import { RulesInputError } from './errors';
import { checkConditional } from './poam/conditional';
import { REGULATION } from './poam/regulation';
import { computeScore } from './score';
import { deriveRequirementOutcomes } from './status';
import type {
  AssessmentInput,
  ConditionalResult,
  ImplementationLevel,
  ObjectiveResult,
  ObjectiveStatus,
  Regulation,
  RequirementOutcome,
  RequirementStatus,
  ScoreResult,
} from './types';
import { validateInput } from './validate';

/** Everything the rules say about one assessment input. */
export interface Evaluation {
  outcomes: RequirementOutcome[];
  score: ScoreResult;
  conditional: ConditionalResult;
}

/** Changes to try on top of an assessment input, without saving them. */
export interface WhatIfChanges {
  objectiveStatuses?: Readonly<Record<ObjectiveId, ObjectiveStatus>>;
  /** `null` removes the requirement's level. */
  implementationLevels?: Readonly<Partial<Record<RequirementId, ImplementationLevel | null>>>;
}

/** How a what-if evaluation differs from the saved one. */
export interface EvaluationDiff {
  /** `null` when either score is incomplete. */
  scoreDelta: number | null;
  /** In catalog order. */
  changed: { requirementId: RequirementId; from: RequirementStatus; to: RequirementStatus }[];
}

/**
 * Requirement outcomes, SPRS score and the Conditional check for one input, composed from
 * `deriveRequirementOutcomes`, `computeScore` and `checkConditional`. The API's saved score and
 * the web's live and what-if scores all call this, so they can't disagree. Throws
 * RulesInputError on invalid input.
 */
export function evaluateAssessment(
  catalog: Catalog,
  input: AssessmentInput,
  regulation: Regulation = REGULATION,
): Evaluation {
  const outcomes = deriveRequirementOutcomes(catalog, input);
  const score = computeScore(catalog, input);
  const conditional = checkConditional(
    catalog,
    outcomes,
    score,
    regulation,
    input.openPoamRequirementIds,
  );
  return { outcomes, score, conditional };
}

/**
 * A new input with `changes` applied; the argument is not mutated. A changed objective that
 * already has a result is replaced in place; one with no result is added after the existing
 * results, in catalog order. A level of `null` removes the requirement's level. The open POA&M
 * list is kept as it was (a copy), and stays absent when the input has none. Throws
 * RulesInputError for an unknown objective or requirement, a level (or `null`) on a requirement
 * without partial credit, and anything `deriveRequirementOutcomes` would reject in the result.
 */
export function applyWhatIf(
  catalog: Catalog,
  input: AssessmentInput,
  changes: WhatIfChanges,
): AssessmentInput {
  const statusChanges = new Map<ObjectiveId, ObjectiveStatus>();
  const known = new Set<ObjectiveId>();
  for (const requirement of catalog.requirements) {
    for (const objective of requirement.objectives) known.add(objective.id);
  }
  for (const [objectiveId, status] of Object.entries(changes.objectiveStatuses ?? {})) {
    if (!known.has(objectiveId)) {
      throw new RulesInputError(
        'unknown_objective',
        `Objective ${objectiveId} is not in the catalog`,
      );
    }
    statusChanges.set(objectiveId, status);
  }

  const requirements = new Map(catalog.requirements.map((r) => [r.id, r]));
  const levels = new Map(Object.entries(input.implementationLevels));
  for (const [requirementId, level] of Object.entries(changes.implementationLevels ?? {})) {
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
    if (level === null) levels.delete(requirementId);
    else levels.set(requirementId, level);
  }
  const implementationLevels: Partial<Record<RequirementId, ImplementationLevel>> =
    Object.fromEntries(levels);

  const present = new Set<ObjectiveId>();
  const objectiveResults: ObjectiveResult[] = input.objectiveResults.map((result) => {
    present.add(result.objectiveId);
    const status = statusChanges.get(result.objectiveId);
    return status === undefined ? { ...result } : { objectiveId: result.objectiveId, status };
  });
  for (const requirement of catalog.requirements) {
    for (const { id } of requirement.objectives) {
      const status = statusChanges.get(id);
      if (status !== undefined && !present.has(id))
        objectiveResults.push({ objectiveId: id, status });
    }
  }

  const next: AssessmentInput =
    input.openPoamRequirementIds === undefined
      ? { objectiveResults, implementationLevels }
      : {
          objectiveResults,
          implementationLevels,
          openPoamRequirementIds: [...input.openPoamRequirementIds],
        };
  validateInput(catalog, next);
  return next;
}

/**
 * The score delta (`next` minus `saved`) and the requirements whose status changed, in the
 * order of `next.outcomes` (catalog order). A requirement missing from `saved` counts as
 * not_assessed, as in `checkConditional`.
 */
export function compareEvaluations(saved: Evaluation, next: Evaluation): EvaluationDiff {
  const scoreDelta =
    saved.score.kind === 'scored' && next.score.kind === 'scored'
      ? next.score.score - saved.score.score
      : null;
  const before = new Map(saved.outcomes.map((o) => [o.requirementId, o.status]));
  const changed: EvaluationDiff['changed'] = [];
  for (const { requirementId, status: to } of next.outcomes) {
    const from = before.get(requirementId) ?? 'not_assessed';
    if (from !== to) changed.push({ requirementId, from, to });
  }
  return { scoreDelta, changed };
}
