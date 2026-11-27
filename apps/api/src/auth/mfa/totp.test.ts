import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '../../contract';
import { base32Decode, base32Encode } from './base32';
import { generateSecret, hotp, matchTotp, otpauthUri, totpAt, totpStep } from './totp';

// RFC 4226 Appendix D and RFC 6238 Appendix B (SHA-1) share this ASCII seed.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const at = (seconds: number) => new Date(seconds * 1000);

describe('base32 follows RFC 4648', () => {
  it('encodes the section 10 vectors, uppercase without padding', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
      expect(base32Decode(encoded).toString('ascii')).toBe(plain);
    }
  });

  it('round-trips 0 to 40 random bytes', () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = randomBytes(n);
      const encoded = base32Encode(bytes);
      expect(encoded).toMatch(/^[A-Z2-7]*$/);
      expect(Buffer.compare(base32Decode(encoded), bytes)).toBe(0);
    }
  });

  it('accepts lowercase', () => {
    expect(base32Decode('mzxw6ytboi').toString('ascii')).toBe('foobar');
    expect(base32Decode('MzXw6YtBoI').toString('ascii')).toBe('foobar');
  });

  it('refuses 1, 8, padding, spaces and impossible lengths', () => {
    for (const bad of [
      'MZXW6YTB1I',
      'MZXW6YTB8I',
      'MZXW6YTBOI======',
      'MZXW 6YTBOI',
      ' MY',
      'MY=',
    ]) {
      expect(() => base32Decode(bad), bad).toThrow();
    }
    // 1, 3 and 6 characters can't come from whole bytes.
    for (const bad of ['M', 'MZX', 'MZXW6Y']) expect(() => base32Decode(bad), bad).toThrow();
  });

  it('refuses leftover bits that are not zero', () => {
    // 'MZ' carries 10 bits for one byte; 'M3' sets a leftover bit.
    expect(() => base32Decode('M3')).toThrow();
  });
});

describe('HOTP matches RFC 4226', () => {
  it('gives Appendix D for counters 0 to 9', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expect(expected.map((_, counter) => hotp(RFC_SECRET, counter))).toEqual(expected);
  });

  it('refuses a negative or fractional counter', () => {
    expect(() => hotp(RFC_SECRET, -1)).toThrow();
    expect(() => hotp(RFC_SECRET, 1.5)).toThrow();
  });
});

describe('TOTP matches RFC 6238', () => {
  it('gives Appendix B (SHA-1, 8 digits)', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(totpAt(RFC_SECRET, at(seconds), 8), String(seconds)).toBe(code);
    }
  });

  it('defaults to 6 digits, the last six of the 8-digit code', () => {
    expect(totpAt(RFC_SECRET, at(59))).toBe('287082');
    expect(totpAt(RFC_SECRET, at(1111111109))).toBe('081804');
  });

  it('generates 20 random bytes', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toHaveLength(20);
    expect(b).toHaveLength(20);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});

describe('window and step edges', () => {
  it('puts 29.999 s in step 0 and 30.000 s in step 1', () => {
    expect(totpStep(new Date(0))).toBe(0);
    expect(totpStep(new Date(29_999))).toBe(0);
    expect(totpStep(new Date(30_000))).toBe(1);
    expect(totpStep(at(1111111109))).toBe(37037036);
  });

  const now = at(1_000_000 * 30 + 12);
  const s = totpStep(now);
  const codeAt = (step: number) => hotp(RFC_SECRET, step);

  it('accepts steps s-1, s and s+1 and refuses s-2 and s+2', () => {
    expect(matchTotp(RFC_SECRET, codeAt(s - 1), now)).toBe(s - 1);
    expect(matchTotp(RFC_SECRET, codeAt(s), now)).toBe(s);
    expect(matchTotp(RFC_SECRET, codeAt(s + 1), now)).toBe(s + 1);
    expect(matchTotp(RFC_SECRET, codeAt(s - 2), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, codeAt(s + 2), now)).toBeNull();
  });

  it('honours a wider or zero window', () => {
    expect(matchTotp(RFC_SECRET, codeAt(s - 2), now, 2)).toBe(s - 2);
    expect(matchTotp(RFC_SECRET, codeAt(s - 1), now, 0)).toBeNull();
    expect(matchTotp(RFC_SECRET, codeAt(s), now, 0)).toBe(s);
  });

  it('returns the highest matching step when two steps share a code', () => {
    // Found offline: with this secret, steps s-1 and s+1 share a code and step s doesn't.
    const secret = Buffer.alloc(20);
    secret.writeUInt32BE(1366016, 16);
    expect(s).toBe(1_000_000);
    expect(hotp(secret, s - 1)).toBe('866075');
    expect(hotp(secret, s + 1)).toBe('866075');
    expect(hotp(secret, s)).not.toBe('866075');
    expect(matchTotp(secret, hotp(secret, s - 1), now)).toBe(s + 1);
  });

  it('refuses a 5-digit, 7-digit or non-digit code', () => {
    const code = codeAt(s);
    expect(matchTotp(RFC_SECRET, code.slice(1), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, `${code}0`, now)).toBeNull();
    expect(matchTotp(RFC_SECRET, `${code.slice(0, 5)}a`, now)).toBeNull();
    expect(matchTotp(RFC_SECRET, ` ${code.slice(1)}`, now)).toBeNull();
    expect(matchTotp(RFC_SECRET, '', now)).toBeNull();
  });

  it('never looks at a step before 0', () => {
    const start = new Date(5_000);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, 0), start)).toBe(0);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, 1), start)).toBe(1);
  });
});

describe('otpauth URI', () => {
  it('is exact for an email with + and @, and its secret decodes to the input', () => {
    const secret = Buffer.from('000102030405060708090a0b0c0d0e0f10111213', 'hex');
    const uri = otpauthUri({ issuer: PRODUCT_NAME, account: 'ann+mfa@example.com', secret });
    const b32 = base32Encode(secret);
    expect(b32).toBe('AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQT');
    expect(uri).toBe(
      `otpauth://totp/Rampart:ann%2Bmfa%40example.com?secret=${b32}&issuer=Rampart&algorithm=SHA1&digits=6&period=30`,
    );
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe('otpauth:');
    const param = parsed.searchParams.get('secret') ?? '';
    expect(Buffer.compare(base32Decode(param), secret)).toBe(0);
  });

  it('encodes an issuer with a space or colon', () => {
    const secret = Buffer.alloc(20);
    const uri = otpauthUri({ issuer: 'Acme: GRC', account: 'a@b.co', secret });
    expect(uri.startsWith('otpauth://totp/Acme%3A%20GRC:a%40b.co?secret=')).toBe(true);
    expect(uri).toContain('&issuer=Acme%3A%20GRC&');
  });
});
