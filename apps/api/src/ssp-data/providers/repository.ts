import { loadCatalog } from '@rampart/catalog';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../../../db/client';
import { responsibility, serviceProvider } from '../../../db/schema';
import type { Actor } from '../../assessment/repository';
import { recordAudit } from '../../audit/record';
import type {
  CreateServiceProviderRequest,
  PatchServiceProviderRequest,
  ServiceProvider,
} from '../../contract';
import { AppError } from '../../errors';
import { changedFields, newId, requireAssessmentId, type Reader } from '../common';

type ProviderRow = typeof serviceProvider.$inferSelect;

/** What the audit log records of a provider: every stored field. */
const FIELDS = ['name', 'providerType', 'fedrampStatus', 'services', 'agreementReference'] as const;
type ProviderFields = Pick<ProviderRow, (typeof FIELDS)[number]>;

function fieldsOf(row: ProviderFields): ProviderFields {
  return {
    name: row.name,
    providerType: row.providerType,
    fedrampStatus: row.fedrampStatus,
    services: row.services,
    agreementReference: row.agreementReference,
  };
}

function toProvider(row: ProviderRow): ServiceProvider {
  return { id: row.id, ...fieldsOf(row), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** Name (case-insensitive), then `createdAt`, then `id`. */
function compareRows(a: ProviderRow, b: ProviderRow): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The assessment's live (not removed) provider with this ID, or undefined. */
export function findLiveProvider(
  db: Reader,
  assessmentId: string,
  id: string,
): ProviderRow | undefined {
  return db
    .select()
    .from(serviceProvider)
    .where(
      and(
        eq(serviceProvider.assessmentId, assessmentId),
        eq(serviceProvider.id, id),
        isNull(serviceProvider.removedAt),
      ),
    )
    .get();
}

function requireProvider(db: Reader, assessmentId: string, id: string): ProviderRow {
  const row = findLiveProvider(db, assessmentId, id);
  if (!row) throw new AppError('not_found', 'No such service provider.');
  return row;
}

/** The assessment's live providers, by name. Exported for the SSP export. */
export function loadProviders(db: Reader, assessmentId: string): ServiceProvider[] {
  return db
    .select()
    .from(serviceProvider)
    .where(and(eq(serviceProvider.assessmentId, assessmentId), isNull(serviceProvider.removedAt)))
    .all()
    .sort(compareRows)
    .map(toProvider);
}

/** `GET /api/ssp/providers`. */
export function listProviders(db: Reader): ServiceProvider[] {
  return loadProviders(db, requireAssessmentId(db));
}

function auditBase(assessmentId: string, id: string, actor: Actor) {
  return {
    at: actor.now,
    actorUserId: actor.userId,
    assessmentId,
    entityType: 'service_provider',
    entityId: id,
    requestId: actor.requestId,
  };
}

/** `POST /api/ssp/providers`: the row and its `service_provider.created` event. */
export function createProvider(
  db: AppDb,
  body: CreateServiceProviderRequest,
  actor: Actor,
): ServiceProvider {
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const id = newId();
    const stamp = actor.now.toISOString();
    const fields = fieldsOf(body);
    tx.insert(serviceProvider)
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
      ...auditBase(assessmentId, id, actor),
      action: 'service_provider.created',
      before: null,
      after: fields,
    });
    return toProvider(requireProvider(tx, assessmentId, id));
  });
}

/** `PATCH /api/ssp/providers/:id`: only changed fields are written and audited. */
export function patchProvider(
  db: AppDb,
  id: string,
  body: PatchServiceProviderRequest,
  actor: Actor,
): ServiceProvider {
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const current = requireProvider(tx, assessmentId, id);
    const { before, after } = changedFields(fieldsOf(current), body, FIELDS);
    if (Object.keys(after).length === 0) return toProvider(current);
    tx.update(serviceProvider)
      .set({ ...after, updatedBy: actor.userId, updatedAt: actor.now.toISOString() })
      .where(eq(serviceProvider.id, id))
      .run();
    recordAudit(tx, {
      ...auditBase(assessmentId, id, actor),
      action: 'service_provider.updated',
      before,
      after,
    });
    return toProvider(requireProvider(tx, assessmentId, id));
  });
}

let cachedPositions: ReadonlyMap<string, number> | undefined;

function requirementPosition(id: string): number {
  cachedPositions ??= new Map(loadCatalog().requirements.map((r, position) => [r.id, position]));
  return cachedPositions.get(id) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * `DELETE /api/ssp/providers/:id`: soft removal with a `service_provider.removed` event. A
 * provider a responsibility row still names is refused with `provider_in_use`.
 */
export function removeProvider(db: AppDb, id: string, actor: Actor): void {
  db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const current = requireProvider(tx, assessmentId, id);
    const named = tx
      .select({ requirementId: responsibility.requirementId })
      .from(responsibility)
      .where(eq(responsibility.providerId, id))
      .all()
      .map((row) => row.requirementId)
      .sort((a, b) => requirementPosition(a) - requirementPosition(b));
    if (named.length > 0) {
      throw new AppError(
        'provider_in_use',
        'This provider is named in the responsibility matrix. Change those rows first.',
        { details: { requirementIds: named } },
      );
    }
    const stamp = actor.now.toISOString();
    tx.update(serviceProvider)
      .set({ removedAt: stamp, updatedBy: actor.userId, updatedAt: stamp })
      .where(eq(serviceProvider.id, id))
      .run();
    recordAudit(tx, {
      ...auditBase(assessmentId, id, actor),
      action: 'service_provider.removed',
      before: fieldsOf(current),
      after: null,
    });
  });
}
