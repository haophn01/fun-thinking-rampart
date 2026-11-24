import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../routes';

/**
 * The POA&M routes under `/api/poam`. A4 fills this in; until then it registers nothing.
 * Called inside the guarded api plugin, so the guard's hooks apply to every route added here.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- empty until A4 adds the routes
export function registerPoamRoutes(api: FastifyInstance, deps: ApiDeps): void {}
