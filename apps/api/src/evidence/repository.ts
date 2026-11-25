import { randomUUID } from 'node:crypto';
import { loadCatalog, type ObjectiveId } from '@rampart/catalog';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { AppDb } from '../../db/client';
import { evidenceItem, evidenceLink, evidenceVersion, user } from '../../db/schema';
import { StorageError, sha256Hex, type FileStore } from '../../storage';
import { findActiveAssessment, type Actor } from '../assessment/repository';
import { recordAudit } from '../audit/record';
import {
  FILE_INTEGRITY_MESSAGE,
  type AddReferenceRequest,
  type CreateEvidenceRequest,
  type EvidenceItem,
  type EvidenceVersion,
  type PatchEvidenceRequest,
} from '../contract';
import { AppError } from '../errors';
import type { Upload } from '../uploads/upload';

/** The app's database or a transaction inside it, for reads. */
type Reader = Pick<AppDb, 'select'>;
type ItemRow = typeof evidenceItem.$inferSelect;

/** A write's result: `created` is false for an identical repeat that changed nothing. */
export interface VersionResult {
  item: EvidenceItem;
  created: boolean;
}

let objectivePositions: ReadonlyMap<ObjectiveId, number> | undefined;

/** Each catalog objective's position, so link lists come back in catalog order. */
function positions(): ReadonlyMap<ObjectiveId, number> {
  if (objectivePositions) return objectivePositions;
  const map = new Map<ObjectiveId, number>();
  for (const requirement of loadCatalog().requirements) {
    for (const objective of requirement.objectives) map.set(objective.id, map.size);
  }
  objectivePositions = map;
  return map;
}

/** `true` when the catalog has this objective. */
export function isCatalogObjective(id: string): boolean {
  return positions().has(id);
}

/**
 * The set of objective IDs, deduplicated and in catalog order. Throws 400 `validation_failed`
 * with one issue per unknown ID (each naming it in `objectiveId`).
 */
export function normalizeObjectiveIds(ids: readonly string[]): ObjectiveId[] {
  const known = positions();
  const unknown = ids
    .map((objectiveId, index) => ({ objectiveId, index }))
    .filter(({ objectiveId }) => !known.has(objectiveId));
  if (unknown.length > 0) {
    throw new AppError('validation_failed', 'Some objective IDs are not in the catalog.', {
      details: unknown.map(({ objectiveId, index }) => ({
        path: ['objectiveIds', index],
        message: `${objectiveId} is not in the catalog`,
        objectiveId,
      })),
    });
  }
  return [...new Set(ids)].sort((a, b) => (known.get(a) ?? 0) - (known.get(b) ?? 0));
}

function activeAssessmentId(db: Reader): string {
  const row = findActiveAssessment(db);
  if (!row) throw new AppError('not_found', 'There is no assessment yet. Run setup first.');
  return row.id;
}

function requireItem(db: Reader, id: string): ItemRow {
  const row = db
    .select()
    .from(evidenceItem)
    .where(and(eq(evidenceItem.id, id), eq(evidenceItem.assessmentId, activeAssessmentId(db))))
    .get();
  if (!row) throw new AppError('not_found', 'No such evidence item.');
  return row;
}

function linkedObjectives(db: Reader, id: string): ObjectiveId[] {
  const rows = db
    .select({ objectiveId: evidenceLink.objectiveId })
    .from(evidenceLink)
    .where(eq(evidenceLink.evidenceId, id))
    .all();
  const known = positions();
  return rows
    .map((r) => r.objectiveId)
    .sort((a, b) => (known.get(a) ?? Infinity) - (known.get(b) ?? Infinity));
}

const versionAuthor = alias(user, 'version_author');

