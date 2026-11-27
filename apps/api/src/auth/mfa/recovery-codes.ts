// Recovery codes: 10 one-time codes shown once at enrollment, `xxxxx-xxxxx` from Crockford base32
// (lowercase, without i, l, o or u). Stored only as an HMAC under the derived recovery-code key.
import { createHmac, randomBytes } from 'node:crypto';

/** The contract's RECOVERY_CODE_ALPHABET (sprint sec-mfa, `contract/mfa.ts`). */
export const RECOVERY_CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** The contract's RECOVERY_CODE_COUNT. */
const CODE_COUNT = 10;
const HALF_LENGTH = 5;
const CODE_LENGTH = HALF_LENGTH * 2;
/** The contract's recoveryCodeInputSchema takes at most this many characters before normalizing. */
const MAX_INPUT_LENGTH = 64;

/** Gives `count` random bytes; `randomBytes` in the app, a seeded stream in tests. */
export type ByteSource = (count: number) => Uint8Array;

/**
 * `count` characters from the alphabet, each uniform. The alphabet has 32 characters, so the low
 * five bits of a random byte pick one with no modulo bias (256 is a multiple of 32).
 */
export function drawRecoveryChars(count: number, source: ByteSource = randomBytes): string {
  const bytes = source(count);
  let out = '';
  for (const byte of bytes) out += RECOVERY_CODE_ALPHABET.charAt(byte & 31);
  return out;
}

/** 10 codes, unique within the set, formatted `xxxxx-xxxxx`. */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < CODE_COUNT) {
    const raw = drawRecoveryChars(CODE_LENGTH);
    codes.add(`${raw.slice(0, HALF_LENGTH)}-${raw.slice(HALF_LENGTH)}`);
  }
  return [...codes];
}

const NORMALIZED = new RegExp(`^[${RECOVERY_CODE_ALPHABET}]{${String(CODE_LENGTH)}}$`);

/** The 10 bare characters of a typed code (any case, spaces and hyphens ignored), or null. */
export function normalizeRecoveryCode(input: string): string | null {
  if (input.length > MAX_INPUT_LENGTH) return null;
  const bare = input.toLowerCase().replace(/[ -]/g, '');
  return NORMALIZED.test(bare) ? bare : null;
}

/** HMAC-SHA-256 hex of `recovery-code:v1:<normalized>` under the recovery-code key. */
export function hashRecoveryCode(key: Uint8Array, normalized: string): string {
  return createHmac('sha256', key).update(`recovery-code:v1:${normalized}`).digest('hex');
}
