import {
  auditVerifyResponseSchema,
  type AuditChainProblem,
  type AuditVerifyResponse,
} from '@rampart/api/contract';
import { useRef, useState } from 'react';
import { ApiError, apiGet } from '../../api/client';
import { tooManyRequestsText } from '../../api/too-many';
import { Alert, Button } from '../../look';
import { ACTION_LABELS } from './auditLabels';
import styles from './AuditVerify.module.css';

const PROBLEM_TEXT: Record<AuditChainProblem, string> = {
  unchained: 'It has no hash: it was added outside Rampart.',
  prev_mismatch:
    "Its link to the event before it doesn't match: an earlier event was changed or removed.",
  hash_mismatch: "Its contents don't match its hash: it was changed after it was written.",
};

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: AuditVerifyResponse }
  | { kind: 'failed'; message: string };

/** A stored `action` is any string once a row is tampered with: known ones read as their label. */
function actionText(action: string): string {
  const labels: Record<string, string> = ACTION_LABELS;
  return (Object.hasOwn(labels, action) ? labels[action] : undefined) ?? action;
}

/** Local time of a stored timestamp, or the raw text when it is no date. */
function localTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

const events = (count: number) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? 'event' : 'events'}`;

function intactText(total: number): string {
  if (total === 0) return 'No events yet. Nothing to check.';
  if (total === 1) return 'The 1 event checks out.';
  return `All ${total.toLocaleString('en-US')} events check out.`;
}

function Result({ result }: { result: AuditVerifyResponse }) {
  const broken = result.firstBroken;
  if (broken === null) {
    return (
      <Alert tone="info" title="Audit log intact" className={styles.result}>
        <div className={styles.stack}>
          <p className={styles.line}>{intactText(result.total)}</p>
          {result.headHash !== null && (
            <>
              <p className={styles.label}>Newest hash</p>
              <p className={styles.hash}>{result.headHash}</p>
            </>
          )}
          <p className={styles.line}>
            Checked <time dateTime={result.verifiedAt}>{localTime(result.verifiedAt)}</time>
          </p>
        </div>
      </Alert>
    );
  }
  return (
    <Alert tone="error" title="Audit log broken" className={styles.result}>
      <div className={styles.stack}>
        <p className={styles.line}>
          {`The chain breaks at event ${String(broken.id)}: ${actionText(broken.action)}, ${localTime(broken.at)}.`}
        </p>
        <p className={styles.line}>{PROBLEM_TEXT[broken.problem]}</p>
        <p className={styles.line}>
          {result.checked === 1
            ? '1 event before it checks out.'
            : `${events(result.checked)} before it check out.`}
        </p>
      </div>
    </Alert>
  );
}

/** Walks the audit chain on request and shows whether it is intact, or where it breaks. */
export function AuditVerify() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  // Only the newest run may write state, so a slow old answer can't replace a newer one.
  const latest = useRef(0);

  const run = () => {
    const request = ++latest.current;
    setState({ kind: 'running' });
    apiGet('/api/audit/verify', auditVerifyResponseSchema).then(
      (result) => {
        if (request === latest.current) setState({ kind: 'done', result });
      },
      (error: unknown) => {
        if (request !== latest.current) return;
        const message =
          error instanceof ApiError && error.status === 429
            ? tooManyRequestsText(error.details)
            : "Couldn't verify the audit log.";
        setState({ kind: 'failed', message });
      },
    );
  };

  return (
    <div className={styles.verify}>
      <Button disabled={state.kind === 'running'} onClick={run}>
        {state.kind === 'running' ? 'Verifying…' : 'Verify audit log'}
      </Button>
      {state.kind === 'running' && (
        <p className={styles.label} aria-live="polite">
          Checking every event&apos;s hash…
        </p>
      )}
      {state.kind === 'done' && <Result result={state.result} />}
      {state.kind === 'failed' && (
        <div className={styles.result}>
          <Alert tone="error">{state.message}</Alert>
          <Button className={styles.retryGap} onClick={run}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
