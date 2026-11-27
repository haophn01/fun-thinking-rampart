// The MFA reset, shared by the admin route and the `admin:reset-mfa` CLI: it clears the user's
// secret, step, enrollment and recovery codes, ends all their sessions and writes `user.mfa_reset`.
import { recordAudit } from '../../audit/record';
import { deleteUserSessions, type SessionStore } from '../sessions';
import { clearMfa, findMfaAccount, recoveryCodeCount } from './repository';

export interface MfaResetContext {
  /** The admin who reset it; null from the CLI. */
  actorUserId: string | null;
  /** The api request; null from the CLI. */
  requestId: string | null;
  now: Date;
}

/**
 * Resets the user's MFA inside the caller's transaction and returns whether anything changed.
 * With nothing stored (no secret, no enrollment, no codes), or no such user, it changes nothing
 * and writes no event. The event's before and after hold `mfaEnrolled`; a reset of a secret that
 * was added but never confirmed also records `pendingSetup`, so it is still logged.
 */
export function resetMfa(tx: SessionStore, userId: string, context: MfaResetContext): boolean {
  const account = findMfaAccount(tx, userId);
  if (!account) return false;
  const enrolled = account.enrolledAt !== null;
  const pendingSetup = !enrolled && account.secretEnc !== null;
  if (!enrolled && !pendingSetup && recoveryCodeCount(tx, userId) === 0) return false;

  clearMfa(tx, userId, context.now);
  deleteUserSessions(tx, userId);
  recordAudit(tx, {
    at: context.now,
    actorUserId: context.actorUserId,
    action: 'user.mfa_reset',
    entityType: 'user',
    entityId: userId,
    before: pendingSetup ? { mfaEnrolled: false, pendingSetup: true } : { mfaEnrolled: enrolled },
    after: pendingSetup ? { mfaEnrolled: false, pendingSetup: false } : { mfaEnrolled: false },
    requestId: context.requestId,
  });
  return true;
}
