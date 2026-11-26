import type { FastifyInstance } from 'fastify';
import type { Role } from '../contract';

/** One route as the access-control checks see it. */
export interface RouteEntry {
  method: string;
  url: string;
  /** Registered inside the `registerApiRoutes` plugin, so the session guard runs on it. */
  guarded: boolean;
  /** Reachable without a session: unguarded, or guarded with `config: { public: true }`. */
  public: boolean;
  /** `config: { skipCsrf: true }`: a write that needs no CSRF header. */
  skipCsrf: boolean;
  /** `config: { role }`, or null when any signed-in user may call it. */
  role: Role | null;
}

const tables = new WeakMap<FastifyInstance, RouteEntry[]>();
const guardedScopes = new WeakSet<object>();

/** A Fastify child scope inherits from its parent, so the prototype chain names its plugins. */
function insideGuardedScope(scope: object): boolean {
  for (let current: object | null = scope; current !== null;) {
    if (guardedScopes.has(current)) return true;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

/**
 * Captures every route registered on `app` from here on, its child plugins included. Call it
 * first in `buildApp`, before any route exists.
 */
export function registerRouteTable(app: FastifyInstance): void {
  const entries: RouteEntry[] = [];
  /** Each url's GET handler: Fastify's automatic HEAD route reuses it, an explicit HEAD can't. */
  const getHandlers = new Map<string, unknown>();
  tables.set(app, entries);
  app.addHook('onRoute', function capture(route) {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const guarded = insideGuardedScope(this);
    const config = route.config ?? {};
    for (const method of methods) {
      if (method === 'GET') getHandlers.set(route.url, route.handler);
      const automaticHead =
        method === 'HEAD' && methods.length === 1 && getHandlers.get(route.url) === route.handler;
      if (automaticHead) continue;
      entries.push({
        method,
        url: route.url,
        guarded,
        public: !guarded || config.public === true,
        skipCsrf: config.skipCsrf === true,
        role: config.role ?? null,
      });
    }
  });
}

/** Marks the session-guarded plugin, so its routes (and its child plugins' routes) are guarded. */
export function markGuardedScope(scope: FastifyInstance): void {
  guardedScopes.add(scope);
}

const byUrlThenMethod = (a: RouteEntry, b: RouteEntry): number => {
  if (a.url !== b.url) return a.url < b.url ? -1 : 1;
  if (a.method === b.method) return 0;
  return a.method < b.method ? -1 : 1;
};

/**
 * Every route registered on `app`, one entry per method, without Fastify's automatic HEAD
 * routes, sorted by url and then method. Call it once the app is ready.
 */
export function listRoutes(app: FastifyInstance): RouteEntry[] {
  const entries = tables.get(app);
  if (entries === undefined) {
    throw new Error('listRoutes needs an app from buildApp: this one has no route table');
  }
  return entries.map((entry) => ({ ...entry })).sort(byUrlThenMethod);
}
