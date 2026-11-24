import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDb, type DbHandle } from '../db/client';
import { buildApp } from './app';
import { loadConfig } from './config';
import { ResponseContractError, respond } from './respond';

const itemSchema = z.object({ id: z.string(), count: z.number().int().nonnegative() });

let handle: DbHandle | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  handle?.sqlite.close();
  app = undefined;
  handle = undefined;
});

function appWith(routes: (instance: FastifyInstance) => void): FastifyInstance {
  handle = openDb(':memory:');
  const built = buildApp({
    config: loadConfig({ DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent' }),
    db: handle.db,
  });
  routes(built);
  app = built;
  return built;
}

describe('respond', () => {
  it('rejects off-contract responses', async () => {
    const server = appWith((instance) => {
      // Type-correct but off-contract: a negative count.
      instance.get('/api/test/bad', () => respond(itemSchema, { id: 'a', count: -1 }));
      instance.get('/api/test/good', () => respond(itemSchema, { id: 'a', count: 2 }));
    });

    const bad = await server.inject({ url: '/api/test/bad' });
    expect(bad.statusCode).toBe(500);
    expect(bad.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'Internal server error',
        requestId: bad.headers['x-request-id'],
      },
    });

    const good = await server.inject({ url: '/api/test/good' });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ id: 'a', count: 2 });
  });

  it('strips keys the schema does not declare', () => {
    const payload = { id: 'a', count: 1, passwordHash: 'x' };
    expect(respond(itemSchema, payload)).toEqual({ id: 'a', count: 1 });
    // The input is left as it was.
    expect(payload.passwordHash).toBe('x');
  });

  it('throws ResponseContractError carrying the issues', () => {
    expect(() => respond(itemSchema, { id: 'a', count: 1.5 })).toThrow(ResponseContractError);
    try {
      respond(itemSchema, { id: 'a', count: 1.5 });
    } catch (error) {
      expect((error as ResponseContractError).issues[0]?.path).toEqual(['count']);
    }
  });
});
