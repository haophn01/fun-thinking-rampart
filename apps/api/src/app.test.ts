import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('api app', () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('GET /api/health returns ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
