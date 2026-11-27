import {
  recoveryCodeInputSchema,
  totpCodeSchema,
  type MfaVerifyRequest,
} from '@rampart/api/contract';
import { useRef, useState, type SyntheticEvent } from 'react';
import { Alert, Button, TextField } from '../look';
import { usePageTitle } from '../pages/usePageTitle';
import styles from './auth.module.css';
import mfa from './Mfa.module.css';
import { CODE_FORMAT, mfaRefusal } from './MfaEnrollPage';
import { useSession } from './session';

const RECOVERY_FORMAT = 'Enter a recovery code: 10 letters and digits.';

type Method = 'code' | 'recovery';

/** The request for what was typed, or the field error when it can't be sent. */
function verifyInput(method: Method, value: string): MfaVerifyRequest | { error: string } {
  if (method === 'code') {
    const code = totpCodeSchema.safeParse(value);
    return code.success ? { code: code.data } : { error: CODE_FORMAT };
  }
  const recoveryCode = recoveryCodeInputSchema.safeParse(value.trim());
  return recoveryCode.success ? { recoveryCode: recoveryCode.data } : { error: RECOVERY_FORMAT };
}

/**
 * Enter your code: the gate shows it while the session's `mfa` is `challenge`. A code from the
 * authenticator app, or one recovery code.
 */
export function MfaChallengePage() {
  usePageTitle('Enter your code');
  const session = useSession();
  const [method, setMethod] = useState<Method>('code');
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  function switchTo(next: Method) {
    setMethod(next);
    setValue('');
    setFieldError(null);
    setAlert(null);
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setAlert(null);
    const input = verifyInput(method, value);
    if ('error' in input) {
      setFieldError(input.error);
      return;
    }
    setFieldError(null);
    inFlight.current = true;
    setPending(true);
    try {
      await session.verifyMfa(input);
    } catch (error) {
      const shown = mfaRefusal(error, "Couldn't check the code. Try again.");
      if ('field' in shown) {
        setFieldError(shown.field);
        setValue('');
      } else if ('alert' in shown) {
        setAlert(shown.alert);
      } else {
        void session.refresh();
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const byCode = method === 'code';
  return (
    <>
      <div className={styles.intro}>
        <p className={styles.kicker}>Inspection access</p>
        <h1>Enter your code</h1>
        <p>
          {byCode
            ? 'Open your authenticator app and enter the code it shows for this account.'
            : 'Enter one of the recovery codes you saved. Each code works once.'}
        </p>
      </div>
      {alert !== null && <Alert tone="error">{alert}</Alert>}
      <form className={styles.form} noValidate onSubmit={(event) => void onSubmit(event)}>
        <TextField
          // A new field per method, so the browser's autofill and the label never mix.
          key={method}
          label={byCode ? '6-digit code' : 'Recovery code'}
          inputMode={byCode ? 'numeric' : 'text'}
          autoComplete={byCode ? 'one-time-code' : 'off'}
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          error={fieldError ?? undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setFieldError(null);
          }}
        />
        <Button
          className={mfa.switch}
          onClick={() => {
            switchTo(byCode ? 'recovery' : 'code');
          }}
        >
          {byCode ? 'Use a recovery code' : 'Use a 6-digit code'}
        </Button>
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={pending}>
            Verify
          </Button>
          <Button onClick={() => void session.signOut().catch(session.endSession)}>Sign out</Button>
        </div>
      </form>
    </>
  );
}
