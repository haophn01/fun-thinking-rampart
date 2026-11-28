import { z } from 'zod';

/** Every error code the api sends today, with its HTTP status in `ERROR_STATUS`. */
export const ERROR_CODES = [
  'not_found',
  'validation_failed',
  'payload_too_large',
  'db_unavailable',
  'internal_error',
  'unauthenticated',
  'invalid_credentials',
  'forbidden',
  'csrf_failed',
  'setup_complete',
  'email_taken',
  'last_admin',
  'unsupported_media_type',
  'too_many_attempts',
  'poam_ineligible',
  'poam_item_exists',
  'poam_item_closed',
  'closeout_not_ready',
  'cui_file_refused',
  'evidence_not_cui',
  'unsupported_file_type',
  'file_integrity_failed',
  'provider_in_use',
  'password_too_common',
  'password_reused',
  'password_change_required',
  'session_locked',
  'notice_not_acknowledged',
  'mfa_required',
  'invalid_mfa_code',
  'mfa_wrong_step',
  'file_refused',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS = {
  not_found: 404,
  validation_failed: 400,
  payload_too_large: 413,
  db_unavailable: 503,
  internal_error: 500,
  /** No valid session on a protected route. */
  unauthenticated: 401,
  /** Wrong password, unknown email or inactive user: one message for all. */
  invalid_credentials: 401,
  /** The role is not allowed. */
  forbidden: 403,
  /** The CSRF header is missing or wrong. */
  csrf_failed: 403,
  /** Setup was called after a user exists. */
  setup_complete: 409,
  /** The email is already used (case-insensitive). */
  email_taken: 409,
  /** The change would leave no active admin. */
  last_admin: 409,
  /** The body is not `application/json`. */
  unsupported_media_type: 415,
  /** The account is locked; `details.retryAfterSeconds` and a `Retry-After` header say how long. */
  too_many_attempts: 429,
  /** The requirement fails POA&M eligibility; `details.reasons` lists each `{ code, citation }`. */
  poam_ineligible: 409,
  /** An open POA&M item already exists for the requirement; `details.itemId` names it. */
  poam_item_exists: 409,
  /** The POA&M item is closed, so it takes no edit or second closeout. */
  poam_item_closed: 409,
  /** Closeout while the requirement isn't `met`; `details.requirementStatus` says what it is. */
  closeout_not_ready: 409,
  /** A file upload to an evidence item flagged "contains CUI": it may only hold references. */
  cui_file_refused: 409,
  /** A reference version on an evidence item that isn't flagged "contains CUI". */
  evidence_not_cui: 409,
  /** The file name's extension isn't allowed; `details.allowed` lists `UPLOAD_EXTENSIONS`. */
  unsupported_file_type: 415,
  /** A stored file is missing or its bytes no longer match the recorded SHA-256. */
  file_integrity_failed: 500,
  /**
   * Removing a service provider that a responsibility row still names; `details.requirementIds`
   * lists those requirements in catalog order.
   */
  provider_in_use: 409,
  /** A new password is on the bundled common-password list. */
  password_too_common: 400,
  /** A new password matches the current one or a recent one (`PASSWORD_HISTORY_DEPTH`). */
  password_reused: 400,
  /** The password is temporary; only the session routes answer until it is changed. */
  password_change_required: 403,
  /** The session is locked; only lock and unlock answer until it is unlocked. */
  session_locked: 423,
  /** A sign-in while a notice is set, without the current notice's digest. */
  notice_not_acknowledged: 400,
  /** The session still needs two-step sign-in (`mfa` is `enroll` or `challenge`). */
  mfa_required: 403,
  /** The TOTP or recovery code is wrong, already used, or a step at or before the last one. */
  invalid_mfa_code: 401,
  /** The MFA route doesn't fit the user's or session's state (already enrolled, not pending). */
  mfa_wrong_step: 409,
  /**
   * The upload's bytes aren't what its extension says, or it is an unsafe office file. The message
   * is `fileRefusedMessage(...)`; `details` follows `fileRefusedDetailsSchema`.
   */
  file_refused: 415,
} as const satisfies Record<ErrorCode, number>;

/** The fixed message the api sends, and the web may show as is, for these codes. */
export const ERROR_MESSAGES = {
  password_too_common: 'This password is too common. Choose another.',
  password_reused: 'You used this password recently. Choose another.',
  password_change_required: 'Change your password to continue.',
  session_locked: 'Your session is locked. Enter your password to unlock it.',
  notice_not_acknowledged: 'Acknowledge the sign-in notice to continue.',
  mfa_required: 'Finish two-step sign-in to continue.',
  invalid_mfa_code: "That code didn't work. Enter the newest code from your app.",
  mfa_wrong_step: "This two-step sign-in step doesn't apply now. Reload the page.",
} as const satisfies Partial<Record<ErrorCode, string>>;

/**
 * The body of every non-2xx response. `code` is a plain string so a client keeps working when a
 * later api adds a code; compare it against `ERROR_CODES`.
 */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
