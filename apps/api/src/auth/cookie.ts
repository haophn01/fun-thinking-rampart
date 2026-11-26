import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { SESSION_COOKIE } from '../contract';
import type { ApiDeps } from '../routes';
import { SESSION_MAX_AGE_SECONDS } from './sessions';

/**
 * The hosted session cookie. The `__Host-` prefix makes the browser refuse it unless it is
 * Secure, has `Path=/` and no `Domain`, so no other host can set or shadow it.
 */
export const HOSTED_SESSION_COOKIE = '__Host-rampart_session';

/** The only code that names the session cookie: `rampart_session` locally, `__Host-` hosted. */
export function sessionCookieName(config: Config): string {
  return config.hosted ? HOSTED_SESSION_COOKIE : SESSION_COOKIE;
}

/** Hosted adds Secure; clearing uses the same attributes, so the browser matches the cookie. */
function attributes(config: Config) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    ...(config.hosted ? { secure: true } : {}),
  };
}

/** The session token from this mode's cookie only; the other mode's name is never read. */
export function readSessionToken(request: FastifyRequest, deps: ApiDeps): string | undefined {
  return request.cookies[sessionCookieName(deps.config)];
}

export function setSessionCookie(reply: FastifyReply, deps: ApiDeps, token: string): void {
  void reply.setCookie(sessionCookieName(deps.config), token, {
    ...attributes(deps.config),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply, deps: ApiDeps): void {
  void reply.clearCookie(sessionCookieName(deps.config), attributes(deps.config));
}
