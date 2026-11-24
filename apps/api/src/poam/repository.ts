import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { loadCatalog, type RequirementId } from '@rampart/catalog';
import type { EligibilityResult, Evaluation, RequirementStatus } from '@rampart/rules';
import {
  REGULATION,
  checkPoamEligibility,
  closeoutClock,
  closeoutConfirmer,
} from '@rampart/rules/poam';
import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { AppDb } from '../../db/client';
import { poamItem, user } from '../../db/schema';
import type { Actor } from '../assessment/repository';
import { evaluateStored, findActiveAssessment, loadInput } from '../assessment/repository';
import { recordAudit } from '../audit/record';
import type {
  CloseoutRequest,
  CreatePoamItemRequest,
  Milestone,
  PatchPoamItemRequest,
  PoamItem,
  PoamView,
} from '../contract';
import { AppError } from '../errors';

/** The app's database or a transaction inside it, for reads. */
type Reader = Pick<AppDb, 'select'>;
type AssessmentRow = NonNullable<ReturnType<typeof findActiveAssessment>>;
type PoamRow = typeof poamItem.$inferSelect;

const DAY_MS = 86_400_000;

/** The UTC calendar date of `now`, as `YYYY-MM-DD`: what "today" means everywhere. */
function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Days from `from` to `to`, both `YYYY-MM-DD`. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

let cachedPositions: ReadonlyMap<RequirementId, number> | undefined;

/** Catalog position of every requirement, so lists come back in catalog order. */
function requirementPositions(): ReadonlyMap<RequirementId, number> {
  cachedPositions ??= new Map(loadCatalog().requirements.map((r, i) => [r.id, i]));
  return cachedPositions;
}

function requireAssessment(db: Reader): AssessmentRow {
  const row = findActiveAssessment(db);
  if (!row) throw new AppError('not_found', 'There is no assessment yet. Run setup first.');
  return row;
}

function invalid(path: (string | number)[], message: string): AppError {
  return new AppError('validation_failed', message, { details: [{ path, message }] });
}

/** Where every requirement stands right now: its status and its stored level. */
interface Standing {
  evaluation: Evaluation;
  levels: ReturnType<typeof loadInput>['implementationLevels'];
  /** `closeoutClock` for the assessment's CSD and today, or null without a CSD. */
  deadline: string | null;
  today: string;
}

function standingOf(db: Reader, assessment: AssessmentRow, now: Date): Standing {
  const today = utcDate(now);
  return {
    evaluation: evaluateStored(db, assessment.id),
    levels: loadInput(db, assessment.id).implementationLevels,
    deadline:
      assessment.conditionalStatusDate === null
        ? null
        : closeoutClock(assessment.conditionalStatusDate, today, REGULATION).deadline,
    today,
  };
}

function statusOf(standing: Standing, requirementId: RequirementId): RequirementStatus {
  const outcome = standing.evaluation.outcomes.find((o) => o.requirementId === requirementId);
  return outcome?.status ?? 'not_assessed';
}

function eligibilityOf(standing: Standing, requirementId: RequirementId): EligibilityResult {
  return checkPoamEligibility(
    loadCatalog(),
    {
      requirementId,
      status: statusOf(standing, requirementId),
      implementationLevel: standing.levels[requirementId] ?? null,
    },
    REGULATION,
  );
}

const createdByUser = alias(user, 'created_by_user');
const closedByUser = alias(user, 'closed_by_user');

function selectItems(db: Reader, assessmentId: string, id?: string) {
  return db
    .select({ row: poamItem, owner: user, createdBy: createdByUser, closedBy: closedByUser })
    .from(poamItem)
    .leftJoin(user, eq(user.id, poamItem.ownerUserId))
    .innerJoin(createdByUser, eq(createdByUser.id, poamItem.createdBy))
    .leftJoin(closedByUser, eq(closedByUser.id, poamItem.closedBy))
    .where(
      and(
        eq(poamItem.assessmentId, assessmentId),
        id === undefined ? undefined : eq(poamItem.id, id),
      ),
    )
    .all();
}

type ItemJoin = ReturnType<typeof selectItems>[number];

