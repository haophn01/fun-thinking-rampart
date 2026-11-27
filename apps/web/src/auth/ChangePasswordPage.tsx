import { Button } from '../look';
import { usePageTitle } from '../pages/usePageTitle';
import styles from './auth.module.css';
import { useSession } from './session';

export interface ChangePasswordPageProps {
  /** The password is temporary: the gate shows this page in the auth frame, with Sign out. */
  forced?: boolean;
}

/**
 * Change password: `/account/password` inside the shell, or forced by the gate for a temporary
 * password. A stub until W1 builds the form.
 */
export function ChangePasswordPage({ forced = false }: ChangePasswordPageProps) {
  usePageTitle('Change password');
  const session = useSession();
  if (!forced) {
    return (
      <section>
        <h1>Change password</h1>
        <p>Changing your password isn&apos;t built yet.</p>
      </section>
    );
  }
  return (
    <>
      <div className={styles.intro} data-testid="change-password-forced">
        <p className={styles.kicker}>Inspection access</p>
        <h1>Change password</h1>
        <p>An admin set your password. Choose your own to continue.</p>
      </div>
      <div className={styles.actions}>
        <Button onClick={() => void session.signOut().catch(session.endSession)}>Sign out</Button>
      </div>
    </>
  );
}
