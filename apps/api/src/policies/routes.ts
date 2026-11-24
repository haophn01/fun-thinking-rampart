import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../routes';

/**
 * The policy routes under `/api/policies`. A6 fills this in; until then it registers nothing.
 * Called inside the guarded api plugin, so the guard's hooks apply to every route added here.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- empty until A6 adds the routes
export function registerPolicyRoutes(api: FastifyInstance, deps: ApiDeps): void {}
