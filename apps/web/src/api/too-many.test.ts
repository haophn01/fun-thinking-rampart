import { describe, expect, it } from 'vitest';
import { retryAfterSecondsOf, tooManyRequestsText } from './too-many';

const text = (seconds: unknown) => tooManyRequestsText({ retryAfterSeconds: seconds });
const LATER = 'Too many requests. Try again later.';

describe('tooManyRequestsText', () => {
  it('wait text edges', () => {
    expect(text(1)).toBe('Too many requests. Try again in 1 second.');
    expect(text(2)).toBe('Too many requests. Try again in 2 seconds.');
    expect(text(59)).toBe('Too many requests. Try again in 59 seconds.');
    expect(text(60)).toBe('Too many requests. Try again in 1 minute.');
    expect(text(61)).toBe('Too many requests. Try again in 2 minutes.');
    expect(text(120)).toBe('Too many requests. Try again in 2 minutes.');
    expect(text(900)).toBe('Too many requests. Try again in 15 minutes.');
    // A fractional wait rounds up, so the user never retries early.
    expect(text(0.2)).toBe('Too many requests. Try again in 1 second.');
    expect(text(59.5)).toBe('Too many requests. Try again in 1 minute.');

    expect(tooManyRequestsText(undefined)).toBe(LATER);
    expect(tooManyRequestsText(null)).toBe(LATER);
    expect(tooManyRequestsText({})).toBe(LATER);
    expect(tooManyRequestsText('30')).toBe(LATER);
    expect(text(0)).toBe(LATER);
    expect(text(-5)).toBe(LATER);
    expect(text(Number.NaN)).toBe(LATER);
    expect(text(Number.POSITIVE_INFINITY)).toBe(LATER);
    expect(text('30')).toBe(LATER);
  });

  it('reads the wait from the envelope details', () => {
    expect(retryAfterSecondsOf({ retryAfterSeconds: 42 })).toBe(42);
    expect(retryAfterSecondsOf({ retryAfterSeconds: 0.5 })).toBe(1);
    expect(retryAfterSecondsOf({ retryAfterSeconds: '42' })).toBeNull();
    expect(retryAfterSecondsOf({ retryAfterSeconds: 0 })).toBeNull();
    expect(retryAfterSecondsOf(undefined)).toBeNull();
    expect(retryAfterSecondsOf([42])).toBeNull();
  });
});
