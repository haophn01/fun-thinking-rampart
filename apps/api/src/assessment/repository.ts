import {
  loadCatalog,
  type ObjectiveId,
  type Requirement,
  type RequirementId,
} from '@rampart/catalog';
import {
  evaluateAssessment,
  type AssessmentInput,
  type Evaluation,
  type ImplementationLevel,
} from '@rampart/rules';
import { REGULATION, closeoutClock } from '@rampart/rules/poam';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { assessment, objectiveResult, poamItem, requirementState, user } from '../../db/schema';
import { recordAudit } from '../audit/record';
import type {
  Assessment,
  AssessmentView,
  ObjectiveResultRow,
  ObjectiveWriteResponse,
  PatchRequirementRequest,
  PutObjectiveResultRequest,
  RequirementState,
  RequirementWriteResponse,
  UpdateAssessmentRequest,
} from '../contract';
import { AppError } from '../errors';

/** The app's database or a transaction inside it, for reads. */
type Reader = Pick<AppDb, 'select'>;
type AssessmentRow = typeof assessment.$inferSelect;

/** Who is writing, and when: the signed-in user, the app clock and the request's id. */
export interface Actor {
  userId: string;
  now: Date;
  requestId: string;
}

interface CatalogIndex {
  objectives: ReadonlyMap<ObjectiveId, number>;
  requirements: ReadonlyMap<RequirementId, { position: number; requirement: Requirement }>;
}

let cachedIndex: CatalogIndex | undefined;

/** Catalog positions of every objective and requirement, so lists come back in catalog order. */
function catalogIndex(): CatalogIndex {
  if (cachedIndex) return cachedIndex;
  const objectives = new Map<ObjectiveId, number>();
  const requirements = new Map<RequirementId, { position: number; requirement: Requirement }>();
  loadCatalog().requirements.forEach((requirement, position) => {
    requirements.set(requirement.id, { position, requirement });
    for (const objective of requirement.objectives) objectives.set(objective.id, objectives.size);
  });
  cachedIndex = { objectives, requirements };
  return cachedIndex;
}

function byPosition<T>(items: T[], position: (item: T) => number | undefined): T[] {
  const at = (item: T) => position(item) ?? Number.MAX_SAFE_INTEGER;
  return items.sort((a, b) => at(a) - at(b));
}

/** The fields in `keys` whose value in `next` differs from `current`, before and after. */
function changedFields<T extends Record<string, unknown>>(
  current: T,
  next: { readonly [K in keyof T]?: T[K] | undefined },
  keys: readonly (keyof T & string)[],
): { before: Partial<T>; after: Partial<T> } {
  const before: Partial<T> = {};
  const after: Partial<T> = {};
  for (const key of keys) {
    const value = next[key];
    if (value !== undefined && value !== current[key]) {
      before[key] = current[key];
      after[key] = value;
    }
  }
  return { before, after };
}

const isEmpty = (fields: object) => Object.keys(fields).length === 0;

/** The UTC calendar date of `now`, as `YYYY-MM-DD`: what "today" means everywhere. */
function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The active assessment: the one created first. */
export function findActiveAssessment(db: Reader): AssessmentRow | undefined {
  return db
    .select()
    .from(assessment)
    .orderBy(asc(assessment.createdAt), sql`rowid`)
    .limit(1)
    .get();
}

function requireAssessment(db: Reader): AssessmentRow {
  const row = findActiveAssessment(db);
  if (!row) throw new AppError('not_found', 'There is no assessment yet. Run setup first.');
  return row;
}

/**
 * The requirements with an open POA&M item, in catalog order. Closed items are history and cover
 * nothing; the partial unique index allows one open item per requirement.
 */
function listOpenPoamRequirementIds(db: Reader, assessmentId: string): RequirementId[] {
  const rows = db
    .select({ requirementId: poamItem.requirementId })
    .from(poamItem)
    .where(and(eq(poamItem.assessmentId, assessmentId), eq(poamItem.status, 'open')))
    .all();
  const { requirements } = catalogIndex();
  return byPosition(rows, (r) => requirements.get(r.requirementId)?.position).map(
    (r) => r.requirementId,
  );
}

