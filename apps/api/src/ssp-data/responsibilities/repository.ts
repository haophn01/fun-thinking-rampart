import { loadCatalog } from '@rampart/catalog';
import { and, eq } from 'drizzle-orm';
import type { AppDb } from '../../../db/client';
import { responsibility, serviceProvider } from '../../../db/schema';
import type { Actor } from '../../assessment/repository';
import { recordAudit } from '../../audit/record';
import type {
  PutResponsibilityRequest,
  ResponsibilityMatrix,
  ResponsibilityRow,
} from '../../contract';
import { AppError } from '../../errors';
import { changedFields, requireAssessmentId, type Reader } from '../common';
import { findLiveProvider } from '../providers/repository';

/** What the audit log records of a row. */
const FIELDS = ['party', 'providerId', 'note'] as const;
type Stored = Pick<typeof responsibility.$inferSelect, (typeof FIELDS)[number]>;

const EMPTY: Stored = { party: null, providerId: null, note: null };

let cachedIds: ReadonlySet<string> | undefined;

function isRequirement(id: string): boolean {
  cachedIds ??= new Set(loadCatalog().requirements.map((r) => r.id));
  return cachedIds.has(id);
}

/** The assessment's stored rows, keyed by requirement, with each named provider's current name. */
function storedRows(db: Reader, assessmentId: string, requirementId?: string) {
  const where = [eq(responsibility.assessmentId, assessmentId)];
  if (requirementId !== undefined) where.push(eq(responsibility.requirementId, requirementId));
  return db
    .select({ row: responsibility, providerName: serviceProvider.name })
    .from(responsibility)
    .leftJoin(serviceProvider, eq(serviceProvider.id, responsibility.providerId))
    .where(and(...where))
    .all();
}

type Joined = ReturnType<typeof storedRows>[number];

function toRow(requirementId: string, stored: Joined | undefined): ResponsibilityRow {
  if (!stored) return { requirementId, party: null, provider: null, note: null, updatedAt: null };
  const { row, providerName } = stored;
  return {
    requirementId,
    party: row.party,
    provider: row.providerId === null ? null : { id: row.providerId, name: providerName ?? '' },
    note: row.note,
    updatedAt: row.updatedAt,
  };
}

/**
 * One row per catalog requirement, in catalog order; a requirement with no stored row reads all
 * null. Exported for the SSP export.
 */
export function loadResponsibilityMatrix(db: Reader, assessmentId: string): ResponsibilityMatrix {
  const byRequirement = new Map(
    storedRows(db, assessmentId).map((stored) => [stored.row.requirementId, stored]),
  );
  return {
    rows: loadCatalog().requirements.map((r) => toRow(r.id, byRequirement.get(r.id))),
  };
}

/** `GET /api/ssp/responsibilities`. */
export function readMatrix(db: Reader): ResponsibilityMatrix {
  return loadResponsibilityMatrix(db, requireAssessmentId(db));
}

/**
 * `PUT /api/ssp/responsibilities/:requirementId`. The provider must be a live provider of the
 * active assessment (400), checked before the requirement (404). The first PUT that sets anything
 * stores the row; an all-null PUT on a requirement with no row stores nothing; a repeat writes
 * nothing. Each change writes one `responsibility.updated` event with the changed fields.
 */
export function putResponsibility(
  db: AppDb,
  requirementId: string,
  body: PutResponsibilityRequest,
  actor: Actor,
): ResponsibilityRow {
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    if (body.providerId !== null && !findLiveProvider(tx, assessmentId, body.providerId)) {
      throw new AppError('validation_failed', 'No such service provider.', {
        details: [{ path: ['providerId'], message: 'Not a service provider of this assessment' }],
      });
    }
    if (!isRequirement(requirementId)) {
      throw new AppError('not_found', `No requirement ${requirementId} in the catalog.`);
    }

    const [existing] = storedRows(tx, assessmentId, requirementId);
    const next: Stored = { party: body.party, providerId: body.providerId, note: body.note };
    const stamp = actor.now.toISOString();
    const audit = {
      at: actor.now,
      actorUserId: actor.userId,
      assessmentId,
      action: 'responsibility.updated',
      entityType: 'responsibility',
      entityId: requirementId,
      requestId: actor.requestId,
    };

    if (!existing) {
      const { after } = changedFields(EMPTY, next, FIELDS);
      if (Object.keys(after).length === 0) return toRow(requirementId, undefined);
      tx.insert(responsibility)
        .values({ assessmentId, requirementId, ...next, updatedBy: actor.userId, updatedAt: stamp })
        .run();
      recordAudit(tx, { ...audit, before: null, after: next });
    } else {
      const current: Stored = {
        party: existing.row.party,
        providerId: existing.row.providerId,
        note: existing.row.note,
      };
      const { before, after } = changedFields(current, next, FIELDS);
      if (Object.keys(after).length === 0) return toRow(requirementId, existing);
      tx.update(responsibility)
        .set({ ...after, updatedBy: actor.userId, updatedAt: stamp })
        .where(
          and(
            eq(responsibility.assessmentId, assessmentId),
            eq(responsibility.requirementId, requirementId),
          ),
        )
        .run();
      recordAudit(tx, { ...audit, before, after });
    }
    return toRow(requirementId, storedRows(tx, assessmentId, requirementId)[0]);
  });
}
