import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../../assessment/repository';
import {
  createServiceProviderRequestSchema,
  patchServiceProviderRequestSchema,
  providerResponseSchema,
  providersResponseSchema,
} from '../../contract';
import { AppError } from '../../errors';
import { respond } from '../../respond';
import type { ApiDeps } from '../../routes';
import type { SspDataRoutes } from '../routes';
import { createProvider, listProviders, patchProvider, removeProvider } from './repository';

const idParams = z.object({ id: z.string() });

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/** Service providers, under `/api/ssp/providers`: any signed-in user reads and writes them. */
export const registerServiceProviderRoutes: SspDataRoutes = (api, deps) => {
  api.get('/api/ssp/providers', () =>
    respond(providersResponseSchema, { providers: listProviders(deps.db) }),
  );

  api.post('/api/ssp/providers', (request, reply) => {
    const body = createServiceProviderRequestSchema.parse(request.body);
    const provider = createProvider(deps.db, body, actorOf(request, deps));
    return reply.code(201).send(respond(providerResponseSchema, { provider }));
  });

  api.patch('/api/ssp/providers/:id', (request) => {
    const { id } = idParams.parse(request.params);
    const body = patchServiceProviderRequestSchema.parse(request.body);
    return respond(providerResponseSchema, {
      provider: patchProvider(deps.db, id, body, actorOf(request, deps)),
    });
  });

  api.delete('/api/ssp/providers/:id', (request, reply) => {
    const { id } = idParams.parse(request.params);
    removeProvider(deps.db, id, actorOf(request, deps));
    return reply.code(204).send();
  });
};
