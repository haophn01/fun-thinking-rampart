import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** The keys `deriveKeys` gives, each 32 bytes, each for one use only. */
export interface DerivedKeys {
  /** Encrypts each user's TOTP secret (`encryptSecret`, aad `user:<userId>`). */
  mfaSecret: Buffer;
  /** Keys the HMAC that stores recovery codes. */
  recoveryCode: Buffer;
}

/** HKDF `info` strings: a new use gets a new string, and a changed one a new version. */
const MFA_SECRET_INFO = 'rampart/mfa-secret/v1';
const RECOVERY_CODE_INFO = 'rampart/recovery-code/v1';

/**
 * Thrown for a wrong key, a wrong aad, any changed byte or a bad format. The message is always
 * the same and never repeats the input, so a log line never carries ciphertext or a secret.
 */
export class SecretDecryptError extends Error {
  constructor() {
    super('The stored secret could not be decrypted');
    this.name = 'SecretDecryptError';
  }
}

function hkdf(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, KEY_BYTES));
}

/** One key per use, from the master key: HKDF-SHA256 with an empty salt. */
export function deriveKeys(master: Buffer): DerivedKeys {
  return {
    mfaSecret: hkdf(master, MFA_SECRET_INFO),
    recoveryCode: hkdf(master, RECOVERY_CODE_INFO),
  };
}

/**
 * AES-256-GCM with a fresh random 12-byte IV per call, as `v1.<iv>.<ciphertext>.<tag>`, each part
 * base64url. `aad` binds the result to where it is stored: `user:<userId>` for an MFA secret.
 */
export function encryptSecret(key: Buffer, plaintext: string, aad: string): string {
  if (key.length !== KEY_BYTES) throw new RangeError('The encryption key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, ciphertext, tag]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** A base64url part decoded, or null unless it is canonical (re-encodes to the same text). */
function decodePart(text: string): Buffer | null {
  if (!BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

/** Reverses `encryptSecret`; anything but the exact key, aad and bytes throws `SecretDecryptError`. */
export function decryptSecret(key: Buffer, enc: string, aad: string): string {
  const parts = enc.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION || key.length !== KEY_BYTES) {
    throw new SecretDecryptError();
  }
  const [iv, ciphertext, tag] = parts.slice(1).map(decodePart);
  if (!iv || !ciphertext || !tag || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretDecryptError();
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptError();
  }
}
