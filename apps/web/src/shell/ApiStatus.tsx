import { healthResponseSchema } from '@rampart/api/contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiGet } from '../api/client';
import { tooManyRequestsText } from '../api/too-many';
import { Button } from '../look';
import styles from './ApiStatus.module.css';

/** What the banner says for a failed health check: the wait on a 429, else unreachable. */
function failureText(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return tooManyRequestsText(error.details);
  return "Can't reach the API";
}

/**
 * Calls health once on load. Silent while ok; an alert with Retry when the api cannot be reached,
 * or the wait when it answers 429.
 */
export function ApiStatus() {
  const [failure, setFailure] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const latest = useRef(0);

  const check = useCallback(async () => {
    latest.current += 1;
    const run = latest.current;
    let next: string | null = null;
    try {
      await apiGet('/api/health', healthResponseSchema);
    } catch (error) {
      next = failureText(error);
    }
    // A newer check (or an unmount) supersedes this one.
    if (run !== latest.current) return;
    setFailure(next);
    setChecking(false);
  }, []);

  useEffect(() => {
    void check();
    return () => {
      latest.current += 1;
    };
  }, [check]);

  if (failure === null) return null;
  return (
    <div role="alert" className={styles.alert}>
      <p className={styles.message}>{failure}</p>
      <Button
        disabled={checking}
        onClick={() => {
          setChecking(true);
          void check();
        }}
      >
        Retry
      </Button>
    </div>
  );
}
