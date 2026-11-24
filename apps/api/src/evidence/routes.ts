import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../routes';

/**
 * The evidence routes under `/api/evidence`. A5 fills this in; until then it registers nothing.
 * Called inside the guarded api plugin, so the guard's hooks apply to every route added here.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- empty until A5 adds the routes
export function registerEvidenceRoutes(api: FastifyInstance, deps: ApiDeps): void {}
