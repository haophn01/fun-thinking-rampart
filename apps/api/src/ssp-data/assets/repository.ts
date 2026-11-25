import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../../../db/client';
import { asset } from '../../../db/schema';
import type { Actor } from '../../assessment/repository';
import { recordAudit } from '../../audit/record';
import {
  ASSET_CATEGORIES,
  type Asset,
  type CreateAssetRequest,
  type PatchAssetRequest,
} from '../../contract';
import { AppError } from '../../errors';
import { changedFields, newId, requireAssessmentId, type Reader } from '../common';

type AssetRow = typeof asset.$inferSelect;

/** The fields an asset stores and audits, in the contract's order. */
const STORED_FIELDS = [
  'name',
  'category',
  'assetType',
  'owner',
  'location',
  'treatment',
  'outOfScopeJustification',
] as const;
type StoredFields = Pick<Asset, (typeof STORED_FIELDS)[number]>;

const JUSTIFICATION_REQUIRED = 'An out-of-scope asset needs a justification';

function storedFields(row: StoredFields): StoredFields {
  return {
    name: row.name,
    category: row.category,
    assetType: row.assetType,
    owner: row.owner,
    location: row.location,
    treatment: row.treatment,
    outOfScopeJustification: row.outOfScopeJustification,
  };
}

function toAsset(row: AssetRow): Asset {
  return { id: row.id, ...storedFields(row), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

const CATEGORY_POSITION = new Map<string, number>(ASSET_CATEGORIES.map((c, i) => [c, i]));

/** Category order, then name (case-insensitive), then `createdAt`, then `id`. */
function compareAssets(a: Asset, b: Asset): number {
  const ca = CATEGORY_POSITION.get(a.category) ?? 0;
  const cb = CATEGORY_POSITION.get(b.category) ?? 0;
  if (ca !== cb) return ca - cb;
  const na = a.name.toLowerCase();
  const nb = b.name.toLowerCase();
  if (na !== nb) return na < nb ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** The live assets of an assessment, in export order. An unknown assessment has none. */
export function loadAssets(db: Reader, assessmentId: string): Asset[] {
  return db
    .select()
    .from(asset)
    .where(and(eq(asset.assessmentId, assessmentId), isNull(asset.removedAt)))
    .all()
    .map(toAsset)
    .sort(compareAssets);
}

/** `GET /api/ssp/assets`. */
export function listAssets(db: Reader): Asset[] {
  return loadAssets(db, requireAssessmentId(db));
}

/** A live asset of the active assessment; 404 when unknown or removed. */
function requireAsset(db: Reader, id: string): AssetRow {
  const row = db
    .select()
    .from(asset)
    .where(
      and(
        eq(asset.id, id),
        eq(asset.assessmentId, requireAssessmentId(db)),
        isNull(asset.removedAt),
      ),
    )
    .get();
  if (!row) throw new AppError('not_found', 'No such asset.');
  return row;
}

/**
 * The out-of-scope rule on a whole asset: `out_of_scope` needs a non-blank justification. The
 * request schemas have already turned blank text into null.
 */
export function checkOutOfScope(fields: Pick<Asset, 'category' | 'outOfScopeJustification'>) {
  if (fields.category === 'out_of_scope' && fields.outOfScopeJustification === null) {
    throw new AppError('validation_failed', JUSTIFICATION_REQUIRED, {
      details: [{ path: ['outOfScopeJustification'], message: JUSTIFICATION_REQUIRED }],
    });
  }
}

function audit(actor: Actor, assessmentId: string, id: string) {
  return {
    at: actor.now,
    actorUserId: actor.userId,
    assessmentId,
    entityType: 'asset',
    entityId: id,
    requestId: actor.requestId,
  };
}

/** `POST /api/ssp/assets`. */
export function createAsset(db: AppDb, body: CreateAssetRequest, actor: Actor): Asset {
  const fields = storedFields(body);
  checkOutOfScope(fields);
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const id = newId();
    const stamp = actor.now.toISOString();
    const row: AssetRow = {
      id,
      assessmentId,
      ...fields,
      createdBy: actor.userId,
      createdAt: stamp,
      updatedBy: actor.userId,
      updatedAt: stamp,
      removedAt: null,
    };
    tx.insert(asset).values(row).run();
    recordAudit(tx, {
      ...audit(actor, assessmentId, id),
      action: 'asset.created',
      before: null,
      after: fields,
    });
    return toAsset(row);
  });
}

/**
 * `PATCH /api/ssp/assets/:id`. The out-of-scope rule is checked on the merged result, so a switch
 * to out of scope, or a blanked justification while out of scope, is a 400. Only changed fields
 * are written and audited; a patch that changes nothing writes nothing.
 */
export function patchAsset(db: AppDb, id: string, body: PatchAssetRequest, actor: Actor): Asset {
  return db.transaction((tx) => {
    const current = requireAsset(tx, id);
    const { before, after } = changedFields(storedFields(current), body, STORED_FIELDS);
    if (Object.keys(after).length === 0) return toAsset(current);
    const merged = { ...current, ...after };
    checkOutOfScope(merged);
    const next: AssetRow = {
      ...merged,
      updatedBy: actor.userId,
      updatedAt: actor.now.toISOString(),
    };
    tx.update(asset)
      .set({ ...after, updatedBy: next.updatedBy, updatedAt: next.updatedAt })
      .where(eq(asset.id, id))
      .run();
    recordAudit(tx, {
      ...audit(actor, current.assessmentId, id),
      action: 'asset.updated',
      before,
      after,
    });
    return toAsset(next);
  });
}

/** `DELETE /api/ssp/assets/:id`: a soft removal. A removed asset is a 404 from then on. */
export function removeAsset(db: AppDb, id: string, actor: Actor): void {
  db.transaction((tx) => {
    const current = requireAsset(tx, id);
    const stamp = actor.now.toISOString();
    tx.update(asset)
      .set({ removedAt: stamp, updatedBy: actor.userId, updatedAt: stamp })
      .where(eq(asset.id, id))
      .run();
    recordAudit(tx, {
      ...audit(actor, current.assessmentId, id),
      action: 'asset.removed',
      before: storedFields(current),
      after: null,
    });
  });
}
