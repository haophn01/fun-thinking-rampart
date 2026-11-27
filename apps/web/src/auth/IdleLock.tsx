import { useSession } from './session';
import { useIdleLock } from './useIdleLock';

/**
 * Locks the session after `SESSION_LOCK_AFTER_MS` without input, and keeps it alive while there
 * is input. The gate mounts it only while signed in, so it unmounts when the session locks.
 */
export function IdleLock() {
  const { lock, refresh } = useSession();
  useIdleLock({ lock, refresh });
  return null;
}
