import { z } from 'zod';
import {
  putResponsibilityRequestSchema,
  responsibilityMatrixSchema,
  responsibilityRowResponseSchema,
} from '../../contract';
import { respond } from '../../respond';
import { actorOf } from '../common';
import type { SspDataRoutes } from '../routes';
import { putResponsibility, readMatrix } from './repository';

const requirementParams = z.object({ requirementId: z.string() });

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
