import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../assessment/repository';
import {
  closeoutRequestSchema,
  createPoamItemRequestSchema,
  patchPoamItemRequestSchema,
  poamItemResponseSchema,
  poamViewSchema,
} from '../contract';
import { AppError } from '../errors';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';
import { closeoutPoamItem, createPoamItem, patchPoamItem, readPoamView } from './repository';

const itemParams = z.object({ id: z.string() });

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/**
 * The POA&M routes under `/api/poam`: any signed-in user reads the view and creates and edits
 * items; only admins record a closeout. Called inside the guarded api plugin, so the guard's
 * hooks apply to every route added here.
 */
export function registerPoamRoutes(api: FastifyInstance, deps: ApiDeps): void {
  api.get('/api/poam', () => respond(poamViewSchema, readPoamView(deps.db, deps.now())));

  api.post('/api/poam', async (request, reply) => {
    const body = createPoamItemRequestSchema.parse(request.body);
    const item = createPoamItem(deps.db, body, actorOf(request, deps));
    return reply.code(201).send(respond(poamItemResponseSchema, { item }));
  });

  api.patch('/api/poam/:id', (request) => {
    const { id } = itemParams.parse(request.params);
    const body = patchPoamItemRequestSchema.parse(request.body);
    const item = patchPoamItem(deps.db, id, body, actorOf(request, deps));
    return respond(poamItemResponseSchema, { item });
  });

  api.post('/api/poam/:id/closeout', { config: { role: 'admin' } }, (request) => {
    const { id } = itemParams.parse(request.params);
    const body = closeoutRequestSchema.parse(request.body);
    const item = closeoutPoamItem(deps.db, id, body, actorOf(request, deps));
    return respond(poamItemResponseSchema, { item });
  });
}
