import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../../assessment/repository';
import {
  putResponsibilityRequestSchema,
  responsibilityMatrixSchema,
  responsibilityRowResponseSchema,
} from '../../contract';
import { AppError } from '../../errors';
import { respond } from '../../respond';
import type { ApiDeps } from '../../routes';
import type { SspDataRoutes } from '../routes';
import { putResponsibility, readMatrix } from './repository';

const requirementParams = z.object({ requirementId: z.string() });

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/**
 * The responsibility matrix, under `/api/ssp/responsibilities`: any signed-in user reads it and
 * sets a requirement's row.
 */
export const registerResponsibilityRoutes: SspDataRoutes = (api, deps) => {
  api.get('/api/ssp/responsibilities', () =>
    respond(responsibilityMatrixSchema, readMatrix(deps.db)),
  );

  api.put('/api/ssp/responsibilities/:requirementId', (request) => {
    const { requirementId } = requirementParams.parse(request.params);
    const body = putResponsibilityRequestSchema.parse(request.body);
    return respond(responsibilityRowResponseSchema, {
      row: putResponsibility(deps.db, requirementId, body, actorOf(request, deps)),
    });
  });
};
