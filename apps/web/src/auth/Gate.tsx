import { PRODUCT_NAME } from '@rampart/api/contract';
import { useState, type ReactNode } from 'react';
import { tooManyRequestsText } from '../api/too-many';
import { Alert, Button } from '../look';
import { usePageTitle } from '../pages/usePageTitle';
import { RegistrationMarks } from '../shell/RegistrationMarks';
import styles from './auth.module.css';
import { ChangePasswordPage } from './ChangePasswordPage';
import { IdleLock } from './IdleLock';
import { LockScreen } from './LockScreen';
import { MfaChallengePage } from './MfaChallengePage';
import { MfaEnrollPage } from './MfaEnrollPage';
import { RecoveryCodesPage } from './RecoveryCodesPage';
import { useSession } from './session';
import { SetupPage } from './SetupPage';
import { SignInPage } from './SignInPage';

/** The brand strip and one sheet, for the pages shown before anyone is signed in. */
function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className={styles.frame}>
      <header className={styles.head}>
        <RegistrationMarks />
        <span className={styles.brand}>
          {PRODUCT_NAME}
          <span className={styles.tag}>CMMC L2</span>
        </span>
      </header>
      <main className={styles.body}>
        <div className={styles.sheet}>{children}</div>
      </main>
    </div>
  );
}

function SessionError({
  retryAfterSeconds,
  onRetry,
}: {
  retryAfterSeconds: number | null;
  onRetry: () => void;
}) {
  usePageTitle('Unavailable');
  const retry = (
    <Button className={styles.retry} onClick={onRetry}>
      Retry
    </Button>
  );
  // A 429 is the api answering: say how long to wait, not that it can't be reached.
  if (retryAfterSeconds !== null) {
    return (
      <Alert tone="error">
        <p>{tooManyRequestsText({ retryAfterSeconds })}</p>
        {retry}
      </Alert>
    );
  }
  return (
    <Alert tone="error" title="Can't load your session">
      <p>Check that the API is running, then retry.</p>
      {retry}
    </Alert>
  );
}

/**
 * The app while a session holds: shown when signed in; kept mounted but `hidden` and `inert`
 * (drafts survive, nothing shows or takes focus) next to the lock screen when the session locks.
 */
function HeldApp({ locked, children }: { locked: boolean; children: ReactNode }) {
  return (
    <>
      <div data-testid="gate-app" hidden={locked} inert={locked}>
        {children}
      </div>
      {locked ? (
        <AuthFrame>
          <LockScreen />
        </AuthFrame>
      ) : (
        <IdleLock />
      )}
    </>
  );
}

/**
 * Shows what the session allows: Loading, Setup, Sign in, an error with Retry, the lock screen,
 * two-step setup, its recovery codes or its challenge, the forced password change, or the app.
 */
export function Gate({ children }: { children: ReactNode }) {
  const session = useSession();
  // Whether the app has been shown since the page loaded, so a lock keeps it mounted. A page
  // that loads into a locked session never mounts it.
  const [appShown, setAppShown] = useState(false);
  const holdApp = session.status === 'signed_in' || (session.status === 'locked' && appShown);
  if (holdApp !== appShown) setAppShown(holdApp);

  if (holdApp) return <HeldApp locked={session.status === 'locked'}>{children}</HeldApp>;
  switch (session.status) {
    case 'signed_in':
    case 'locked':
      return (
        <AuthFrame>
          <LockScreen />
        </AuthFrame>
      );
    case 'mfa_enroll':
      return (
        <AuthFrame>
          <MfaEnrollPage />
        </AuthFrame>
      );
    case 'mfa_recovery_codes':
      return (
        <AuthFrame>
          <RecoveryCodesPage />
        </AuthFrame>
      );
    case 'mfa_challenge':
      return (
        <AuthFrame>
          <MfaChallengePage />
        </AuthFrame>
      );
    case 'password_change':
      return (
        <AuthFrame>
          <ChangePasswordPage forced />
        </AuthFrame>
      );
    case 'setup':
      return (
        <AuthFrame>
          <SetupPage />
        </AuthFrame>
      );
    case 'signed_out':
      return (
        <AuthFrame>
          <SignInPage />
        </AuthFrame>
      );
    case 'error':
      return (
        <AuthFrame>
          <SessionError
            retryAfterSeconds={session.retryAfterSeconds}
            onRetry={() => void session.refresh()}
          />
        </AuthFrame>
      );
    case 'loading':
      return (
        <AuthFrame>
          <p role="status">Loading…</p>
        </AuthFrame>
      );
  }
}