/**
 * The rules input stored for an assessment: its objective results, implementation levels and the
 * requirements with an open POA&M item, so every evaluation applies the POA&M rule.
 */
export function loadInput(db: Reader, assessmentId: string): AssessmentInput {
  const results = db
    .select({ objectiveId: objectiveResult.objectiveId, status: objectiveResult.status })
    .from(objectiveResult)
    .where(eq(objectiveResult.assessmentId, assessmentId))
    .all();
  const levels = db
    .select({
      requirementId: requirementState.requirementId,
      level: requirementState.implementationLevel,
    })
    .from(requirementState)
    .where(eq(requirementState.assessmentId, assessmentId))
    .all();
  const implementationLevels: Partial<Record<RequirementId, ImplementationLevel>> = {};
  for (const { requirementId, level } of levels) {
    if (level !== null) implementationLevels[requirementId] = level;
  }
  const { objectives } = catalogIndex();
  return {
    objectiveResults: byPosition(results, (r) => objectives.get(r.objectiveId)),
    implementationLevels,
    openPoamRequirementIds: listOpenPoamRequirementIds(db, assessmentId),
  };
}

/** The one evaluation every response carries: `evaluateAssessment` over the stored rows. */
export function evaluateStored(db: Reader, assessmentId: string): Evaluation {
  return evaluateAssessment(loadCatalog(), loadInput(db, assessmentId), REGULATION);
}

function toAssessment(row: AssessmentRow): Assessment {
  return {
    id: row.id,
    type: row.type,
    conditionalStatusDate: row.conditionalStatusDate,
    catalogVersion: row.catalogVersion,
    updatedAt: row.updatedAt,
  };
}

function listObjectiveResults(
  db: Reader,
  assessmentId: string,
  objectiveId?: ObjectiveId,
): ObjectiveResultRow[] {
  const rows = db
    .select({ row: objectiveResult, updatedByName: user.displayName })
    .from(objectiveResult)
    .innerJoin(user, eq(user.id, objectiveResult.updatedBy))
    .where(
      and(
        eq(objectiveResult.assessmentId, assessmentId),
        objectiveId === undefined ? undefined : eq(objectiveResult.objectiveId, objectiveId),
      ),
    )
    .all();
  const { objectives } = catalogIndex();
  return byPosition(
    rows.map(({ row, updatedByName }) => ({
      objectiveId: row.objectiveId,
      status: row.status,
      note: row.note,
      updatedAt: row.updatedAt,
      updatedBy: { id: row.updatedBy, displayName: updatedByName },
    })),
    (r) => objectives.get(r.objectiveId),
  );
}

function listRequirementStates(
  db: Reader,
  assessmentId: string,
  requirementId?: RequirementId,
): RequirementState[] {
  const rows = db
    .select({ row: requirementState, owner: user })
    .from(requirementState)
    .leftJoin(user, eq(user.id, requirementState.ownerUserId))
    .where(
      and(
        eq(requirementState.assessmentId, assessmentId),
        requirementId === undefined ? undefined : eq(requirementState.requirementId, requirementId),
      ),
    )
    .all();
  const { requirements } = catalogIndex();
  return byPosition(
    rows.map(({ row, owner }) => ({
      requirementId: row.requirementId,
      implementationLevel: row.implementationLevel,
      implementationStatement: row.implementationStatement,
      plannedImplementation: row.plannedImplementation,
      naRationale: row.naRationale,
      owner:
        owner === null
          ? null
          : { id: owner.id, displayName: owner.displayName, active: owner.active },
      updatedAt: row.updatedAt,
    })),
    (s) => requirements.get(s.requirementId)?.position,
  );
}