function versionsOf(db: Reader, ids: readonly string[]): Map<string, EvidenceVersion[]> {
  const byItem = new Map<string, EvidenceVersion[]>();
  if (ids.length === 0) return byItem;
  const rows = db
    .select({ row: evidenceVersion, authorName: versionAuthor.displayName })
    .from(evidenceVersion)
    .innerJoin(versionAuthor, eq(versionAuthor.id, evidenceVersion.createdBy))
    .where(inArray(evidenceVersion.evidenceId, [...ids]))
    .orderBy(desc(evidenceVersion.version))
    .all();
  for (const { row, authorName } of rows) {
    const common = {
      version: row.version,
      createdAt: row.createdAt,
      createdBy: { id: row.createdBy, displayName: authorName },
    };
    const version: EvidenceVersion = row.containsCui
      ? {
          kind: 'reference',
          ...common,
          location: row.referenceLocation ?? '',
          note: row.referenceNote,
        }
      : {
          kind: 'file',
          ...common,
          fileName: row.fileName ?? '',
          size: row.size ?? 0,
          sha256: row.sha256 ?? '',
        };
    const list = byItem.get(row.evidenceId) ?? [];
    list.push(version);
    byItem.set(row.evidenceId, list);
  }
  return byItem;
}

function linksOf(db: Reader, ids: readonly string[]): Map<string, ObjectiveId[]> {
  const byItem = new Map<string, ObjectiveId[]>();
  if (ids.length === 0) return byItem;
  const known = positions();
  const rows = db
    .select()
    .from(evidenceLink)
    .where(inArray(evidenceLink.evidenceId, [...ids]))
    .all()
    .sort(
      (a, b) => (known.get(a.objectiveId) ?? Infinity) - (known.get(b.objectiveId) ?? Infinity),
    );
  for (const { evidenceId, objectiveId } of rows) {
    const list = byItem.get(evidenceId) ?? [];
    list.push(objectiveId);
    byItem.set(evidenceId, list);
  }
  return byItem;
}

/** Title (case-insensitive), then `createdAt`, then `id`. */
function compareItems(a: EvidenceItem, b: EvidenceItem): number {
  const ta = a.title.toLowerCase();
  const tb = b.title.toLowerCase();
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function loadItems(db: Reader, filter: { id?: string; objectiveId?: string }): EvidenceItem[] {
  const assessmentId = activeAssessmentId(db);
  const conditions = [eq(evidenceItem.assessmentId, assessmentId)];
  if (filter.id !== undefined) conditions.push(eq(evidenceItem.id, filter.id));
  if (filter.objectiveId !== undefined) {
    const linked = db
      .select({ id: evidenceLink.evidenceId })
      .from(evidenceLink)
      .where(eq(evidenceLink.objectiveId, filter.objectiveId));
    conditions.push(inArray(evidenceItem.id, linked));
  }
  const rows = db
    .select({ row: evidenceItem, creatorName: user.displayName })
    .from(evidenceItem)
    .innerJoin(user, eq(user.id, evidenceItem.createdBy))
    .where(and(...conditions))
    .all();
  const ids = rows.map(({ row }) => row.id);
  const versions = versionsOf(db, ids);
  const links = linksOf(db, ids);
  return rows
    .map(({ row, creatorName }) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      containsCui: row.containsCui,
      objectiveIds: links.get(row.id) ?? [],
      versions: versions.get(row.id) ?? [],
      createdAt: row.createdAt,
      createdBy: { id: row.createdBy, displayName: creatorName },
      updatedAt: row.updatedAt,
    }))
    .sort(compareItems);
}

function readItem(db: Reader, id: string): EvidenceItem {
  const [item] = loadItems(db, { id });
  if (!item) throw new AppError('not_found', 'No such evidence item.');
  return item;
}

/** `GET /api/evidence`. An `objectiveId` not in the catalog is a 400. */
export function listEvidence(db: Reader, objectiveId?: string): EvidenceItem[] {
  if (objectiveId !== undefined && !isCatalogObjective(objectiveId)) {
    throw new AppError('validation_failed', `${objectiveId} is not in the catalog.`, {
      details: [{ path: ['objectiveId'], message: 'Not in the catalog' }],
    });
  }
  return loadItems(db, objectiveId === undefined ? {} : { objectiveId });
}

function audit(actor: Actor, assessmentId: string, id: string) {
  return {
    at: actor.now,
    actorUserId: actor.userId,
    assessmentId,
    entityType: 'evidence_item',
    entityId: id,
    requestId: actor.requestId,
  };
}