function parseMilestones(text: string): Milestone[] {
  return JSON.parse(text) as Milestone[];
}

function toItem({ row, owner, createdBy, closedBy }: ItemJoin, standing: Standing): PoamItem {
  const requirementStatus = statusOf(standing, row.requirementId);
  const open = row.status === 'open';
  const daysToDue = daysBetween(standing.today, row.due);
  const closeout =
    row.status === 'closed' && row.closedOn !== null && row.confirmedBy !== null && closedBy
      ? {
          closedOn: row.closedOn,
          note: row.closeoutNote,
          confirmedBy: row.confirmedBy,
          c3paoName: row.c3paoName,
          recordedBy: { id: closedBy.id, displayName: closedBy.displayName },
          late: standing.deadline !== null && row.closedOn > standing.deadline,
        }
      : null;
  return {
    id: row.id,
    requirementId: row.requirementId,
    status: row.status,
    plan: row.plan,
    due: row.due,
    milestones: parseMilestones(row.milestones),
    owner:
      owner === null
        ? null
        : { id: owner.id, displayName: owner.displayName, active: owner.active },
    createdAt: row.createdAt,
    createdBy: { id: createdBy.id, displayName: createdBy.displayName },
    updatedAt: row.updatedAt,
    closeout,
    requirementStatus,
    eligibility: eligibilityOf(standing, row.requirementId),
    daysToDue,
    overdue: open && daysToDue < 0,
    dueAfterDeadline: standing.deadline !== null && row.due > standing.deadline,
    readyToClose: open && requirementStatus === 'met',
  };
}

