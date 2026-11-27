/**
 * Locks the session after `SESSION_LOCK_AFTER_MS` without input, and keeps it alive while there
 * is input. The gate mounts it only while signed in. A stub until W2 builds `useIdleLock`.
 */
export function IdleLock() {
  return null;
}