/** `POST /api/evidence`. The CUI flag is fixed from here on. */
export function createEvidence(db: AppDb, body: CreateEvidenceRequest, actor: Actor): EvidenceItem {
  const objectiveIds = normalizeObjectiveIds(body.objectiveIds);
  return db.transaction((tx) => {
    const assessmentId = activeAssessmentId(tx);
    const id = randomUUID();
    const stamp = actor.now.toISOString();
    tx.insert(evidenceItem)
      .values({
        id,
        assessmentId,
        title: body.title,
        description: body.description,
        containsCui: body.containsCui,
        createdBy: actor.userId,
        createdAt: stamp,
        updatedBy: actor.userId,
        updatedAt: stamp,
      })
      .run();
    if (objectiveIds.length > 0) {
      tx.insert(evidenceLink)
        .values(objectiveIds.map((objectiveId) => ({ evidenceId: id, objectiveId })))
        .run();
    }
    recordAudit(tx, {
      ...audit(actor, assessmentId, id),
      action: 'evidence.created',
      before: null,
      after: {
        title: body.title,
        description: body.description,
        containsCui: body.containsCui,
        objectiveIds,
      },
    });
    return readItem(tx, id);
  });
}

function touch(tx: Pick<AppDb, 'update'>, id: string, actor: Actor): void {
  tx.update(evidenceItem)
    .set({ updatedBy: actor.userId, updatedAt: actor.now.toISOString() })
    .where(eq(evidenceItem.id, id))
    .run();
}

/** `PATCH /api/evidence/:id`: title and description. Only changed fields are written and audited. */
export function patchEvidence(
  db: AppDb,
  id: string,
  body: PatchEvidenceRequest,
  actor: Actor,
): EvidenceItem {
  return db.transaction((tx) => {
    const current = requireItem(tx, id);
    const before: Record<string, string | null> = {};
    const after: Record<string, string | null> = {};
    if (body.title !== undefined && body.title !== current.title) {
      before.title = current.title;
      after.title = body.title;
    }
    if (body.description !== undefined && body.description !== current.description) {
      before.description = current.description;
      after.description = body.description;
    }
    if (Object.keys(after).length > 0) {
      tx.update(evidenceItem).set(after).where(eq(evidenceItem.id, id)).run();
      touch(tx, id, actor);
      recordAudit(tx, {
        ...audit(actor, current.assessmentId, id),
        action: 'evidence.updated',
        before,
        after,
      });
    }
    return readItem(tx, id);
  });
}

/** `PUT /api/evidence/:id/objectives`: replaces the set. The same set again writes nothing. */
export function putEvidenceObjectives(
  db: AppDb,
  id: string,
  ids: readonly string[],
  actor: Actor,
): EvidenceItem {
  const next = normalizeObjectiveIds(ids);
  return db.transaction((tx) => {
    const current = requireItem(tx, id);
    const previous = linkedObjectives(tx, id);
    const same = previous.length === next.length && previous.every((o, i) => o === next[i]);
    if (!same) {
      tx.delete(evidenceLink).where(eq(evidenceLink.evidenceId, id)).run();
      if (next.length > 0) {
        tx.insert(evidenceLink)
          .values(next.map((objectiveId) => ({ evidenceId: id, objectiveId })))
          .run();
      }
      touch(tx, id, actor);
      recordAudit(tx, {
        ...audit(actor, current.assessmentId, id),
        action: 'evidence.links_updated',
        before: { objectiveIds: previous },
        after: { objectiveIds: next },
      });
    }
    return readItem(tx, id);
  });
}

type VersionRow = typeof evidenceVersion.$inferSelect;

function newestVersion(db: Reader, id: string): VersionRow | undefined {
  return db
    .select()
    .from(evidenceVersion)
    .where(eq(evidenceVersion.evidenceId, id))
    .orderBy(desc(evidenceVersion.version))
    .limit(1)
    .get();
}

function nextVersion(db: Reader, id: string): number {
  const row = db
    .select({ top: max(evidenceVersion.version) })
    .from(evidenceVersion)
    .where(eq(evidenceVersion.evidenceId, id))
    .get();
  return (row?.top ?? 0) + 1;
}

/** The item for a file upload: 404 when unknown, 409 `cui_file_refused` when flagged CUI. */
function fileTarget(db: Reader, id: string): ItemRow {
  const item = requireItem(db, id);
  if (item.containsCui) {
    throw new AppError(
      'cui_file_refused',
      'This item contains CUI, so it never holds a file. Record where the file lives instead.',
    );
  }
  return item;
}

