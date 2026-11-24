import { z } from 'zod';

/** Every error code the api sends today, with its HTTP status in `ERROR_STATUS`. */
export const ERROR_CODES = [
  'not_found',
  'validation_failed',
  'payload_too_large',
  'db_unavailable',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS = {
  not_found: 404,
  validation_failed: 400,
  payload_too_large: 413,
  db_unavailable: 503,
  internal_error: 500,
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
