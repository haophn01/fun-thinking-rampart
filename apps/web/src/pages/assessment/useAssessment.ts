import {
  assessmentViewSchema,
  objectiveWriteResponseSchema,
  requirementWriteResponseSchema,
  usersResponseSchema,
  type AssessmentView,
  type PatchRequirementRequest,
  type User,
} from '@rampart/api/contract';
import { loadCatalog } from '@rampart/catalog';
import {
  applyWhatIf,
  evaluateAssessment,
  type AssessmentInput,
  type Evaluation,
  type ObjectiveStatus,
} from '@rampart/rules';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiGet, apiSend } from '../../api/client';
import { toAssessmentInput } from '../../score';

/** What the page shows when a call fails: the message and the request ID to quote. */
export interface Problem {
  message: string;
  requestId?: string | undefined;
}

function problemOf(error: unknown): Problem {
  if (error instanceof ApiError) return { message: error.message, requestId: error.requestId };
  return { message: 'Something went wrong.' };
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; problem: Problem }
  | { status: 'ready'; view: AssessmentView };

const EMPTY_INPUT: AssessmentInput = { objectiveResults: [], implementationLevels: {} };

export interface AssessmentState {
  load: Load;
  /** Re-reads the view and the users. */
  retry: () => void;
  users: readonly User[];
  /** The saved input, with optimistic statuses applied. */
  input: AssessmentInput;
  /** The saved evaluation: the server's, or the local one while a status write is pending. */
  evaluation: Evaluation | null;
  /** The status shown for an objective: an unconfirmed click, else the stored row. */
  statusOf: (objectiveId: string) => ObjectiveStatus;
  noteOf: (objectiveId: string) => string | null;
  /** True while a write for this objective is in flight. */
  isSaving: (objectiveId: string) => boolean;
  /** True while a requirement write is in flight. */
  isPatching: (requirementId: string) => boolean;
  /** Sets the status (keeping the stored note) with the score updated at once. */
  setStatus: (objectiveId: string, status: ObjectiveStatus) => Promise<void>;
  saveNote: (objectiveId: string, note: string | null) => Promise<void>;
  patchRequirement: (requirementId: string, body: PatchRequirementRequest) => Promise<void>;
  /** The last write that failed, until the next write starts. */
  saveProblem: Problem | null;
}

/** Loads the assessment view and users, and writes objective and requirement changes. */
export function useAssessment(): AssessmentState {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [users, setUsers] = useState<readonly User[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [optimistic, setOptimistic] = useState<Readonly<Record<string, ObjectiveStatus>>>({});
  const [patching, setPatching] = useState<ReadonlySet<string>>(new Set());
  const [saveProblem, setSaveProblem] = useState<Problem | null>(null);
  const view = load.status === 'ready' ? load.view : null;

  useEffect(() => {
    const live = { on: true };
    void (async () => {
      try {
        const next = await apiGet('/api/assessment', assessmentViewSchema);
        if (live.on) setLoad({ status: 'ready', view: next });
      } catch (error) {
        if (live.on) setLoad({ status: 'error', problem: problemOf(error) });
      }
      try {
        const list = await apiGet('/api/users', usersResponseSchema);
        if (live.on) setUsers(list.users);
      } catch {
        // Without the list, the owner Select offers Unassigned and the current owner only.
      }
    })();
    return () => {
      live.on = false;
    };
  }, [attempt]);

  const input = useMemo(() => {
    const saved = view ? toAssessmentInput(view) : EMPTY_INPUT;
    return Object.keys(optimistic).length === 0
      ? saved
      : applyWhatIf(loadCatalog(), saved, { objectiveStatuses: optimistic });
  }, [view, optimistic]);

  const evaluation = useMemo(() => {
    if (!view) return null;
    return Object.keys(optimistic).length === 0
      ? view.evaluation
      : evaluateAssessment(loadCatalog(), input);
  }, [view, optimistic, input]);

  const statusOf = useCallback(
    (objectiveId: string): ObjectiveStatus =>
      optimistic[objectiveId] ??
      view?.objectiveResults.find((r) => r.objectiveId === objectiveId)?.status ??
      'not_assessed',
    [optimistic, view],
  );
  const noteOf = useCallback(
    (objectiveId: string) =>
      view?.objectiveResults.find((r) => r.objectiveId === objectiveId)?.note ?? null,
    [view],
  );

  const write = useCallback(
    async (objectiveId: string, status: ObjectiveStatus, note: string | null) => {
      setSaveProblem(null);
      setOptimistic((current) => ({ ...current, [objectiveId]: status }));
      try {
        const response = await apiSend(
          'PUT',
          `/api/assessment/objectives/${encodeURIComponent(objectiveId)}`,
          { status, note },
          objectiveWriteResponseSchema,
        );
        setLoad((current) => {
          if (current.status !== 'ready') return current;
          const rows = current.view.objectiveResults;
          const exists = rows.some((r) => r.objectiveId === objectiveId);
          return {
            status: 'ready',
            view: {
              ...current.view,
              objectiveResults: exists
                ? rows.map((r) => (r.objectiveId === objectiveId ? response.objectiveResult : r))
                : [...rows, response.objectiveResult],
              evaluation: response.evaluation,
            },
          };
        });
      } catch (error) {
        setSaveProblem(problemOf(error));
      } finally {
        setOptimistic((current) => {
          return Object.fromEntries(Object.entries(current).filter(([id]) => id !== objectiveId));
        });
      }
    },
    [],
  );

  const setStatus = useCallback(
    (objectiveId: string, status: ObjectiveStatus) => {
      const row = view?.objectiveResults.find((r) => r.objectiveId === objectiveId);
      return write(objectiveId, status, row?.note ?? null);
    },
    [write, view],
  );
  const saveNote = useCallback(
    (objectiveId: string, note: string | null) => {
      const row = view?.objectiveResults.find((r) => r.objectiveId === objectiveId);
      return write(objectiveId, row?.status ?? 'not_assessed', note);
    },
    [write, view],
  );

  const patchRequirement = useCallback(
    async (requirementId: string, body: PatchRequirementRequest) => {
      setSaveProblem(null);
      setPatching((current) => new Set(current).add(requirementId));
      try {
        const response = await apiSend(
          'PATCH',
          `/api/assessment/requirements/${encodeURIComponent(requirementId)}`,
          body,
          requirementWriteResponseSchema,
        );
        setLoad((current) => {
          if (current.status !== 'ready') return current;
          const rows = current.view.requirementStates;
          const exists = rows.some((r) => r.requirementId === requirementId);
          return {
            status: 'ready',
            view: {
              ...current.view,
              requirementStates: exists
                ? rows.map((r) =>
                    r.requirementId === requirementId ? response.requirementState : r,
                  )
                : [...rows, response.requirementState],
              evaluation: response.evaluation,
            },
          };
        });
      } catch (error) {
        setSaveProblem(problemOf(error));
      } finally {
        setPatching((current) => {
          const rest = new Set(current);
          rest.delete(requirementId);
          return rest;
        });
      }
    },
    [],
  );

  return {
    load,
    retry: useCallback(() => {
      setLoad({ status: 'loading' });
      setAttempt((n) => n + 1);
    }, []),
    users,
    input,
    evaluation,
    statusOf,
    noteOf,
    isSaving: (objectiveId) => objectiveId in optimistic,
    isPatching: (requirementId) => patching.has(requirementId),
    setStatus,
    saveNote,
    patchRequirement,
    saveProblem,
  };
}
