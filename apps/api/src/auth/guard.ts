import type { FastifyInstance } from 'fastify';
import { CSRF_HEADER, ERROR_MESSAGES, type ErrorCode, type Role } from '../contract';
import { AppError } from '../errors';
import type { ApiDeps } from '../routes';
import { readSessionToken } from './cookie';
import { csrfMatches, resolveSession, type ActiveSession } from './sessions';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Reachable without a session (session status, setup, sign-in, sign-out). */
    public?: boolean;
    /** Setup and sign-in: no session to hold a token, so they rely on JSON-only + SameSite. */
    skipCsrf?: boolean;
    /** The role the route needs; any signed-in user when omitted. */
    role?: Role;
  }
  interface FastifyRequest {
    /** The request's live session, or null. Set by the guard before anything else runs. */
    auth: ActiveSession | null;
  }
}

const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The only guarded routes a locked session reaches. sec-mfa appends to it. */
export const LOCKED_SESSION_ROUTES: readonly string[] = [
  'POST /api/session/lock',
  'POST /api/session/unlock',
];

/** The session's two-step routes: enroll, confirm and verify. */
const MFA_SESSION_ROUTES: readonly string[] = [
  'POST /api/session/mfa/enroll',
  'POST /api/session/mfa/enroll/confirm',
  'POST /api/session/mfa/verify',
];

/** The only guarded routes a session reaches before its MFA step (`mfa` not `none`). */
export const MFA_ROUTES: readonly string[] = [...LOCKED_SESSION_ROUTES, ...MFA_SESSION_ROUTES];

/**
 * The only guarded routes a user with a temporary password reaches. The MFA routes are on it, so
 * such a user enrolls first and then changes the password.
 */
export const PASSWORD_CHANGE_ROUTES: readonly string[] = [
  ...LOCKED_SESSION_ROUTES,
  'POST /api/session/password',
  ...MFA_SESSION_ROUTES,
];

export interface AccessCheck {
  method: string;
  /** `'<METHOD> <route url>'`, as the pinned route lists name it. */
  route: string;
  auth: ActiveSession | null;
  csrfHeader: unknown;
  public?: boolean | undefined;
  skipCsrf?: boolean | undefined;
  role?: Role | undefined;
}

/**
 * Decides whether a request may reach its handler, in the contract's order: session (401), then
 * CSRF (403 `csrf_failed`), then lock (423 `session_locked`), then the MFA step (403
 * `mfa_required`), then a required password change (403 `password_change_required`), then role
 * (403 `forbidden`). Public routes are never gated by lock, MFA or a password change. Returns the
 * refusal's code, or null.
 */
export function checkAccess(check: AccessCheck): ErrorCode | null {
  const { auth } = check;
  if (auth === null) return check.public === true ? null : 'unauthenticated';
  if (WRITE_METHODS.has(check.method) && check.skipCsrf !== true) {
    if (!csrfMatches(auth.csrfToken, check.csrfHeader)) return 'csrf_failed';
  }
  if (check.public === true) return null;
  if (auth.locked && !LOCKED_SESSION_ROUTES.includes(check.route)) return 'session_locked';
  if (auth.mfa !== 'none' && !MFA_ROUTES.includes(check.route)) return 'mfa_required';
  if (auth.mustChangePassword && !PASSWORD_CHANGE_ROUTES.includes(check.route)) {
    return 'password_change_required';
  }
  if (check.role === 'admin' && auth.user.role !== 'admin') return 'forbidden';
  return null;
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  unauthenticated: 'Sign in to continue.',
  csrf_failed: 'The request is missing its CSRF token. Reload the page and try again.',
  forbidden: 'Your role does not allow this.',
  ...ERROR_MESSAGES,
};

/**
 * Deny by default: every route registered in the same plugin needs a session unless it sets
 * `config: { public: true }`. Register it inside an encapsulated plugin so health and unknown
 * routes, which live on the root, never reach it.
 */
export function registerGuard(app: FastifyInstance, deps: ApiDeps): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', (request, _reply, done) => {
    try {
      const config = request.routeOptions.config;
      request.auth = resolveSession(deps.db, readSessionToken(request, deps), deps.now());
      const refusal = checkAccess({
        method: request.method,
        route: `${request.method} ${request.routeOptions.url ?? ''}`,
        auth: request.auth,
        csrfHeader: request.headers[CSRF_HEADER],
        public: config.public,
        skipCsrf: config.skipCsrf,
        role: config.role,
      });
      if (refusal !== null) throw new AppError(refusal, MESSAGES[refusal] ?? refusal);
    } catch (error) {
      done(error as Error);
      return;
    }
    done();
  });
}
