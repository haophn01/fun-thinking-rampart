import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  PASSWORD_HISTORY_DEPTH,
  SESSION_ABSOLUTE_LIMIT_MS,
  SESSION_IDLE_LIMIT_MS,
  SESSION_KEEPALIVE_MS,
  SESSION_LOCK_AFTER_MS,
  SIGN_IN_NOTICE_MAX_LENGTH,
  changePasswordRequestSchema,
  sessionResponseSchema,
  signInNoticeResponseSchema,
  signInNoticeSchema,
  signInNoticeTextSchema,
  signInRequestSchema,
  unlockRequestSchema,
  updateSignInNoticeRequestSchema,
} from './index';

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

const DIGEST = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
const USER = { id: 'u1', email: 'ada@example.com', displayName: 'Ada', role: 'admin' } as const;

describe('sec-auth contract', () => {
  it('session response defaults', () => {
    // An answer from before this sprint (and every old mock) still parses; sec-mfa adds `mfa`.
    const old = { setupRequired: false, user: USER, csrfToken: 'csrf' };
    expect(sessionResponseSchema.parse(old)).toEqual({
      ...old,
      locked: false,
      mustChangePassword: false,
      signInNotice: null,
      mfa: 'none',
    });
    expect(
      sessionResponseSchema.parse({ setupRequired: true, user: null, csrfToken: null }),
    ).toEqual({
      setupRequired: true,
      user: null,
      csrfToken: null,
      locked: false,
      mustChangePassword: false,
      signInNotice: null,
      mfa: 'none',
    });

    // Sent values are kept.
    const full = {
      ...old,
      locked: true,
      mustChangePassword: true,
      signInNotice: { text: 'Authorized use only.', digest: DIGEST },
      mfa: 'challenge',
    };
    expect(sessionResponseSchema.parse(full)).toEqual(full);
    expect(sessionResponseSchema.parse({ ...old, signInNotice: null }).signInNotice).toBeNull();

    // The new fields are still typed.
    expect(accepts(sessionResponseSchema, { ...old, locked: 'yes' })).toBe(false);
    expect(accepts(sessionResponseSchema, { ...old, mustChangePassword: 1 })).toBe(false);
    expect(
      accepts(sessionResponseSchema, { ...old, signInNotice: { text: 'x', digest: 'nope' } }),
    ).toBe(false);
    expect(accepts(sessionResponseSchema, { ...old, signInNotice: 'x' })).toBe(false);
  });

  it('sign-in notice rules', () => {
    expect(SIGN_IN_NOTICE_MAX_LENGTH).toBe(4000);

    // Length is counted after trimming.
    const max = 'n'.repeat(4000);
    expect(signInNoticeTextSchema.parse(max)).toBe(max);
    expect(signInNoticeTextSchema.parse(`  ${max}\n`)).toBe(max);
    expect(accepts(signInNoticeTextSchema, 'n'.repeat(4001))).toBe(false);

    // Blank turns the notice off; null is accepted as off.
    expect(signInNoticeTextSchema.parse('')).toBeNull();
    expect(signInNoticeTextSchema.parse('  ')).toBeNull();
    expect(signInNoticeTextSchema.parse('\n\t \r\n')).toBeNull();
    expect(signInNoticeTextSchema.parse(null)).toBeNull();
    expect(accepts(signInNoticeTextSchema, 42)).toBe(false);
    expect(accepts(signInNoticeTextSchema, undefined)).toBe(false);

    // Inner line breaks and spacing are kept; only the ends are trimmed.
    expect(signInNoticeTextSchema.parse('\n  Line one\n\n  Line two\r\nEnd  \n')).toBe(
      'Line one\n\n  Line two\r\nEnd',
    );

    // The request names the key, and only the key.
    expect(updateSignInNoticeRequestSchema.parse({ text: ' Hi ' })).toEqual({ text: 'Hi' });
    expect(updateSignInNoticeRequestSchema.parse({ text: null })).toEqual({ text: null });
    expect(updateSignInNoticeRequestSchema.parse({ text: '   ' })).toEqual({ text: null });
    expect(accepts(updateSignInNoticeRequestSchema, {})).toBe(false);
    expect(accepts(updateSignInNoticeRequestSchema, { text: undefined })).toBe(false);
    expect(accepts(updateSignInNoticeRequestSchema, { text: 'x', extra: 1 })).toBe(false);
    expect(accepts(updateSignInNoticeRequestSchema, { text: 'n'.repeat(4001) })).toBe(false);

    // The digest is 64 lowercase hex characters.
    expect(signInNoticeSchema.parse({ text: 'x', digest: DIGEST })).toEqual({
      text: 'x',
      digest: DIGEST,
    });
    for (const bad of [
      DIGEST.toUpperCase(),
      DIGEST.slice(1),
      `${DIGEST}0`,
      `${DIGEST.slice(1)}g`,
      ` ${DIGEST.slice(1)}`,
      '',
    ]) {
      expect(accepts(signInNoticeSchema, { text: 'x', digest: bad }), bad).toBe(false);
    }
    expect(accepts(signInNoticeSchema, { text: 'x' })).toBe(false);

    expect(signInNoticeResponseSchema.parse({ signInNotice: null })).toEqual({
      signInNotice: null,
    });
    expect(
      signInNoticeResponseSchema.parse({ signInNotice: { text: 'x', digest: DIGEST } }),
    ).toEqual({ signInNotice: { text: 'x', digest: DIGEST } });
    expect(accepts(signInNoticeResponseSchema, {})).toBe(false);
  });

  it('auth request rules', () => {
    const change = (currentPassword: string, newPassword: string) =>
      accepts(changePasswordRequestSchema, { currentPassword, newPassword });
    expect(change('x', 'p'.repeat(12))).toBe(true);
    expect(change('x', 'p'.repeat(128))).toBe(true);
    expect(change('x', 'p'.repeat(11))).toBe(false);
    expect(change('x', 'p'.repeat(129))).toBe(false);
    expect(change('', 'p'.repeat(12))).toBe(false);
    expect(change('c'.repeat(128), 'p'.repeat(12))).toBe(true);
    expect(change('c'.repeat(129), 'p'.repeat(12))).toBe(false);
    // Passwords are never trimmed.
    expect(
      changePasswordRequestSchema.parse({ currentPassword: ' c ', newPassword: ' new password ' }),
    ).toEqual({ currentPassword: ' c ', newPassword: ' new password ' });
    // Strict: no other key.
    expect(
      accepts(changePasswordRequestSchema, {
        currentPassword: 'x',
        newPassword: 'p'.repeat(12),
        confirm: 'p'.repeat(12),
      }),
    ).toBe(false);
    expect(accepts(changePasswordRequestSchema, { newPassword: 'p'.repeat(12) })).toBe(false);

    expect(unlockRequestSchema.parse({ password: ' pw ' })).toEqual({ password: ' pw ' });
    expect(accepts(unlockRequestSchema, { password: 'p'.repeat(128) })).toBe(true);
    expect(accepts(unlockRequestSchema, { password: 'p'.repeat(129) })).toBe(false);
    expect(accepts(unlockRequestSchema, { password: '' })).toBe(false);
    expect(accepts(unlockRequestSchema, {})).toBe(false);
    expect(accepts(unlockRequestSchema, { password: 'pw', email: 'a@b.c' })).toBe(false);

    // noticeDigest is optional, and 64 lowercase hex when sent.
    const signIn = { email: 'ada@example.com', password: 'pw' };
    expect(signInRequestSchema.parse(signIn)).toEqual(signIn);
    expect(signInRequestSchema.parse({ ...signIn, noticeDigest: DIGEST })).toEqual({
      ...signIn,
      noticeDigest: DIGEST,
    });
    for (const bad of [DIGEST.toUpperCase(), DIGEST.slice(1), `${DIGEST}0`, 'not hex', '', null]) {
      expect(accepts(signInRequestSchema, { ...signIn, noticeDigest: bad }), String(bad)).toBe(
        false,
      );
    }
    expect(accepts(signInRequestSchema, { ...signIn, extra: 1 })).toBe(false);
  });

  it('session and password constants', () => {
    expect(SESSION_IDLE_LIMIT_MS).toBe(30 * 60 * 1000);
    expect(SESSION_ABSOLUTE_LIMIT_MS).toBe(8 * 60 * 60 * 1000);
    expect(SESSION_LOCK_AFTER_MS).toBe(15 * 60 * 1000);
    expect(SESSION_KEEPALIVE_MS).toBe(5 * 60 * 1000);
    expect(PASSWORD_HISTORY_DEPTH).toBe(5);
    expect([
      SESSION_IDLE_LIMIT_MS,
      SESSION_ABSOLUTE_LIMIT_MS,
      SESSION_LOCK_AFTER_MS,
      SESSION_KEEPALIVE_MS,
    ]).toEqual([1_800_000, 28_800_000, 900_000, 300_000]);
    // The lock comes before the idle end, and the keep-alive well before the lock.
    expect(SESSION_LOCK_AFTER_MS).toBeLessThan(SESSION_IDLE_LIMIT_MS);
    expect(SESSION_KEEPALIVE_MS).toBeLessThan(SESSION_LOCK_AFTER_MS);
  });
});
