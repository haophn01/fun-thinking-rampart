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
} as const satisfies Record<ErrorCode, number>;

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
