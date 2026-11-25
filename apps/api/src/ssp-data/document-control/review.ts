// The SSP review schedule, as pure date math on `YYYY-MM-DD` calendar dates in UTC.

const DAY_MS = 24 * 60 * 60 * 1000;

function parts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year: year ?? Number.NaN, month: month ?? Number.NaN, day: day ?? Number.NaN };
}

function epochDay(date: string): number {
  const { year, month, day } = parts(date);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/**
 * `date` plus `months` calendar months, with the day clamped to the end of the target month:
 * 2026-01-31 + 1 is 2026-02-28, and 2027-11-30 + 3 is 2028-02-29.
 */
export function addMonths(date: string, months: number): string {
  const { year, month, day } = parts(date);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round(epochDay(to) - epochDay(from));
}

export interface ReviewInput {
  /** The profile's stored next review date, if any. */
  nextReviewDate: string | null;
  reviewCadenceMonths: number;
  /** Every live approval's `approvedOn`; null ones are undated and don't count. */
  approvalDates: readonly (string | null)[];
  /** The UTC today. */
  today: string;
}

export interface ReviewStatus {
  nextReviewDue: string | null;
  daysToReview: number | null;
  reviewOverdue: boolean;
}

/**
 * When the SSP is next due for review: the stored next review date if set; else the latest
 * dated approval plus the cadence; else none. Due today is 0 days and not yet overdue.
 */
export function reviewStatus(input: ReviewInput): ReviewStatus {
  const nextReviewDue = input.nextReviewDate ?? fromApprovals(input);
  if (nextReviewDue === null) {
    return { nextReviewDue: null, daysToReview: null, reviewOverdue: false };
  }
  const daysToReview = daysBetween(input.today, nextReviewDue);
  return { nextReviewDue, daysToReview, reviewOverdue: daysToReview < 0 };
}

function fromApprovals(input: ReviewInput): string | null {
  let latest: string | null = null;
  for (const date of input.approvalDates) {
    if (date !== null && (latest === null || date > latest)) latest = date;
  }
  return latest === null ? null : addMonths(latest, input.reviewCadenceMonths);
}
