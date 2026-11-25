import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../../assessment/repository';
import {
  createDiagramLinkRequestSchema,
  diagramResponseSchema,
  diagramsResponseSchema,
  patchDiagramLinkRequestSchema,
} from '../../contract';
import { AppError } from '../../errors';
import { respond } from '../../respond';
import type { ApiDeps } from '../../routes';
import type { SspDataRoutes } from '../routes';
import {
  createDiagramLink,
  listDiagramLinks,
  patchDiagramLink,
  removeDiagramLink,
} from './repository';

const URL = '/api/ssp/diagrams';
const itemParams = z.object({ id: z.string() });

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/** Diagram links, under `/api/ssp/diagrams`: any signed-in user reads and writes them. */
export const registerDiagramLinkRoutes: SspDataRoutes = (api, deps) => {
  api.get(URL, () => respond(diagramsResponseSchema, { diagrams: listDiagramLinks(deps.db) }));

  api.post(URL, (request, reply) => {
    const body = createDiagramLinkRequestSchema.parse(request.body);
    const diagram = createDiagramLink(deps.db, body, actorOf(request, deps));
    return reply.code(201).send(respond(diagramResponseSchema, { diagram }));
  });

  api.patch(`${URL}/:id`, (request) => {
    const { id } = itemParams.parse(request.params);
    const body = patchDiagramLinkRequestSchema.parse(request.body);
    const diagram = patchDiagramLink(deps.db, id, body, actorOf(request, deps));
    return respond(diagramResponseSchema, { diagram });
  });

  api.delete(`${URL}/:id`, (request, reply) => {
    const { id } = itemParams.parse(request.params);
    removeDiagramLink(deps.db, id, actorOf(request, deps));
    return reply.code(204).send();
  });
};
