import { loadCatalog } from '@rampart/catalog';
import { SSP_LINT_VERSION, lintSspFrom, type SspLintFinding } from '@rampart/rules';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { embedCandidates, exportSsp, type SspSource } from '../../ssp';
import type { AppDb } from '../../db/client';
import type { FileStore } from '../../storage';
import { readView } from '../assessment/repository';
import {
  SSP_CONTENT_TYPE,
  SSP_LARGE_IMAGE_BYTES,
  SSP_MAX_EMBEDDED_IMAGES,
  sspLintResponseSchema,
  type DiagramLink,
  type SspLintResponse,
} from '../contract';
import { AppError } from '../errors';
import { listEvidence, readFileVersion } from '../evidence/repository';
import { readPoamView } from '../poam/repository';
import { listPolicies } from '../policies/repository';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';
import { loadAssets } from '../ssp-data/assets/repository';
import { loadDiagramLinks } from '../ssp-data/diagrams/repository';
import { loadDocumentControl } from '../ssp-data/document-control/repository';
import { loadSspProfile } from '../ssp-data/profile/repository';
import { loadProviders } from '../ssp-data/providers/repository';
import { loadResponsibilityMatrix } from '../ssp-data/responsibilities/repository';
import { loadSystemRoles, roleTotals } from '../ssp-data/roles/repository';
import { loadSystemProfile } from '../system-profile/repository';
import { attachmentDisposition } from '../uploads/upload';

/**
 * The pre-export check, `GET /api/ssp/lint`: the rules over the same reads the web makes. The
 * reads run in one synchronous pass; `readView` throws `not_found` first with no assessment.
 */
export function readSspLint(db: AppDb, now: Date): SspLintResponse {
  const view = readView(db, now);
  const assessmentId = view.assessment.id;
  const findings: SspLintFinding[] = lintSspFrom(
    loadCatalog(),
    {
      view,
      assets: loadAssets(db, assessmentId),
      diagrams: loadDiagramLinks(db, assessmentId),
      review: loadDocumentControl(db, now),
    },
    { maxEmbeddedImages: SSP_MAX_EMBEDDED_IMAGES, largeImageBytes: SSP_LARGE_IMAGE_BYTES },
  );
  return {
    version: SSP_LINT_VERSION,
    findings,
    counts: {
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
    },
  };
}

/** The SSP's sources apart from the image bytes, which are read after them. */
type SspRecords = Omit<SspSource, 'images'>;

/**
 * What the SSP is built from, through the same reads the other routes answer with. They run in
 * one synchronous pass, so no write lands between them. `readView` throws `not_found` first when
 * there is no assessment.
 */
function readSspRecords(db: AppDb, now: Date): SspRecords {
  const view = readView(db, now);
  const assessmentId = view.assessment.id;
  const roles = loadSystemRoles(db, assessmentId);
  return {
    catalog: loadCatalog(),
    profile: loadSystemProfile(db, assessmentId),
    view,
    poam: readPoamView(db, now),
    policies: listPolicies(db, {}).items,
    evidence: listEvidence(db),
    sspProfile: loadSspProfile(db, assessmentId),
    roles,
    roleTotals: roleTotals(roles),
    assets: loadAssets(db, assessmentId),
    providers: loadProviders(db, assessmentId),
    responsibilities: loadResponsibilityMatrix(db, assessmentId).rows,
    diagrams: loadDiagramLinks(db, assessmentId),
    documentControl: loadDocumentControl(db, now),
    maxEmbeddedImages: SSP_MAX_EMBEDDED_IMAGES,
    exportEntry: null,
  };
}

/**
 * The bytes of the links the export may embed, read through the hash-checked evidence read. Only
 * the first `SSP_MAX_EMBEDDED_IMAGES` embeddable, non-CUI files are read. A read the app refuses
 * (a missing or altered file) leaves that link out, so it is referenced, and logs a warning that
 * names the link and no path.
 */
async function readImages(
  db: AppDb,
  store: FileStore,
  links: readonly DiagramLink[],
  log: FastifyBaseLogger,
): Promise<Map<string, Uint8Array>> {
  const images = new Map<string, Uint8Array>();
  for (const link of embedCandidates(links, SSP_MAX_EMBEDDED_IMAGES)) {
    if (link.resolved === null) continue;
    try {
      const file = await readFileVersion(db, store, link.evidence.id, link.resolved.version);
      images.set(link.id, file.bytes);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      log.warn(
        { linkId: link.id, code: error.code },
        'SSP export: a diagram image could not be read',
      );
    }
  }
  return images;
}

/**
 * The SSP export, `GET /api/ssp/export`: any signed-in user downloads it. It writes nothing and
 * records no audit event. Called inside the guarded api plugin, so the guard's hooks apply.
 */
export function registerSspRoutes(api: FastifyInstance, deps: ApiDeps): void {
  api.get('/api/ssp/lint', () => respond(sspLintResponseSchema, readSspLint(deps.db, deps.now())));

  api.get('/api/ssp/export', async (request, reply) => {
    const now = deps.now();
    const records = readSspRecords(deps.db, now);
    const images = await readImages(deps.db, deps.store, records.diagrams, request.log);
    const { fileName, bytes } = await exportSsp({ ...records, images }, now);
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
