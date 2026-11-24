import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import { sql } from 'drizzle-orm';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { DestinationStream } from 'pino';
import type { AppDb } from '../db/client';
import type { Config } from './config';
import { healthResponseSchema } from './contract';
import { AppError, registerEarlyNotFound, registerErrorHandling } from './errors';
import { createLogger } from './logger';
import { respond } from './respond';

/** JSON bodies over 1 MiB are refused with 413. */
export const BODY_LIMIT_BYTES = 1024 * 1024;

const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface BuildAppOptions {
  config: Config;
  db: AppDb;
  /** Where log lines go; stdout when omitted. */
  logStream?: DestinationStream;
}

/** Reuses a well-formed incoming `x-request-id`; anything else gets a fresh UUID. */
export function resolveRequestId(header: string | string[] | undefined): string {
  return typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
}

/** Builds the API without listening, so tests can drive it with `inject`. */
export function buildApp({ config, db, logStream }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger(config.logLevel, logStream),
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: (request) => resolveRequestId(request.headers['x-request-id']),
    bodyLimit: BODY_LIMIT_BYTES,
  });

  app.addHook('onRequest', (request, reply, done) => {
    void reply.header('x-request-id', request.id);
    done();
  });

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
  // Unknown routes answer 404 before the body is read (the test checks helmet still runs).
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

  return app;
}
