import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MFA_STATES,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  TOTP_WINDOW_STEPS,
  configureZodForBrowser,
  mfaConfirmRequestSchema,
  mfaEnrolledResponseSchema,
  mfaEnrollmentResponseSchema,
  mfaStateSchema,
  mfaVerifyRequestSchema,
  recoveryCodeInputSchema,
  sessionResponseSchema,
  totpCodeSchema,
  userResponseSchema,
  userSchema,
  usersResponseSchema,
} from './index';

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

const USER = { id: 'u1', email: 'ada@example.com', displayName: 'Ada', role: 'admin' } as const;
const SESSION = { setupRequired: false, user: USER, csrfToken: 'csrf' };
const SESSION_DEFAULTS = {
  locked: false,
  mustChangePassword: false,
  signInNotice: null,
  mfa: 'none',
};
const LISTED_USER = {
  ...USER,
  active: true,
  createdAt: '2026-11-26T10:00:00.000Z',
};
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const ENROLLMENT = {
  secret: SECRET,
  otpauthUri: `otpauth://totp/Rampart:ada%40example.com?secret=${SECRET}&issuer=Rampart`,
  qr: { size: 25, path: 'M0 0h7v1h-7zM8 0h1v1h-1zM0 1h1v1h-1z' },
};
const CODES = [
  '0123a-bcdef',
  'ghjkm-npqrs',
  'tvwxy-z0123',
  '45678-9abcd',
  'efghj-kmnpq',
  'rstvw-xyz01',
  '23456-789ab',
  'cdefg-hjkmn',
  'pqrst-vwxyz',
  'zzzzz-00000',
];

