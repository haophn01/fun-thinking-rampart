import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  assessmentViewSchema,
  objectiveWriteResponseSchema,
  patchRequirementRequestSchema,
  putObjectiveResultRequestSchema,
  requirementWriteResponseSchema,
  updateAssessmentRequestSchema,
} from '../contract';
import { AppError } from '../errors';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';
import {
  patchRequirement,
  putObjectiveResult,
  readView,
  updateAssessment,
  type Actor,
} from './repository';

const objectiveParams = z.object({ objectiveId: z.string() });
const requirementParams = z.object({ requirementId: z.string() });

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/**
 * The assessment: any signed-in user reads it and writes objective results and requirement
 * state; only admins change its settings. Fastify decodes the URL-encoded objective ID
 * (`3.1.1%5Ba%5D` arrives as `3.1.1[a]`).
 */
export function registerAssessmentRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/assessment', () => respond(assessmentViewSchema, readView(deps.db, deps.now())));

  app.patch('/api/assessment', { config: { role: 'admin' } }, (request) => {
    const body = updateAssessmentRequestSchema.parse(request.body);
    const view = updateAssessment(deps.db, body, actorOf(request, deps));
    return respond(assessmentViewSchema, view);
  });

  app.put('/api/assessment/objectives/:objectiveId', (request) => {
    const { objectiveId } = objectiveParams.parse(request.params);
    const body = putObjectiveResultRequestSchema.parse(request.body);
    const result = putObjectiveResult(deps.db, objectiveId, body, actorOf(request, deps));
    return respond(objectiveWriteResponseSchema, result);
  });

  app.patch('/api/assessment/requirements/:requirementId', (request) => {
    const { requirementId } = requirementParams.parse(request.params);
    const body = patchRequirementRequestSchema.parse(request.body);
    const result = patchRequirement(deps.db, requirementId, body, actorOf(request, deps));
    return respond(requirementWriteResponseSchema, result);
  });
}
