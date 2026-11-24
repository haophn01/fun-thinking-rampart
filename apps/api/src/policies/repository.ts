import { randomUUID } from 'node:crypto';
import { loadCatalog, type RequirementId } from '@rampart/catalog';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { policy, policyLink, policyVersion, user } from '../../db/schema';
import { StorageError, type FileStore } from '../../storage';
import { findActiveAssessment, type Actor } from '../assessment/repository';
import { recordAudit } from '../audit/record';
import {
  FILE_INTEGRITY_MESSAGE,
  type CreatePolicyRequest,
  type PatchPolicyRequest,
  type Policy,
  type PolicyList,
  type PolicyQuery,
  type PolicyVersion,
  type PutPolicyRequirementsRequest,
} from '../contract';
import { AppError } from '../errors';
import type { Upload } from '../uploads/upload';

/** The app's database or a transaction inside it, for reads. */
type Reader = Pick<AppDb, 'select'>;
type PolicyRow = typeof policy.$inferSelect;

let cachedPositions: ReadonlyMap<RequirementId, number> | undefined;

/** Each catalog requirement's position, so link lists come back in catalog order. */
function requirementPositions(): ReadonlyMap<RequirementId, number> {
  cachedPositions ??= new Map(loadCatalog().requirements.map((r, position) => [r.id, position]));
  return cachedPositions;
}

/**
 * The IDs with duplicates collapsed, in catalog order. Throws `validation_failed` naming every
 * ID the catalog doesn't have, at its index in the request.
 */
function catalogRequirements(ids: readonly string[], field: string): RequirementId[] {
  const positions = requirementPositions();
  const unknown = ids.map((id, index) => ({ id, index })).filter(({ id }) => !positions.has(id));
  if (unknown.length > 0) {
    throw new AppError(
      'validation_failed',
      `Not in the catalog: ${unknown.map(({ id }) => id).join(', ')}`,
      {
        details: unknown.map(({ id, index }) => ({
          path: [field, index],
          message: `${id} is not a requirement in the catalog`,
        })),
      },
    );
  }
  return [...new Set(ids)].sort((a, b) => (positions.get(a) ?? 0) - (positions.get(b) ?? 0));
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function requireAssessmentId(db: Reader): string {
  const row = findActiveAssessment(db);
  if (!row) throw new AppError('not_found', 'There is no assessment yet. Run setup first.');
  return row.id;
}

function requirePolicy(db: Reader, assessmentId: string, id: string): PolicyRow {
  const row = db
    .select()
    .from(policy)
    .where(and(eq(policy.assessmentId, assessmentId), eq(policy.id, id)))
    .get();
  if (!row) throw new AppError('not_found', 'No such policy.');
  return row;
}

function linksOf(db: Reader, policyId: string): RequirementId[] {
  const positions = requirementPositions();
  return db
    .select({ requirementId: policyLink.requirementId })
    .from(policyLink)
    .where(eq(policyLink.policyId, policyId))
    .all()
    .map((row) => row.requirementId)
    .sort((a, b) => (positions.get(a) ?? 0) - (positions.get(b) ?? 0));
}

/** The policies as the contract shows them: links in catalog order, versions newest first. */
function toPolicies(db: Reader, rows: PolicyRow[]): Policy[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const links = db.select().from(policyLink).where(inArray(policyLink.policyId, ids)).all();
  const versions = db
    .select({ row: policyVersion, createdByName: user.displayName })
    .from(policyVersion)
    .innerJoin(user, eq(user.id, policyVersion.createdBy))
    .where(inArray(policyVersion.policyId, ids))
    .orderBy(desc(policyVersion.version))
    .all();
  const creators = new Map(
    db
      .select({ id: user.id, displayName: user.displayName })
      .from(user)
      .where(inArray(user.id, [...new Set(rows.map((row) => row.createdBy))]))
      .all()
      .map((u) => [u.id, u.displayName]),
  );
  const positions = requirementPositions();

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    requirementIds: links
      .filter((link) => link.policyId === row.id)
      .map((link) => link.requirementId)
      .sort((a, b) => (positions.get(a) ?? 0) - (positions.get(b) ?? 0)),
    versions: versions
      .filter(({ row: version }) => version.policyId === row.id)
      .map(({ row: version, createdByName }): PolicyVersion => ({
        version: version.version,
        fileName: version.fileName,
        size: version.size,
        sha256: version.sha256,
        createdAt: version.createdAt,
        createdBy: { id: version.createdBy, displayName: createdByName },
      })),
    createdAt: row.createdAt,
    createdBy: { id: row.createdBy, displayName: creators.get(row.createdBy) ?? '' },
    updatedAt: row.updatedAt,
  }));
}

