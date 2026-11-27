import { randomUUID } from 'node:crypto';
import { catalogKey, loadCatalog } from '@rampart/catalog';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assessment, user } from '../../db/schema';
import { recordAudit } from '../audit/record';
import {
  sessionResponseSchema,
  setupRequestSchema,
  signInRequestSchema,
  type SessionResponse,
} from '../contract';
import { AppError } from '../errors';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';
import { clearSessionCookie, readSessionToken, setSessionCookie } from './cookie';
import { hashPassword, verifyPassword } from './password';
import { createSession, deleteSession, deleteSessionByToken, type SessionStore } from './sessions';

/** The 5th consecutive failure locks the account. */
export const MAX_FAILED_SIGN_INS = 5;
export const LOCK_MS = 15 * 60 * 1000;

const INVALID_CREDENTIALS = 'Email or password is incorrect.';

function setupRequired(db: SessionStore): boolean {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(user)
    .get();
  return (row?.n ?? 0) === 0;
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

function isLocked(lockedUntil: string | null, now: Date): boolean {
  return lockedUntil !== null && now.getTime() < Date.parse(lockedUntil);
}

/** Records one failed sign-in on an existing, active account; the 5th in a row locks it. */
function recordFailure(deps: ApiDeps, userId: string, now: Date, requestId: string): void {
  deps.db.transaction((tx) => {
    const current = tx
      .select({ failed: user.failedSignIns, lockedUntil: user.lockedUntil })
      .from(user)
      .where(eq(user.id, userId))
      .get();
    // Locked by a request that finished while this one was hashing: not counted.
    if (!current || isLocked(current.lockedUntil, now)) return;
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
  });
}

async function signIn(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionResponse> {
  const body = signInRequestSchema.parse(request.body);
  const now = deps.now();
  const found = deps.db.select().from(user).where(eq(user.email, body.email)).get();
  const account = found?.active === true ? found : undefined;

  const lockedUntil = account?.lockedUntil ?? null;
  if (lockedUntil !== null && isLocked(lockedUntil, now)) {
    throw tooManyAttempts(reply, lockedUntil, now);
  }
  // Unknown emails and inactive users still pay for a verify, so timing says nothing.
  const matched = await verifyPassword(account?.passwordHash ?? null, body.password);
  if (!account) throw new AppError('invalid_credentials', INVALID_CREDENTIALS);
  if (!matched) {
    recordFailure(deps, account.id, now, request.id);
    throw new AppError('invalid_credentials', INVALID_CREDENTIALS);
  }

  const created = deps.db.transaction((tx) => {
    tx.update(user)
      .set({ failedSignIns: 0, lockedUntil: null })
      .where(eq(user.id, account.id))
      .run();
    // No fixation: the cookie's old session, whoever it belonged to, is gone.
    deleteSessionByToken(tx, readSessionToken(request, deps));
    recordAudit(tx, {
      at: now,
      actorUserId: account.id,
      action: 'auth.signed_in',
      entityType: 'user',
      entityId: account.id,
      before: null,
      after: null,
      requestId: request.id,
    });
    return createSession(tx, account.id, now);
  });
  setSessionCookie(reply, deps, created.token);
  return {
    setupRequired: false,
    user: {
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      role: account.role,
    },
    csrfToken: created.csrfToken,
    locked: false,
    mustChangePassword: false,
    signInNotice: null,
  };
}

async function setup(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionResponse> {
  const body = setupRequestSchema.parse(request.body);
  const complete = () => new AppError('setup_complete', 'Setup is already complete.');
  if (!setupRequired(deps.db)) throw complete();
  const passwordHash = await hashPassword(body.password);
  const now = deps.now();
  const at = now.toISOString();

  const result = deps.db.transaction((tx) => {
    // Checked again inside the transaction, so two racing setups can't both win.
    if (!setupRequired(tx)) throw complete();
    deleteSessionByToken(tx, readSessionToken(request, deps));
    const userId = randomUUID();
    const admin = {
      email: body.email,
      displayName: body.displayName,
      role: 'admin' as const,
      active: true,
    };
    tx.insert(user)
      .values({ id: userId, ...admin, passwordHash, createdAt: at, updatedAt: at })
      .run();
    recordAudit(tx, {
      at: now,
      actorUserId: userId,
      action: 'user.created',
      entityType: 'user',
      entityId: userId,
      before: null,
      after: admin,
      requestId: request.id,
    });

    const existing = tx.select({ id: assessment.id }).from(assessment).limit(1).get();
    if (!existing) {
      const assessmentId = randomUUID();
      const created = {
        type: 'self' as const,
        conditionalStatusDate: null,
        catalogVersion: catalogKey(loadCatalog()),
      };
      tx.insert(assessment)
        .values({ id: assessmentId, ...created, createdAt: at, updatedAt: at })
        .run();
      recordAudit(tx, {
        at: now,
        actorUserId: userId,
        assessmentId,
        action: 'assessment.created',
        entityType: 'assessment',
        entityId: assessmentId,
        before: null,
        after: created,
        requestId: request.id,
      });
    }
    return { userId, session: createSession(tx, userId, now) };
  });

  setSessionCookie(reply, deps, result.session.token);
  return {
    setupRequired: false,
    user: { id: result.userId, email: body.email, displayName: body.displayName, role: 'admin' },
    csrfToken: result.session.csrfToken,
    locked: false,
    mustChangePassword: false,
    signInNotice: null,
  };
}

function signOut(deps: ApiDeps, request: FastifyRequest, reply: FastifyReply): void {
  const auth = request.auth;
  if (auth !== null) {
    deps.db.transaction((tx) => {
      deleteSession(tx, auth.id);
      recordAudit(tx, {
        at: deps.now(),
        actorUserId: auth.user.id,
        action: 'auth.signed_out',
        entityType: 'user',
        entityId: auth.user.id,
        before: null,
        after: null,
        requestId: request.id,
      });
    });
  }
  clearSessionCookie(reply, deps);
}

/** Session status, setup, sign-in and sign-out. All public; the guard still reads the cookie. */
export function registerAuthRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/session', { config: { public: true } }, (request) =>
    respond(sessionResponseSchema, {
      setupRequired: setupRequired(deps.db),
      user: request.auth?.user ?? null,
      csrfToken: request.auth?.csrfToken ?? null,
    }),
  );

  app.post('/api/setup', { config: { public: true, skipCsrf: true } }, async (request, reply) => {
    const body = respond(sessionResponseSchema, await setup(deps, request, reply));
    return reply.code(201).send(body);
  });

  app.post('/api/session', { config: { public: true, skipCsrf: true } }, async (request, reply) =>
    respond(sessionResponseSchema, await signIn(deps, request, reply)),
  );

  app.delete('/api/session', { config: { public: true } }, (request, reply) => {
    signOut(deps, request, reply);
    return reply.code(204).send();
  });
}