function viewOf(db: Reader, row: AssessmentRow, now: Date): AssessmentView {
  const input = loadInput(db, row.id);
  return {
    assessment: toAssessment(row),
    objectiveResults: listObjectiveResults(db, row.id),
    requirementStates: listRequirementStates(db, row.id),
    openPoamRequirementIds: [...(input.openPoamRequirementIds ?? [])],
    evaluation: evaluateAssessment(loadCatalog(), input, REGULATION),
    closeout:
      row.conditionalStatusDate === null
        ? null
        : closeoutClock(row.conditionalStatusDate, utcDate(now), REGULATION),
  };
}

/** `GET /api/assessment`. Throws `not_found` when there is no assessment row. */
export function readView(db: Reader, now: Date): AssessmentView {
  return viewOf(db, requireAssessment(db), now);
}

/**
 * `PATCH /api/assessment`: sets the type and the Conditional Status Date (null clears it). Only
 * changed fields are written and audited; a no-op writes nothing.
 */
export function updateAssessment(
  db: AppDb,
  body: UpdateAssessmentRequest,
  actor: Actor,
): AssessmentView {
  return db.transaction((tx) => {
    const current = requireAssessment(tx);
    const { before, after } = changedFields(
      { type: current.type, conditionalStatusDate: current.conditionalStatusDate },
      body,
      ['type', 'conditionalStatusDate'],
    );
    if (!isEmpty(after)) {
      tx.update(assessment)
        .set({ ...after, updatedAt: actor.now.toISOString() })
        .where(eq(assessment.id, current.id))
        .run();
      recordAudit(tx, {
        at: actor.now,
        actorUserId: actor.userId,
        assessmentId: current.id,
        action: 'assessment.updated',
        entityType: 'assessment',
        entityId: current.id,
        before,
        after,
        requestId: actor.requestId,
      });
    }
    return viewOf(tx, requireAssessment(tx), actor.now);
  });
}

/**
 * `PUT /api/assessment/objectives/:objectiveId`. A first write is audited with `before: null`, a
 * change with only the changed fields; an identical repeat writes nothing and leaves the row as
 * it was. Throws `not_found` for an objective the catalog doesn't have.
 */
export function putObjectiveResult(
  db: AppDb,
  objectiveId: string,
  body: PutObjectiveResultRequest,
  actor: Actor,
): ObjectiveWriteResponse {
  return db.transaction((tx) => {
    const { id: assessmentId } = requireAssessment(tx);
    if (!catalogIndex().objectives.has(objectiveId)) {
      throw new AppError('not_found', `No objective ${objectiveId} in the catalog.`);
    }
    const where = and(
      eq(objectiveResult.assessmentId, assessmentId),
      eq(objectiveResult.objectiveId, objectiveId),
    );
    const current = tx.select().from(objectiveResult).where(where).get();
    const next = { status: body.status, note: body.note };
    const stamp = { updatedBy: actor.userId, updatedAt: actor.now.toISOString() };
    const audit = {
      at: actor.now,
      actorUserId: actor.userId,
      assessmentId,
      action: 'objective_result.updated',
      entityType: 'objective_result',
      entityId: objectiveId,
      requestId: actor.requestId,
    };

    if (!current) {
      tx.insert(objectiveResult)
        .values({ assessmentId, objectiveId, ...next, ...stamp })
        .run();
      recordAudit(tx, { ...audit, before: null, after: next });
    } else {
      const { before, after } = changedFields(current, next, ['status', 'note']);
      if (!isEmpty(after)) {
        tx.update(objectiveResult)
          .set({ ...after, ...stamp })
          .where(where)
          .run();
        recordAudit(tx, { ...audit, before, after });
      }
    }

    const [objectiveResultRow] = listObjectiveResults(tx, assessmentId, objectiveId);
    if (!objectiveResultRow) throw new Error('written objective result is missing');
    return { objectiveResult: objectiveResultRow, evaluation: evaluateStored(tx, assessmentId) };
  });
}

/** What a requirement's content is when it has no row yet. */
const EMPTY_STATE = {
  implementationStatement: null,
  implementationLevel: null,
  ownerId: null,
  plannedImplementation: null,
  naRationale: null,
} as const;

