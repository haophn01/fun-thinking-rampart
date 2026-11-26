import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { DestinationStream } from 'pino';
import type { AppDb } from '../db/client';
import { createLocalStore, type FileStore } from '../storage';
import type { Config } from './config';
import { healthResponseSchema } from './contract';
import { AppError, registerEarlyNotFound, registerErrorHandling } from './errors';
import { createLogger } from './logger';
import { respond } from './respond';
import { registerApiRoutes } from './routes';
import type { SecurityContext } from './security/context';
import { registerSecurityHeaders } from './security/headers';
import { registerRateLimit } from './security/rate-limit';
import { registerWebApp } from './security/web-app';

/** JSON bodies over 1 MiB are refused with 413. */
export const BODY_LIMIT_BYTES = 1024 * 1024;

const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface BuildAppOptions {
  config: Config;
  db: AppDb;
  /** Where log lines go; stdout when omitted. */
  logStream?: DestinationStream;
  /** The app clock; the real one when omitted. Tests pass a clock they can move. */
  now?: () => Date;
  /** Where uploaded files live; a local store at `config.storagePath` when omitted. */
  store?: FileStore;
}

/** Reuses a well-formed incoming `x-request-id`; anything else gets a fresh UUID. */
export function resolveRequestId(header: string | string[] | undefined): string {
  return typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
}

/**
 * Builds the API without listening, so tests can drive it with `inject`. The order below is the
 * request order: each security part lives in its own file under `security/`, so changing one
 * never edits this function.
 */
export function buildApp({
  config,
  db,
  logStream,
  now = () => new Date(),
  store = createLocalStore(config.storagePath),
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger(config.logLevel, logStream),
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: (request) => resolveRequestId(request.headers['x-request-id']),
    bodyLimit: BODY_LIMIT_BYTES,
    // Hosted, only the single local reverse proxy's X-Forwarded-For is honoured. Locally the
    // header never changes request.ip.
    trustProxy: config.hosted ? '127.0.0.1' : false,
  });
  const ctx: SecurityContext = { config, now };

  app.addHook('onRequest', (request, reply, done) => {
    void reply.header('x-request-id', request.id);
    done();
  });

  registerSecurityHeaders(app, ctx);
  // Before the routes and the guard, so a flood gets 429 and never touches the database.
  registerRateLimit(app, ctx);

  // Unknown routes answer 404 before the body is read (the test checks the headers still run).
  registerEarlyNotFound(app);

  // JSON is the only body the api reads: anything else is 415 before a handler runs, so a
  // cross-site form post (text/plain, urlencoded, multipart) can never reach one.
  app.removeContentTypeParser('text/plain');
  registerErrorHandling(app);

  app.get('/api/health', () => {
    try {
      db.get(sql`select 1`);
    } catch (error) {
      throw new AppError('db_unavailable', 'The database is not available', { cause: error });
    }
    return respond(healthResponseSchema, { status: 'ok', db: 'ok' });
  });

  // Everything else under /api needs a session unless the route says it is public.
  registerApiRoutes(app, { config, db, now, store });

  // Last, so the api routes always win over the web app's fallback.
  registerWebApp(app, ctx);

  return app;
}
