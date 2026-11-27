import { z } from 'zod';

/** The sign-in notice's longest text, counted after trimming. */
export const SIGN_IN_NOTICE_MAX_LENGTH = 4000;

/** The lowercase SHA-256 hex of the notice's stored text (UTF-8). */
export const noticeDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** The notice shown before sign-in, as the session and the settings route report it. */
export const signInNoticeSchema = z.object({
  text: z.string(),
  digest: noticeDigestSchema,
});
export type SignInNotice = z.infer<typeof signInNoticeSchema>;

/**
 * The notice text an admin saves. Trimmed at both ends, inner line breaks kept; at most
 * `SIGN_IN_NOTICE_MAX_LENGTH` characters after trimming. Empty or whitespace-only, or `null`,
 * means no notice.
 */
export const signInNoticeTextSchema = z
  .string()
  .trim()
  .max(SIGN_IN_NOTICE_MAX_LENGTH)
  .transform((value) => (value === '' ? null : value))
  .nullable();

/** `PUT /api/settings/sign-in-notice`. The key is required; `null` turns the notice off. */
export const updateSignInNoticeRequestSchema = z.strictObject({
  text: signInNoticeTextSchema,
});
export type UpdateSignInNoticeRequest = z.infer<typeof updateSignInNoticeRequestSchema>;

/** `PUT /api/settings/sign-in-notice`: the notice as stored, or `null` when it is off. */
export const signInNoticeResponseSchema = z.object({
  signInNotice: signInNoticeSchema.nullable(),
});
export type SignInNoticeResponse = z.infer<typeof signInNoticeResponseSchema>;
