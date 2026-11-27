import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, deriveKeys, encryptSecret, SecretDecryptError } from './secrets';

const KEY = Buffer.from('0123456789abcdef'.repeat(4), 'hex');
const OTHER_KEY = Buffer.from('fedcba9876543210'.repeat(4), 'hex');
const PLAINTEXT = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const AAD = 'user:5f0c6c1e-2b1e-4c55-9a4e-0d6c3f1a7b21';

/** The thrown error, which must be a SecretDecryptError that never repeats the input. */
function decryptError(key: Buffer, enc: string, aad: string): SecretDecryptError {
  try {
    decryptSecret(key, enc, aad);
  } catch (error) {
    expect(error).toBeInstanceOf(SecretDecryptError);
    const thrown = error as SecretDecryptError;
    expect(thrown.name).toBe('SecretDecryptError');
    for (const part of enc.split('.')) {
      if (part.length >= 8) expect(thrown.message).not.toContain(part);
    }
    if (aad.length >= 8) expect(thrown.message).not.toContain(aad);
    expect(thrown.message).not.toContain(PLAINTEXT);
    return thrown;
  }
  throw new Error(`expected decryptSecret to refuse ${enc}`);
}

/** `enc` with one byte of part `index` (1 iv, 2 ciphertext, 3 tag) flipped. */
function flipByte(enc: string, index: number, at: number): string {
  const parts = enc.split('.');
  const bytes = Buffer.from(parts[index] ?? '', 'base64url');
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  parts[index] = bytes.toString('base64url');
  return parts.join('.');
}

describe('AES-256-GCM seals and refuses tampering', () => {
  it('a round trip returns the plaintext, in the v1 format', () => {
    const enc = encryptSecret(KEY, PLAINTEXT, AAD);
    expect(enc).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(enc.split('.')[1] ?? '', 'base64url')).toHaveLength(12);
    expect(Buffer.from(enc.split('.')[3] ?? '', 'base64url')).toHaveLength(16);
    expect(enc).not.toContain(PLAINTEXT);
    expect(decryptSecret(KEY, enc, AAD)).toBe(PLAINTEXT);
    // Any text survives, the empty string and non-ASCII included.
    for (const text of ['', 'é ✓ 中文', 'x'.repeat(5000)]) {
      expect(decryptSecret(KEY, encryptSecret(KEY, text, AAD), AAD)).toBe(text);
    }
  });

  it('two encryptions of the same input differ (a fresh IV each time)', () => {
    const seen = new Set<string>();
    const ivs = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const enc = encryptSecret(KEY, PLAINTEXT, AAD);
      seen.add(enc);
      ivs.add(enc.split('.')[1] ?? '');
    }
    expect(seen.size).toBe(20);
    expect(ivs.size).toBe(20);
  });

  it('a wrong key or a wrong aad is refused', () => {
    const enc = encryptSecret(KEY, PLAINTEXT, AAD);
    decryptError(OTHER_KEY, enc, AAD);
    decryptError(randomBytes(32), enc, AAD);
    decryptError(KEY, enc, 'user:someone-else');
    decryptError(KEY, enc, '');
    // A key of the wrong length is refused the same way, not with a crypto RangeError.
    decryptError(KEY.subarray(0, 16), enc, AAD);
  });

  it('one flipped byte in any part is refused', () => {
    const enc = encryptSecret(KEY, PLAINTEXT, AAD);
    for (const index of [1, 2, 3]) {
      const length = Buffer.from(enc.split('.')[index] ?? '', 'base64url').length;
      for (const at of [0, length - 1]) decryptError(KEY, flipByte(enc, index, at), AAD);
    }
  });

  it('a bad format is refused', () => {
    const enc = encryptSecret(KEY, PLAINTEXT, AAD);
    const [, iv = '', ct = '', tag = ''] = enc.split('.');
    const bad = [
      `v2.${iv}.${ct}.${tag}`,
      `V1.${iv}.${ct}.${tag}`,
      `${iv}.${ct}.${tag}`,
      `v1.${iv}.${ct}`,
      `v1.${iv}.${ct}.${tag}.`,
      `v1.${iv}.${ct}.${tag}.extra`,
      // An IV or a tag of the wrong length.
      `v1.${iv.slice(0, 12)}.${ct}.${tag}`,
      `v1.${iv}.${ct}.${tag.slice(0, 16)}`,
      // Characters outside base64url, and padding.
      `v1.${iv}.${ct}+.${tag}`,
      `v1.${iv}.${ct}.${tag}==`,
      ` ${enc}`,
      '',
      'v1...',
    ];
    for (const value of bad) decryptError(KEY, value, AAD);
  });

  it('refuses to encrypt with a key that is not 32 bytes', () => {
    expect(() => encryptSecret(KEY.subarray(0, 31), PLAINTEXT, AAD)).toThrow(/32 bytes/);
  });
});

describe('derived keys are separate', () => {
  it('is deterministic, and its two keys differ from each other and from the master', () => {
    const first = deriveKeys(KEY);
    const again = deriveKeys(Buffer.from(KEY));
    expect(first.mfaSecret.equals(again.mfaSecret)).toBe(true);
    expect(first.recoveryCode.equals(again.recoveryCode)).toBe(true);
    expect(first.mfaSecret).toHaveLength(32);
    expect(first.recoveryCode).toHaveLength(32);
    expect(first.mfaSecret.equals(first.recoveryCode)).toBe(false);
    expect(first.mfaSecret.equals(KEY)).toBe(false);
    expect(first.recoveryCode.equals(KEY)).toBe(false);
  });

  it('uses HKDF-SHA256 with an empty salt and the pinned info strings', async () => {
    const { hkdfSync } = await import('node:crypto');
    const expected = (info: string) =>
      Buffer.from(hkdfSync('sha256', KEY, Buffer.alloc(0), info, 32));
    const keys = deriveKeys(KEY);
    expect(keys.mfaSecret.equals(expected('rampart/mfa-secret/v1'))).toBe(true);
    expect(keys.recoveryCode.equals(expected('rampart/recovery-code/v1'))).toBe(true);
  });

  it('another master gives other keys', () => {
    const a = deriveKeys(KEY);
    const b = deriveKeys(OTHER_KEY);
    expect(a.mfaSecret.equals(b.mfaSecret)).toBe(false);
    expect(a.recoveryCode.equals(b.recoveryCode)).toBe(false);
  });
});
