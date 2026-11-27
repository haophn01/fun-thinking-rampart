import { z } from 'zod';
import { displayNameSchema, emailSchema, passwordSchema, roleSchema } from './common';
import { RECOVERY_CODE_COUNT, mfaStateSchema, recoveryCodeSchema } from './mfa';
import { noticeDigestSchema, signInNoticeSchema } from './settings';

/** A session ends this long after its last request (`last_seen_at`). */
export const SESSION_IDLE_LIMIT_MS = 1_800_000;
/** A session ends this long after sign-in (`created_at`), however busy it is. */
export const SESSION_ABSOLUTE_LIMIT_MS = 28_800_000;
/** The web app locks the session after this long without input. */
export const SESSION_LOCK_AFTER_MS = 900_000;
/** Input this long after the last keep-alive refreshes the session, so idle follows real input. */
export const SESSION_KEEPALIVE_MS = 300_000;
/** A new password may not match the current one or the ones before it, this many in all. */
export const PASSWORD_HISTORY_DEPTH = 5;

/** The signed-in user as the session reports them. */
export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/** `GET /api/session`, and the result of setup and sign-in. */
export const sessionResponseSchema = z.object({
  setupRequired: z.boolean(),
  user: sessionUserSchema.nullable(),
  csrfToken: z.string().nullable(),
  /** The session is locked: only lock and unlock answer until the password is entered again. */
  locked: z.boolean().default(false),
  /** The password is temporary: only the session routes answer until it is changed. */
  mustChangePassword: z.boolean().default(false),
  /** The notice every sign-in acknowledges, or `null` when none is set. Sent signed out too. */
  signInNotice: signInNoticeSchema.nullable().default(null),
  /** What two-step sign-in still needs: only the MFA, lock and sign-out routes answer until `none`. */
  mfa: mfaStateSchema.default('none'),
});
/** As parsed: the sec-auth and sec-mfa fields are always present (defaults fill old answers). */
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** `POST /api/setup`: the first admin. */
export const setupRequestSchema = z.strictObject({
  email: emailSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

/**
 * `POST /api/session` (sign in). No email format or password length rule beyond sanity limits,
 * so every wrong guess gets the same "Email or password is incorrect." answer.
 */
export const signInRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(128),
  /** The `digest` of the sign-in notice the user acknowledged; needed while a notice is set. */
  noticeDigest: noticeDigestSchema.optional(),
});
export type SignInRequest = z.infer<typeof signInRequestSchema>;

/** `POST /api/session/password`. The current password has only sanity limits, as at sign-in. */
export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** `POST /api/session/unlock`. */
export const unlockRequestSchema = z.strictObject({
  password: z.string().min(1).max(128),
});
export type UnlockRequest = z.infer<typeof unlockRequestSchema>;

/**
 * `POST /api/session/mfa/enroll/confirm`: the rotated session, with the recovery codes. They are
 * shown this once; the api keeps only their hashes.
 */
export const mfaEnrolledResponseSchema = sessionResponseSchema.extend({
  recoveryCodes: z.array(recoveryCodeSchema).length(RECOVERY_CODE_COUNT),
});
export type MfaEnrolledResponse = z.infer<typeof mfaEnrolledResponseSchema>;
