import { SESSION_KEEPALIVE_MS, SESSION_LOCK_AFTER_MS } from '@rampart/api/contract';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_INPUT_KEY, useIdleLock } from './useIdleLock';

vi.setConfig({ testTimeout: 15_000 });

const START = new Date('2026-11-26T09:00:00.000Z').getTime();
const MINUTE = 60_000;

function mount() {
  const lock = vi.fn();
  const refresh = vi.fn(() => Promise.resolve());
  const hook = renderHook(() => {
    useIdleLock({ lock, refresh });
  });
  return { lock, refresh, unmount: hook.unmount };
}

/** Moves the fake clock to `ms` after START, running the timers due on the way. */
function advanceTo(ms: number) {
  act(() => {
    vi.advanceTimersByTime(START + ms - Date.now());
  });
}

function input(type = 'keydown') {
  act(() => {
    window.dispatchEvent(new Event(type));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('locks after 15 minutes without input', () => {
  it('locks after 15 minutes without input', () => {
    const { lock } = mount();
    advanceTo(SESSION_LOCK_AFTER_MS - 1);
    expect(lock).not.toHaveBeenCalled();
    advanceTo(SESSION_LOCK_AFTER_MS);
    expect(lock).toHaveBeenCalledTimes(1);
    // Once locked it never locks again.
    advanceTo(SESSION_LOCK_AFTER_MS * 3);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('input at 10:00 moves the lock to 25:00', () => {
    const { lock } = mount();
    advanceTo(10 * MINUTE);
    input();
    advanceTo(25 * MINUTE - 1);
    expect(lock).not.toHaveBeenCalled();
    advanceTo(25 * MINUTE);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('every input kind counts', () => {
    for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart']) {
      const { lock, unmount } = mount();
      advanceTo(14 * MINUTE);
      input(type);
      advanceTo(15 * MINUTE);
      expect(lock, type).not.toHaveBeenCalled();
      unmount();
      vi.setSystemTime(START);
    }
  });

  it('other events are not input', () => {
    const { lock } = mount();
    advanceTo(14 * MINUTE);
    input('scroll');
    input('focus');
    advanceTo(15 * MINUTE);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('a tab that returns after the timer was held back locks at once', () => {
    // A sleeping laptop or a throttled background tab runs no timers; the wall clock still moves.
    const { lock } = mount();
    act(() => {
      vi.setSystemTime(START + 40 * MINUTE);
    });
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('unmounting stops the timer and the listeners', () => {
    const { lock, refresh, unmount } = mount();
    unmount();
    advanceTo(SESSION_LOCK_AFTER_MS * 2);
    input();
    expect(lock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('shares input across tabs', () => {
  it('a newer rampart.lastInputAt from another tab defers the lock', () => {
    const { lock } = mount();
    advanceTo(12 * MINUTE);
    // Another tab saw input at 12:00.
    window.localStorage.setItem(LAST_INPUT_KEY, String(START + 12 * MINUTE));
    advanceTo(15 * MINUTE);
    expect(lock).not.toHaveBeenCalled();
    advanceTo(27 * MINUTE - 1);
    expect(lock).not.toHaveBeenCalled();
    advanceTo(27 * MINUTE);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('input writes the time for other tabs, at most once a second', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    mount();
    advanceTo(MINUTE);
    input();
    expect(window.localStorage.getItem(LAST_INPUT_KEY)).toBe(String(START + MINUTE));
    advanceTo(MINUTE + 999);
    input('pointermove');
    input('pointermove');
    expect(setItem).toHaveBeenCalledTimes(1);
    advanceTo(MINUTE + 1000);
    input('pointermove');
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(LAST_INPUT_KEY)).toBe(String(START + MINUTE + 1000));
  });

  it('an older stored time never brings the lock forward', () => {
    window.localStorage.setItem(LAST_INPUT_KEY, String(START - 60 * MINUTE));
    const { lock } = mount();
    advanceTo(SESSION_LOCK_AFTER_MS - 1);
    expect(lock).not.toHaveBeenCalled();
    advanceTo(SESSION_LOCK_AFTER_MS);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('a stored time that is not a past time is ignored', () => {
    const { lock } = mount();
    // Junk, or a time in the future, would otherwise hold the lock off forever.
    window.localStorage.setItem(LAST_INPUT_KEY, String(START + 24 * 60 * MINUTE));
    advanceTo(SESSION_LOCK_AFTER_MS);
    expect(lock).toHaveBeenCalledTimes(1);

    const junk = mount();
    window.localStorage.setItem(LAST_INPUT_KEY, 'soon');
    advanceTo(SESSION_LOCK_AFTER_MS * 2);
    expect(junk.lock).toHaveBeenCalledTimes(1);
  });

  it('when storage throws it still locks per tab', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { lock } = mount();
    advanceTo(10 * MINUTE);
    input();
    advanceTo(25 * MINUTE - 1);
    expect(lock).not.toHaveBeenCalled();
    advanceTo(25 * MINUTE);
    expect(lock).toHaveBeenCalledTimes(1);
  });
});

describe('keep-alive follows input', () => {
  it('input 5 min or more after the last keep-alive calls refresh() once', () => {
    const { refresh } = mount();
    advanceTo(SESSION_KEEPALIVE_MS - 1);
    input();
    expect(refresh).not.toHaveBeenCalled();
    advanceTo(SESSION_KEEPALIVE_MS);
    input();
    input();
    expect(refresh).toHaveBeenCalledTimes(1);
    // The next one counts from that keep-alive.
    advanceTo(SESSION_KEEPALIVE_MS * 2 - 1);
    input();
    expect(refresh).toHaveBeenCalledTimes(1);
    advanceTo(SESSION_KEEPALIVE_MS * 2);
    input('pointermove');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('there is no keep-alive without input', () => {
    const { refresh, lock } = mount();
    advanceTo(SESSION_LOCK_AFTER_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    advanceTo(SESSION_LOCK_AFTER_MS);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("another tab's input sends no keep-alive here", () => {
    const { refresh } = mount();
    advanceTo(10 * MINUTE);
    window.localStorage.setItem(LAST_INPUT_KEY, String(START + 10 * MINUTE));
    advanceTo(14 * MINUTE);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('none while locked', () => {
    const { refresh, lock } = mount();
    advanceTo(SESSION_LOCK_AFTER_MS);
    expect(lock).toHaveBeenCalledTimes(1);
    // Typing the unlock password is input, but a locked session must not be kept alive.
    input();
    input('pointerdown');
    expect(refresh).not.toHaveBeenCalled();
  });
});