function readPolicy(db: Reader, assessmentId: string, id: string): Policy {
  const [item] = toPolicies(db, [requirePolicy(db, assessmentId, id)]);
  if (!item) throw new Error('policy row vanished while reading it');
  return item;
}

/** Title (case-insensitive), then `createdAt`, then `id`. */
function compareRows(a: PolicyRow, b: PolicyRow): number {
  const at = a.title.toLowerCase();
  const bt = b.title.toLowerCase();
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** `GET /api/policies[?requirementId=]`. A requirement not in the catalog is a 400. */
export function listPolicies(db: Reader, query: PolicyQuery): PolicyList {
  const { requirementId } = query;
  if (requirementId !== undefined) catalogRequirements([requirementId], 'requirementId');
  const assessmentId = requireAssessmentId(db);
  let rows = db.select().from(policy).where(eq(policy.assessmentId, assessmentId)).all();
  if (requirementId !== undefined) {
    const linked = new Set(
      db
        .select({ policyId: policyLink.policyId })
        .from(policyLink)
        .where(eq(policyLink.requirementId, requirementId))
        .all()
        .map((row) => row.policyId),
    );
    rows = rows.filter((row) => linked.has(row.id));
  }
  return { items: toPolicies(db, rows.sort(compareRows)) };
}

function auditBase(assessmentId: string, policyId: string, actor: Actor) {
  return {
    at: actor.now,
    actorUserId: actor.userId,
    assessmentId,
    entityType: 'policy',
    entityId: policyId,
    requestId: actor.requestId,
  };
}

/** `POST /api/policies`: the policy, its links and a `policy.created` event, in one transaction. */
export function createPolicy(db: AppDb, body: CreatePolicyRequest, actor: Actor): Policy {
  const requirementIds = catalogRequirements(body.requirementIds, 'requirementIds');
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const id = randomUUID();
    const stamp = actor.now.toISOString();
    tx.insert(policy)
      .values({
        id,
        assessmentId,
        title: body.title,
        description: body.description,
        createdBy: actor.userId,
        createdAt: stamp,
        updatedBy: actor.userId,
        updatedAt: stamp,
      })
      .run();
    if (requirementIds.length > 0) {
      tx.insert(policyLink)
        .values(requirementIds.map((requirementId) => ({ policyId: id, requirementId })))
        .run();
    }
    recordAudit(tx, {
      ...auditBase(assessmentId, id, actor),
      action: 'policy.created',
      before: null,
      after: { title: body.title, description: body.description, requirementIds },
    });
    return readPolicy(tx, assessmentId, id);
  });
}

/** `PATCH /api/policies/:id`: only changed fields are written and audited; a no-op writes nothing. */
export function patchPolicy(db: AppDb, id: string, body: PatchPolicyRequest, actor: Actor): Policy {
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const current = requirePolicy(tx, assessmentId, id);
    const before: Partial<Pick<PolicyRow, 'title' | 'description'>> = {};
    const after: Partial<Pick<PolicyRow, 'title' | 'description'>> = {};
    if (body.title !== undefined && body.title !== current.title) {
      before.title = current.title;
      after.title = body.title;
    }
    if (body.description !== undefined && body.description !== current.description) {
      before.description = current.description;
      after.description = body.description;
    }
    if (Object.keys(after).length > 0) {
      tx.update(policy)
        .set({ ...after, updatedBy: actor.userId, updatedAt: actor.now.toISOString() })
        .where(eq(policy.id, id))
        .run();
      recordAudit(tx, {
        ...auditBase(assessmentId, id, actor),
        action: 'policy.updated',
        before,
        after,
      });
    }
    return readPolicy(tx, assessmentId, id);
  });
}

