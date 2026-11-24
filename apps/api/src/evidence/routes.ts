import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../assessment/repository';
import {
  addReferenceRequestSchema,
  createEvidenceRequestSchema,
  evidenceItemResponseSchema,
  evidenceListSchema,
  evidenceQuerySchema,
  patchEvidenceRequestSchema,
  putEvidenceObjectivesRequestSchema,
} from '../contract';
import { AppError } from '../errors';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';
import { readUpload, registerUploadBodyParser, sendFile } from '../uploads/upload';
import {
  addFileVersion,
  addReference,
  createEvidence,
  listEvidence,
  patchEvidence,
  putEvidenceObjectives,
  readFileVersion,
} from './repository';

const itemParams = z.object({ id: z.string() });
const fileParams = z.object({ id: z.string(), version: z.string() });
const VERSION = /^[1-9][0-9]{0,8}$/;

/** A version in a URL is a whole number from 1; anything else names no version, so 404. */
function versionNumber(raw: string): number {
  if (!VERSION.test(raw)) throw new AppError('not_found', 'No such file version.');
  return Number(raw);
}

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/**
 * The evidence routes under `/api/evidence`, for any signed-in user. They live in their own
 * child plugin so its octet-stream parser reaches only these routes; the guard's hooks from the
 * parent still run first (401, then 403 `csrf_failed`, before any body is read).
 */
export function registerEvidenceRoutes(api: FastifyInstance, deps: ApiDeps): void {
  void api.register((scope, _options, done) => {
    registerUploadBodyParser(scope);

    scope.get('/api/evidence', (request) => {
      const { objectiveId } = evidenceQuerySchema.parse(request.query);
      return respond(evidenceListSchema, { items: listEvidence(deps.db, objectiveId) });
    });

    scope.post('/api/evidence', async (request, reply) => {
      const body = createEvidenceRequestSchema.parse(request.body);
      const item = createEvidence(deps.db, body, actorOf(request, deps));
      return reply.code(201).send(respond(evidenceItemResponseSchema, { item }));
    });

    scope.patch('/api/evidence/:id', (request) => {
      const { id } = itemParams.parse(request.params);
      const body = patchEvidenceRequestSchema.parse(request.body);
      const item = patchEvidence(deps.db, id, body, actorOf(request, deps));
      return respond(evidenceItemResponseSchema, { item });
    });

    scope.put('/api/evidence/:id/objectives', (request) => {
      const { id } = itemParams.parse(request.params);
      const { objectiveIds } = putEvidenceObjectivesRequestSchema.parse(request.body);
      const item = putEvidenceObjectives(deps.db, id, objectiveIds, actorOf(request, deps));
      return respond(evidenceItemResponseSchema, { item });
    });

    scope.post('/api/evidence/:id/versions', async (request, reply) => {
      const { id } = itemParams.parse(request.params);
      const upload = readUpload(request);
      const result = await addFileVersion(deps.db, deps.store, id, upload, actorOf(request, deps));
      return reply
        .code(result.created ? 201 : 200)
        .send(respond(evidenceItemResponseSchema, { item: result.item }));
    });

    scope.post('/api/evidence/:id/references', async (request, reply) => {
      const { id } = itemParams.parse(request.params);
      const body = addReferenceRequestSchema.parse(request.body);
      const result = addReference(deps.db, id, body, actorOf(request, deps));
      return reply
        .code(result.created ? 201 : 200)
        .send(respond(evidenceItemResponseSchema, { item: result.item }));
    });

    scope.get('/api/evidence/:id/versions/:version/file', async (request, reply) => {
      const { id, version } = fileParams.parse(request.params);
      const file = await readFileVersion(deps.db, deps.store, id, versionNumber(version));
      return sendFile(reply, file.bytes, file.fileName);
    });

    done();
  });
}
