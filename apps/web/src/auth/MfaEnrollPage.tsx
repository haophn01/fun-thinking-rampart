import { ERROR_MESSAGES, totpCodeSchema, type MfaEnrollmentResponse } from '@rampart/api/contract';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { ApiError } from '../api/client';
import { tooManyRequestsText } from '../api/too-many';
import { Alert, Button, SectionLabel, TextField } from '../look';
import { usePageTitle } from '../pages/usePageTitle';
import styles from './auth.module.css';
import mfa from './Mfa.module.css';
import { useSession } from './session';

/** The field error for a code that isn't 6 digits once spaces are removed. */
export const CODE_FORMAT = 'Enter the 6-digit code from your app.';
const UNREACHABLE = "Can't reach the API. Check that it is running, then try again.";

/**
 * How a refused two-step call shows: a wrong code on the field (which clears), a re-read for a
 * step that no longer applies, or an Alert. A 401 that ends the session is the client's.
 */
export type MfaRefusal = { field: string } | { reread: true } | { alert: string };

export function mfaRefusal(error: unknown, fallback: string): MfaRefusal {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_mfa_code') return { field: ERROR_MESSAGES.invalid_mfa_code };
    if (error.code === 'mfa_wrong_step') return { reread: true };
    if (error.status === 429) return { alert: tooManyRequestsText(error.details) };
    if (error.code === 'network_error') return { alert: UNREACHABLE };
  }
  return { alert: fallback };
}

/** The base32 key in groups of 4, as authenticator apps show it. */
export function groupKey(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * The QR as inline SVG: a Sheet square with a 4-module quiet zone and the api's path in Ink.
 * The path is a React attribute, never markup, and the contract allows only move and line
 * commands in it.
 */
function QrCode({ qr }: { qr: MfaEnrollmentResponse['qr'] }) {
  const side = qr.size + 8;
  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      className={mfa.qr}
      viewBox={`-4 -4 ${String(side)} ${String(side)}`}
      shapeRendering="crispEdges"
    >
      <rect className={mfa.qrSheet} x={-4} y={-4} width={side} height={side} />
      <path className={mfa.qrModules} d={qr.path} />
    </svg>
  );
}

type Load =
  | { status: 'loading' }
  | { status: 'ready'; enrollment: MfaEnrollmentResponse }
  | { status: 'error'; message: string };

/** The message a failed start shows. */
function startFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return tooManyRequestsText(error.details);
    if (error.code === 'mfa_wrong_step') return ERROR_MESSAGES.mfa_wrong_step;
    if (error.code === 'network_error') return UNREACHABLE;
  }
  return "Couldn't start setting up two-step sign-in.";
}

/**
 * Set up two-step sign-in: the gate shows it while the session's `mfa` is `enroll`. Each show
 * asks the api for a new secret, and only the newest answer shows, since each one replaces the
 * last.
 */
export function MfaEnrollPage() {
  usePageTitle('Set up two-step sign-in');
  const session = useSession();
  const { startMfaEnrollment, refresh } = session;
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    // Cleared when the show ends, so an older answer never replaces a newer one.
    let current = true;
    startMfaEnrollment().then(
      (enrollment) => {
        if (current) setLoad({ status: 'ready', enrollment });
      },
      (error: unknown) => {
        if (!current) return;
        setLoad({ status: 'error', message: startFailure(error) });
        if (error instanceof ApiError && error.code === 'mfa_wrong_step') void refresh();
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, startMfaEnrollment, refresh]);

  function retry() {
    setLoad({ status: 'loading' });
    setAttempt((count) => count + 1);
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setAlert(null);
    const parsed = totpCodeSchema.safeParse(code);
    if (!parsed.success) {
      setFieldError(CODE_FORMAT);
      return;
    }
    setFieldError(null);
    inFlight.current = true;
    setPending(true);
    try {
      await session.confirmMfaEnrollment(parsed.data);
    } catch (error) {
      const shown = mfaRefusal(error, "Couldn't confirm the code. Try again.");
      if ('field' in shown) {
        setFieldError(shown.field);
        setCode('');
      } else if ('alert' in shown) {
        setAlert(shown.alert);
      } else {
        void refresh();
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const signOut = (
    <Button onClick={() => void session.signOut().catch(session.endSession)}>Sign out</Button>
  );

  return (
    <>
      <div className={styles.intro}>
        <p className={styles.kicker}>Inspection access</p>
        <h1>Set up two-step sign-in</h1>
        <p>Your account needs a code from an authenticator app each time you sign in.</p>
      </div>
      {load.status === 'loading' && <p role="status">Loading…</p>}
      {load.status === 'error' && (
        <>
          <Alert tone="error">
            <p>{load.message}</p>
            <Button className={styles.retry} onClick={retry}>
              Retry
            </Button>
          </Alert>
          <div className={styles.actions}>{signOut}</div>
        </>
      )}
      {load.status === 'ready' && (
        <>
          <section className={mfa.step}>
            <h2 className={mfa.stepHead}>
              <SectionLabel number={1}>Add the account to your app</SectionLabel>
            </h2>
            <p>Scan the code with your authenticator app, or enter the key by hand.</p>
            <QrCode qr={load.enrollment.qr} />
            <dl className={mfa.manual}>
              <dt className={mfa.term}>Key</dt>
              <dd className={mfa.key} data-testid="mfa-manual-key">
                {groupKey(load.enrollment.secret)}
              </dd>
              {session.user !== null && (
                <>
                  <dt className={mfa.term}>Account</dt>
                  <dd className={mfa.account}>{session.user.email}</dd>
                </>
              )}
            </dl>
          </section>
          <section className={mfa.step}>
            <h2 className={mfa.stepHead}>
              <SectionLabel number={2}>Enter the code it shows</SectionLabel>
            </h2>
            {alert !== null && <Alert tone="error">{alert}</Alert>}
            <form className={styles.form} noValidate onSubmit={(event) => void onSubmit(event)}>
              <TextField
                label="6-digit code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                error={fieldError ?? undefined}
                onChange={(event) => {
                  setCode(event.target.value);
                  setFieldError(null);
                }}
              />
              <div className={styles.actions}>
                <Button type="submit" variant="primary" disabled={pending}>
                  Confirm
                </Button>
                {signOut}
              </div>
            </form>
          </section>
        </>
      )}
    </>
  );
}
