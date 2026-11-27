import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { passwordHistory } from '../../db/schema';
import { ERROR_MESSAGES, PASSWORD_HISTORY_DEPTH } from '../contract';
import { AppError } from '../errors';
import { createHarness, type Harness } from '../testing/harness';
import { hashPassword } from './password';
import { assertNotReused, checkNewPassword, pushPasswordHistory } from './password-policy';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function world() {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  const created = await admin.post('/api/users', {
    email: 'carl@example.com',
    displayName: 'Carl',
    role: 'contributor',
    password: 'carl first password',
  });
  expect(created.statusCode).toBe(201);
  const adminId = admin.user?.id ?? '';
  const carlId = created.json<{ user: { id: string } }>().user.id;
  return { h, adminId, carlId };
}

function historyOf(h: Harness, userId: string): string[] {
  return h.db
    .select()
    .from(passwordHistory)
    .where(eq(passwordHistory.userId, userId))
    .orderBy(asc(passwordHistory.id))
    .all()
    .map((row) => row.passwordHash);
}

/** The error code a call throws, or null. */
async function codeOf(run: () => unknown): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
}

describe('history is pruned to the depth', () => {
  it('keeps the newest 4 rows per user, ordered by id, and leaves other users alone', async () => {
    const { h, adminId, carlId } = await world();
    pushPasswordHistory(h.db, carlId, 'carl-old', h.clock.now());
    // Same-moment rows: id decides which are newest.
    for (let i = 1; i <= 6; i += 1) {
      pushPasswordHistory(h.db, adminId, `hash-${String(i)}`, h.clock.now());
    }
    expect(PASSWORD_HISTORY_DEPTH - 1).toBe(4);
    expect(historyOf(h, adminId)).toEqual(['hash-3', 'hash-4', 'hash-5', 'hash-6']);
    expect(historyOf(h, carlId)).toEqual(['carl-old']);
    const row = h.db.select().from(passwordHistory).where(eq(passwordHistory.userId, carlId)).get();
    expect(row?.createdAt).toBe(h.clock.now().toISOString());
  });
});

describe('new password rules', () => {
  it('refuses a blocklisted password in any case with the contract message', () => {
    for (const listed of ['password1234', 'PassWord1234']) {
      let thrown: unknown;
      try {
        checkNewPassword(listed);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, listed).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe('password_too_common');
      expect((thrown as AppError).message).toBe(ERROR_MESSAGES.password_too_common);
    }
    expect(() => {
      checkNewPassword('correct horse battery');
    }).not.toThrow();
  });

  it('a reuse is the current hash or one of the newest 4 history rows', async () => {
    const { h, adminId } = await world();
    const current = await hashPassword('current password 0');
    const passwords = ['old password 1', 'old password 2', 'old password 3', 'old password 4'];
    // Written straight to the table so a fifth, older row exists beyond the depth.
    const rows = ['too old password', ...passwords];
    for (const pw of rows) {
      h.db
        .insert(passwordHistory)
        .values({ userId: adminId, passwordHash: await hashPassword(pw), createdAt: 'x' })
        .run();
    }
    const check = (pw: string) => assertNotReused(h.db, adminId, current, pw);
    expect(await codeOf(() => check('current password 0'))).toBe('password_reused');
    for (const pw of passwords) expect(await codeOf(() => check(pw)), pw).toBe('password_reused');
    expect(await codeOf(() => check('too old password'))).toBeNull();
    expect(await codeOf(() => check('a brand new password'))).toBeNull();
  });
});
