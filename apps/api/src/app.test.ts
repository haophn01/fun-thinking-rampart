import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDb, runMigrations, type DbHandle } from '../db/client';
import { buildApp, type BuildAppOptions } from './app';
import { loadConfig } from './config';
import { errorEnvelopeSchema } from './contract';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ONE_MIB = 1024 * 1024;

const handles: DbHandle[] = [];
const apps: FastifyInstance[] = [];

interface Setup {
  app: FastifyInstance;
  handle: DbHandle;
  logs: Record<string, unknown>[];
}

/** A fresh app on a migrated in-memory DB. `routes` adds test-only routes before it is ready. */
function setup(
  routes: (app: FastifyInstance) => void = () => undefined,
  options: { logLevel?: string } = {},
): Setup {
  const handle = openDb(':memory:');
  runMigrations(handle.db);
  handles.push(handle);
  const logs: Record<string, unknown>[] = [];
  const config = loadConfig({ DATABASE_PATH: ':memory:', LOG_LEVEL: options.logLevel ?? 'silent' });
  const appOptions: BuildAppOptions = {
    config,
    db: handle.db,
    logStream: {
      write(line: string) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  };
  const app = buildApp(appOptions);
  routes(app);
  apps.push(app);
  return { app, handle, logs };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const handle of handles.splice(0)) if (handle.sqlite.open) handle.sqlite.close();
});

function envelope(body: string) {
  return errorEnvelopeSchema.parse(JSON.parse(body));
}

describe('api app', () => {
  it('health reports db state', async () => {
    const { app, handle } = setup();
    const ok = await app.inject({ method: 'GET', url: '/api/health' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^application\/json/);
    expect(ok.json()).toEqual({ status: 'ok', db: 'ok' });

    handle.sqlite.close();
    const down = await app.inject({ method: 'GET', url: '/api/health' });
    expect(down.statusCode).toBe(503);
    const body = envelope(down.body);
    expect(body.error.code).toBe('db_unavailable');
    expect(body.error.requestId).toBe(down.headers['x-request-id']);
    expect(down.body).not.toContain('connection is not open');
  });

  it('not found envelope', async () => {
    const { app } = setup();
    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({ method, url: '/api/nope' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      const body = envelope(response.body);
      expect(body.error.code).toBe('not_found');
      expect(body.error.requestId).toMatch(UUID);
      expect(body.error.requestId).toBe(response.headers['x-request-id']);
    }
  });

  it('body limit', async () => {
    const { app } = setup((instance) => {
      instance.post('/api/test/echo', (request) => ({ size: JSON.stringify(request.body).length }));
    });
    const overhead = JSON.stringify({ data: '' }).length;
    const atLimit = JSON.stringify({ data: 'x'.repeat(ONE_MIB - overhead) });
    expect(atLimit.length).toBe(ONE_MIB);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: atLimit,
    });
    expect(accepted.statusCode).toBe(200);

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: atLimit.replace('"x', '"xx'),
    });
    expect(rejected.statusCode).toBe(413);
    const body = envelope(rejected.body);
    expect(body.error.code).toBe('payload_too_large');
    expect(body.error.requestId).toBe(rejected.headers['x-request-id']);
  });

  it('internal errors do not leak', async () => {
    const { app } = setup((instance) => {
      instance.get('/api/test/boom', () => {
        throw new Error('password=hunter2 at /srv/secret.ts');
      });
      instance.get('/api/test/boom-async', async () => {
        await Promise.resolve();
        throw Object.assign(new TypeError('internal detail'), { statusCode: 500 });
      });
    });
    for (const url of ['/api/test/boom', '/api/test/boom-async']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(500);
      const body = envelope(response.body);
      expect(body).toEqual({
        error: {
          code: 'internal_error',
          message: 'Internal server error',
          requestId: response.headers['x-request-id'],
        },
      });
      expect(response.body).not.toMatch(/hunter2|secret|internal detail|stack|\.ts/);
    }
  });

  it('validation errors use the envelope with zod issues', async () => {
    const { app } = setup((instance) => {
      instance.post('/api/test/validate', (request) =>
        z.object({ name: z.string() }).parse(request.body),
      );
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/test/validate',
      payload: { name: 5 },
    });
    expect(invalid.statusCode).toBe(400);
    const body = envelope(invalid.body);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toEqual([
      expect.objectContaining({ path: ['name'], code: 'invalid_type' }),
    ]);

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/test/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(envelope(malformed.body).error.code).toBe('validation_failed');
  });

  it('request id', async () => {
    const { app } = setup();
    const valid = ['abc-123', 'A'.repeat(64)];
    for (const id of valid) {
      const response = await app.inject({ url: '/api/nope', headers: { 'x-request-id': id } });
      expect(response.headers['x-request-id']).toBe(id);
      expect(envelope(response.body).error.requestId).toBe(id);
    }

    const invalid = ['A'.repeat(65), 'has space', 'under_score', '', 'semi;colon', 'ü'];
    for (const id of invalid) {
      const response = await app.inject({ url: '/api/health', headers: { 'x-request-id': id } });
      expect(response.headers['x-request-id'], JSON.stringify(id)).toMatch(UUID);
    }

    const first = await app.inject({ url: '/api/health' });
    const second = await app.inject({ url: '/api/health' });
    expect(first.headers['x-request-id']).toMatch(UUID);
    expect(second.headers['x-request-id']).toMatch(UUID);
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  it('security headers', async () => {
    const { app } = setup((instance) => {
      instance.get('/api/test/boom', () => {
        throw new Error('boom');
      });
    });
    for (const url of ['/api/health', '/api/nope', '/api/test/boom']) {
      const response = await app.inject({ url });
      const csp = String(response.headers['content-security-policy']);
      expect(csp, url).toContain("default-src 'none'");
      expect(csp, url).toContain("frame-ancestors 'none'");
      expect(response.headers['x-content-type-options'], url).toBe('nosniff');
      expect(response.headers['x-frame-options'], url).toBe('DENY');
      expect(response.headers['x-powered-by'], url).toBeUndefined();
    }
  });

  it('logs are redacted', async () => {
    const { app, logs } = setup(
      (instance) => {
        instance.get('/api/test/cookie', (_request, reply) => {
          void reply.header('set-cookie', 'sid=leaked-session; HttpOnly');
          return { ok: true };
        });
      },
      { logLevel: 'info' },
    );
    const response = await app.inject({
      url: '/api/test/cookie',
      headers: {
        cookie: 'session=s3cret-cookie',
        authorization: 'Bearer t0ken-value',
        'x-request-id': 'redact-check',
      },
    });
    expect(response.statusCode).toBe(200);

    const text = JSON.stringify(logs);
    expect(text).not.toContain('s3cret-cookie');
    expect(text).not.toContain('t0ken-value');
    expect(text).not.toContain('leaked-session');

    const incoming = logs.find((line) => line.msg === 'incoming request') as
      { req: { headers: Record<string, unknown> } } | undefined;
    expect(incoming?.req.headers.cookie).toBe('[Redacted]');
    expect(incoming?.req.headers.authorization).toBe('[Redacted]');
    const completed = logs.find((line) => line.msg === 'request completed') as
      { res: { statusCode: number; headers: Record<string, unknown> } } | undefined;
    expect(completed?.res.statusCode).toBe(200);
    expect(completed?.res.headers['set-cookie']).toBe('[Redacted]');

    // Every line for the request carries its id.
    expect(logs.length).toBeGreaterThanOrEqual(2);
    for (const line of logs) expect(line.requestId).toBe('redact-check');
  });
});
