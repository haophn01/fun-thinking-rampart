import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../routes';

/**
 * The SSP export, `GET /api/ssp/export`. S3 fills this in; until then it registers nothing.
 * Called inside the guarded api plugin, so the guard's hooks apply to every route added here.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- empty until S3 adds the route
export function registerSspRoutes(api: FastifyInstance, deps: ApiDeps): void {}
