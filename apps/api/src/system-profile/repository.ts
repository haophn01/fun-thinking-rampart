import { eq } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { systemProfile, user } from '../../db/schema';
import { findActiveAssessment, type Actor } from '../assessment/repository';
import { recordAudit } from '../audit/record';
import {
  SYSTEM_PROFILE_FIELDS,
  type PatchSystemProfileRequest,
  type SystemProfile,
  type SystemProfileFieldKey,
} from '../contract';
import { AppError } from '../errors';

/** The app's database or a transaction inside it, for reads. */
type Reader = Pick<AppDb, 'select'>;
type Fields = Record<SystemProfileFieldKey, string | null>;

const FIELD_KEYS: readonly SystemProfileFieldKey[] = SYSTEM_PROFILE_FIELDS.map(({ key }) => key);

const EMPTY_FIELDS = Object.fromEntries(FIELD_KEYS.map((key) => [key, null])) as Fields;

function requireAssessmentId(db: Reader): string {
  const row = findActiveAssessment(db);
  if (!row) throw new AppError('not_found', 'There is no assessment yet. Run setup first.');
  return row.id;
}

/**
 * The system profile of an assessment: the one read path (the routes and the SSP export use it).
 * With no saved row, every field, `updatedAt` and `updatedBy` is null.
 */
export function loadSystemProfile(db: Reader, assessmentId: string): SystemProfile {
  const row = db
    .select({ profile: systemProfile, updatedByName: user.displayName })
    .from(systemProfile)
    .innerJoin(user, eq(user.id, systemProfile.updatedBy))
    .where(eq(systemProfile.assessmentId, assessmentId))
    .get();
  if (!row) return { ...EMPTY_FIELDS, updatedAt: null, updatedBy: null };
  const fields = Object.fromEntries(FIELD_KEYS.map((key) => [key, row.profile[key]])) as Fields;
  return {
    ...fields,
    updatedAt: row.profile.updatedAt,
    updatedBy: { id: row.profile.updatedBy, displayName: row.updatedByName },
  };
}

/** `GET /api/system-profile`. Throws `not_found` when there is no assessment. */
export function readSystemProfile(db: Reader): SystemProfile {
  return loadSystemProfile(db, requireAssessmentId(db));
}

/**
 * `PATCH /api/system-profile`. Writes and audits only the fields whose value changes. The first
 * save creates the row and is audited with `before: null`; a patch that changes nothing writes
 * neither a row nor an event, and leaves `updatedAt` as it was.
 */
export function patchSystemProfile(
  db: AppDb,
  body: PatchSystemProfileRequest,
  actor: Actor,
): SystemProfile {
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const current = loadSystemProfile(tx, assessmentId);
    const before: Partial<Fields> = {};
    const after: Partial<Fields> = {};
    for (const key of FIELD_KEYS) {
      const value = body[key];
      if (value !== undefined && value !== current[key]) {
        before[key] = current[key];
        after[key] = value;
      }
    }
    if (Object.keys(after).length === 0) return current;

    const stamp = { updatedBy: actor.userId, updatedAt: actor.now.toISOString() };
    const isFirstSave = current.updatedAt === null;
    if (isFirstSave) {
      tx.insert(systemProfile)
        .values({ ...EMPTY_FIELDS, ...after, ...stamp, assessmentId })
        .run();
    } else {
      tx.update(systemProfile)
        .set({ ...after, ...stamp })
        .where(eq(systemProfile.assessmentId, assessmentId))
        .run();
    }
    recordAudit(tx, {
      at: actor.now,
      actorUserId: actor.userId,
      assessmentId,
      action: 'system_profile.updated',
      entityType: 'system_profile',
      entityId: assessmentId,
      before: isFirstSave ? null : before,
      after,
      requestId: actor.requestId,
    });
    return loadSystemProfile(tx, assessmentId);
  });
}
