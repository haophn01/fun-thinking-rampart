import type { AssessmentInput, ImplementationLevel, ObjectiveStatus } from '@rampart/rules';

/** The part of an assessment view the rules need: its stored rows and open POA&M list. */
export interface ViewRows {
  objectiveResults: readonly { objectiveId: string; status: ObjectiveStatus }[];
  requirementStates: readonly {
    requirementId: string;
    implementationLevel: ImplementationLevel | null;
  }[];
  /** The requirements with an open POA&M item; absent when the view carries no POA&M data. */
  openPoamRequirementIds?: readonly string[] | undefined;
}

/**
 * Maps a view's stored rows to the rules input. A missing row means not assessed or no level.
 * The open POA&M list is passed on (a copy) only when the view has one, so the local evaluation
 * applies the same POA&M rule as the api's.
 */
export function toAssessmentInput(view: ViewRows): AssessmentInput {
  const implementationLevels: Partial<Record<string, ImplementationLevel>> = {};
  for (const state of view.requirementStates) {
    if (state.implementationLevel !== null) {
      implementationLevels[state.requirementId] = state.implementationLevel;
    }
  }
  const input: AssessmentInput = {
    objectiveResults: view.objectiveResults.map(({ objectiveId, status }) => ({
      objectiveId,
      status,
    })),
    implementationLevels,
  };
  return view.openPoamRequirementIds === undefined
    ? input
    : { ...input, openPoamRequirementIds: [...view.openPoamRequirementIds] };
}
