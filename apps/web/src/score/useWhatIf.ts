import { loadCatalog } from '@rampart/catalog';
import type { ObjectiveId, RequirementId } from '@rampart/catalog';
import {
  applyWhatIf,
  compareEvaluations,
  evaluateAssessment,
  type AssessmentInput,
  type Evaluation,
  type EvaluationDiff,
  type ImplementationLevel,
  type ObjectiveStatus,
  type WhatIfChanges,
} from '@rampart/rules';
import { useCallback, useMemo, useState } from 'react';

export interface WhatIf {
  active: boolean;
  start: () => void;
  exit: () => void;
  reset: () => void;
  setObjective: (objectiveId: ObjectiveId, status: ObjectiveStatus) => void;
  /** `null` is "no level" (the worst case). */
  setLevel: (requirementId: RequirementId, level: ImplementationLevel | null) => void;
  /** Only values that differ from the saved input. */
  changes: WhatIfChanges;
  /** The what-if evaluation while changes exist, otherwise the saved one. */
  evaluation: Evaluation;
  diff: EvaluationDiff;
}

interface Pending {
  objectiveStatuses: Record<ObjectiveId, ObjectiveStatus>;
  implementationLevels: Record<RequirementId, ImplementationLevel | null>;
}
const NONE: Pending = { objectiveStatuses: {}, implementationLevels: {} };

function omit<V>(record: Record<string, V>, key: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

function savedStatus(saved: AssessmentInput, objectiveId: ObjectiveId): ObjectiveStatus {
  return (
    saved.objectiveResults.find((r) => r.objectiveId === objectiveId)?.status ?? 'not_assessed'
  );
}

/**
 * What-if state over the saved input. Changes are kept only while they differ from the saved
 * value, so setting a value back leaves no change. Nothing is saved.
 */
export function useWhatIf(saved: AssessmentInput): WhatIf {
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState<Pending>(NONE);

  const setObjective = useCallback(
    (objectiveId: ObjectiveId, status: ObjectiveStatus) => {
      setPending((current) => {
        const objectiveStatuses = { ...current.objectiveStatuses };
        objectiveStatuses[objectiveId] = status;
        if (status === savedStatus(saved, objectiveId)) {
          return { ...current, objectiveStatuses: omit(objectiveStatuses, objectiveId) };
        }
        return { ...current, objectiveStatuses };
      });
    },
    [saved],
  );
  const setLevel = useCallback(
    (requirementId: RequirementId, level: ImplementationLevel | null) => {
      setPending((current) => {
        const implementationLevels = { ...current.implementationLevels };
        implementationLevels[requirementId] = level;
        if (level === (saved.implementationLevels[requirementId] ?? null)) {
          return { ...current, implementationLevels: omit(implementationLevels, requirementId) };
        }
        return { ...current, implementationLevels };
      });
    },
    [saved],
  );

  const result = useMemo(() => {
    const catalog = loadCatalog();
    const savedEvaluation = evaluateAssessment(catalog, saved);
    const changes: WhatIfChanges = {};
    if (active) {
      if (Object.keys(pending.objectiveStatuses).length > 0) {
        changes.objectiveStatuses = pending.objectiveStatuses;
      }
      if (Object.keys(pending.implementationLevels).length > 0) {
        changes.implementationLevels = pending.implementationLevels;
      }
    }
    const evaluation =
      changes.objectiveStatuses || changes.implementationLevels
        ? evaluateAssessment(catalog, applyWhatIf(catalog, saved, changes))
        : savedEvaluation;
    return { changes, evaluation, diff: compareEvaluations(savedEvaluation, evaluation) };
  }, [saved, active, pending]);

  return {
    active,
    start: useCallback(() => {
      setActive(true);
    }, []),
    exit: useCallback(() => {
      setActive(false);
      setPending(NONE);
    }, []),
    reset: useCallback(() => {
      setPending(NONE);
    }, []),
    setObjective,
    setLevel,
    ...result,
  };
}
