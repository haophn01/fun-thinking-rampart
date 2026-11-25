import { loadCatalog } from '@rampart/catalog';
import type { FastifyInstance } from 'fastify';
import { exportSsp, type SspSource } from '../../ssp';
import type { AppDb } from '../../db/client';
import { readView } from '../assessment/repository';
import { SSP_CONTENT_TYPE } from '../contract';
import { listEvidence } from '../evidence/repository';
import { readPoamView } from '../poam/repository';
import { listPolicies } from '../policies/repository';
import type { ApiDeps } from '../routes';
import { loadSystemProfile } from '../system-profile/repository';
import { attachmentDisposition } from '../uploads/upload';

/**
 * What the SSP is built from, through the same reads the other routes answer with. They run in
 * one synchronous pass, so no write lands between them. `readView` throws `not_found` first when
 * there is no assessment.
 */
function readSspSource(db: AppDb, now: Date): SspSource {
  const view = readView(db, now);
  return {
    catalog: loadCatalog(),
    profile: loadSystemProfile(db, view.assessment.id),
    view,
    poam: readPoamView(db, now),
    policies: listPolicies(db, {}).items,
    evidence: listEvidence(db),
  };
}

/**
 * The SSP export, `GET /api/ssp/export`: any signed-in user downloads it. It writes nothing and
 * records no audit event. Called inside the guarded api plugin, so the guard's hooks apply.
 */
export function registerSspRoutes(api: FastifyInstance, deps: ApiDeps): void {
  api.get('/api/ssp/export', async (_request, reply) => {
    const now = deps.now();
    const { fileName, bytes } = await exportSsp(readSspSource(deps.db, now), now);
    const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return reply
      .code(200)
      .header('content-type', SSP_CONTENT_TYPE)
      .header('content-disposition', attachmentDisposition(fileName))
      .header('content-length', String(body.length))
      .header('cache-control', 'no-store')
      .send(body);
  });
}
