import { z } from 'zod';

/** An objective's result. Exactly these four values; nothing else is accepted. */
export const objectiveStatusSchema = z.enum(['met', 'not_met', 'na', 'not_assessed']);

export const requirementStatusSchema = z.enum(['met', 'not_met', 'not_assessed']);

/** Only for requirements with partial credit (3.5.3 and 3.13.11). */
export const implementationLevelSchema = z.enum(['none', 'partial']);

export const assessmentTypeSchema = z.enum(['self', 'c3pao']);

export const roleSchema = z.enum(['admin', 'contributor']);
export type Role = z.infer<typeof roleSchema>;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `YYYY-MM-DD` names a day that exists (2028-02-29 does, 2027-02-29 does not). */
function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** A calendar date as `YYYY-MM-DD`, with no time or zone. */
export const calendarDateSchema = z
  .string()
  .refine(isCalendarDate, { message: 'Expected a real date as YYYY-MM-DD' });

/** Trimmed and lowercased before the format check, so emails compare case-insensitively. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** Never trimmed: leading and trailing spaces are part of the password. */
export const passwordSchema = z.string().min(12).max(128);

export const displayNameSchema = z.string().trim().min(1).max(80);

/** Trimmed free text where empty or whitespace-only means no text (`null`). */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable();
}

/** An objective result's note: at most 4,000 characters after trimming; blank becomes null. */
export const noteSchema = optionalText(4000);

/** A requirement's implementation statement: at most 20,000 characters; blank becomes null. */
export const implementationStatementSchema = optionalText(20000);

/** A user as other records show them. */
export const userRefSchema = z.object({ id: z.string(), displayName: z.string() });
export type UserRef = z.infer<typeof userRefSchema>;

/** The session cookie's name. It is HttpOnly, so the browser app never reads it. */
export const SESSION_COOKIE = 'rampart_session';

/** The header every state-changing request on a session route carries. */
export const CSRF_HEADER = 'x-csrf-token';
