import type { AssessmentInput, ImplementationLevel, ObjectiveStatus } from '@rampart/rules';

/** The part of an assessment view the rules need: its stored rows. */
export interface ViewRows {
  objectiveResults: readonly { objectiveId: string; status: ObjectiveStatus }[];
  requirementStates: readonly {
    requirementId: string;
    implementationLevel: ImplementationLevel | null;
  }[];
}

/** Maps a view's stored rows to the rules input. A missing row means not assessed or no level. */
export function toAssessmentInput(view: ViewRows): AssessmentInput {
  const implementationLevels: Partial<Record<string, ImplementationLevel>> = {};
  for (const state of view.requirementStates) {
    if (state.implementationLevel !== null) {
      implementationLevels[state.requirementId] = state.implementationLevel;
    }
  }
  return {
    objectiveResults: view.objectiveResults.map(({ objectiveId, status }) => ({
      objectiveId,
      status,
    })),
    implementationLevels,
  };
}
