import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { ApiError } from '../api/client';
import { tooManyRequestsText } from '../api/too-many';
import { Alert, Button, TextField } from '../look';
import { usePageTitle } from '../pages/usePageTitle';
import styles from './auth.module.css';
import lockStyles from './LockScreen.module.css';
import { useSession } from './session';

/** The message a failed unlock shows. */
export function unlockFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return 'Password is incorrect.';
    if (error.status === 429) return tooManyRequestsText(error.details);
  }
  return 'Unlock failed. Try again.';
}

/**
 * Re-reads the session when the window gets focus or the tab becomes visible, so a session
 * unlocked in another tab dismisses this lock. One re-read at a time.
 */
function useRefreshOnReturn(refresh: () => Promise<void>) {
  useEffect(() => {
    let inFlight = false;
    const reread = () => {
      if (inFlight) return;
      inFlight = true;
      void refresh().finally(() => {
        inFlight = false;
      });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') reread();
    };
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);
}

/**
 * The lock screen (3.1.10): who is locked out, the password to unlock, or Sign out. The gate
 * shows it in the auth frame while the session is locked, with the app hidden behind it.
 */
export function LockScreen() {
  usePageTitle('Session locked');
  const session = useSession();
  const [password, setPassword] = useState('');
  const [empty, setEmpty] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // TextField takes no ref, so the form finds its input.
  const form = useRef<HTMLFormElement>(null);
  const focusField = () => form.current?.querySelector('input')?.focus();

  useRefreshOnReturn(session.refresh);

  // Focused on show, and again after each failure.
  useEffect(() => {
    if (!pending) form.current?.querySelector('input')?.focus();
  }, [pending, failure]);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (password === '') {
      setEmpty(true);
      focusField();
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await session.unlock(password);
    } catch (error) {
      setFailure(unlockFailure(error));
      setPassword('');
      setPending(false);
    }
  }

  return (
    <>
      <div className={styles.intro}>
        <p className={styles.kicker}>Inspection access</p>
        <h1>Session locked</h1>
        <p>Enter your password to go back to where you were.</p>
      </div>
      {session.user !== null && (
        <dl className={lockStyles.who}>
          <dt className={lockStyles.term}>Signed in as</dt>
          <dd className={lockStyles.name}>{session.user.displayName}</dd>
          <dd className={lockStyles.email}>{session.user.email}</dd>
        </dl>
      )}
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <form
        ref={form}
        className={styles.form}
        noValidate
        onSubmit={(event) => void onSubmit(event)}
      >
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          error={empty ? 'Enter your password.' : undefined}
          onChange={(event) => {
            setPassword(event.target.value);
            setEmpty(false);
          }}
        />
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={pending}>
            Unlock
          </Button>
          <Button onClick={() => void session.signOut().catch(session.endSession)}>Sign out</Button>
        </div>
      </form>
    </>
  );
}
