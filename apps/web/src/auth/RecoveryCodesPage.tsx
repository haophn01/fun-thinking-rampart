import { useState } from 'react';
import { Alert, Button, Checkbox } from '../look';
import { usePageTitle } from '../pages/usePageTitle';
import styles from './auth.module.css';
import mfa from './Mfa.module.css';
import { useSession } from './session';

type Copy = 'idle' | 'copied' | 'failed';

/**
 * Save your recovery codes: shown once, right after enrollment. Continue waits until the user
 * says the codes are saved; it then opens whatever the session allows.
 */
export function RecoveryCodesPage() {
  usePageTitle('Save your recovery codes');
  const session = useSession();
  const codes = session.recoveryCodes ?? [];
  const [saved, setSaved] = useState(false);
  const [copy, setCopy] = useState<Copy>('idle');

  async function copyCodes() {
    setCopy('idle');
    try {
      // `navigator.clipboard` is missing outside a secure context.
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (clipboard === undefined) throw new Error('no clipboard');
      await clipboard.writeText(codes.join('\n'));
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <>
      <div className={styles.intro}>
        <p className={styles.kicker}>Inspection access</p>
        <h1>Save your recovery codes</h1>
        <p>If you lose your authenticator app, a recovery code signs you in instead.</p>
        <p>Each code works once. You won&apos;t see them again.</p>
      </div>
      <ol className={mfa.codes} data-testid="recovery-codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      {copy === 'copied' && <Alert tone="info">Copied.</Alert>}
      {copy === 'failed' && <Alert tone="error">Couldn&apos;t copy. Write them down.</Alert>}
      <div className={styles.actions}>
        <Button onClick={() => void copyCodes()}>Copy</Button>
      </div>
      <div className={styles.form}>
        <Checkbox label="I saved my recovery codes" checked={saved} onChange={setSaved} />
        <div className={styles.actions}>
          <Button variant="primary" disabled={!saved} onClick={session.acknowledgeRecoveryCodes}>
            Continue
          </Button>
        </div>
      </div>
    </>
  );
}
