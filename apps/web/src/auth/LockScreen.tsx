import { useState, type SyntheticEvent } from 'react';
import { ApiError } from '../api/client';
import { tooManyRequestsText } from '../api/too-many';
import { Alert, Button, TextField } from '../look';
import { usePageTitle } from '../pages/usePageTitle';
import styles from './auth.module.css';
import { useSession } from './session';

/** The message a failed unlock shows. */
function unlockFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return 'Password is incorrect.';
    if (error.status === 429) return tooManyRequestsText(error.details);
  }
  return 'Unlock failed. Try again.';
}

/**
 * The lock screen: the password unlocks the session, or Sign out. The gate shows it in the auth
 * frame while the session is locked. A stub until W2 builds the full screen.
 */
export function LockScreen() {
  usePageTitle('Session locked');
  const session = useSession();
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || password === '') return;
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
      </div>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <form className={styles.form} noValidate onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
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
