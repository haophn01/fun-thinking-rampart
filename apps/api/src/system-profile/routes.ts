import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from '../assessment/repository';
import { patchSystemProfileRequestSchema, systemProfileResponseSchema } from '../contract';
import { AppError } from '../errors';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';
import { patchSystemProfile, readSystemProfile } from './repository';

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/** The system profile under `/api/system-profile`: any signed-in user reads and writes it. */
export function registerSystemProfileRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/system-profile', () =>
    respond(systemProfileResponseSchema, { profile: readSystemProfile(deps.db) }),
  );

  app.patch('/api/system-profile', (request) => {
    const body = patchSystemProfileRequestSchema.parse(request.body);
    const profile = patchSystemProfile(deps.db, body, actorOf(request, deps));
    return respond(systemProfileResponseSchema, { profile });
  });
}
