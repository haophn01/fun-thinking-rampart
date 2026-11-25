import {
  evidenceItemResponseSchema,
  evidenceListSchema,
  type AddReferenceRequest,
  type CreateEvidenceRequest,
  type EvidenceItem,
} from '@rampart/api/contract';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiGet, apiSend, apiUpload } from '../../api/client';

/** What the page shows when a call fails: the message and the request ID to quote. */
export interface Problem {
  message: string;
  requestId?: string | undefined;
}

export function problemOf(error: unknown): Problem {
  if (error instanceof ApiError) return { message: error.message, requestId: error.requestId };
  return { message: 'Something went wrong.' };
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; problem: Problem }
  | { status: 'ready'; items: readonly EvidenceItem[] };

/** A write's outcome: the saved item, or the message to show. */
export type Outcome = { ok: true; item: EvidenceItem } | { ok: false; message: string };

export interface EvidenceState {
  load: Load;
  retry: () => void;
  create: (body: CreateEvidenceRequest) => Promise<Outcome>;
  upload: (id: string, file: File) => Promise<Outcome>;
  addReference: (id: string, body: AddReferenceRequest) => Promise<Outcome>;
  putObjectives: (id: string, objectiveIds: string[]) => Promise<Outcome>;
}

function byTitle(a: EvidenceItem, b: EvidenceItem): number {
  return (
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

/** Loads the evidence list and applies each write's answer to it. */
export function useEvidence(): EvidenceState {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const live = { on: true };
    void (async () => {
      try {
        const next = await apiGet('/api/evidence', evidenceListSchema);
        if (live.on) setLoad({ status: 'ready', items: next.items });
      } catch (error) {
        if (live.on) setLoad({ status: 'error', problem: problemOf(error) });
      }
    })();
    return () => {
      live.on = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setLoad({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  /** Puts the answered item into the list (by id), keeping the list's sort order. */
  const adopt = useCallback((item: EvidenceItem) => {
    setLoad((current) => {
      if (current.status !== 'ready') return current;
      const rest = current.items.filter((i) => i.id !== item.id);
      return { status: 'ready', items: [...rest, item].sort(byTitle) };
    });
  }, []);

  const run = useCallback(
    async (write: () => Promise<{ item: EvidenceItem }>): Promise<Outcome> => {
      try {
        const { item } = await write();
        adopt(item);
        return { ok: true, item };
      } catch (error) {
        return { ok: false, message: problemOf(error).message };
      }
    },
    [adopt],
  );

  return {
    load,
    retry,
    create: (body) => run(() => apiSend('POST', '/api/evidence', body, evidenceItemResponseSchema)),
    upload: (id, file) =>
      run(() =>
        apiUpload(
          `/api/evidence/${encodeURIComponent(id)}/versions`,
          file,
          file.name,
          evidenceItemResponseSchema,
        ),
      ),
    addReference: (id, body) =>
      run(() =>
        apiSend(
          'POST',
          `/api/evidence/${encodeURIComponent(id)}/references`,
          body,
          evidenceItemResponseSchema,
        ),
      ),
    putObjectives: (id, objectiveIds) =>
      run(() =>
        apiSend(
          'PUT',
          `/api/evidence/${encodeURIComponent(id)}/objectives`,
          { objectiveIds },
          evidenceItemResponseSchema,
        ),
      ),
  };
}
