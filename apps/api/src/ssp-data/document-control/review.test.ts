import { describe, expect, it } from 'vitest';
import { addMonths, daysBetween, reviewStatus } from './review';

describe('calendar months', () => {
  it('clamps to the end of a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29');
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30');
  });

  it('keeps the day when the month has it, across years', () => {
    expect(addMonths('2026-03-15', 12)).toBe('2027-03-15');
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28');
    expect(addMonths('2026-05-10', 60)).toBe('2031-05-10');
  });

  it('counts whole days between calendar dates, negative when the second is earlier', () => {
    expect(daysBetween('2026-11-25', '2026-11-25')).toBe(0);
    expect(daysBetween('2026-11-25', '2026-12-25')).toBe(30);
    expect(daysBetween('2026-11-25', '2026-11-24')).toBe(-1);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });
});

describe('review status', () => {
  const base = {
    nextReviewDate: null,
    reviewCadenceMonths: 12,
    approvalDates: [],
    today: '2026-11-25',
  };

  it('uses the stored next review date over the approvals', () => {
    expect(
      reviewStatus({ ...base, nextReviewDate: '2027-01-10', approvalDates: ['2026-11-01'] }),
    ).toEqual({ nextReviewDue: '2027-01-10', daysToReview: 46, reviewOverdue: false });
  });

  it('otherwise adds the cadence to the latest dated approval, ignoring undated ones', () => {
    expect(
      reviewStatus({
        ...base,
        reviewCadenceMonths: 3,
        approvalDates: ['2026-09-30', null, '2026-02-01', '2026-10-15'],
      }),
    ).toEqual({ nextReviewDue: '2027-01-15', daysToReview: 51, reviewOverdue: false });
  });

  it('is null with no stored date and no dated approval', () => {
    const none = { nextReviewDue: null, daysToReview: null, reviewOverdue: false };
    expect(reviewStatus(base)).toEqual(none);
    expect(reviewStatus({ ...base, approvalDates: [null, null] })).toEqual(none);
  });

  it('is 0 and not overdue on the due date, -1 and overdue the day after', () => {
    expect(reviewStatus({ ...base, nextReviewDate: '2026-11-25' })).toEqual({
      nextReviewDue: '2026-11-25',
      daysToReview: 0,
      reviewOverdue: false,
    });
    expect(reviewStatus({ ...base, today: '2026-11-26', nextReviewDate: '2026-11-25' })).toEqual({
      nextReviewDue: '2026-11-25',
      daysToReview: -1,
      reviewOverdue: true,
    });
    expect(
      reviewStatus({ ...base, today: '2027-11-26', approvalDates: ['2026-11-25'] }),
    ).toMatchObject({ nextReviewDue: '2027-11-25', daysToReview: -1, reviewOverdue: true });
  });
});
