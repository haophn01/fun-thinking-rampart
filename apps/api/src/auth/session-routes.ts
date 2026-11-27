import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { user } from '../../db/schema';
import { recordAudit } from '../audit/record';
import {
  changePasswordRequestSchema,
  sessionResponseSchema,
  unlockRequestSchema,
  type SessionResponse,
} from '../contract';
import { AppError } from '../errors';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';
import { clearSessionCookie, setSessionCookie } from './cookie';
import { assertAccountUnlocked, clearFailures, recordFailure } from './lockout';
import { hashPassword, verifyPassword } from './password';
import { assertNotReused, checkNewPassword, pushPasswordHistory } from './password-policy';
import {
  deleteOtherSessions,
  lockSession,
  rotateSession,
  unlockSession,
  type ActiveSession,
} from './sessions';

const WRONG_PASSWORD = 'Password is incorrect.';
const SIGNED_OUT = 'Sign in to continue.';

/** The guard has run: every route here needs a session. */
function sessionOf(request: FastifyRequest): ActiveSession {
  if (request.auth === null) throw new AppError('unauthenticated', SIGNED_OUT);
  return request.auth;
}

/** The caller's account as stored now. */
function accountOf(deps: ApiDeps, userId: string) {
  const row = deps.db.select().from(user).where(eq(user.id, userId)).get();
  if (!row) throw new AppError('unauthenticated', SIGNED_OUT);
  return row;
}

/**
 * A wrong password from a signed-in session. It counts in the account's run of failures; the
 * failure that locks the account also ended every session of the user, so the cookie is cleared
 * and the answer is 401 `unauthenticated`.
 */
function wrongPassword(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  now: Date,
): AppError {
  const locked = recordFailure(deps, userId, now, request.id, { fromSession: true });
  if (!locked) return new AppError('invalid_credentials', WRONG_PASSWORD);
  clearSessionCookie(reply, deps);
  return new AppError('unauthenticated', SIGNED_OUT);
}

/**
 * `POST /api/session/password`, in the contract's order: body, account lock (429), current
 * password, blocklist, reuse. A change ends every other session of the user and rotates the
 * caller's, so the old cookie and CSRF token stop working.
 */
async function changePassword(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionResponse> {
  const auth = sessionOf(request);
  const body = changePasswordRequestSchema.parse(request.body);
  const now = deps.now();
  const account = accountOf(deps, auth.user.id);
  assertAccountUnlocked(reply, account.lockedUntil, now);
  if (!(await verifyPassword(account.passwordHash, body.currentPassword))) {
    throw wrongPassword(deps, request, reply, account.id, now);
  }
  checkNewPassword(body.newPassword);
  await assertNotReused(deps.db, account.id, account.passwordHash, body.newPassword);
  const passwordHash = await hashPassword(body.newPassword);

  const rotated = deps.db.transaction((tx) => {
    // Another change may have finished while this one was hashing: its password is the current one.
    const current = tx
      .select({ passwordHash: user.passwordHash })
      .from(user)
      .where(eq(user.id, account.id))
      .get();
    if (current?.passwordHash !== account.passwordHash) {
      throw new AppError('invalid_credentials', WRONG_PASSWORD);
    }
    const at = now.toISOString();
    pushPasswordHistory(tx, account.id, account.passwordHash, now);
    tx.update(user)
      .set({
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: at,
        failedSignIns: 0,
        lockedUntil: null,
        updatedAt: at,
      })
      .where(eq(user.id, account.id))
      .run();
    deleteOtherSessions(tx, account.id, auth.id);
    const next = rotateSession(tx, auth.id, now);
    if (next === null) throw new AppError('unauthenticated', SIGNED_OUT);
    recordAudit(tx, {
      at: now,
      actorUserId: account.id,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: account.id,
      before: null,
      after: null,
      requestId: request.id,
    });
    return next;
  });
  setSessionCookie(reply, deps, rotated.token);
  return {
    setupRequired: false,
    user: auth.user,
    csrfToken: rotated.csrfToken,
    locked: false,
    mustChangePassword: false,
    signInNotice: null,
  };
}

/** `POST /api/session/lock`: locks the caller's session; only the first lock is audited. */
function lock(deps: ApiDeps, request: FastifyRequest): void {
  const auth = sessionOf(request);
  const now = deps.now();
  deps.db.transaction((tx) => {
    if (!lockSession(tx, auth.id, now)) return;
    recordAudit(tx, {
      at: now,
      actorUserId: auth.user.id,
      action: 'auth.session_locked',
      entityType: 'user',
      entityId: auth.user.id,
      before: null,
      after: null,
      requestId: request.id,
    });
  });
}

/**
 * `POST /api/session/unlock`: body, account lock (429), password. A right password unlocks the
 * session, moves `last_seen_at` and restarts the run of failures; the cookie is kept, since tabs
 * share it. Only an unlock of a locked session is audited.
 */
async function unlock(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionResponse> {
  const auth = sessionOf(request);
  const body = unlockRequestSchema.parse(request.body);
  const now = deps.now();
  const account = accountOf(deps, auth.user.id);
  assertAccountUnlocked(reply, account.lockedUntil, now);
  if (!(await verifyPassword(account.passwordHash, body.password))) {
    throw wrongPassword(deps, request, reply, account.id, now);
  }
  deps.db.transaction((tx) => {
    clearFailures(tx, account.id);
    if (!unlockSession(tx, auth.id, now)) return;
    recordAudit(tx, {
      at: now,
      actorUserId: account.id,
      action: 'auth.session_unlocked',
      entityType: 'user',
      entityId: account.id,
      before: null,
      after: null,
      requestId: request.id,
    });
  });
  return {
    setupRequired: false,
    user: auth.user,
    csrfToken: auth.csrfToken,
    locked: false,
    mustChangePassword: account.mustChangePassword,
    signInNotice: null,
  };
}

/** The signed-in session's own routes. Registered inside the guarded plugin: each needs a session. */
export function registerSessionRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/api/session/lock', (request, reply) => {
    lock(deps, request);
    return reply.code(204).send();
  });

  app.post('/api/session/unlock', async (request, reply) =>
    respond(sessionResponseSchema, await unlock(deps, request, reply)),
  );

  app.post('/api/session/password', async (request, reply) =>
    respond(sessionResponseSchema, await changePassword(deps, request, reply)),
  );
}
