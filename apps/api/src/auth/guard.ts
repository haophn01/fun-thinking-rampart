import type { FastifyInstance } from 'fastify';
import { CSRF_HEADER, type ErrorCode, type Role } from '../contract';
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

export interface AccessCheck {
  method: string;
  auth: ActiveSession | null;
  csrfHeader: unknown;
  public?: boolean | undefined;
  skipCsrf?: boolean | undefined;
  role?: Role | undefined;
}

/**
 * Decides whether a request may reach its handler, in the contract's order: session (401), then
 * CSRF (403 `csrf_failed`), then role (403 `forbidden`). Returns the refusal's code, or null.
 */
export function checkAccess(check: AccessCheck): ErrorCode | null {
  if (check.auth === null) return check.public === true ? null : 'unauthenticated';
  if (WRITE_METHODS.has(check.method) && check.skipCsrf !== true) {
    if (!csrfMatches(check.auth.csrfToken, check.csrfHeader)) return 'csrf_failed';
  }
  if (check.role === 'admin' && check.auth.user.role !== 'admin') return 'forbidden';
  return null;
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  unauthenticated: 'Sign in to continue.',
  csrf_failed: 'The request is missing its CSRF token. Reload the page and try again.',
  forbidden: 'Your role does not allow this.',
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
