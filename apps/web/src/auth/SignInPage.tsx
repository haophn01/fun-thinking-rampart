import { useRef, useState, type SyntheticEvent } from 'react';
import { ApiError } from '../api/client';
import { Alert, Button, TextField } from '../look';
import { usePageTitle } from '../pages/usePageTitle';
import styles from './auth.module.css';
import notice from './SignInNotice.module.css';
import { useSession } from './session';

const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const NOTICE_CHANGED = 'The notice has changed. Read it again.';
const UNREACHABLE = "Can't reach the API. Check that it is running, then try again.";

/** "Too many attempts. Try again in N minutes.", N being `retryAfterSeconds` rounded up. */
function lockoutMessage(details: unknown): string {
  const seconds =
    typeof details === 'object' && details !== null && 'retryAfterSeconds' in details
      ? details.retryAfterSeconds
      : undefined;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return 'Too many attempts. Try again later.';
  }
  const minutes = Math.ceil(seconds / 60);
  return `Too many attempts. Try again in ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/** The message a failed sign-in shows. */
function signInFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return INVALID_CREDENTIALS;
    if (error.code === 'too_many_attempts') return lockoutMessage(error.details);
    if (error.code === 'network_error') return UNREACHABLE;
  }
  return 'Sign-in failed. Try again.';
}

export function SignInPage() {
  usePageTitle('Sign in');
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [showNotice, setShowNotice] = useState(true);
  const [pending, setPending] = useState(false);
  // The digest of the notice read on this visit; a new visit starts unacknowledged.
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  // Guards a second submit that lands before React re-renders the disabled button.
  const inFlight = useRef(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setShowNotice(false);
    const next = {
      ...(email.trim() === '' ? { email: 'Enter your email.' } : {}),
      ...(password === '' ? { password: 'Enter your password.' } : {}),
    };
    setErrors(next);
    if (next.email !== undefined || next.password !== undefined) return;

    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try {
      await session.signIn(
        email.trim().toLowerCase(),
        password,
        ...(acknowledged !== null && session.signInNotice !== null ? [acknowledged] : []),
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'notice_not_acknowledged') {
        setAcknowledged(null);
        setChanged(true);
        inFlight.current = false;
        setPending(false);
        await session.refresh();
        return;
      }
      setFailure(signInFailure(error));
      inFlight.current = false;
      setPending(false);
    }
  }

  const noticeStep = session.signInNotice !== null && acknowledged !== session.signInNotice.digest;
  if (session.signInNotice !== null && noticeStep) {
    const { text, digest } = session.signInNotice;
    return (
      <>
        <div className={styles.intro}>
          <p className={styles.kicker}>Inspection access</p>
          <h1>Sign in</h1>
        </div>
        {showNotice && session.notice !== null && <Alert tone="info">{session.notice}</Alert>}
        {changed && <Alert tone="info">{NOTICE_CHANGED}</Alert>}
        <section className={notice.notice} aria-labelledby="sign-in-notice-heading">
          <h2 id="sign-in-notice-heading" className={notice.heading}>
            System use notice
          </h2>
          <p className={notice.text}>{text}</p>
          <div className={styles.actions}>
            <Button
              variant="primary"
              onClick={() => {
                setAcknowledged(digest);
                setChanged(false);
              }}
            >
              Acknowledge and continue
            </Button>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <div className={styles.intro}>
        <p className={styles.kicker}>Inspection access</p>
        <h1>Sign in</h1>
      </div>
      {showNotice && session.notice !== null && <Alert tone="info">{session.notice}</Alert>}
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <form className={styles.form} noValidate onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          error={errors.email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          error={errors.password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>
      </form>
    </>
  );
}