/** `PUT /api/policies/:id/requirements`: replaces the whole set; the same set writes nothing. */
export function putPolicyRequirements(
  db: AppDb,
  id: string,
  body: PutPolicyRequirementsRequest,
  actor: Actor,
): Policy {
  const next = catalogRequirements(body.requirementIds, 'requirementIds');
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    requirePolicy(tx, assessmentId, id);
    const current = linksOf(tx, id);
    if (!sameList(current, next)) {
      tx.delete(policyLink).where(eq(policyLink.policyId, id)).run();
      if (next.length > 0) {
        tx.insert(policyLink)
          .values(next.map((requirementId) => ({ policyId: id, requirementId })))
          .run();
      }
      tx.update(policy)
        .set({ updatedBy: actor.userId, updatedAt: actor.now.toISOString() })
        .where(eq(policy.id, id))
        .run();
      recordAudit(tx, {
        ...auditBase(assessmentId, id, actor),
        action: 'policy.links_updated',
        before: { requirementIds: current },
        after: { requirementIds: next },
      });
    }
    return readPolicy(tx, assessmentId, id);
  });
}

/**
 * `POST /api/policies/:id/versions`. The policy must exist before any byte reaches the store.
 * The same bytes and name as the newest version answer `created: false` with no new version and
 * no event; anything else becomes the next version, with a `policy.version_added` event.
 */
export async function addPolicyVersion(
  db: AppDb,
  store: FileStore,
  id: string,
  upload: Upload,
  actor: Actor,
): Promise<{ item: Policy; created: boolean }> {
  requirePolicy(db, requireAssessmentId(db), id);
  const stored = await store.put(upload.bytes);

  // Synchronous, so the version number can't race another upload to the same policy.
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    requirePolicy(tx, assessmentId, id);
    const newest = tx
      .select()
      .from(policyVersion)
      .where(eq(policyVersion.policyId, id))
      .orderBy(desc(policyVersion.version))
      .limit(1)
      .get();
    if (newest && newest.sha256 === stored.sha256 && newest.fileName === upload.fileName) {
      return { item: readPolicy(tx, assessmentId, id), created: false };
    }
    const version = (newest?.version ?? 0) + 1;
    const stamp = actor.now.toISOString();
    tx.insert(policyVersion)
      .values({
        policyId: id,
        version,
        fileName: upload.fileName,
        size: stored.size,
        sha256: stored.sha256,
        storageKey: stored.key,
        createdBy: actor.userId,
        createdAt: stamp,
      })
      .run();
    tx.update(policy)
      .set({ updatedBy: actor.userId, updatedAt: stamp })
      .where(eq(policy.id, id))
      .run();
    recordAudit(tx, {
      ...auditBase(assessmentId, id, actor),
      action: 'policy.version_added',
      before: null,
      after: {
        version,
        kind: 'file',
        fileName: upload.fileName,
        size: stored.size,
        sha256: stored.sha256,
      },
    });
    return { item: readPolicy(tx, assessmentId, id), created: true };
  });
}

const VERSION = /^[1-9]\d{0,8}$/;

/**
 * `GET /api/policies/:id/versions/:version/file`: the stored bytes, checked against the recorded
 * SHA-256. An unknown policy or version (or one that isn't a positive integer) is `not_found`; a
 * missing or altered file is 500 `file_integrity_failed`, naming no path.
 */
export async function readPolicyFile(
  db: Reader,
  store: FileStore,
  id: string,
  version: string,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const assessmentId = requireAssessmentId(db);
  requirePolicy(db, assessmentId, id);
  const row = VERSION.test(version)
    ? db
        .select()
        .from(policyVersion)
        .where(and(eq(policyVersion.policyId, id), eq(policyVersion.version, Number(version))))
        .get()
    : undefined;
  if (!row) throw new AppError('not_found', 'No such policy version.');
  try {
    return { bytes: await store.get(row.storageKey, row.sha256), fileName: row.fileName };
  } catch (error) {
    if (error instanceof StorageError) {
      throw new AppError('file_integrity_failed', FILE_INTEGRITY_MESSAGE, { cause: error });
    }
    throw error;
  }
}
