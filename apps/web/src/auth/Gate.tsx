import { PRODUCT_NAME } from '@rampart/api/contract';
import type { ReactNode } from 'react';
import { Alert, Button } from '../look';
import { usePageTitle } from '../pages/usePageTitle';
import { RegistrationMarks } from '../shell/RegistrationMarks';
import styles from './auth.module.css';
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

function SessionError({ onRetry }: { onRetry: () => void }) {
  usePageTitle('Unavailable');
  return (
    <Alert tone="error" title="Can't load your session">
      <p>Check that the API is running, then retry.</p>
      <Button className={styles.retry} onClick={onRetry}>
        Retry
      </Button>
    </Alert>
  );
}

/** Shows what the session allows: Loading, Setup, Sign in, an error with Retry, or the app. */
export function Gate({ children }: { children: ReactNode }) {
  const session = useSession();
  switch (session.status) {
    case 'signed_in':
      return children;
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
          <SessionError onRetry={() => void session.refresh()} />
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
