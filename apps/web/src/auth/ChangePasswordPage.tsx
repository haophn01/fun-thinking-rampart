import { passwordSchema } from '@rampart/api/contract';
import { useRef, useState, type SyntheticEvent } from 'react';
import { ApiError } from '../api/client';
import { tooManyRequestsText } from '../api/too-many';
import { Alert, Button, TextField } from '../look';
import { usePageTitle } from '../pages/usePageTitle';
import styles from './auth.module.css';
import pageStyles from './ChangePasswordPage.module.css';
import { useSession } from './session';

const CURRENT_REQUIRED = 'Enter your current password.';
const CURRENT_WRONG = 'Current password is incorrect.';
const PASSWORD_RULE = 'Use 12 to 128 characters.';
const PASSWORD_MISMATCH = "The passwords don't match.";
const TOO_COMMON = 'This password is too common. Choose another.';
const REUSED = 'You used this password recently. Choose another.';
const SUCCESS = 'Password changed. Your other sessions have ended.';

type Field = 'current' | 'next' | 'confirm';
type Errors = Partial<Record<Field, string>>;

/** Where an api refusal shows: on a field, or as the form's Alert. */
function refusal(error: unknown): { field: Errors } | { alert: string } {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return { field: { current: CURRENT_WRONG } };
    if (error.code === 'password_too_common') return { field: { next: TOO_COMMON } };
    if (error.code === 'password_reused') return { field: { next: REUSED } };
    if (error.status === 429) return { alert: tooManyRequestsText(error.details) };
    if (error.code === 'network_error') {
      return { alert: "Can't reach the API. Check that it is running, then try again." };
    }
  }
  return { alert: "Couldn't change your password. Try again." };
}

export interface ChangePasswordPageProps {
  /** The password is temporary: the gate shows this page in the auth frame, with Sign out. */
  forced?: boolean;
}

/** Change password: `/account/password` inside the shell, or forced by the gate. */
export function ChangePasswordPage({ forced = false }: ChangePasswordPageProps) {
  usePageTitle('Change password');
  const session = useSession();
  const [values, setValues] = useState<Record<Field, string>>({
    current: '',
    next: '',
    confirm: '',
  });
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const next: Errors = {};
    if (values.current === '') next.current = CURRENT_REQUIRED;
    if (!passwordSchema.safeParse(values.next).success) next.next = PASSWORD_RULE;
    else if (values.confirm !== values.next) next.confirm = PASSWORD_MISMATCH;
    setErrors(next);
    setAlert(null);
    setDone(false);
    if (Object.keys(next).length > 0) return;

    inFlight.current = true;
    setPending(true);
    try {
      await session.changePassword(values.current, values.next);
      setValues({ current: '', next: '', confirm: '' });
      setDone(true);
    } catch (error) {
      const shown = refusal(error);
      if ('field' in shown) setErrors(shown.field);
      else setAlert(shown.alert);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const field = (name: Field) => ({
    value: values[name],
    error: errors[name],
    onChange: (event: { target: { value: string } }) => {
      const value = event.target.value;
      setValues((current) => ({ ...current, [name]: value }));
    },
  });

  const form = (
    <>
      {alert !== null && <Alert tone="error">{alert}</Alert>}
      {done && <Alert tone="info">{SUCCESS}</Alert>}
      <form className={pageStyles.form} noValidate onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Current password"
          type="password"
          autoComplete="current-password"
          {...field('current')}
        />
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          {...field('next')}
        />
        <TextField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          {...field('confirm')}
        />
        <div className={pageStyles.actions}>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Changing…' : 'Change password'}
          </Button>
          {forced && (
            <Button onClick={() => void session.signOut().catch(session.endSession)}>
              Sign out
            </Button>
          )}
        </div>
      </form>
    </>
  );

  if (!forced) {
    return (
      <section className={pageStyles.page}>
        <h1>Change password</h1>
        {form}
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
      {form}
    </>
  );
}
