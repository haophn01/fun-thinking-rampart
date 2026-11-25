import { useState } from 'react';
import { Alert, Button } from '../look';
import styles from './auth.module.css';
import { ROLE_LABELS, useSession } from './session';

/** The masthead's signed-in user: name, role and Sign out. */
export function UserSlot() {
  const session = useSession();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  if (session.user === null) return null;

  async function signOut() {
    setPending(true);
    setFailed(false);
    try {
      await session.signOut();
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <div className={styles.slot}>
      <span className={styles.who}>
        <span className={styles.name}>{session.user.displayName}</span>
        <span className={styles.role}>{ROLE_LABELS[session.user.role]}</span>
      </span>
      <Button disabled={pending} onClick={() => void signOut()}>
        Sign out
      </Button>
      {failed && (
        <Alert tone="error" className={styles.slotAlert}>
          Couldn&apos;t sign out. Check your connection and try again.
        </Alert>
      )}
    </div>
  );
}
