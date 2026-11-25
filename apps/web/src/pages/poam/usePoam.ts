import {
  poamItemResponseSchema,
  poamViewSchema,
  usersResponseSchema,
  type CloseoutRequest,
  type CreatePoamItemRequest,
  type PatchPoamItemRequest,
  type PoamView,
  type User,
} from '@rampart/api/contract';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiGet, apiSend } from '../../api/client';

/** What the page shows when a load fails: the message and the request ID to quote. */
export interface Problem {
  message: string;
  requestId?: string | undefined;
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; problem: Problem }
  | { status: 'ready'; view: PoamView };

export interface PoamState {
  load: Load;
  retry: () => void;
  users: readonly User[];
  /** Each write resolves to `null` on success (the view is re-read), or the error. */
  create: (body: CreatePoamItemRequest) => Promise<ApiError | null>;
  patch: (id: string, body: PatchPoamItemRequest) => Promise<ApiError | null>;
  closeout: (id: string, body: CloseoutRequest) => Promise<ApiError | null>;
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError({ status: 0, code: 'unknown', message: 'Something went wrong.' });
}

/** Loads the POA&M view and the users (for the owner Select), and writes items. */
export function usePoam(): PoamState {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [users, setUsers] = useState<readonly User[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const live = { on: true };
    void (async () => {
      try {
        const view = await apiGet('/api/poam', poamViewSchema);
        if (live.on) setLoad({ status: 'ready', view });
      } catch (error) {
        if (live.on) {
          const e = asApiError(error);
          setLoad({ status: 'error', problem: { message: e.message, requestId: e.requestId } });
        }
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

  /** Re-reads the view after a write, keeping the page up if the re-read fails. */
  const reread = useCallback(async () => {
    try {
      setLoad({ status: 'ready', view: await apiGet('/api/poam', poamViewSchema) });
    } catch {
      // The write went through; the next load shows the saved state.
    }
  }, []);

  const write = useCallback(
    async (method: 'POST' | 'PATCH', path: string, body: unknown) => {
      try {
        await apiSend(method, path, body, poamItemResponseSchema);
      } catch (error) {
        return asApiError(error);
      }
      await reread();
      return null;
    },
    [reread],
  );

  return {
    load,
    users,
    retry: useCallback(() => {
      setLoad({ status: 'loading' });
      setAttempt((n) => n + 1);
    }, []),
    create: useCallback((body) => write('POST', '/api/poam', body), [write]),
    patch: useCallback(
      (id, body) => write('PATCH', `/api/poam/${encodeURIComponent(id)}`, body),
      [write],
    ),
    closeout: useCallback(
      (id, body) => write('POST', `/api/poam/${encodeURIComponent(id)}/closeout`, body),
      [write],
    ),
  };
}
