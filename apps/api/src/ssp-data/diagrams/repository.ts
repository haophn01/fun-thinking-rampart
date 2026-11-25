import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDb } from '../../../db/client';
import { diagramLink, evidenceItem, evidenceVersion } from '../../../db/schema';
import type { Actor } from '../../assessment/repository';
import { recordAudit } from '../../audit/record';
import {
  DIAGRAM_KINDS,
  isEmbeddableImage,
  type CreateDiagramLinkRequest,
  type DiagramLink,
  type PatchDiagramLinkRequest,
  type ResolvedDiagram,
} from '../../contract';
import { AppError } from '../../errors';
import { changedFields, newId, requireAssessmentId, type Reader } from '../common';

type LinkRow = typeof diagramLink.$inferSelect;

/** The fields a link stores and audits. */
type StoredFields = Pick<LinkRow, 'evidenceId' | 'kind' | 'caption' | 'version'>;
/** The stored fields a patch may change: the evidence item never changes. */
const PATCHABLE_FIELDS = ['kind', 'caption', 'version'] as const;

function storedFields(row: StoredFields): StoredFields {
  return { evidenceId: row.evidenceId, kind: row.kind, caption: row.caption, version: row.version };
}

/**
 * Each item's versions, newest first, as a link resolves them. Reads only the version's
 * metadata: never the storage key, and never the file bytes.
 */
function versionsOf(db: Reader, evidenceIds: readonly string[]): Map<string, ResolvedDiagram[]> {
  const byItem = new Map<string, ResolvedDiagram[]>();
  if (evidenceIds.length === 0) return byItem;
  const rows = db
    .select({
      evidenceId: evidenceVersion.evidenceId,
      version: evidenceVersion.version,
      containsCui: evidenceVersion.containsCui,
      fileName: evidenceVersion.fileName,
      size: evidenceVersion.size,
      sha256: evidenceVersion.sha256,
      location: evidenceVersion.referenceLocation,
      createdAt: evidenceVersion.createdAt,
    })
    .from(evidenceVersion)
    .where(inArray(evidenceVersion.evidenceId, [...new Set(evidenceIds)]))
    .all()
    .sort((a, b) => b.version - a.version);
  for (const row of rows) {
    const resolved: ResolvedDiagram = row.containsCui
      ? {
          version: row.version,
          kind: 'reference',
          fileName: null,
          size: null,
          sha256: null,
          location: row.location,
          createdAt: row.createdAt,
        }
      : {
          version: row.version,
          kind: 'file',
          fileName: row.fileName,
          size: row.size,
          sha256: row.sha256,
          location: null,
          createdAt: row.createdAt,
        };
    const list = byItem.get(row.evidenceId) ?? [];
    list.push(resolved);
    byItem.set(row.evidenceId, list);
  }
  return byItem;
}

/** The pinned version, or the newest when `version` is null; null while there is none. */
export function resolveVersion(
  versions: readonly ResolvedDiagram[],
  version: number | null,
): ResolvedDiagram | null {
  if (version === null) return versions[0] ?? null;
  return versions.find((v) => v.version === version) ?? null;
}

/** A picture the export may embed: a file, on an item not flagged CUI, with an image name. */
export function isEmbeddable(resolved: ResolvedDiagram | null, containsCui: boolean): boolean {
  return (
    resolved !== null &&
    resolved.kind === 'file' &&
    !containsCui &&
    resolved.fileName !== null &&
    isEmbeddableImage(resolved.fileName)
  );
}

const KIND_POSITION = new Map<string, number>(DIAGRAM_KINDS.map((k, i) => [k, i]));