/** Open items by due then catalog order; then closed items by closeout date, newest first. */
function compareItems(a: PoamItem, b: PoamItem): number {
  if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
  if (a.status === 'open') {
    if (a.due !== b.due) return a.due < b.due ? -1 : 1;
    const positions = requirementPositions();
    return (positions.get(a.requirementId) ?? 0) - (positions.get(b.requirementId) ?? 0);
  }
  const closedA = a.closeout?.closedOn ?? '';
  const closedB = b.closeout?.closedOn ?? '';
  if (closedA !== closedB) return closedA < closedB ? 1 : -1;
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

function readItem(db: Reader, assessment: AssessmentRow, id: string, now: Date): PoamItem {
  const [join] = selectItems(db, assessment.id, id);
  if (!join) throw new AppError('not_found', 'No such POA&M item.');
  return toItem(join, standingOf(db, assessment, now));
}

/** `GET /api/poam`: every item, the Not Met requirements with no open item, and the clock. */
export function readPoamView(db: Reader, now: Date): PoamView {
  const assessment = requireAssessment(db);
  const standing = standingOf(db, assessment, now);
  const items = selectItems(db, assessment.id)
    .map((join) => toItem(join, standing))
    .sort(compareItems);
  const openRequirements = new Set(
    items.filter((i) => i.status === 'open').map((i) => i.requirementId),
  );
  const candidates = standing.evaluation.outcomes
    .filter((o) => o.status === 'not_met' && !openRequirements.has(o.requirementId))
    .map((o) => ({
      requirementId: o.requirementId,
      eligibility: eligibilityOf(standing, o.requirementId),
    }))
    .sort(
      (a, b) =>
        (requirementPositions().get(a.requirementId) ?? 0) -
        (requirementPositions().get(b.requirementId) ?? 0),
    );
  return {
    items,
    candidates,
    closeout:
      assessment.conditionalStatusDate === null
        ? null
        : closeoutClock(assessment.conditionalStatusDate, standing.today, REGULATION),
    confirmer: closeoutConfirmer(assessment.type, REGULATION),
  };
}

/** Every milestone is due on or before the item's `due`. */
function checkMilestonesDue(milestones: readonly Milestone[], due: string): void {
  const index = milestones.findIndex((m) => m.due > due);
  if (index !== -1) {
    throw invalid(['milestones', index, 'due'], "A milestone can't be due after the item.");
  }
}

/** No milestone was done after today. */
function checkMilestonesDone(milestones: readonly Milestone[], today: string): void {
  const index = milestones.findIndex((m) => m.doneOn !== null && m.doneOn > today);
  if (index !== -1) {
    throw invalid(['milestones', index, 'doneOn'], "A milestone can't be done after today.");
  }
}

/** The same rule as requirement owners: an active user, or 400. */
function checkOwner(db: Reader, ownerId: string): void {
  const owner = db.select({ active: user.active }).from(user).where(eq(user.id, ownerId)).get();
  if (owner?.active !== true) throw invalid(['ownerId'], 'The owner must be an active user.');
}

function audit(actor: Actor, assessmentId: string, itemId: string) {
  return {
    at: actor.now,
    actorUserId: actor.userId,
    assessmentId,
    entityType: 'poam_item',
    entityId: itemId,
    requestId: actor.requestId,
  } as const;
}

/**
 * `POST /api/poam`. Throws `validation_failed` for a milestone or owner that breaks the rules,
 * `not_found` for a requirement the catalog doesn't have, `poam_ineligible` with every reason,
 * and `poam_item_exists` when the requirement already has an open item.
 */
export function createPoamItem(db: AppDb, body: CreatePoamItemRequest, actor: Actor): PoamItem {
  checkMilestonesDue(body.milestones, body.due);
  checkMilestonesDone(body.milestones, utcDate(actor.now));
  const ownerId = body.ownerId ?? null;

  return db.transaction((tx) => {
    if (ownerId !== null) checkOwner(tx, ownerId);
    if (!requirementPositions().has(body.requirementId)) {
      throw new AppError('not_found', `No requirement ${body.requirementId} in the catalog.`);
    }
    const assessment = requireAssessment(tx);
    const eligibility = eligibilityOf(standingOf(tx, assessment, actor.now), body.requirementId);
    if (!eligibility.eligible) {
      throw new AppError('poam_ineligible', `${body.requirementId} can't go on a POA&M.`, {
        details: { reasons: eligibility.reasons },
      });
    }
    const existing = tx
      .select({ id: poamItem.id })
      .from(poamItem)
      .where(
        and(
          eq(poamItem.assessmentId, assessment.id),
          eq(poamItem.requirementId, body.requirementId),
          eq(poamItem.status, 'open'),
        ),
      )
      .get();
    if (existing) {
      throw new AppError('poam_item_exists', `${body.requirementId} already has an open item.`, {
        details: { itemId: existing.id },
      });
    }

    const id = randomUUID();
    const stamp = actor.now.toISOString();
    tx.insert(poamItem)
      .values({
        id,
        assessmentId: assessment.id,
        requirementId: body.requirementId,
        plan: body.plan,
        due: body.due,
        milestones: JSON.stringify(body.milestones),
        ownerUserId: ownerId,
        createdBy: actor.userId,
        createdAt: stamp,
        updatedBy: actor.userId,
        updatedAt: stamp,
      })
      .run();
    recordAudit(tx, {
      ...audit(actor, assessment.id, id),
      action: 'poam_item.created',
      before: null,
      after: {
        requirementId: body.requirementId,
        plan: body.plan,
        due: body.due,
        ownerId,
        milestones: body.milestones,
      },
    });
    return readItem(tx, assessment, id, actor.now);
  });
}

function requireOpenItem(db: Reader, assessment: AssessmentRow, id: string): PoamRow {
  const row = db
    .select()
    .from(poamItem)
    .where(and(eq(poamItem.assessmentId, assessment.id), eq(poamItem.id, id)))
    .get();
  if (!row) throw new AppError('not_found', 'No such POA&M item.');
  if (row.status === 'closed') {
    throw new AppError('poam_item_closed', 'This POA&M item is closed, so it takes no changes.');
  }
  return row;
}

interface EditableFields {
  plan: string;
  due: string;
  ownerId: string | null;
  milestones: Milestone[];
}

const EDITABLE_KEYS = ['plan', 'due', 'ownerId', 'milestones'] as const;

/**
 * `PATCH /api/poam/:id`. Milestones are checked against the merged result, so moving `due`
 * earlier than a milestone is refused. Only changed fields are written and audited.
 */
export function patchPoamItem(
  db: AppDb,
  id: string,
  body: PatchPoamItemRequest,
  actor: Actor,
): PoamItem {
  if (body.milestones !== undefined) checkMilestonesDone(body.milestones, utcDate(actor.now));

  return db.transaction((tx) => {
    if (body.ownerId !== undefined && body.ownerId !== null) checkOwner(tx, body.ownerId);
    const assessment = requireAssessment(tx);
    const row = requireOpenItem(tx, assessment, id);
    const current: EditableFields = {
      plan: row.plan,
      due: row.due,
      ownerId: row.ownerUserId,
      milestones: parseMilestones(row.milestones),
    };
    const next: EditableFields = {
      plan: body.plan ?? current.plan,
      due: body.due ?? current.due,
      ownerId: body.ownerId === undefined ? current.ownerId : body.ownerId,
      milestones: body.milestones ?? current.milestones,
    };
    checkMilestonesDue(next.milestones, next.due);

    const before: Partial<EditableFields> = {};
    const after: Partial<EditableFields> = {};
    for (const key of EDITABLE_KEYS) {
      if (!isDeepStrictEqual(current[key], next[key])) {
        Object.assign(before, { [key]: current[key] });
        Object.assign(after, { [key]: next[key] });
      }
    }
    if (Object.keys(after).length > 0) {
      tx.update(poamItem)
        .set({
          plan: next.plan,
          due: next.due,
          ownerUserId: next.ownerId,
          milestones: JSON.stringify(next.milestones),
          updatedBy: actor.userId,
          updatedAt: actor.now.toISOString(),
        })
        .where(eq(poamItem.id, id))
        .run();
      recordAudit(tx, {
        ...audit(actor, assessment.id, id),
        action: 'poam_item.updated',
        before,
        after,
      });
    }
    return readItem(tx, assessment, id, actor.now);
  });
}

/**
 * `POST /api/poam/:id/closeout` (admin). The requirement must be Met; `closedOn` lies between
 * the day the item was created and today; the confirmer follows the assessment's type, and a
 * C3PAO assessment needs the C3PAO's name while a self-assessment takes none.
 */
export function closeoutPoamItem(
  db: AppDb,
  id: string,
  body: CloseoutRequest,
  actor: Actor,
): PoamItem {
  const today = utcDate(actor.now);
  if (body.closedOn > today) throw invalid(['closedOn'], "The closeout can't be after today.");

  return db.transaction((tx) => {
    const assessment = requireAssessment(tx);
    const row = requireOpenItem(tx, assessment, id);
    if (body.closedOn < row.createdAt.slice(0, 10)) {
      throw invalid(['closedOn'], "The closeout can't be before the item was created.");
    }
    const confirmedBy = closeoutConfirmer(assessment.type, REGULATION);
    const c3paoName = body.c3paoName ?? null;
    if (confirmedBy === 'c3pao' && c3paoName === null) {
      throw invalid(['c3paoName'], 'A C3PAO assessment needs the name of the C3PAO.');
    }
    if (confirmedBy === 'organization' && c3paoName !== null) {
      throw invalid(
        ['c3paoName'],
        'A self-assessment is confirmed by the organization, not a C3PAO.',
      );
    }
    const requirementStatus = statusOf(standingOf(tx, assessment, actor.now), row.requirementId);
    if (requirementStatus !== 'met') {
      throw new AppError(
        'closeout_not_ready',
        `${row.requirementId} must be Met before its item can be closed.`,
        { details: { requirementStatus } },
      );
    }

    tx.update(poamItem)
      .set({
        status: 'closed',
        closedOn: body.closedOn,
        closeoutNote: body.note,
        confirmedBy,
        c3paoName,
        closedBy: actor.userId,
        updatedBy: actor.userId,
        updatedAt: actor.now.toISOString(),
      })
      .where(eq(poamItem.id, id))
      .run();
    recordAudit(tx, {
      ...audit(actor, assessment.id, id),
      action: 'poam_item.closed',
      before: { status: 'open' },
      after: { status: 'closed', closedOn: body.closedOn, note: body.note, confirmedBy, c3paoName },
    });
    return readItem(tx, assessment, id, actor.now);
  });
}
