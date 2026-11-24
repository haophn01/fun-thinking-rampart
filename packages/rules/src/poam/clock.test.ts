import { describe, expect, it } from 'vitest';
import type { Regulation } from '../types';
import { closeoutClock, closeoutConfirmer } from './clock';
import { REGULATION } from './regulation';

const invalidDate: unknown = expect.objectContaining({
  name: 'RulesInputError',
  code: 'invalid_date',
});

describe('closeoutClock', () => {
  // 32 CFR 170.21(b): closeout within 180 days of the Conditional CMMC Status Date.
  it.each([
    ['2026-03-01', '2026-08-28'],
    ['2027-01-01', '2027-06-30'],
    ['2028-01-01', '2028-06-29'], // 2028 is a leap year
  ])('computes the deadline: %s plus 180 days is %s', (start, deadline) => {
    expect(closeoutClock(start, start)).toEqual({
      conditionalStatusDate: start,
      deadline,
      daysRemaining: 180,
      expired: false,
    });
  });

  it('computes the deadline across a DST change without shifting a day', () => {
    // US DST starts 2026-03-08 and ends 2026-11-01; UTC dates never shift.
    expect(closeoutClock('2026-06-01', '2026-06-01').deadline).toBe('2026-11-28');
    expect(closeoutClock('2026-03-01', '2026-03-09').daysRemaining).toBe(172);
  });

  it('countdown edges: 180 on the start date, 0 on the deadline, -1 the day after', () => {
    expect(closeoutClock('2026-03-01', '2026-03-01')).toMatchObject({
      daysRemaining: 180,
      expired: false,
    });
    expect(closeoutClock('2026-03-01', '2026-08-27')).toMatchObject({
      daysRemaining: 1,
      expired: false,
    });
    expect(closeoutClock('2026-03-01', '2026-08-28')).toMatchObject({
      daysRemaining: 0,
      expired: false,
    });
    expect(closeoutClock('2026-03-01', '2026-08-29')).toMatchObject({
      daysRemaining: -1,
      expired: true,
    });
    // Before the Conditional Status Date the clock reads more than the window.
    expect(closeoutClock('2026-03-01', '2026-02-28')).toMatchObject({
      daysRemaining: 181,
      expired: false,
    });
  });

  it.each([
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '11/23/2026',
    '2026-3-1',
    '2026-03-01T00:00:00Z',
    ' 2026-03-01',
    '',
  ])('countdown edges: %j throws invalid_date', (bad) => {
    expect(() => closeoutClock(bad, '2026-03-01')).toThrow(invalidDate);
    expect(() => closeoutClock('2026-03-01', bad)).toThrow(invalidDate);
  });

  it('countdown edges: 2028-02-29 is a real date', () => {
    expect(closeoutClock('2028-02-29', '2028-02-29').deadline).toBe('2028-08-27');
  });

  it('reads the window from regulation data', () => {
    const shorter: Regulation = {
      ...REGULATION,
      closeoutWindowDays: { ...REGULATION.closeoutWindowDays, value: 30 },
    };
    expect(closeoutClock('2026-03-01', '2026-03-01', shorter)).toMatchObject({
      deadline: '2026-03-31',
      daysRemaining: 30,
    });
  });
});

describe('closeoutConfirmer', () => {
  // 32 CFR 170.21(b)(1) and (b)(2).
  it('closeout confirmer by assessment type: self gives organization, c3pao gives c3pao', () => {
    expect(closeoutConfirmer('self')).toBe('organization');
    expect(closeoutConfirmer('c3pao')).toBe('c3pao');
  });

  it('reads the confirmer from regulation data', () => {
    const swapped: Regulation = {
      ...REGULATION,
      closeoutConfirmedBy: {
        ...REGULATION.closeoutConfirmedBy,
        value: { self: 'c3pao', c3pao: 'c3pao' },
      },
    };
    expect(closeoutConfirmer('self', swapped)).toBe('c3pao');
  });
});