const isRepeatFile = (newest: VersionRow | undefined, fileName: string, sha256: string) =>
  newest !== undefined &&
  !newest.containsCui &&
  newest.fileName === fileName &&
  newest.sha256 === sha256;

/**
 * `POST /api/evidence/:id/versions`. Checks the item before anything is stored, so a CUI item
 * leaves the store untouched. Bytes and a name identical to the newest version change nothing.
 */
export async function addFileVersion(
  db: AppDb,
  store: FileStore,
  id: string,
  upload: Upload,
  actor: Actor,
): Promise<VersionResult> {
  fileTarget(db, id);
  const sha256 = sha256Hex(upload.bytes);
  if (isRepeatFile(newestVersion(db, id), upload.fileName, sha256)) {
    return { item: readItem(db, id), created: false };
  }
  const stored = await store.put(upload.bytes);

  // Checked again in the transaction: the item and its newest version may have moved on.
  return db.transaction((tx) => {
    const item = fileTarget(tx, id);
    if (isRepeatFile(newestVersion(tx, id), upload.fileName, stored.sha256)) {
      return { item: readItem(tx, id), created: false };
    }
    const version = nextVersion(tx, id);
    tx.insert(evidenceVersion)
      .values({
        evidenceId: id,
        version,
        containsCui: false,
        fileName: upload.fileName,
        size: stored.size,
        sha256: stored.sha256,
        storageKey: stored.key,
        createdBy: actor.userId,
        createdAt: actor.now.toISOString(),
      })
      .run();
    touch(tx, id, actor);
    recordAudit(tx, {
      ...audit(actor, item.assessmentId, id),
      action: 'evidence.version_added',
      before: null,
      after: {
        version,
        kind: 'file',
        fileName: upload.fileName,
        size: stored.size,
        sha256: stored.sha256,
      },
    });
    return { item: readItem(tx, id), created: true };
  });
}

/**
 * `POST /api/evidence/:id/references`: where a CUI item's file really lives. 409
 * `evidence_not_cui` on an item that isn't flagged. The same location and note as the newest
 * reference change nothing.
 */
export function addReference(
  db: AppDb,
  id: string,
  body: AddReferenceRequest,
  actor: Actor,
): VersionResult {
  return db.transaction((tx) => {
    const item = requireItem(tx, id);
    if (!item.containsCui) {
      throw new AppError(
        'evidence_not_cui',
        "This item isn't flagged as containing CUI, so it holds files, not references.",
      );
    }
    const newest = newestVersion(tx, id);
    if (newest?.referenceLocation === body.location && newest.referenceNote === body.note) {
      return { item: readItem(tx, id), created: false };
    }
    const version = nextVersion(tx, id);
    tx.insert(evidenceVersion)
      .values({
        evidenceId: id,
        version,
        containsCui: true,
        referenceLocation: body.location,
        referenceNote: body.note,
        createdBy: actor.userId,
        createdAt: actor.now.toISOString(),
      })
      .run();
    touch(tx, id, actor);
    recordAudit(tx, {
      ...audit(actor, item.assessmentId, id),
      action: 'evidence.version_added',
      before: null,
      after: { version, kind: 'reference', location: body.location, note: body.note },
    });
    return { item: readItem(tx, id), created: true };
  });
}

/**
 * `GET /api/evidence/:id/versions/:version/file`: the stored bytes, checked against the recorded
 * SHA-256. A reference version or an unknown one is a 404; a missing or altered file is a 500
 * `file_integrity_failed` that names no path.
 */
export async function readFileVersion(
  db: Reader,
  store: FileStore,
  id: string,
  version: number,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  requireItem(db, id);
  const row = db
    .select()
    .from(evidenceVersion)
    .where(and(eq(evidenceVersion.evidenceId, id), eq(evidenceVersion.version, version)))
    .get();
  if (
    !row ||
    row.containsCui ||
    row.storageKey === null ||
    row.sha256 === null ||
    row.fileName === null
  ) {
    throw new AppError('not_found', 'No such file version.');
  }
  try {
    return { bytes: await store.get(row.storageKey, row.sha256), fileName: row.fileName };
  } catch (error) {
    if (error instanceof StorageError) {
      throw new AppError('file_integrity_failed', FILE_INTEGRITY_MESSAGE, { cause: error });
    }
    throw error;
  }
}
