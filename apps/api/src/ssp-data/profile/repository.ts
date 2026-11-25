import { eq } from 'drizzle-orm';
import type { AppDb } from '../../../db/client';
import { sspProfile, user } from '../../../db/schema';
import type { Actor } from '../../assessment/repository';
import { recordAudit } from '../../audit/record';
import {
  DEFAULT_CATEGORIZATION,
  DEFAULT_REVIEW_CADENCE_MONTHS,
  SSP_PROFILE_FIELDS,
  type PatchSspProfileRequest,
  type SspProfile,
  type SspProfileFieldKey,
} from '../../contract';
import { changedFields, requireAssessmentId, type Reader } from '../common';

/** The profile's fields as read: what users see, with the defaults filled in. */
type Fields = Pick<SspProfile, SspProfileFieldKey>;
type StoredFields = Omit<Fields, 'categorization'> & { categorization: string | null };
/** A patch in read values; an undefined field was not sent. */
type Requested = { [K in SspProfileFieldKey]?: Fields[K] | undefined };

const FIELD_KEYS: readonly SspProfileFieldKey[] = SSP_PROFILE_FIELDS.map(({ key }) => key);

/** A profile with no saved row, as stored when the first change creates it. */
const EMPTY_STORED: StoredFields = {
  ...(Object.fromEntries(FIELD_KEYS.map((key) => [key, null])) as Record<SspProfileFieldKey, null>),
  reviewCadenceMonths: DEFAULT_REVIEW_CADENCE_MONTHS,
};

/** The stored row's fields as read: a null categorization reads as the default. */
function effective(stored: StoredFields): Fields {
  return { ...stored, categorization: stored.categorization ?? DEFAULT_CATEGORIZATION };
}

/** How a read value is stored: the default categorization is kept as null, so it resets. */
function toStored(fields: Partial<Fields>): Partial<StoredFields> {
  if (fields.categorization !== DEFAULT_CATEGORIZATION) return fields;
  return { ...fields, categorization: null };
}

/** The patch as read values: a null (reset) categorization means the default. */
function requested(body: PatchSspProfileRequest): Requested {
  const { categorization, ...rest } = body;
  if (categorization === undefined) return rest;
  return { ...rest, categorization: categorization ?? DEFAULT_CATEGORIZATION };
}

/**
 * The SSP profile of an assessment: the one read path (the routes, document control and the
 * export read through it). With no saved row it reads the defaults (`DEFAULT_CATEGORIZATION`,
 * cadence 12, every other field null) and creates nothing.
 */
export function loadSspProfile(db: Reader, assessmentId: string): SspProfile {
  const row = db
    .select({ profile: sspProfile, updatedByName: user.displayName })
    .from(sspProfile)
    .innerJoin(user, eq(user.id, sspProfile.updatedBy))
    .where(eq(sspProfile.assessmentId, assessmentId))
    .get();
  if (!row) return { ...effective(EMPTY_STORED), updatedAt: null, updatedBy: null };
  const stored = Object.fromEntries(
    FIELD_KEYS.map((key) => [key, row.profile[key]]),
  ) as StoredFields;
  return {
    ...effective(stored),
    updatedAt: row.profile.updatedAt,
    updatedBy: { id: row.profile.updatedBy, displayName: row.updatedByName },
  };
}

/** `GET /api/ssp/profile`. Throws `not_found` when there is no assessment. */
export function readSspProfile(db: Reader): SspProfile {
  return loadSspProfile(db, requireAssessmentId(db));
}

/**
 * `PATCH /api/ssp/profile`. Compares read values, so sending the default categorization or
 * cadence to an empty profile changes nothing. The first change creates the row (cadence 12
 * unless sent) and is audited with `before: null`; later changes audit only the changed fields.
 * A patch that changes nothing writes neither a row nor an event and keeps `updatedAt`.
 */
export function patchSspProfile(db: AppDb, body: PatchSspProfileRequest, actor: Actor): SspProfile {
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const current = loadSspProfile(tx, assessmentId);
    const { before, after } = changedFields<Fields>(current, requested(body), FIELD_KEYS);
    if (Object.keys(after).length === 0) return current;

    const stamp = { updatedBy: actor.userId, updatedAt: actor.now.toISOString() };
    const isFirstSave = current.updatedAt === null;
    if (isFirstSave) {
      tx.insert(sspProfile)
        .values({ ...EMPTY_STORED, ...toStored(after), ...stamp, assessmentId })
        .run();
    } else {
      tx.update(sspProfile)
        .set({ ...toStored(after), ...stamp })
        .where(eq(sspProfile.assessmentId, assessmentId))
        .run();
    }
    recordAudit(tx, {
      at: actor.now,
      actorUserId: actor.userId,
      assessmentId,
      action: 'ssp_profile.updated',
      entityType: 'ssp_profile',
      entityId: assessmentId,
      before: isFirstSave ? null : before,
      after,
      requestId: actor.requestId,
    });
    return loadSspProfile(tx, assessmentId);
  });
}