describe('sec-mfa contract', () => {
  it('constants', () => {
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_WINDOW_STEPS).toBe(1);
    expect(TOTP_SECRET_BYTES).toBe(20);
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(RECOVERY_CODE_ALPHABET).toBe('0123456789abcdefghjkmnpqrstvwxyz');
    // Crockford base32: 32 distinct characters, none of the four easily misread letters.
    expect(new Set(RECOVERY_CODE_ALPHABET).size).toBe(32);
    for (const letter of 'ilou')
      expect(RECOVERY_CODE_ALPHABET.includes(letter), letter).toBe(false);
    expect(MFA_STATES).toEqual(['none', 'enroll', 'challenge']);
    expect(mfaStateSchema.options).toEqual(['none', 'enroll', 'challenge']);
  });

  it('defaults keep old answers parsing', () => {
    // A session answer from before this sprint (and every old mock) reads as `none`.
    expect(sessionResponseSchema.parse(SESSION)).toEqual({ ...SESSION, ...SESSION_DEFAULTS });
    for (const state of MFA_STATES) {
      expect(sessionResponseSchema.parse({ ...SESSION, mfa: state }).mfa, state).toBe(state);
    }
    for (const bad of ['pending', 'None', '', null, 0, true]) {
      expect(accepts(sessionResponseSchema, { ...SESSION, mfa: bad }), String(bad)).toBe(false);
    }
    expect(accepts(mfaStateSchema, 'verify')).toBe(false);

    // A user without the field reads as not enrolled; a sent value is kept and typed.
    expect(userSchema.parse(LISTED_USER)).toEqual({ ...LISTED_USER, mfaEnrolled: false });
    expect(userSchema.parse({ ...LISTED_USER, mfaEnrolled: true }).mfaEnrolled).toBe(true);
    expect(accepts(userSchema, { ...LISTED_USER, mfaEnrolled: 'yes' })).toBe(false);
    expect(accepts(userSchema, { ...LISTED_USER, mfaEnrolled: null })).toBe(false);
    expect(userResponseSchema.parse({ user: LISTED_USER }).user.mfaEnrolled).toBe(false);
    expect(usersResponseSchema.parse({ users: [LISTED_USER] }).users[0]?.mfaEnrolled).toBe(false);

    // The same in jitless mode, as the browser parses.
    const before = z.config().jitless;
    try {
      configureZodForBrowser();
      expect(sessionResponseSchema.parse(SESSION)).toEqual({ ...SESSION, ...SESSION_DEFAULTS });
      expect(accepts(sessionResponseSchema, { ...SESSION, mfa: 'pending' })).toBe(false);
      expect(userSchema.parse(LISTED_USER).mfaEnrolled).toBe(false);
    } finally {
      z.config({ jitless: before ?? false });
    }
  });

  it('code and recovery code inputs', () => {
    // Every whitespace character is removed before the 6-digit check.
    expect(totpCodeSchema.parse(' 123 456 ')).toBe('123456');
    expect(totpCodeSchema.parse('123456')).toBe('123456');
    expect(totpCodeSchema.parse('\t12 34\n56\r\n')).toBe('123456');
    expect(totpCodeSchema.parse('000000')).toBe('000000');
    for (const bad of [
      '12345',
      '1234567',
      '12a456',
      '',
      '      ',
      '123-456',
      '１２３４５６',
      '١٢٣٤٥٦',
      '+12345',
      '1e5678',
      123456,
      null,
    ]) {
      expect(accepts(totpCodeSchema, bad), JSON.stringify(bad)).toBe(false);
    }

    // Lowercased, spaces and hyphens removed, then exactly 10 alphabet characters.
    expect(recoveryCodeInputSchema.parse('ABCDE-FGHJK')).toBe('abcdefghjk');
    expect(recoveryCodeInputSchema.parse(' abcde fghjk ')).toBe('abcdefghjk');
    expect(recoveryCodeInputSchema.parse('abcdefghjk')).toBe('abcdefghjk');
    expect(recoveryCodeInputSchema.parse('0123-45-6789')).toBe('0123456789');
    expect(recoveryCodeInputSchema.parse('-a-b-c-d-e-f-g-h-j-k-')).toBe('abcdefghjk');
    for (const letter of ['i', 'l', 'o', 'u', 'I', 'L', 'O', 'U']) {
      const code = `abcde-fghj${letter}`;
      expect(accepts(recoveryCodeInputSchema, code), code).toBe(false);
    }
    for (const bad of [
      'abcde-fghj',
      'abcde-fghjkm',
      'abcd',
      '',
      '----------',
      'abcde_fghjk',
      'abcde.fghjk',
      'abcdé-fghjk',
      10,
      null,
    ]) {
      expect(accepts(recoveryCodeInputSchema, bad), JSON.stringify(bad)).toBe(false);
    }
    // The 64-character cap counts the input, before anything is removed.
    const padded = (length: number) => 'abcdefghjk'.padStart(length, ' ');
    expect(recoveryCodeInputSchema.parse(padded(64))).toBe('abcdefghjk');
    expect(accepts(recoveryCodeInputSchema, padded(65))).toBe(false);
    expect(accepts(recoveryCodeInputSchema, `abcdefghjk${'-'.repeat(55)}`)).toBe(false);
  });

  it('mfa request rules', () => {
    // Confirm: strict, one code.
    expect(mfaConfirmRequestSchema.parse({ code: '123 456' })).toEqual({ code: '123456' });
    expect(accepts(mfaConfirmRequestSchema, {})).toBe(false);
    expect(accepts(mfaConfirmRequestSchema, { code: '12345' })).toBe(false);
    expect(accepts(mfaConfirmRequestSchema, { code: '123456', extra: 1 })).toBe(false);
    expect(accepts(mfaConfirmRequestSchema, { recoveryCode: 'abcde-fghjk' })).toBe(false);
    expect(accepts(mfaConfirmRequestSchema, null)).toBe(false);

    // Verify: exactly one of code or recoveryCode.
    expect(mfaVerifyRequestSchema.parse({ code: ' 123456' })).toEqual({ code: '123456' });
    expect(mfaVerifyRequestSchema.parse({ recoveryCode: 'ABCDE-FGHJK' })).toEqual({
      recoveryCode: 'abcdefghjk',
    });
    for (const bad of [
      {},
      { code: '123456', recoveryCode: 'abcde-fghjk' },
      { code: '123456', extra: 1 },
      { recoveryCode: 'abcde-fghjk', extra: 1 },
      { code: undefined },
      { code: '12345' },
      { recoveryCode: 'abcde-fghj' },
      // A recovery code in the code field, or the reverse, is refused.
      { code: 'abcde-fghjk' },
      { recoveryCode: '123456' },
      null,
      '123456',
    ]) {
      expect(accepts(mfaVerifyRequestSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('mfa response rules', () => {
    expect(mfaEnrollmentResponseSchema.parse(ENROLLMENT)).toEqual(ENROLLMENT);
    const withSecret = (secret: string) => ({ ...ENROLLMENT, secret });
    const withUri = (otpauthUri: string) => ({ ...ENROLLMENT, otpauthUri });
    const withQr = (qr: unknown) => ({ ...ENROLLMENT, qr });
    for (const bad of [
      withSecret(SECRET.slice(1)),
      withSecret(`${SECRET}A`),
      withSecret(SECRET.toLowerCase()),
      withSecret(`${SECRET.slice(1)}1`),
      withSecret(`${SECRET.slice(1)}=`),
      withUri('otpauth://hotp/Rampart:ada?secret=X'),
      withUri('https://example.com/otpauth://totp/'),
      withUri(' otpauth://totp/Rampart'),
      withQr({ size: 20, path: '' }),
      withQr({ size: 178, path: '' }),
      withQr({ size: 25.5, path: '' }),
      withQr({ size: 25 }),
      withQr({ size: 25, path: 'M0 0h1v1h-1z<script>' }),
      withQr({ size: 25, path: 'M0 0h1v1h-1z"' }),
      withQr({ size: 25, path: '<path d="M0 0"/>' }),
      withQr({ size: 25, path: 'M0 0h1v1h-1z M1 0h1v1h-1z' }),
      withQr({ size: 25, path: 'M0 0h1v2h-1z' }),
      withQr({ size: 25, path: 'M1000 0h1v1h-1z' }),
      withQr({ size: 25, path: 'm0 0h1v1h-1z' }),
      { secret: SECRET, otpauthUri: ENROLLMENT.otpauthUri },
    ]) {
      expect(accepts(mfaEnrollmentResponseSchema, bad), JSON.stringify(bad)).toBe(false);
    }
    // The edges of the QR side, and an empty path (no dark module) are accepted.
    expect(accepts(mfaEnrollmentResponseSchema, withQr({ size: 21, path: '' }))).toBe(true);
    expect(
      accepts(mfaEnrollmentResponseSchema, withQr({ size: 177, path: 'M176 176h1v1h-1z' })),
    ).toBe(true);

    // The enrolled answer is a session answer with exactly 10 well-formed codes.
    const enrolled = { ...SESSION, recoveryCodes: CODES };
    expect(mfaEnrolledResponseSchema.parse(enrolled)).toEqual({
      ...enrolled,
      ...SESSION_DEFAULTS,
    });
    for (const bad of [
      CODES.slice(1),
      [...CODES, '0000a-0000b'],
      [],
      CODES.map((code, index) => (index === 3 ? code.toUpperCase() : code)),
      CODES.map((code, index) => (index === 3 ? code.replace('-', '') : code)),
      CODES.map((code, index) => (index === 3 ? `${code.slice(0, 10)}i` : code)),
      CODES.map((code, index) => (index === 3 ? `${code.slice(0, 10)}u` : code)),
      CODES.map((code, index) => (index === 3 ? ` ${code}` : code)),
      CODES.map((code, index) => (index === 3 ? `${code}0` : code)),
    ]) {
      expect(
        accepts(mfaEnrolledResponseSchema, { ...SESSION, recoveryCodes: bad }),
        JSON.stringify(bad),
      ).toBe(false);
    }
    expect(accepts(mfaEnrolledResponseSchema, SESSION)).toBe(false);
    // Still a session answer: its own fields are checked.
    expect(accepts(mfaEnrolledResponseSchema, { ...enrolled, mfa: 'pending' })).toBe(false);
  });
});
