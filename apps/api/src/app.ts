import Fastify, { type FastifyInstance } from 'fastify';

export interface BuildAppOptions {
  logger?: boolean;
}

/** Builds the API without listening, so tests can drive it with `inject`. */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/api/health', () => ({ status: 'ok' as const }));

  return app;
}
