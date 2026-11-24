import {
  sessionResponseSchema,
  type Role,
  type SessionResponse,
  type SessionUser,
} from '@rampart/api/contract';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { apiGet, apiSend, setApiSessionHooks } from '../api/client';

export type SessionStatus = 'loading' | 'setup' | 'signed_out' | 'signed_in' | 'error';

/** How a role reads in the UI. */
export const ROLE_LABELS: Record<Role, string> = { admin: 'Admin', contributor: 'Contributor' };

/** What Sign in shows after a call answers 401 mid-session. */
export const SESSION_ENDED = 'Your session ended. Sign in again.';

export interface SetupInput {
  email: string;
  displayName: string;
  password: string;
}

export interface SessionValue {
  status: SessionStatus;
  user: SessionUser | null;
  /** A message for the Sign in page, such as `SESSION_ENDED`; `null` otherwise. */
  notice: string | null;
  /** Re-reads `GET /api/session`. Never throws: a failure becomes `status: 'error'`. */
  refresh: () => Promise<void>;
  /** `POST /api/setup`. Throws `ApiError`; on success the user is signed in. */
  setup: (input: SetupInput) => Promise<void>;
  /** `POST /api/session`. Throws `ApiError`; on success the user is signed in. */
  signIn: (email: string, password: string) => Promise<void>;
  /** `DELETE /api/session`. Throws `ApiError` and stays signed in when it fails. */
  signOut: () => Promise<void>;
  /** Drops the session locally and shows Sign in with `SESSION_ENDED`. */
  endSession: () => void;
}

interface State {
  status: SessionStatus;
  user: SessionUser | null;
  csrfToken: string | null;
  notice: string | null;
}

const LOADING: State = { status: 'loading', user: null, csrfToken: null, notice: null };

/** The gate's state for a session answer. */
function stateFor(session: SessionResponse): State {
  if (session.user !== null) {
    return { status: 'signed_in', user: session.user, csrfToken: session.csrfToken, notice: null };
  }
  return {
    status: session.setupRequired ? 'setup' : 'signed_out',
    user: null,
    csrfToken: null,
    notice: null,
  };
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(LOADING);
  // The CSRF token is read by the api client between renders, so it lives in a ref too.
  const csrf = useRef<string | null>(null);
  // Each change bumps the version; an answer that arrives after a newer change is dropped.
  const version = useRef(0);

  const apply = useCallback((next: State) => {
    csrf.current = next.csrfToken;
    setState(next);
  }, []);

  const endSession = useCallback(() => {
    version.current += 1;
    csrf.current = null;
    // Only a signed-in user's session can end; a late 401 after sign-out says nothing.
    setState((current) =>
      current.status === 'signed_in'
        ? { status: 'signed_out', user: null, csrfToken: null, notice: SESSION_ENDED }
        : current,
    );
  }, []);

  /** Reads the session; it sets state only once the answer is in. */
  const load = useCallback(async () => {
    version.current += 1;
    const run = version.current;
    let next: State;
    try {
      next = stateFor(await apiGet('/api/session', sessionResponseSchema));
    } catch {
      next = { status: 'error', user: null, csrfToken: null, notice: null };
    }
    if (run === version.current) apply(next);
  }, [apply]);

  const refresh = useCallback(() => {
    // Only a retry after an error shows Loading; a signed-in refresh keeps the page mounted.
    setState((current) =>
      current.status === 'error' ? { ...current, status: 'loading' } : current,
    );
    return load();
  }, [load]);

  const signInWith = useCallback(
    async (path: '/api/session' | '/api/setup', body: unknown) => {
      version.current += 1;
      const run = version.current;
      const session = await apiSend('POST', path, body, sessionResponseSchema);
      if (run === version.current) apply(stateFor(session));
    },
    [apply],
  );

  const signIn = useCallback(
    (email: string, password: string) => signInWith('/api/session', { email, password }),
    [signInWith],
  );
  const setup = useCallback((input: SetupInput) => signInWith('/api/setup', input), [signInWith]);

  const signOut = useCallback(async () => {
    await apiSend('DELETE', '/api/session');
    version.current += 1;
    apply({ status: 'signed_out', user: null, csrfToken: null, notice: null });
  }, [apply]);

  useEffect(() => {
    setApiSessionHooks({ csrfToken: () => csrf.current, onUnauthenticated: endSession });
    void load();
    return () => {
      version.current += 1;
      setApiSessionHooks(null);
    };
  }, [endSession, load]);

  const value = useMemo<SessionValue>(
    () => ({
      status: state.status,
      user: state.user,
      notice: state.notice,
      refresh,
      setup,
      signIn,
      signOut,
      endSession,
    }),
    [state, refresh, setup, signIn, signOut, endSession],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}

/** The session store. Use inside `SessionProvider`. */
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
