import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../../assessment/repository';
import {
  createSystemRoleRequestSchema,
  patchSystemRoleRequestSchema,
  roleResponseSchema,
  rolesResponseSchema,
} from '../../contract';
import { AppError } from '../../errors';
import { respond } from '../../respond';
import type { ApiDeps } from '../../routes';
import type { SspDataRoutes } from '../routes';
import { createSystemRole, listSystemRoles, patchSystemRole, removeSystemRole } from './repository';

const roleParams = z.object({ id: z.string() });

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/**
 * The SSP's system roles, under `/api/ssp/roles`: any signed-in user lists, creates, changes
 * and removes them. Removal is soft.
 */
export const registerSystemRoleRoutes: SspDataRoutes = (api, deps) => {
  api.get('/api/ssp/roles', () => respond(rolesResponseSchema, listSystemRoles(deps.db)));

  api.post('/api/ssp/roles', async (request, reply) => {
    const body = createSystemRoleRequestSchema.parse(request.body);
    const role = createSystemRole(deps.db, body, actorOf(request, deps));
    return reply.code(201).send(respond(roleResponseSchema, { role }));
  });

  api.patch('/api/ssp/roles/:id', (request) => {
    const { id } = roleParams.parse(request.params);
    const body = patchSystemRoleRequestSchema.parse(request.body);
    const role = patchSystemRole(deps.db, id, body, actorOf(request, deps));
    return respond(roleResponseSchema, { role });
  });

  api.delete('/api/ssp/roles/:id', async (request, reply) => {
    const { id } = roleParams.parse(request.params);
    removeSystemRole(deps.db, id, actorOf(request, deps));
    return reply.code(204).send();
  });
};
