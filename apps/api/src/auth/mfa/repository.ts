// The MFA rows: the user's sealed TOTP secret, last accepted step and enrollment time, the
// session's `mfa_pending` flag, and the recovery-code hashes. Every write that must happen once
// (a step, a code) is a conditional UPDATE whose changed-row count is the answer, so two requests
// racing for the same step or code can't both win.
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { mfaRecoveryCode, session, user } from '../../../db/schema';
import type { SessionStore } from '../sessions';

/** The caller's MFA state as stored now. */
export interface MfaAccount {
  id: string;
  email: string;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  /** `v1.` ciphertext of the base32 secret (aad `user:<id>`), or null. */
  secretEnc: string | null;
  lastStep: number | null;
  enrolledAt: string | null;
}

export function findMfaAccount(db: SessionStore, userId: string): MfaAccount | undefined {
  return db
    .select({
      id: user.id,
      email: user.email,
      mustChangePassword: user.mustChangePassword,
      lockedUntil: user.lockedUntil,
      secretEnc: user.mfaSecretEnc,
      lastStep: user.mfaLastStep,
      enrolledAt: user.mfaEnrolledAt,
    })
    .from(user)
    .where(eq(user.id, userId))
    .get();
}

/** Whether the session is waiting for its MFA step; undefined when the session is gone. */
export function sessionMfaPending(db: SessionStore, sessionId: string): boolean | undefined {
  return db
    .select({ pending: session.mfaPending })
    .from(session)
    .where(eq(session.id, sessionId))
    .get()?.pending;
}

/**
 * Stores a new pending secret in place of any earlier one and clears the last step. Only while
 * the user isn't enrolled: returns false (and changes nothing) once they are.
 */
export function storePendingSecret(
  db: SessionStore,
  userId: string,
  secretEnc: string,
  now: Date,
): boolean {
  const result = db
    .update(user)
    .set({ mfaSecretEnc: secretEnc, mfaLastStep: null, updatedAt: now.toISOString() })
    .where(and(eq(user.id, userId), isNull(user.mfaEnrolledAt)))
    .run();
  return result.changes > 0;
}

/**
 * Finishes enrollment with the matched step. Only when the user is still unenrolled and the
 * pending secret is still `secretEnc` (no newer enroll replaced it): returns false otherwise.
 */
export function markEnrolled(
  db: SessionStore,
  userId: string,
  secretEnc: string,
  step: number,
  now: Date,
): boolean {
  const at = now.toISOString();
  const result = db
    .update(user)
    .set({ mfaEnrolledAt: at, mfaLastStep: step, updatedAt: at })
    .where(and(eq(user.id, userId), isNull(user.mfaEnrolledAt), eq(user.mfaSecretEnc, secretEnc)))
    .run();
  return result.changes > 0;
}

/**
 * The replay guard: moves `mfa_last_step` to `step` only when it is higher than the last step
 * accepted. False means the step (or a later one) was already used: refuse the code.
 */
export function acceptStep(db: SessionStore, userId: string, step: number): boolean {
  const result = db
    .update(user)
    .set({ mfaLastStep: step })
    .where(and(eq(user.id, userId), or(isNull(user.mfaLastStep), lt(user.mfaLastStep, step))))
    .run();
  return result.changes > 0;
}

/** Replaces the user's recovery codes with these hashes. */
export function replaceRecoveryCodes(
  db: SessionStore,
  userId: string,
  hashes: readonly string[],
  now: Date,
): void {
  db.delete(mfaRecoveryCode).where(eq(mfaRecoveryCode.userId, userId)).run();
  const createdAt = now.toISOString();
  db.insert(mfaRecoveryCode)
    .values(hashes.map((codeHash) => ({ userId, codeHash, createdAt })))
    .run();
}

/** Marks one unused code of this user used. False: no such unused code (wrong, used or not theirs). */
export function useRecoveryCode(
  db: SessionStore,
  userId: string,
  codeHash: string,
  now: Date,
): boolean {
  const result = db
    .update(mfaRecoveryCode)
    .set({ usedAt: now.toISOString() })
    .where(
      and(
        eq(mfaRecoveryCode.userId, userId),
        eq(mfaRecoveryCode.codeHash, codeHash),
        isNull(mfaRecoveryCode.usedAt),
      ),
    )
    .run();
  return result.changes > 0;
}

/** The user's recovery codes not yet used. */
export function unusedRecoveryCodes(db: SessionStore, userId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(mfaRecoveryCode)
    .where(and(eq(mfaRecoveryCode.userId, userId), isNull(mfaRecoveryCode.usedAt)))
    .get();
  return row?.n ?? 0;
}

/** Every recovery code the user has, used or not. */
export function recoveryCodeCount(db: SessionStore, userId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(mfaRecoveryCode)
    .where(eq(mfaRecoveryCode.userId, userId))
    .get();
  return row?.n ?? 0;
}

/** Clears the secret, the step and the enrollment, and deletes every recovery code. */
export function clearMfa(db: SessionStore, userId: string, now: Date): void {
  db.update(user)
    .set({
      mfaSecretEnc: null,
      mfaLastStep: null,
      mfaEnrolledAt: null,
      updatedAt: now.toISOString(),
    })
    .where(eq(user.id, userId))
    .run();
  db.delete(mfaRecoveryCode).where(eq(mfaRecoveryCode.userId, userId)).run();
}
