import rateLimit, { type FastifyRateLimitStore } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import type { SecuritySeam } from './context';

/** Requests per window per client. The effective `max` is `max * config.rateLimitMultiplier`. */
export const RATE_LIMITS = {
  general: { max: 600, windowMs: 60_000 },
  auth: { max: 10, windowMs: 60_000 },
} as const;

/**
 * The routes with the tight `auth` limit, each in a bucket of its own per client. Their requests
 * don't count in the general bucket. Later sprints append their password and MFA routes.
 */
export const AUTH_LIMITED_ROUTES: readonly string[] = [
  'POST /api/setup',
  'POST /api/session',
  'POST /api/session/password',
  'POST /api/session/unlock',
];

export const RATE_LIMITED_MESSAGE = 'Too many requests. Try again later.';

/** Above this many keys, expired windows are swept (at most once a window). */
const SWEEP_AT_KEYS = 10_000;

interface Window {
  count: number;
  startMs: number;
}

/**
 * A fixed-window counter on the app clock, in this process's memory. A window starts at a key's
 * first counted request and ends `timeWindow` later; the next request after that starts a fresh
 * one. Each `child` (one per limiter) is a separate set of buckets.
 */
export function appClockStore(now: () => Date): new () => FastifyRateLimitStore {
  return class AppClockStore implements FastifyRateLimitStore {
    private readonly windows = new Map<string, Window>();
    private lastSweepMs = Number.NEGATIVE_INFINITY;

    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindow: number,
    ): void {
      const nowMs = now().getTime();
      let window = this.windows.get(key);
      if (window === undefined || window.startMs + timeWindow <= nowMs) {
        this.sweep(nowMs, timeWindow);
        window = { count: 0, startMs: nowMs };
        this.windows.set(key, window);
      }
      window.count += 1;
      callback(null, { current: window.count, ttl: window.startMs + timeWindow - nowMs });
    }

    child(): FastifyRateLimitStore {
      return new AppClockStore();
    }

    private sweep(nowMs: number, timeWindow: number): void {
      if (this.windows.size < SWEEP_AT_KEYS || nowMs - this.lastSweepMs < timeWindow) return;
      this.lastSweepMs = nowMs;
      for (const [key, window] of this.windows) {
        if (window.startMs + timeWindow <= nowMs) this.windows.delete(key);
      }
    }
  };
}

/** Whole seconds until the window ends, rounded up, and never 0. */
export function retryAfterSeconds(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

function rateLimited(ttlMs: number): AppError {
  return new AppError('too_many_attempts', RATE_LIMITED_MESSAGE, {
    details: { retryAfterSeconds: retryAfterSeconds(ttlMs) },
  });
}

/** `'<METHOD> <route url>'`, or `null` for a request that matched no route. */
function routeKey(request: FastifyRequest): string | null {
  const url = request.routeOptions.url;
  return url === undefined ? null : `${request.method} ${url}`;
}

type Limiter = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Rate limits on every request, keyed by `request.ip` (the forwarded address only from the local
 * proxy when hosted), on the app clock. One root `onRequest` hook, registered after the security
 * headers and before the early 404 and the routes, so a refused request never reaches the guard,
 * never reads its body and never touches the database. Unknown routes, `/api/health` and static
 * files all count in the general bucket.
 */
export const registerRateLimit: SecuritySeam = (app, ctx) => {
  const multiplier = ctx.config.rateLimitMultiplier;
  void app.register(rateLimit, {
    // No route gets the plugin's own per-route hook: the one hook below decides every request.
    global: false,
    store: appClockStore(ctx.now),
    timeWindow: RATE_LIMITS.general.windowMs,
    max: RATE_LIMITS.general.max * multiplier,
    // The 429 sets Retry-After itself; no other rate-limit headers are sent.
    addHeaders: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
      'retry-after': false,
    },
    addHeadersOnExceeding: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
    },
    errorResponseBuilder: (_request, context) => rateLimited(context.ttl),
  });

  // The plugin's `rateLimit` decorator exists once the plugin has loaded, before any request.
  let limiters: { general: Limiter; auth: Map<string, Limiter> } | undefined;
  function limiterFor(instance: FastifyInstance, request: FastifyRequest): Limiter {
    limiters ??= {
      general: instance.rateLimit() as Limiter,
      auth: new Map(
        AUTH_LIMITED_ROUTES.map((route) => [
          route,
          instance.rateLimit({
            max: RATE_LIMITS.auth.max * multiplier,
            timeWindow: RATE_LIMITS.auth.windowMs,
          }) as Limiter,
        ]),
      ),
    };
    const key = routeKey(request);
    return (key === null ? undefined : limiters.auth.get(key)) ?? limiters.general;
  }

  app.addHook('onRequest', async (request, reply) => {
    try {
      await limiterFor(app, request)(request, reply);
    } catch (error) {
      if (error instanceof AppError && error.code === 'too_many_attempts') {
        const { retryAfterSeconds: seconds } = error.details as { retryAfterSeconds: number };
        void reply.header('retry-after', String(seconds));
      }
      throw error;
    }
  });
};
