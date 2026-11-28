import helmet from '@fastify/helmet';
import type { SecuritySeam } from './context';

/**
 * The web app's CSP: everything from its own origin, nothing inline, no `eval`, no `data:`, and
 * no framing. The production build has no inline script or style (`assetsInlineLimit: 0`).
 */
export const WEB_CSP =
  "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; " +
  "form-action 'self'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; " +
  "script-src 'self'; script-src-attr 'none'; style-src 'self'";

/** Hosted pages are https: any stray http subresource is upgraded rather than loaded in clear. */
export const HOSTED_WEB_CSP = `${WEB_CSP}; upgrade-insecure-requests`;

/** The api serves JSON only, so its CSP lets nothing load or frame it (unchanged bytes). */
export const API_CSP =
  "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";

export const PERMISSIONS_POLICY = 'camera=(), geolocation=(), microphone=(), payment=(), usb=()';

const HSTS_MAX_AGE_SECONDS = 31_536_000;

/** True for `/api` and anything under `/api/`, read without the query string. */
export function isApiPath(url: string): boolean {
  const query = url.indexOf('?');
  const path = query === -1 ? url : url.slice(0, query);
  return path === '/api' || path.startsWith('/api/');
}

/** The CSP for a request's raw url: the api's on api paths, the web app's everywhere else. */
export function cspFor(url: string, hosted: boolean): string {
  if (isApiPath(url)) return API_CSP;
  return hosted ? HOSTED_WEB_CSP : WEB_CSP;
}

/**
 * The security headers on every response, 404, 413, 415, 429 and 500 included. Registered on
 * the root before the routes, so even the early 404 carries them.
 */
export const registerSecurityHeaders: SecuritySeam = (app, ctx) => {
  const { hosted } = ctx.config;
  void app.register(helmet, {
    global: true,
    // Set per request below: the CSP depends on the path.
    contentSecurityPolicy: false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    // Locally the app is plain http on 127.0.0.1: HSTS there would pin the browser to https.
    strictTransportSecurity: hosted
      ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true, preload: false }
      : false,
  });

  app.addHook('onRequest', (request, reply, done) => {
    void reply.header('content-security-policy', cspFor(request.url, hosted));
    void reply.header('permissions-policy', PERMISSIONS_POLICY);
    done();
  });
};
