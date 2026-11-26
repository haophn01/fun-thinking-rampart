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
import { checkDiagramImage, checkDiagramImages } from './embeddable';

const URL = '/api/ssp/diagrams';
const itemParams = z.object({ id: z.string() });

/**
 * Diagram links, under `/api/ssp/diagrams`: any signed-in user reads and writes them. Every
 * answer's `embeddable` is settled from the file bytes.
 */
export const registerDiagramLinkRoutes: SspDataRoutes = (api, deps) => {
  api.get(URL, async () => {
    const { diagrams } = await checkDiagramImages(deps.db, deps.store, listDiagramLinks(deps.db));
    return respond(diagramsResponseSchema, { diagrams });
  });

  api.post(URL, async (request, reply) => {
    const body = createDiagramLinkRequestSchema.parse(request.body);
    const created = createDiagramLink(deps.db, body, actorOf(request, deps));
    const diagram = await checkDiagramImage(deps.db, deps.store, created);
    return reply.code(201).send(respond(diagramResponseSchema, { diagram }));
  });

  api.patch(`${URL}/:id`, async (request) => {
    const { id } = itemParams.parse(request.params);
    const body = patchDiagramLinkRequestSchema.parse(request.body);
    const patched = patchDiagramLink(deps.db, id, body, actorOf(request, deps));
    const diagram = await checkDiagramImage(deps.db, deps.store, patched);
    return respond(diagramResponseSchema, { diagram });
  });

  api.delete(`${URL}/:id`, (request, reply) => {
    const { id } = itemParams.parse(request.params);
    removeDiagramLink(deps.db, id, actorOf(request, deps));
    return reply.code(204).send();
  });
};
