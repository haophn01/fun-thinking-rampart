// HOTP (RFC 4226) and TOTP (RFC 6238) on node:crypto: HMAC-SHA1, 6 digits, 30-second steps.
// Pure: no DB, no config, no clock of its own (callers pass `at`). Replay protection is the
// caller's: `matchTotp` returns the step it matched so the caller can refuse a step it has seen.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './base32';

// The contract's values (sprint sec-mfa, `contract/mfa.ts`): TOTP_DIGITS, TOTP_PERIOD_SECONDS,
// TOTP_WINDOW_STEPS, TOTP_SECRET_BYTES.
const DIGITS = 6;
const PERIOD_SECONDS = 30;
const WINDOW_STEPS = 1;
const SECRET_BYTES = 20;

/** RFC 4226: HMAC-SHA1 of the 8-byte big-endian counter, dynamic truncation, zero-padded. */
export function hotp(secret: Uint8Array, counter: number, digits = DIGITS): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError('HOTP counter must be a non-negative safe integer');
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new RangeError('HOTP digits must be 6, 7 or 8');
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The TOTP step `at` falls in: floor(unix seconds / 30). */
export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / PERIOD_SECONDS);
}

export function totpAt(secret: Uint8Array, at: Date, digits = DIGITS): string {
  return hotp(secret, totpStep(at), digits);
}

/**
 * The highest step in [step - window, step + window] whose code equals `code`, or null. Each
 * compare is constant time and every step in the window is checked, so timing doesn't say which
 * step matched. A code that isn't exactly 6 digits never matches.
 */
export function matchTotp(
  secret: Uint8Array,
  code: string,
  at: Date,
  window = WINDOW_STEPS,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code, 'ascii');
  const step = totpStep(at);
  let matched: number | null = null;
  for (let s = Math.max(0, step - window); s <= step + window; s++) {
    if (timingSafeEqual(Buffer.from(hotp(secret, s), 'ascii'), given)) matched = s;
  }
  return matched;
}

/** A new TOTP secret: 20 random bytes (160 bits, RFC 4226's recommended length). */
export function generateSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

export interface OtpauthInput {
  issuer: string;
  account: string;
  secret: Uint8Array;
}

/** The Key URI authenticator apps read from the QR code. */
export function otpauthUri({ issuer, account, secret }: OtpauthInput): string {
  const enc = encodeURIComponent;
  return (
    `otpauth://totp/${enc(issuer)}:${enc(account)}` +
    `?secret=${base32Encode(secret)}&issuer=${enc(issuer)}` +
    `&algorithm=SHA1&digits=${String(DIGITS)}&period=${String(PERIOD_SECONDS)}`
  );
}
