import { patchSspProfileRequestSchema, sspProfileResponseSchema } from '../../contract';
import { respond } from '../../respond';
import { actorOf } from '../common';
import type { SspDataRoutes } from '../routes';
import { patchSspProfile, readSspProfile } from './repository';

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
