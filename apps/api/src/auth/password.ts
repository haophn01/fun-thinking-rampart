import { hash, verify } from '@node-rs/argon2';
import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config';

/**
 * How new passwords are hashed. Argon2id is the default; PBKDF2-HMAC-SHA-256 is the
 * FIPS-approved choice, used when `FIPS_MODE=required`. A stored hash always verifies by its own
 * prefix, whatever the scheme now is.
 */
export type PasswordScheme = 'argon2id' | 'pbkdf2-sha256';

/** The scheme new passwords get under this config: PBKDF2 only when FIPS is required. */
export function passwordSchemeFor(config: Pick<Config, 'fipsMode'>): PasswordScheme {
  return config.fipsMode === 'required' ? 'pbkdf2-sha256' : 'argon2id';
}

/**
 * An Argon2id hash (the library's default parameters) of a random value nobody knows. Sign-in
 * verifies against it when the email is unknown, so a wrong email takes as long as a wrong password.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$CBgf7VsXiZhMgBz58EqrVw$FaD55CZ7sMxDEstehjDb0a3B5hcfC0/4tIqca4KuQZg';

/** The PBKDF2 counterpart of `DUMMY_HASH`, at `PBKDF2_ITERATIONS`, of a random value nobody knows. */
export const DUMMY_PBKDF2_HASH =
  '$pbkdf2-sha256$i=600000$q4FwDDxG8wymY8ETOddPbg$aobjI3h9er5+2uC+ozSqCPz8ScBII4eZVUzqU8dYW8g';

/** OWASP's 2023 figure for PBKDF2-HMAC-SHA-256. */
export const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_PREFIX = '$pbkdf2-sha256$';
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BYTES = 32;
/** Stored counts outside this range are refused: too weak below, a time sink above. */
const PBKDF2_MIN_ITERATIONS = 100_000;
const PBKDF2_MAX_ITERATIONS = 10_000_000;

/** Standard base64 without padding, as the stored format writes it. */
const toBase64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

/** Strict: only the canonical unpadded encoding of exactly `length` bytes, else null. */
function fromBase64(text: string, length: number): Buffer | null {
  if (!/^[A-Za-z0-9+/]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== length || toBase64(bytes) !== text) return null;
  return bytes;
}

function derive(password: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, PBKDF2_KEY_BYTES, 'sha256', (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

interface Pbkdf2Hash {
  iterations: number;
  salt: Buffer;
  key: Buffer;
}

/** `$pbkdf2-sha256$i=<count>$<salt>$<key>`, or null when any part is off. */
function parsePbkdf2(stored: string): Pbkdf2Hash | null {
  const parts = stored.slice(PBKDF2_PREFIX.length).split('$');
  if (parts.length !== 3) return null;
  const [count = '', saltText = '', keyText = ''] = parts;
  const match = /^i=([1-9]\d{0,9})$/.exec(count);
  if (!match) return null;
  const iterations = Number(match[1]);
  if (iterations < PBKDF2_MIN_ITERATIONS || iterations > PBKDF2_MAX_ITERATIONS) return null;
  const salt = fromBase64(saltText, PBKDF2_SALT_BYTES);
  const key = fromBase64(keyText, PBKDF2_KEY_BYTES);
  if (salt === null || key === null) return null;
  return { iterations, salt, key };
}

async function verifyPbkdf2(stored: string, password: string): Promise<boolean> {
  const parsed = parsePbkdf2(stored);
  if (parsed === null) return false;
  const key = await derive(password, parsed.salt, parsed.iterations);
  return timingSafeEqual(key, parsed.key);
}

async function verifyArgon2(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    // A stored value the library can't decode matches nothing.
    return false;
  }
}

/**
 * Hashes a new password: Argon2id with `@node-rs/argon2`'s defaults (`$argon2id$…`), or
 * PBKDF2-HMAC-SHA-256 (`$pbkdf2-sha256$i=600000$<salt>$<key>`, standard base64 without padding).
 */
export async function hashPassword(
  password: string,
  scheme: PasswordScheme = 'argon2id',
): Promise<string> {
  if (scheme === 'argon2id') return hash(password);
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const key = await derive(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_PREFIX}i=${String(PBKDF2_ITERATIONS)}$${toBase64(salt)}$${toBase64(key)}`;
}

/**
 * Whether `password` matches `stored`, by the stored hash's own prefix, so both schemes always
 * verify; a malformed or unknown hash is false, never a throw. Pass `null` for an unknown user:
 * it verifies against `scheme`'s dummy hash, so it spends the same time as a real account.
 */
export async function verifyPassword(
  stored: string | null,
  password: string,
  scheme: PasswordScheme = 'argon2id',
): Promise<boolean> {
  const target = stored ?? (scheme === 'pbkdf2-sha256' ? DUMMY_PBKDF2_HASH : DUMMY_HASH);
  let matched = false;
  if (target.startsWith(PBKDF2_PREFIX)) matched = await verifyPbkdf2(target, password);
  else if (target.startsWith('$argon2')) matched = await verifyArgon2(target, password);
  return stored !== null && matched;
}
