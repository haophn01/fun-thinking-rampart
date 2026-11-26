import type { SecuritySeam } from './context';

/**
 * Rate limits on every request, keyed by `request.ip`, on the app clock. Registered on the root
 * after the security headers and before the routes, so a refused request never reaches the guard.
 * A seam for now: the limits themselves come with `@fastify/rate-limit`.
 */
export const registerRateLimit: SecuritySeam = () => {
  // Filled in with @fastify/rate-limit.
};
