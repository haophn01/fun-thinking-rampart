import { SESSION_KEEPALIVE_MS, SESSION_LOCK_AFTER_MS } from '@rampart/api/contract';
import { useEffect, useRef } from 'react';

/** What the idle lock needs from the session. */
export interface IdleLockActions {
  /** Called once, when no tab has seen input for `SESSION_LOCK_AFTER_MS`. */
  lock: () => unknown;
  /** The keep-alive: re-reads the session, so the api's idle clock follows real input. */
  refresh: () => unknown;
}

/** The key every tab writes its last input time to, in ms since the epoch. */
export const LAST_INPUT_KEY = 'rampart.lastInputAt';

/** The events that count as the user being there. */
export const INPUT_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'];

/** Other tabs' input reaches storage at most this often. */
const WRITE_EVERY_MS = 1000;

/**
 * The last input time another tab stored, or `null` when there is none, it isn't a time at or
 * before `now` (junk or a future time would hold the lock off for ever), or storage throws.
 */
export function storedInputAt(now: number): number | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(LAST_INPUT_KEY);
  } catch {
    return null;
  }
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const at = Number(raw);
  return at <= now ? at : null;
}

function storeInputAt(at: number): void {
  try {
    window.localStorage.setItem(LAST_INPUT_KEY, String(at));
  } catch {
    // Storage is off: each tab tracks its own input.
  }
}

/** How long until the lock is due, given this tab's and the stored last input. */
export function msUntilLock(now: number, localInputAt: number): number {
  const last = Math.max(localInputAt, storedInputAt(now) ?? localInputAt);
  return last + SESSION_LOCK_AFTER_MS - now;
}

/**
 * Locks the session after `SESSION_LOCK_AFTER_MS` without input in any tab, and sends a
 * keep-alive on input that comes `SESSION_KEEPALIVE_MS` or more after the last one. Mounting
 * counts as input (it happens at sign-in, unlock or a page load). After it locks it does
 * nothing more until it is mounted again.
 */
export function useIdleLock(actions: IdleLockActions): void {
  // The latest actions, so a re-render never restarts the timer.
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });

  useEffect(() => {
    const mountedAt = Date.now();
    let inputAt = mountedAt;
    let writtenAt = -Infinity;
    let keptAliveAt = mountedAt;
    let locked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = () => {
      clearTimeout(timer);
      if (locked) return;
      const wait = msUntilLock(Date.now(), inputAt);
      if (wait > 0) {
        timer = setTimeout(check, wait);
        return;
      }
      locked = true;
      stop();
      void latest.current.lock();
    };

    const onInput = () => {
      if (locked) return;
      const now = Date.now();
      inputAt = now;
      if (now - writtenAt >= WRITE_EVERY_MS) {
        writtenAt = now;
        storeInputAt(now);
      }
      if (now - keptAliveAt >= SESSION_KEEPALIVE_MS) {
        keptAliveAt = now;
        void latest.current.refresh();
      }
    };

    // Timers are held back while a laptop sleeps or a tab is in the background, so a tab that
    // becomes visible again checks at once rather than showing the app until the timer runs.
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };

    const options = { capture: true, passive: true };
    function stop() {
      clearTimeout(timer);
      for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, options);
      document.removeEventListener('visibilitychange', onVisible);
    }

    for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, options);
    document.addEventListener('visibilitychange', onVisible);
    check();
    return stop;
  }, []);
}
