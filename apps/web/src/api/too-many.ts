/**
 * The wait a `429 too_many_attempts` envelope's `details.retryAfterSeconds` gives, in whole
 * seconds rounded up; `null` when it is missing or not a positive finite number.
 */
export function retryAfterSecondsOf(details: unknown): number | null {
  if (typeof details !== 'object' || details === null || !('retryAfterSeconds' in details)) {
    return null;
  }
  const seconds = details.retryAfterSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds);
}

const plural = (count: number, unit: string) => `${String(count)} ${unit}${count === 1 ? '' : 's'}`;

/**
 * What a 429 shows: "Too many requests. Try again in N seconds." below a minute, "… in N
 * minutes." (rounded up) from a minute on, and "… later." when the wait is missing or invalid.
 */
export function tooManyRequestsText(details: unknown): string {
  const seconds = retryAfterSecondsOf(details);
  if (seconds === null) return 'Too many requests. Try again later.';
  const wait = seconds < 60 ? plural(seconds, 'second') : plural(Math.ceil(seconds / 60), 'minute');
  return `Too many requests. Try again in ${wait}.`;
}
