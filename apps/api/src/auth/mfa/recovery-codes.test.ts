import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_ALPHABET,
  drawRecoveryChars,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from './recovery-codes';

const FORMAT = /^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/;
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);

/** A seeded byte stream (SHA-256 in counter mode): random-looking, the same on every run. */
function seededBytes(seed: string) {
  let counter = 0;
  return (count: number) => {
    const blocks: Buffer[] = [];
    for (let have = 0; have < count; have += 32) {
      blocks.push(
        createHash('sha256')
          .update(`${seed}:${String(counter++)}`)
          .digest(),
      );
    }
    return Buffer.concat(blocks).subarray(0, count);
  };
}

describe('recovery codes', () => {
  it('uses the contract alphabet: Crockford base32, lowercase, without i, l, o or u', () => {
    expect(RECOVERY_CODE_ALPHABET).toBe('0123456789abcdefghjkmnpqrstvwxyz');
  });

  it('gives 10 unique codes in format, over 1,000 runs', () => {
    for (let run = 0; run < 1000; run++) {
      const codes = generateRecoveryCodes();
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const code of codes) expect(code).toMatch(FORMAT);
    }
  });

  it('maps every byte value to the alphabet evenly, so there is no modulo bias', () => {
    const everyByte = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const chars = drawRecoveryChars(256, () => everyByte);
    for (const ch of RECOVERY_CODE_ALPHABET) {
      expect(chars.split(ch).length - 1, ch).toBe(8);
    }
  });

  it('draws from crypto randomness by default', () => {
    expect(drawRecoveryChars(64)).toMatch(/^[0-9a-hjkmnp-tv-z]{64}$/);
    expect(drawRecoveryChars(64)).not.toBe(drawRecoveryChars(64));
  });

  it('draws every character within 5 % of uniform over 100,000 draws', () => {
    // A seeded stream keeps this exact: at 100,000 live draws, 5 % is about 2.8 standard
    // deviations per character, so one of 32 would miss it on roughly one run in six.
    const chars = drawRecoveryChars(100_000, seededBytes('rampart-recovery-uniformity'));
    expect(chars).toHaveLength(100_000);
    const counts = new Map<string, number>();
    for (const ch of chars) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect([...counts.keys()].sort().join('')).toBe(RECOVERY_CODE_ALPHABET);
    const expected = 100_000 / 32;
    for (const [ch, count] of counts) {
      expect(Math.abs(count - expected) / expected, ch).toBeLessThan(0.05);
    }
  });

  it('normalizes case, hyphens and spaces', () => {
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('abcdefghjk');
    expect(normalizeRecoveryCode('ABCDE-FGHJK')).toBe('abcdefghjk');
    expect(normalizeRecoveryCode(' ab cde - fg-hjk ')).toBe('abcdefghjk');
    expect(normalizeRecoveryCode('abcdefghjk')).toBe('abcdefghjk');
  });

  it('refuses i, l, o, u, a wrong length and an over-long input', () => {
    for (const bad of ['abcde-fghji', 'abcde-fghjl', 'abcde-fghjo', 'abcde-fghju']) {
      expect(normalizeRecoveryCode(bad), bad).toBeNull();
    }
    expect(normalizeRecoveryCode('abcde-fghj')).toBeNull();
    expect(normalizeRecoveryCode('abcde-fghjkm')).toBeNull();
    expect(normalizeRecoveryCode('')).toBeNull();
    expect(normalizeRecoveryCode('abcde_fghjk')).toBeNull();
    // At most 64 characters before normalizing, as the contract's input schema says.
    expect(normalizeRecoveryCode(`abcde-fghjk${' '.repeat(53)}`)).toBe('abcdefghjk');
    expect(normalizeRecoveryCode(`abcde-fghjk${' '.repeat(54)}`)).toBeNull();
  });

  it('hashes to 64 hex, the same for both spellings, different under another key', () => {
    const a = normalizeRecoveryCode('ABCDE-FGHJK');
    const b = normalizeRecoveryCode('abcdefghjk');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const hashA = hashRecoveryCode(KEY, a ?? '');
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(KEY, b ?? '')).toBe(hashA);
    expect(hashRecoveryCode(OTHER_KEY, a ?? '')).not.toBe(hashA);
    expect(hashRecoveryCode(KEY, 'abcdefghjm')).not.toBe(hashA);
  });

  it('hashes the prefixed text recovery-code:v1:<code> with HMAC-SHA-256', async () => {
    const { createHmac } = await import('node:crypto');
    const want = createHmac('sha256', KEY).update('recovery-code:v1:abcdefghjk').digest('hex');
    expect(hashRecoveryCode(KEY, 'abcdefghjk')).toBe(want);
  });
});