interface StateFields {
  [key: string]: unknown;
  implementationStatement: string | null;
  implementationLevel: ImplementationLevel | null;
  ownerId: string | null;
  plannedImplementation: string | null;
  naRationale: string | null;
}

function checkOwner(db: Reader, ownerId: string): void {
  const owner = db.select({ active: user.active }).from(user).where(eq(user.id, ownerId)).get();
  if (owner?.active !== true) {
    throw new AppError('validation_failed', 'The owner must be an active user.', {
      details: [{ path: ['ownerId'], message: 'Not an active user' }],
    });
  }
}

/**
 * `PATCH /api/assessment/requirements/:requirementId`: the implementation statement, the
 * partial-credit level, the owner, the planned implementation and the N/A rationale (the last two
 * are stored on any status). Throws `not_found` for a requirement the catalog doesn't
 * have, and `validation_failed` for a level on a requirement without partial credit or an owner
 * who isn't an active user. A change that leaves the content as it was writes nothing.
 */
export function patchRequirement(
  db: AppDb,
  requirementId: string,
  body: PatchRequirementRequest,
  actor: Actor,
): RequirementWriteResponse {
  const entry = catalogIndex().requirements.get(requirementId);
  if (!entry) throw new AppError('not_found', `No requirement ${requirementId} in the catalog.`);
  const { scoring } = entry.requirement;
  const hasPartialCredit = scoring.kind === 'points' && scoring.partialCredit !== null;
  if (body.implementationLevel !== undefined && !hasPartialCredit) {
    throw new AppError(
      'validation_failed',
      `${requirementId} has no partial credit, so it takes no implementation level.`,
      { details: [{ path: ['implementationLevel'], message: 'No partial credit' }] },
    );
  }

  return db.transaction((tx) => {
    const { id: assessmentId } = requireAssessment(tx);
    if (body.ownerId !== undefined && body.ownerId !== null) checkOwner(tx, body.ownerId);

    const where = and(
      eq(requirementState.assessmentId, assessmentId),
      eq(requirementState.requirementId, requirementId),
    );
    const row = tx.select().from(requirementState).where(where).get();
    const current: StateFields = row
      ? {
          implementationStatement: row.implementationStatement,
          implementationLevel: row.implementationLevel,
          ownerId: row.ownerUserId,
          plannedImplementation: row.plannedImplementation,
          naRationale: row.naRationale,
        }
      : { ...EMPTY_STATE };
    const { before, after } = changedFields<StateFields>(current, body, [
      'implementationStatement',
      'implementationLevel',
      'ownerId',
      'plannedImplementation',
      'naRationale',
    ]);

    if (!isEmpty(after)) {
      const next = { ...current, ...after };
      const values = {
        implementationStatement: next.implementationStatement,
        implementationLevel: next.implementationLevel,
        ownerUserId: next.ownerId,
        plannedImplementation: next.plannedImplementation,
        naRationale: next.naRationale,
        updatedBy: actor.userId,
        updatedAt: actor.now.toISOString(),
      };
      if (row) tx.update(requirementState).set(values).where(where).run();
      else
        tx.insert(requirementState)
          .values({ assessmentId, requirementId, ...values })
          .run();
      recordAudit(tx, {
        at: actor.now,
        actorUserId: actor.userId,
        assessmentId,
        action: 'requirement_state.updated',
        entityType: 'requirement_state',
        entityId: requirementId,
        before: row ? before : null,
        after,
        requestId: actor.requestId,
      });
    }

    // No row and nothing to change: the requirement stays empty and nothing is stored.
    const [state] = listRequirementStates(tx, assessmentId, requirementId);
    const requirementStateRow: RequirementState = state ?? {
      requirementId,
      implementationLevel: null,
      implementationStatement: null,
      plannedImplementation: null,
      naRationale: null,
      owner: null,
      updatedAt: actor.now.toISOString(),
    };
    return { requirementState: requirementStateRow, evaluation: evaluateStored(tx, assessmentId) };
  });
}
