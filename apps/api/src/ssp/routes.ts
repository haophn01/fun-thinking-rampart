import { loadCatalog } from '@rampart/catalog';
import { SSP_LINT_VERSION, lintSspFrom, type SspLintFinding } from '@rampart/rules';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import {
  embedCandidates,
  exportRevisionDescription,
  exportSsp,
  type SspExport,
  type SspExportEntry,
  type SspSource,
} from '../../ssp';
import type { AppDb } from '../../db/client';
import type { FileStore } from '../../storage';
import { readView } from '../assessment/repository';
import {
  SSP_CONTENT_TYPE,
  SSP_LARGE_IMAGE_BYTES,
  SSP_MAX_EMBEDDED_IMAGES,
  sspFileName,
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
import { actorOf, utcDate } from '../ssp-data/common';
import { checkDiagramImages } from '../ssp-data/diagrams/embeddable';
import { loadDiagramLinks } from '../ssp-data/diagrams/repository';
import { appendExportRevision, loadDocumentControl } from '../ssp-data/document-control/repository';
import { loadSspProfile } from '../ssp-data/profile/repository';
import { loadProviders } from '../ssp-data/providers/repository';
import { loadResponsibilityMatrix } from '../ssp-data/responsibilities/repository';
import { loadSystemRoles, roleTotals } from '../ssp-data/roles/repository';
import { loadSystemProfile } from '../system-profile/repository';
import { attachmentDisposition } from '../uploads/upload';

/**
 * The pre-export check, `GET /api/ssp/lint`: the rules over the same reads the web makes. The
 * reads run in one synchronous pass; `readView` throws `not_found` first with no assessment.
 * Then the diagrams' `embeddable` is settled from their bytes, as `GET /api/ssp/diagrams` does.
 */
export async function readSspLint(
  db: AppDb,
  store: FileStore,
  now: Date,
): Promise<SspLintResponse> {
  const view = readView(db, now);
  const assessmentId = view.assessment.id;
  const assets = loadAssets(db, assessmentId);
  const links = loadDiagramLinks(db, assessmentId);
  const review = loadDocumentControl(db, now);
  const { diagrams } = await checkDiagramImages(db, store, links);
  const findings: SspLintFinding[] = lintSspFrom(
    loadCatalog(),
    { view, assets, diagrams, review },
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

/** The SSP's sources apart from the image bytes and this export's entry, read after them. */
type SspRecords = Omit<SspSource, 'images' | 'exportEntry'>;

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
  };
}

/**
 * The bytes of the links the export may embed, read through the hash-checked evidence read. Only
 * the first `SSP_MAX_EMBEDDED_IMAGES` embeddable, non-CUI files are read, and none that `known`
 * (the embeddable check's reads) already holds. A read the app refuses (a missing or altered
 * file) leaves that link out, so it is referenced, and logs a warning that names the link and no
 * path.
 */
async function readImages(
  db: AppDb,
  store: FileStore,
  links: readonly DiagramLink[],
  known: ReadonlyMap<string, Uint8Array>,
  log: FastifyBaseLogger,
): Promise<Map<string, Uint8Array>> {
  const images = new Map<string, Uint8Array>();
  for (const link of embedCandidates(links, SSP_MAX_EMBEDDED_IMAGES)) {
    if (link.resolved === null) continue;
    const held = known.get(link.id);
    if (held !== undefined) {
      images.set(link.id, held);
      continue;
    }
    try {
      const file = await readFileVersion(db, store, link.evidence.id, link.resolved.version);
      images.set(link.id, file.bytes);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      log.warn(
        { linkId: link.id, errorCode: error.code },
        'SSP export: a diagram image could not be read',
      );
    }
  }
  return images;
}

/**
 * This export's own record-of-changes entry, as the file prints it and the api then stores it:
 * dated the UTC day of `now`, described by the file name, made by the exporter.
 */
function exportEntryOf(profile: SspRecords['profile'], now: Date, madeBy: string): SspExportEntry {
  const date = utcDate(now);
  return {
    date,
    description: exportRevisionDescription(sspFileName(profile.systemIdentifier, date)),
    madeBy,
  };
}

/**
 * Builds the SSP and records it: read the sources and images, render with this export's entry,
 * and only after the render succeeds append that entry (and its `ssp_revision.created` event) in
 * one transaction. A failed read or render throws before anything is written.
 */
async function exportAndRecord(request: FastifyRequest, deps: ApiDeps): Promise<SspExport> {
  const actor = actorOf(request, deps);
  const madeBy = request.auth?.user.displayName ?? '';
  const read = readSspRecords(deps.db, actor.now);
  const checked = await checkDiagramImages(deps.db, deps.store, read.diagrams);
  const records = { ...read, diagrams: checked.diagrams };
  const images = await readImages(
    deps.db,
    deps.store,
    records.diagrams,
    checked.bytes,
    request.log,
  );
  const exportEntry = exportEntryOf(records.profile, actor.now, madeBy);
  const result = await exportSsp({ ...records, images, exportEntry }, actor.now);
  deps.db.transaction((tx) => {
    appendExportRevision(tx, {
      assessmentId: records.view.assessment.id,
      actor,
      description: exportEntry.description,
    });
  });
  return result;
}

/**
 * The SSP export, `GET /api/ssp/export`: any signed-in user downloads it, and each download
 * appends one export entry to the record of changes. The session cookie is `SameSite=Strict`, so
 * a cross-site GET carries no session and can't add one. Called inside the guarded api plugin,
 * so the guard's hooks apply.
 */
export function registerSspRoutes(api: FastifyInstance, deps: ApiDeps): void {
  api.get('/api/ssp/lint', async () =>
    respond(sspLintResponseSchema, await readSspLint(deps.db, deps.store, deps.now())),
  );

  api.get('/api/ssp/export', async (request, reply) => {
    const { fileName, bytes } = await exportAndRecord(request, deps);
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
