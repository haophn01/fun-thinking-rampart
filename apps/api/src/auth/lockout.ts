import { eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { user } from '../../db/schema';
import { recordAudit } from '../audit/record';
import { AppError } from '../errors';
import type { ApiDeps } from '../routes';
import { deleteUserSessions, type SessionStore } from './sessions';

/** The 5th consecutive failure locks the account. */
export const MAX_FAILED_SIGN_INS = 5;
export const LOCK_MS = 15 * 60 * 1000;

/** Whether an account locked until `lockedUntil` is still locked at `now`. */
export function isAccountLocked(lockedUntil: string | null, now: Date): boolean {
  return lockedUntil !== null && now.getTime() < Date.parse(lockedUntil);
}

/** The 429 for a locked account; whole seconds, rounded up, and never 0. */
function tooManyAttempts(reply: FastifyReply, lockedUntil: string, now: Date): AppError {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((Date.parse(lockedUntil) - now.getTime()) / 1000),
  );
  void reply.header('retry-after', String(retryAfterSeconds));
  return new AppError('too_many_attempts', 'Too many failed sign-ins. Try again later.', {
    details: { retryAfterSeconds },
  });
}

/** Throws the 429 while the account is locked; the attempt is not counted. */
export function assertAccountUnlocked(
  reply: FastifyReply,
  lockedUntil: string | null,
  now: Date,
): void {
  if (lockedUntil !== null && isAccountLocked(lockedUntil, now)) {
    throw tooManyAttempts(reply, lockedUntil, now);
  }
}

/** A right password: the run of failures starts again. */
export function clearFailures(db: SessionStore, userId: string): void {
  db.update(user).set({ failedSignIns: 0, lockedUntil: null }).where(eq(user.id, userId)).run();
}

/**
 * Records one failed password on an existing, active account; the 5th in a row locks it.
 * Sign-in, unlock and change password share the run. With `fromSession` (unlock, change), the
 * lock also ends every session the user has, in the same transaction. Returns whether this
 * failure locked the account.
 */
export function recordFailure(
  deps: ApiDeps,
  userId: string,
  now: Date,
  requestId: string,
  options: { fromSession?: boolean } = {},
): boolean {
  return deps.db.transaction((tx) => {
    const current = tx
      .select({ failed: user.failedSignIns, lockedUntil: user.lockedUntil })
      .from(user)
      .where(eq(user.id, userId))
      .get();
    // Locked by a request that finished while this one was hashing: not counted.
    if (!current || isAccountLocked(current.lockedUntil, now)) return false;
    // A lock that has ended restarts the count.
    const failed = (current.lockedUntil === null ? current.failed : 0) + 1;
    const locks = failed >= MAX_FAILED_SIGN_INS;
    tx.update(user)
      .set({
        failedSignIns: failed,
        lockedUntil: locks ? new Date(now.getTime() + LOCK_MS).toISOString() : null,
      })
      .where(eq(user.id, userId))
      .run();
    if (locks) {
      if (options.fromSession === true) deleteUserSessions(tx, userId);
      recordAudit(tx, {
        at: now,
        actorUserId: null,
        action: 'auth.locked_out',
        entityType: 'user',
        entityId: userId,
        before: null,
        after: null,
        requestId,
      });
    }
    return locks;
  });
}
