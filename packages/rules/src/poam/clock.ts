import { RulesInputError } from '../errors';
import type { AssessmentType, CloseoutClock, Regulation } from '../types';
import { REGULATION } from './regulation';

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a `YYYY-MM-DD` calendar date to its UTC day number; rejects impossible dates. */
function toUtcDay(date: string): number {
  const match = ISO_DATE.exec(date);
  if (match !== null) {
    const [, y, m, d] = match.map(Number) as [number, number, number, number];
    const ms = Date.UTC(y, m - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d) {
      return ms / DAY_MS;
    }
  }
  throw new RulesInputError(
    'invalid_date',
    `Expected a real YYYY-MM-DD date, got ${JSON.stringify(date)}`,
  );
}

function fromUtcDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The POA&M closeout countdown (32 CFR 170.21(b)): the deadline is the Conditional
 * Status Date plus the closeout window. Dates are UTC calendar days, so DST never
 * shifts one. `daysRemaining` is 0 on the deadline and negative after it; `expired`
 * is true only after the deadline.
 */
export function closeoutClock(
  conditionalStatusDate: string,
  today: string,
  regulation: Regulation = REGULATION,
): CloseoutClock {
  const start = toUtcDay(conditionalStatusDate);
  const now = toUtcDay(today);
  const deadline = start + regulation.closeoutWindowDays.value;
  const daysRemaining = deadline - now;
  return {
    conditionalStatusDate,
    deadline: fromUtcDay(deadline),
    daysRemaining,
    expired: daysRemaining < 0,
  };
}

/** Who confirms POA&M closeout (32 CFR 170.21(b)(1) and (b)(2)). */
export function closeoutConfirmer(
  type: AssessmentType,
  regulation: Regulation = REGULATION,
): 'organization' | 'c3pao' {
  return regulation.closeoutConfirmedBy.value[type];
}
