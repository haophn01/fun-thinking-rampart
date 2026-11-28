import { z } from 'zod';

/** TOTP (RFC 6238 over RFC 4226 HOTP, HMAC-SHA1): digits per code. */
export const TOTP_DIGITS = 6;
/** TOTP: seconds per step. */
export const TOTP_PERIOD_SECONDS = 30;
/** TOTP: steps accepted either side of the current one, for clock drift. */
export const TOTP_WINDOW_STEPS = 1;
/** Random bytes in a new TOTP secret (160 bits, as RFC 4226 recommends). */
export const TOTP_SECRET_BYTES = 20;
/** Recovery codes issued at enrollment. Each works once. */
export const RECOVERY_CODE_COUNT = 10;
/** Crockford base32, lowercase, without i, l, o or u: no two characters are easily misread. */
export const RECOVERY_CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * What the session still needs before it is a full one. `enroll`: the user has no
 * `mfa_enrolled_at`. `challenge`: the user is enrolled and the session has `mfa_pending`.
 * `none`: neither applies.
 */
export const MFA_STATES = ['none', 'enroll', 'challenge'] as const;
export const mfaStateSchema = z.enum(MFA_STATES);
export type MfaState = z.infer<typeof mfaStateSchema>;

/** A 6-digit code from an authenticator app. Every whitespace character is removed first. */
export const totpCodeSchema = z
  .string()
  .transform((value) => value.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/));

/** Ten characters from the alphabet, for one recovery code. */
const recoveryCodeCharactersSchema = z.string().regex(/^[0-9a-hjkmnp-tv-z]{10}$/);

/**
 * A recovery code as typed: at most 64 characters, lowercased, with spaces and hyphens removed,
 * then exactly 10 characters from `RECOVERY_CODE_ALPHABET`. Parses to those 10 characters.
 */
export const recoveryCodeInputSchema = z
  .string()
  .max(64)
  .transform((value) => value.toLowerCase().replace(/[ -]/g, ''))
  .pipe(recoveryCodeCharactersSchema);

/** `POST /api/session/mfa/enroll/confirm`: the first code from the newly added secret. */
export const mfaConfirmRequestSchema = z.strictObject({ code: totpCodeSchema });
export type MfaConfirmRequest = z.infer<typeof mfaConfirmRequestSchema>;

/** `POST /api/session/mfa/verify`: exactly one of a TOTP code or a recovery code. */
export const mfaVerifyRequestSchema = z.union([
  z.strictObject({ code: totpCodeSchema }),
  z.strictObject({ recoveryCode: recoveryCodeInputSchema }),
]);
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;

/** `POST /api/session/mfa/enroll`: a new secret, to add to an authenticator app. */
export const mfaEnrollmentResponseSchema = z.object({
  /** The secret in base32 (RFC 4648, uppercase, no padding): 20 bytes are 32 characters. */
  secret: z.string().regex(/^[A-Z2-7]{32}$/),
  otpauthUri: z.string().startsWith('otpauth://totp/'),
  qr: z.object({
    /** The QR matrix side in modules, without a quiet zone: versions 1 to 40. */
    size: z.number().int().min(21).max(177),
    /** An SVG path, one `M<x> <y>h<n>v1h-<n>z` per run of dark modules; nothing else. */
    path: z.string().regex(/^(M\d{1,3} \d{1,3}h\d{1,3}v1h-\d{1,3}z)*$/),
  }),
});
export type MfaEnrollmentResponse = z.infer<typeof mfaEnrollmentResponseSchema>;

/** One recovery code as the api shows it once: `xxxxx-xxxxx`. */
export const recoveryCodeSchema = z.string().regex(/^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/);
