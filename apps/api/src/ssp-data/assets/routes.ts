import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../../assessment/repository';
import {
  assetResponseSchema,
  assetsResponseSchema,
  createAssetRequestSchema,
  patchAssetRequestSchema,
} from '../../contract';
import { AppError } from '../../errors';
import { respond } from '../../respond';
import type { ApiDeps } from '../../routes';
import type { SspDataRoutes } from '../routes';
import { createAsset, listAssets, patchAsset, removeAsset } from './repository';

const URL = '/api/ssp/assets';
const itemParams = z.object({ id: z.string() });

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/** Assets, under `/api/ssp/assets`: any signed-in user reads and writes them. */
export const registerAssetRoutes: SspDataRoutes = (api, deps) => {
  api.get(URL, () => respond(assetsResponseSchema, { assets: listAssets(deps.db) }));

  api.post(URL, (request, reply) => {
    const body = createAssetRequestSchema.parse(request.body);
    const asset = createAsset(deps.db, body, actorOf(request, deps));
    return reply.code(201).send(respond(assetResponseSchema, { asset }));
  });

  api.patch(`${URL}/:id`, (request) => {
    const { id } = itemParams.parse(request.params);
    const body = patchAssetRequestSchema.parse(request.body);
    const asset = patchAsset(deps.db, id, body, actorOf(request, deps));
    return respond(assetResponseSchema, { asset });
  });

  api.delete(`${URL}/:id`, (request, reply) => {
    const { id } = itemParams.parse(request.params);
    removeAsset(deps.db, id, actorOf(request, deps));
    return reply.code(204).send();
  });
};
