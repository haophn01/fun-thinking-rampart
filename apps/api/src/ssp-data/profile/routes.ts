import type { FastifyRequest } from 'fastify';
import type { Actor } from '../../assessment/repository';
import { patchSspProfileRequestSchema, sspProfileResponseSchema } from '../../contract';
import { AppError } from '../../errors';
import { respond } from '../../respond';
import type { ApiDeps } from '../../routes';
import type { SspDataRoutes } from '../routes';
import { patchSspProfile, readSspProfile } from './repository';

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/** The SSP profile, under `/api/ssp/profile`: any signed-in user reads and writes it. */
export const registerSspProfileRoutes: SspDataRoutes = (api, deps) => {
  api.get('/api/ssp/profile', () =>
    respond(sspProfileResponseSchema, { profile: readSspProfile(deps.db) }),
  );

  api.patch('/api/ssp/profile', (request) => {
    const body = patchSspProfileRequestSchema.parse(request.body);
    const profile = patchSspProfile(deps.db, body, actorOf(request, deps));
    return respond(sspProfileResponseSchema, { profile });
  });
};
