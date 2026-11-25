import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../../assessment/repository';
import {
  approvalResponseSchema,
  createApprovalRequestSchema,
  createRevisionRequestSchema,
  documentControlSchema,
  patchApprovalRequestSchema,
  revisionResponseSchema,
} from '../../contract';
import { AppError } from '../../errors';
import { respond } from '../../respond';
import type { ApiDeps } from '../../routes';
import type { SspDataRoutes } from '../routes';
import {
  createApproval,
  createRevision,
  loadDocumentControl,
  patchApproval,
  removeApproval,
} from './repository';

const idParams = z.object({ id: z.string() });
const ADMIN_ONLY = { config: { role: 'admin' as const } };

/** The signed-in writer. The guard has already refused a request without a session. */
function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}

/**
 * Document control, under `/api/ssp/document-control`, `/api/ssp/revisions`
 * and `/api/ssp/approvals`. Revisions are append-only (no update or delete route); approvals are
 * admin-only to write.
 */
export const registerDocumentControlRoutes: SspDataRoutes = (api, deps) => {
  api.get('/api/ssp/document-control', () =>
    respond(documentControlSchema, loadDocumentControl(deps.db, deps.now())),
  );

  api.post('/api/ssp/revisions', (request, reply) => {
    const body = createRevisionRequestSchema.parse(request.body);
    const revision = createRevision(deps.db, body, actorOf(request, deps));
    return reply.code(201).send(respond(revisionResponseSchema, { revision }));
  });

  api.post('/api/ssp/approvals', ADMIN_ONLY, (request, reply) => {
    const body = createApprovalRequestSchema.parse(request.body);
    const approval = createApproval(deps.db, body, actorOf(request, deps));
    return reply.code(201).send(respond(approvalResponseSchema, { approval }));
  });

  api.patch('/api/ssp/approvals/:id', ADMIN_ONLY, (request) => {
    const { id } = idParams.parse(request.params);
    const body = patchApprovalRequestSchema.parse(request.body);
    return respond(approvalResponseSchema, {
      approval: patchApproval(deps.db, id, body, actorOf(request, deps)),
    });
  });

  api.delete('/api/ssp/approvals/:id', ADMIN_ONLY, (request, reply) => {
    const { id } = idParams.parse(request.params);
    removeApproval(deps.db, id, actorOf(request, deps));
    return reply.code(204).send();
  });
};
