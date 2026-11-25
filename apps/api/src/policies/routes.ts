import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../assessment/repository';
import {
  createPolicyRequestSchema,
  patchPolicyRequestSchema,
  policyListSchema,
  policyQuerySchema,
  policyResponseSchema,
  putPolicyRequirementsRequestSchema,
} from '../contract';
import { AppError } from '../errors';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';
import { readUpload, registerUploadBodyParser, sendFile } from '../uploads/upload';
import {
  addPolicyVersion,
  createPolicy,
  listPolicies,
  patchPolicy,
  putPolicyRequirements,
  readPolicyFile,
} from './repository';

const idParams = z.object({ id: z.string() });
const fileParams = z.object({ id: z.string(), version: z.string() });

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/**
 * The policy routes under `/api/policies`: any signed-in user reads and writes them. They live in
 * their own child plugin so the octet-stream upload parser stays here; the guard's hooks from the
 * parent api plugin still run first (401, then 403 `csrf_failed`, before the body is read).
 */
export function registerPolicyRoutes(api: FastifyInstance, deps: ApiDeps): void {
  void api.register(async (scope) => {
    registerUploadBodyParser(scope);

    scope.get('/api/policies', (request) =>
      respond(policyListSchema, listPolicies(deps.db, policyQuerySchema.parse(request.query))),
    );

    scope.post('/api/policies', (request, reply) => {
      const body = createPolicyRequestSchema.parse(request.body);
      const item = createPolicy(deps.db, body, actorOf(request, deps));
      return reply.code(201).send(respond(policyResponseSchema, { item }));
    });

    scope.patch('/api/policies/:id', (request) => {
      const { id } = idParams.parse(request.params);
      const body = patchPolicyRequestSchema.parse(request.body);
      return respond(policyResponseSchema, {
        item: patchPolicy(deps.db, id, body, actorOf(request, deps)),
      });
    });

    scope.put('/api/policies/:id/requirements', (request) => {
      const { id } = idParams.parse(request.params);
      const body = putPolicyRequirementsRequestSchema.parse(request.body);
      return respond(policyResponseSchema, {
        item: putPolicyRequirements(deps.db, id, body, actorOf(request, deps)),
      });
    });

    scope.post('/api/policies/:id/versions', async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const upload = readUpload(request);
      const { item, created } = await addPolicyVersion(
        deps.db,
        deps.store,
        id,
        upload,
        actorOf(request, deps),
      );
      return reply.code(created ? 201 : 200).send(respond(policyResponseSchema, { item }));
    });

    scope.get('/api/policies/:id/versions/:version/file', async (request, reply) => {
      const { id, version } = fileParams.parse(request.params);
      const file = await readPolicyFile(deps.db, deps.store, id, version);
      return sendFile(reply, file.bytes, file.fileName);
    });

    await Promise.resolve();
  });
}
