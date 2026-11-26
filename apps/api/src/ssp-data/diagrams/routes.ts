import { z } from 'zod';
import {
  createDiagramLinkRequestSchema,
  diagramResponseSchema,
  diagramsResponseSchema,
  patchDiagramLinkRequestSchema,
} from '../../contract';
import { respond } from '../../respond';
import { actorOf } from '../common';
import type { SspDataRoutes } from '../routes';
import {
  createDiagramLink,
  listDiagramLinks,
  patchDiagramLink,
  removeDiagramLink,
} from './repository';

const URL = '/api/ssp/diagrams';
const itemParams = z.object({ id: z.string() });

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
