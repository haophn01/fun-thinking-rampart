import {
  PRODUCT_NAME,
  displayNameSchema,
  emailSchema,
  passwordSchema,
} from '@rampart/api/contract';
import { useRef, useState, type ChangeEvent, type SyntheticEvent } from 'react';
import { ApiError } from '../api/client';
import { Alert, Button, TextField } from '../look';
import { usePageTitle } from '../pages/usePageTitle';
import styles from './auth.module.css';
import { useSession } from './session';

const EMAIL_RULE = 'Enter a valid email address.';
const NAME_RULE = 'Enter a name of 1 to 80 characters.';
const PASSWORD_RULE = 'Use 12 to 128 characters.';
const TOO_COMMON = 'This password is too common. Choose another.';
const PASSWORD_MISMATCH = "The passwords don't match.";

type Field = 'email' | 'displayName' | 'password' | 'confirm';

export function SetupPage() {
  usePageTitle('Set up');
  const session = useSession();
  const [values, setValues] = useState<Record<Field, string>>({
    email: '',
    displayName: '',
    password: '',
    confirm: '',
  });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const email = emailSchema.safeParse(values.email);
    const displayName = displayNameSchema.safeParse(values.displayName);
    const password = passwordSchema.safeParse(values.password);
    const next: Partial<Record<Field, string>> = {};
    if (!email.success) next.email = EMAIL_RULE;
    if (!displayName.success) next.displayName = NAME_RULE;
    if (!password.success) next.password = PASSWORD_RULE;
    else if (values.confirm !== values.password) next.confirm = PASSWORD_MISMATCH;
    setErrors(next);
    if (!email.success || !displayName.success || !password.success) return;
    if (next.confirm !== undefined) return;

    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try {
      await session.setup({
        email: email.data,
        displayName: displayName.data,
        password: password.data,
      });
    } catch (error) {
      inFlight.current = false;
      setPending(false);
      // Someone finished setup first: re-reading the session moves the gate on to Sign in.
      if (error instanceof ApiError && error.code === 'setup_complete') {
        await session.refresh();
        return;
      }
      if (error instanceof ApiError && error.code === 'password_too_common') {
        setErrors({ password: TOO_COMMON });
        return;
      }
      setFailure(
        error instanceof ApiError && error.code === 'network_error'
          ? "Can't reach the API. Check that it is running, then try again."
          : 'Setup failed. Check the fields and try again.',
      );
    }
  }

  const field = (name: Field) => ({
    value: values[name],
    error: errors[name],
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setValues((current) => ({ ...current, [name]: value }));
    },
  });

  return (
    <>
      <div className={styles.intro}>
        <p className={styles.kicker}>First run</p>
        <h1>Set up {PRODUCT_NAME}</h1>
        <p>Create the first admin. You can add other people once you&apos;re in.</p>
      </div>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <form className={styles.form} noValidate onSubmit={(event) => void onSubmit(event)}>
        <TextField label="Email" type="email" autoComplete="username" {...field('email')} />
        <TextField label="Display name" autoComplete="name" {...field('displayName')} />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          {...field('password')}
        />
        <TextField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          {...field('confirm')}
        />
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create admin'}
          </Button>
        </div>
      </form>
    </>
  );
}