/** Kind order, then `createdAt`, then `id`. */
function compareLinks(a: DiagramLink, b: DiagramLink): number {
  const ka = KIND_POSITION.get(a.kind) ?? 0;
  const kb = KIND_POSITION.get(b.kind) ?? 0;
  if (ka !== kb) return ka - kb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function loadLinks(db: Reader, assessmentId: string, id?: string): DiagramLink[] {
  const conditions = [eq(diagramLink.assessmentId, assessmentId), isNull(diagramLink.removedAt)];
  if (id !== undefined) conditions.push(eq(diagramLink.id, id));
  const rows = db
    .select({
      link: diagramLink,
      title: evidenceItem.title,
      containsCui: evidenceItem.containsCui,
    })
    .from(diagramLink)
    .innerJoin(evidenceItem, eq(evidenceItem.id, diagramLink.evidenceId))
    .where(and(...conditions))
    .all();
  const versions = versionsOf(
    db,
    rows.map(({ link }) => link.evidenceId),
  );
  return rows
    .map(({ link, title, containsCui }) => {
      const resolved = resolveVersion(versions.get(link.evidenceId) ?? [], link.version);
      return {
        id: link.id,
        kind: link.kind,
        caption: link.caption,
        evidence: { id: link.evidenceId, title, containsCui },
        version: link.version,
        resolved,
        embeddable: isEmbeddable(resolved, containsCui),
        createdAt: link.createdAt,
        updatedAt: link.updatedAt,
      };
    })
    .sort(compareLinks);
}

/** The live diagram links of an assessment, in export order. An unknown assessment has none. */
export function loadDiagramLinks(db: Reader, assessmentId: string): DiagramLink[] {
  return loadLinks(db, assessmentId);
}

/** `GET /api/ssp/diagrams`. */
export function listDiagramLinks(db: Reader): DiagramLink[] {
  return loadDiagramLinks(db, requireAssessmentId(db));
}

function readLink(db: Reader, assessmentId: string, id: string): DiagramLink {
  const [link] = loadLinks(db, assessmentId, id);
  if (!link) throw new AppError('not_found', 'No such diagram link.');
  return link;
}

/** A live link of the active assessment; 404 when unknown or removed. */
function requireLink(db: Reader, id: string): LinkRow {
  const row = db
    .select()
    .from(diagramLink)
    .where(
      and(
        eq(diagramLink.id, id),
        eq(diagramLink.assessmentId, requireAssessmentId(db)),
        isNull(diagramLink.removedAt),
      ),
    )
    .get();
  if (!row) throw new AppError('not_found', 'No such diagram link.');
  return row;
}

function invalid(path: string, message: string): AppError {
  return new AppError('validation_failed', message, { details: [{ path: [path], message }] });
}

/** 400 on `evidenceId` unless it names an evidence item of the assessment. */
function checkEvidence(db: Reader, assessmentId: string, evidenceId: string): void {
  const row = db
    .select({ id: evidenceItem.id })
    .from(evidenceItem)
    .where(and(eq(evidenceItem.id, evidenceId), eq(evidenceItem.assessmentId, assessmentId)))
    .get();
  if (!row) throw invalid('evidenceId', 'No such evidence item.');
}

/** 400 on `version` when a pinned version doesn't exist on the item. Null always passes. */
function checkVersion(db: Reader, evidenceId: string, version: number | null): void {
  if (version === null) return;
  const row = db
    .select({ version: evidenceVersion.version })
    .from(evidenceVersion)
    .where(and(eq(evidenceVersion.evidenceId, evidenceId), eq(evidenceVersion.version, version)))
    .get();
  if (!row) throw invalid('version', `The evidence item has no version ${String(version)}.`);
}

function audit(actor: Actor, assessmentId: string, id: string) {
  return {
    at: actor.now,
    actorUserId: actor.userId,
    assessmentId,
    entityType: 'diagram_link',
    entityId: id,
    requestId: actor.requestId,
  };
}

/** `POST /api/ssp/diagrams`. Linking the same item twice makes two links. */
export function createDiagramLink(
  db: AppDb,
  body: CreateDiagramLinkRequest,
  actor: Actor,
): DiagramLink {
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    checkEvidence(tx, assessmentId, body.evidenceId);
    checkVersion(tx, body.evidenceId, body.version);
    const id = newId();
    const stamp = actor.now.toISOString();
    const fields = storedFields(body);
    tx.insert(diagramLink)
      .values({
        id,
        assessmentId,
        ...fields,
        createdBy: actor.userId,
        createdAt: stamp,
        updatedBy: actor.userId,
        updatedAt: stamp,
      })
      .run();
    recordAudit(tx, {
      ...audit(actor, assessmentId, id),
      action: 'diagram_link.created',
      before: null,
      after: fields,
    });
    return readLink(tx, assessmentId, id);
  });
}

/** `PATCH /api/ssp/diagrams/:id`: kind, caption and version. Only changes are written. */
export function patchDiagramLink(
  db: AppDb,
  id: string,
  body: PatchDiagramLinkRequest,
  actor: Actor,
): DiagramLink {
  return db.transaction((tx) => {
    const current = requireLink(tx, id);
    const { before, after } = changedFields(storedFields(current), body, PATCHABLE_FIELDS);
    if (Object.keys(after).length > 0) {
      if (after.version !== undefined) checkVersion(tx, current.evidenceId, after.version);
      tx.update(diagramLink)
        .set({ ...after, updatedBy: actor.userId, updatedAt: actor.now.toISOString() })
        .where(eq(diagramLink.id, id))
        .run();
      recordAudit(tx, {
        ...audit(actor, current.assessmentId, id),
        action: 'diagram_link.updated',
        before,
        after,
      });
    }
    return readLink(tx, current.assessmentId, id);
  });
}

/** `DELETE /api/ssp/diagrams/:id`: a soft removal. A removed link is a 404 from then on. */
export function removeDiagramLink(db: AppDb, id: string, actor: Actor): void {
  db.transaction((tx) => {
    const current = requireLink(tx, id);
    const stamp = actor.now.toISOString();
    tx.update(diagramLink)
      .set({ removedAt: stamp, updatedBy: actor.userId, updatedAt: stamp })
      .where(eq(diagramLink.id, id))
      .run();
    recordAudit(tx, {
      ...audit(actor, current.assessmentId, id),
      action: 'diagram_link.removed',
      before: storedFields(current),
      after: null,
    });
  });
}
