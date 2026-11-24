import { healthResponseSchema } from '@rampart/api/contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../api/client';
import { Button } from '../look';
import styles from './ApiStatus.module.css';

/** Calls health once on load. Silent while ok; an alert with Retry when the api cannot be reached. */
export function ApiStatus() {
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(true);
  const latest = useRef(0);

  const check = useCallback(async () => {
    latest.current += 1;
    const run = latest.current;
    let reachable = true;
    try {
      await apiGet('/api/health', healthResponseSchema);
    } catch {
      reachable = false;
    }
    // A newer check (or an unmount) supersedes this one.
    if (run !== latest.current) return;
    setFailed(!reachable);
    setChecking(false);
  }, []);

  useEffect(() => {
    void check();
    return () => {
      latest.current += 1;
    };
  }, [check]);

  if (!failed) return null;
  return (
    <div role="alert" className={styles.alert}>
      <p className={styles.message}>Can&apos;t reach the API</p>
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
