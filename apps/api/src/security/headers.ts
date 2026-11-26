import helmet from '@fastify/helmet';
import type { SecuritySeam } from './context';

/**
 * The security headers on every response, 404, 413, 415 and 500 included. Registered on the root
 * before the routes, so even the early 404 carries them.
 */
export const registerSecurityHeaders: SecuritySeam = (app) => {
  // The api serves JSON only, so its CSP allows nothing to load or frame it.
  void app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
  });
};
