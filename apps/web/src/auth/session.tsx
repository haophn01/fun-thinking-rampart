import {
  sessionResponseSchema,
  type Role,
  type SessionResponse,
  type SessionUser,
  type SignInNotice,
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
import { ApiError, apiGet, apiSend, setApiSessionHooks } from '../api/client';
import { retryAfterSecondsOf } from '../api/too-many';

/**
 * `locked`: the session needs the password again (it wins over `password_change`).
 * `password_change`: the password is temporary and must be changed before the app opens.
 */
export type SessionStatus =
  'loading' | 'setup' | 'signed_out' | 'signed_in' | 'locked' | 'password_change' | 'error';

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
  /** The notice every sign-in acknowledges, from the last session answer; `null` when none. */
  signInNotice: SignInNotice | null;
  /**
   * Set only while `status` is `error` because the session load got a 429: the wait in whole
   * seconds, or 0 when the answer gave none. `null` otherwise.
   */
  retryAfterSeconds: number | null;
  /**
   * Re-reads `GET /api/session`. Never throws. A failure becomes `status: 'error'`, except while
   * signed in, locked or changing a password, where the current state (and the app's drafts)
   * stays; a 401 still ends the session through the api client.
   */
  refresh: () => Promise<void>;
  /** `POST /api/setup`. Throws `ApiError`; on success the user is signed in. */
  setup: (input: SetupInput) => Promise<void>;
  /** `POST /api/session`, with `noticeDigest` when given. Throws `ApiError`. */
  signIn: (email: string, password: string, noticeDigest?: string) => Promise<void>;
  /** `DELETE /api/session`. Throws `ApiError` and stays signed in when it fails. */
  signOut: () => Promise<void>;
  /** Drops the session locally and shows Sign in with `SESSION_ENDED`. */
  endSession: () => void;
  /**
   * Shows the lock at once, then posts `POST /api/session/lock`; a failure is ignored. Until
   * that post succeeds, a session answer saying "not locked" keeps the lock and posts again.
   * Does nothing unless signed in or changing a password.
   */
  lock: () => Promise<void>;
  /** `POST /api/session/unlock`. Throws `ApiError`; on success applies the returned session. */
  unlock: (password: string) => Promise<void>;
  /** `POST /api/session/password`. Throws `ApiError`; on success applies the rotated session. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

interface State {
  status: SessionStatus;
  user: SessionUser | null;
  csrfToken: string | null;
  notice: string | null;
  signInNotice: SignInNotice | null;
  retryAfterSeconds: number | null;
}

const LOADING: State = {
  status: 'loading',
  user: null,
  csrfToken: null,
  notice: null,
  signInNotice: null,
  retryAfterSeconds: null,
};

/** The statuses that hold a session: a failed refresh keeps them, and `endSession` ends them. */
const HOLDS_SESSION: ReadonlySet<SessionStatus> = new Set([
  'signed_in',
  'locked',
  'password_change',
]);

/** The gate's state for a session answer. */
function stateFor(session: SessionResponse): State {
  const base = { notice: null, signInNotice: session.signInNotice, retryAfterSeconds: null };
  if (session.user !== null) {
    const status = session.locked
      ? 'locked'
      : session.mustChangePassword
        ? 'password_change'
        : 'signed_in';
    return { ...base, status, user: session.user, csrfToken: session.csrfToken };
  }
  return {
    ...base,
    status: session.setupRequired ? 'setup' : 'signed_out',
    user: null,
    csrfToken: null,
  };
}

/** The error state for a failed session load; a 429 carries its wait. */
function errorFor(error: unknown): State {
  const limited = error instanceof ApiError && error.status === 429;
  return {
    ...LOADING,
    status: 'error',
    retryAfterSeconds: limited ? (retryAfterSecondsOf(error.details) ?? 0) : null,
  };
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(LOADING);
  // The api client and the methods read the state between renders, so it lives in a ref too.
  const current = useRef<State>(LOADING);
  // Each change bumps the version; an answer that arrives after a newer change is dropped.
  const version = useRef(0);
  // False from a local lock() until its POST succeeds or the api reports the lock itself.
  const lockConfirmed = useRef(true);

  const commit = useCallback((next: State) => {
    current.current = next;
    setState(next);
  }, []);

  const endSession = useCallback(() => {
    version.current += 1;
    const now = current.current;
    // Only a held session can end; a late 401 after sign-out says nothing.
    if (!HOLDS_SESSION.has(now.status)) return;
    commit({ ...now, status: 'signed_out', user: null, csrfToken: null, notice: SESSION_ENDED });
  }, [commit]);

  const postLock = useCallback(async () => {
    try {
      await apiSend('POST', '/api/session/lock');
      lockConfirmed.current = true;
    } catch {
      // Ignored: the lock already shows, and the next session answer posts it again.
    }
  }, []);

  const onLocked = useCallback(() => {
    const now = current.current;
    if (now.status !== 'signed_in' && now.status !== 'password_change') return;
    version.current += 1;
    lockConfirmed.current = true;
    commit({ ...now, status: 'locked' });
  }, [commit]);

  /** Applies a re-read session, unless it would drop a lock the api hasn't confirmed yet. */
  const applyAnswer = useCallback(
    (next: State) => {
      const now = current.current;
      if (next.status === 'locked') lockConfirmed.current = true;
      const unconfirmed =
        now.status === 'locked' &&
        !lockConfirmed.current &&
        next.user !== null &&
        next.user.id === now.user?.id;
      if (unconfirmed) {
        commit({ ...next, status: 'locked' });
        void postLock();
        return;
      }
      commit(next);
    },
    [commit, postLock],
  );

  /** Reads the session; it sets state only once the answer is in. */
  const load = useCallback(async () => {
    version.current += 1;
    const run = version.current;
    let next: State | null;
    try {
      next = stateFor(await apiGet('/api/session', sessionResponseSchema));
    } catch (error) {
      // A held session survives a failed re-read, so a blip never unmounts the app.
      next = HOLDS_SESSION.has(current.current.status) ? null : errorFor(error);
    }
    if (run === version.current && next !== null) applyAnswer(next);
  }, [applyAnswer]);

  const refresh = useCallback(() => {
    // Only a retry after an error shows Loading; a signed-in refresh keeps the page mounted.
    const now = current.current;
    if (now.status === 'error') commit({ ...now, status: 'loading', retryAfterSeconds: null });
    return load();
  }, [commit, load]);

  /** Posts a call that answers with a session, then applies it if nothing newer happened. */
  const sendForSession = useCallback(
    async (path: string, body: unknown) => {
      version.current += 1;
      const run = version.current;
      const session = await apiSend('POST', path, body, sessionResponseSchema);
      if (run !== version.current) return;
      // These calls set the session's state themselves, so their answer always applies.
      lockConfirmed.current = true;
      commit(stateFor(session));
    },
    [commit],
  );

  const signIn = useCallback(
    (email: string, password: string, noticeDigest?: string) =>
      sendForSession(
        '/api/session',
        noticeDigest === undefined ? { email, password } : { email, password, noticeDigest },
      ),
    [sendForSession],
  );
  const setup = useCallback(
    (input: SetupInput) => sendForSession('/api/setup', input),
    [sendForSession],
  );
  const unlock = useCallback(
    (password: string) => sendForSession('/api/session/unlock', { password }),
    [sendForSession],
  );
  const changePassword = useCallback(
    (currentPassword: string, newPassword: string) =>
      sendForSession('/api/session/password', { currentPassword, newPassword }),
    [sendForSession],
  );

  const lock = useCallback(async () => {
    const now = current.current;
    if (now.status !== 'signed_in' && now.status !== 'password_change') return;
    version.current += 1;
    lockConfirmed.current = false;
    commit({ ...now, status: 'locked' });
    await postLock();
  }, [commit, postLock]);

  const signOut = useCallback(async () => {
    await apiSend('DELETE', '/api/session');
    version.current += 1;
    commit({ ...current.current, status: 'signed_out', user: null, csrfToken: null, notice: null });
  }, [commit]);

  useEffect(() => {
    setApiSessionHooks({
      csrfToken: () => current.current.csrfToken,
      onUnauthenticated: endSession,
      onLocked,
      // The api says two-step sign-in is still needed: re-read the session to find which step.
      onMfaRequired: () => void load(),
    });
    void load();
    return () => {
      version.current += 1;
      setApiSessionHooks(null);
    };
  }, [endSession, onLocked, load]);

  const value = useMemo<SessionValue>(
    () => ({
      status: state.status,
      user: state.user,
      notice: state.notice,
      signInNotice: state.signInNotice,
      retryAfterSeconds: state.retryAfterSeconds,
      refresh,
      setup,
      signIn,
      signOut,
      endSession,
      lock,
      unlock,
      changePassword,
    }),
    [state, refresh, setup, signIn, signOut, endSession, lock, unlock, changePassword],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}

/** The session store. Use inside `SessionProvider`. */
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
