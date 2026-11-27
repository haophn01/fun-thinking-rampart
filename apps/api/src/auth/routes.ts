import { randomUUID } from 'node:crypto';
import { catalogKey, loadCatalog } from '@rampart/catalog';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assessment, user } from '../../db/schema';
import { recordAudit } from '../audit/record';
import {
  ERROR_MESSAGES,
  sessionResponseSchema,
  setupRequestSchema,
  signInRequestSchema,
  type SessionResponse,
} from '../contract';
import { AppError } from '../errors';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';
import { getSignInNotice, getSignInNoticeText, noticeDigest } from '../settings/repository';
import { clearSessionCookie, readSessionToken, setSessionCookie } from './cookie';
import { assertAccountUnlocked, clearFailures, recordFailure } from './lockout';
import { hashPassword, verifyPassword } from './password';
import { checkNewPassword } from './password-policy';
import { createSession, deleteSession, deleteSessionByToken, type SessionStore } from './sessions';

const INVALID_CREDENTIALS = 'Email or password is incorrect.';

function setupRequired(db: SessionStore): boolean {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(user)
    .get();
  return (row?.n ?? 0) === 0;
}

/**
 * The digest the sign-in must carry while a notice is set, or null when there is none. A missing
 * or stale digest is refused before anything else is looked at, so it counts no failure.
 */
function acknowledgedDigest(db: SessionStore, sent: string | undefined): string | null {
  const text = getSignInNoticeText(db);
  if (text === null) return null;
  const digest = noticeDigest(text);
  if (sent !== digest) {
    throw new AppError('notice_not_acknowledged', ERROR_MESSAGES.notice_not_acknowledged);
  }
  return digest;
}

async function signIn(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionResponse> {
  const body = signInRequestSchema.parse(request.body);
  acknowledgedDigest(deps.db, body.noticeDigest);
  const now = deps.now();
  const found = deps.db.select().from(user).where(eq(user.email, body.email)).get();
  const account = found?.active === true ? found : undefined;

  assertAccountUnlocked(reply, account?.lockedUntil ?? null, now);
  // Unknown emails and inactive users still pay for a verify, so timing says nothing.
  const matched = await verifyPassword(account?.passwordHash ?? null, body.password);
  if (!account) throw new AppError('invalid_credentials', INVALID_CREDENTIALS);
  if (!matched) {
    recordFailure(deps, account.id, now, request.id);
    throw new AppError('invalid_credentials', INVALID_CREDENTIALS);
  }

  const created = deps.db.transaction((tx) => {
    // Checked again: the notice may have changed while the password was being verified.
    const digest = acknowledgedDigest(tx, body.noticeDigest);
    clearFailures(tx, account.id);
    // No fixation: the cookie's old session, whoever it belonged to, is gone.
    deleteSessionByToken(tx, readSessionToken(request, deps));
    if (digest !== null) {
      recordAudit(tx, {
        at: now,
        actorUserId: account.id,
        action: 'auth.notice_acknowledged',
        entityType: 'user',
        entityId: account.id,
        before: null,
        after: { digest },
        requestId: request.id,
      });
    }
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
    return { session: createSession(tx, account.id, now), signInNotice: getSignInNotice(tx) };
  });
  setSessionCookie(reply, deps, created.session.token);
  return {
    setupRequired: false,
    user: {
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      role: account.role,
    },
    csrfToken: created.session.csrfToken,
    locked: false,
    mustChangePassword: account.mustChangePassword,
    signInNotice: created.signInNotice,
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
  checkNewPassword(body.password);
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
      .values({
        id: userId,
        ...admin,
        passwordHash,
        passwordChangedAt: at,
        createdAt: at,
        updatedAt: at,
      })
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
    // No user existed before setup, so no notice can be set: the settings row needs an author.
    signInNotice: getSignInNotice(deps.db),
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
      locked: request.auth?.locked ?? false,
      mustChangePassword: request.auth?.mustChangePassword ?? false,
      signInNotice: getSignInNotice(deps.db),
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
