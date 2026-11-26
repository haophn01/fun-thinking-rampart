import { z } from 'zod';
import {
  assetResponseSchema,
  assetsResponseSchema,
  createAssetRequestSchema,
  patchAssetRequestSchema,
} from '../../contract';
import { respond } from '../../respond';
import { actorOf } from '../common';
import type { SspDataRoutes } from '../routes';
import { createAsset, listAssets, patchAsset, removeAsset } from './repository';

const URL = '/api/ssp/assets';
const itemParams = z.object({ id: z.string() });

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
