import { z } from 'zod';
import {
  createServiceProviderRequestSchema,
  patchServiceProviderRequestSchema,
  providerResponseSchema,
  providersResponseSchema,
} from '../../contract';
import { respond } from '../../respond';
import { actorOf } from '../common';
import type { SspDataRoutes } from '../routes';
import { createProvider, listProviders, patchProvider, removeProvider } from './repository';

const idParams = z.object({ id: z.string() });

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
