import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../../../db/client';
import { sspApproval, sspProfile, sspRevision, user } from '../../../db/schema';
import type { Actor } from '../../assessment/repository';
import { recordAudit } from '../../audit/record';
import {
  DEFAULT_REVIEW_CADENCE_MONTHS,
  type CreateApprovalRequest,
  type CreateRevisionRequest,
  type DocumentControl,
  type PatchApprovalRequest,
  type RevisionKind,
  type SspApproval,
  type SspRevision,
} from '../../contract';
import { AppError } from '../../errors';
import { changedFields, newId, requireAssessmentId, utcDate, type Reader } from '../common';
import { reviewStatus } from './review';

/** The app's database or a transaction inside it, for writes that also read. */
type Writer = Pick<AppDb, 'select' | 'insert'>;
type RevisionRow = typeof sspRevision.$inferSelect;
type ApprovalRow = typeof sspApproval.$inferSelect;

const APPROVAL_KEYS = ['name', 'title', 'approvedOn'] as const;
type ApprovalFields = Pick<ApprovalRow, (typeof APPROVAL_KEYS)[number]>;

function toRevision(row: RevisionRow): SspRevision {
  return {
    id: row.id,
    kind: row.kind,
    date: row.revisedOn,
    description: row.description,
    madeBy: row.madeBy,
    createdAt: row.createdAt,
  };
}

function toApproval(row: ApprovalRow): SspApproval {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    approvedOn: row.approvedOn,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function approvalFields(row: ApprovalFields): ApprovalFields {
  return { name: row.name, title: row.title, approvedOn: row.approvedOn };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Refuses a date after the UTC today of `now` with a 400 on `field`. Runs before any lookup, as
 * the contract's check order puts body errors before 404.
 */
function refuseFuture(
  date: string | null | undefined,
  now: Date,
  field: string,
  label: string,
): void {
  if (date === null || date === undefined || date <= utcDate(now)) return;
  throw new AppError('validation_failed', `The ${label} can't be after today.`, {
    details: [{ path: [field], message: 'Must be today or earlier' }],
  });
}

/**
 * The profile's review settings. The `ssp_profile` row may not exist yet: then the cadence is the
 * contract's default and there is no stored next review date.
 */
function reviewSettings(
  db: Reader,
  assessmentId: string,
): { reviewCadenceMonths: number; nextReviewDate: string | null } {
  const row = db
    .select({
      reviewCadenceMonths: sspProfile.reviewCadenceMonths,
      nextReviewDate: sspProfile.nextReviewDate,
    })
    .from(sspProfile)
    .where(eq(sspProfile.assessmentId, assessmentId))
    .get();
  return row ?? { reviewCadenceMonths: DEFAULT_REVIEW_CADENCE_MONTHS, nextReviewDate: null };
}

function liveApprovals(db: Reader, assessmentId: string): ApprovalRow[] {
  return db
    .select()
    .from(sspApproval)
    .where(and(eq(sspApproval.assessmentId, assessmentId), isNull(sspApproval.removedAt)))
    .all()
    .sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
}

/** `GET /api/ssp/document-control`: revisions, live approvals and the review schedule. */
export function loadDocumentControl(db: Reader, now: Date): DocumentControl {
  const assessmentId = requireAssessmentId(db);
  const settings = reviewSettings(db, assessmentId);
  const approvals = liveApprovals(db, assessmentId);
  const revisions = db
    .select()
    .from(sspRevision)
    .where(eq(sspRevision.assessmentId, assessmentId))
    .all()
    .sort(
      (a, b) =>
        compare(a.revisedOn, b.revisedOn) ||
        compare(a.createdAt, b.createdAt) ||
        compare(a.id, b.id),
    );
  return {
    ...settings,
    ...reviewStatus({
      ...settings,
      approvalDates: approvals.map((row) => row.approvedOn),
      today: utcDate(now),
    }),
    revisions: revisions.map(toRevision),
    approvals: approvals.map(toApproval),
  };
}

function displayNameOf(db: Reader, userId: string): string {
  const row = db
    .select({ displayName: user.displayName })
    .from(user)
    .where(eq(user.id, userId))
    .get();
  if (!row) throw new Error(`no user ${userId} for a revision`);
  return row.displayName;
}

function insertRevision(
  tx: Writer,
  assessmentId: string,
  actor: Actor,
  entry: { kind: RevisionKind; date: string; description: string; madeBy: string | undefined },
): SspRevision {
  const row: RevisionRow = {
    id: newId(),
    assessmentId,
    kind: entry.kind,
    revisedOn: entry.date,
    description: entry.description,
    madeBy: entry.madeBy ?? displayNameOf(tx, actor.userId),
    createdBy: actor.userId,
    createdAt: actor.now.toISOString(),
  };
  tx.insert(sspRevision).values(row).run();
  const revision = toRevision(row);
  recordAudit(tx, {
    at: actor.now,
    actorUserId: actor.userId,
    assessmentId,
    action: 'ssp_revision.created',
    entityType: 'ssp_revision',
    entityId: row.id,
    requestId: actor.requestId,
    before: null,
    after: {
      kind: revision.kind,
      date: revision.date,
      description: revision.description,
      madeBy: revision.madeBy,
    },
  });
  return revision;
}

/** `POST /api/ssp/revisions`: a manual entry dated today or earlier. Revisions never change. */
export function createRevision(db: AppDb, body: CreateRevisionRequest, actor: Actor): SspRevision {
  refuseFuture(body.date, actor.now, 'date', 'revision date');
  return db.transaction((tx) =>
    insertRevision(tx, requireAssessmentId(tx), actor, {
      kind: 'manual',
      date: body.date,
      description: body.description,
      madeBy: body.madeBy,
    }),
  );
}

/**
 * Appends an `export` revision dated the UTC today, made by the actor's display name, with its
 * `ssp_revision.created` event, inside the caller's transaction: if the export rolls back, so do
 * both. Each call adds an entry.
 */
export function appendExportRevision(
  tx: Writer,
  input: { assessmentId: string; actor: Actor; description: string },
): SspRevision {
  return insertRevision(tx, input.assessmentId, input.actor, {
    kind: 'export',
    date: utcDate(input.actor.now),
    description: input.description,
    madeBy: undefined,
  });
}

function auditApproval(assessmentId: string, id: string, actor: Actor) {
  return {
    at: actor.now,
    actorUserId: actor.userId,
    assessmentId,
    entityType: 'ssp_approval',
    entityId: id,
    requestId: actor.requestId,
  };
}

function requireApproval(db: Reader, assessmentId: string, id: string): ApprovalRow {
  const row = db
    .select()
    .from(sspApproval)
    .where(
      and(
        eq(sspApproval.assessmentId, assessmentId),
        eq(sspApproval.id, id),
        isNull(sspApproval.removedAt),
      ),
    )
    .get();
  if (!row) throw new AppError('not_found', 'No such approval.');
  return row;
}

/** `POST /api/ssp/approvals` (admin). */
export function createApproval(db: AppDb, body: CreateApprovalRequest, actor: Actor): SspApproval {
  refuseFuture(body.approvedOn, actor.now, 'approvedOn', 'approval date');
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const stamp = actor.now.toISOString();
    const row: ApprovalRow = {
      id: newId(),
      assessmentId,
      name: body.name,
      title: body.title,
      approvedOn: body.approvedOn,
      createdBy: actor.userId,
      createdAt: stamp,
      updatedBy: actor.userId,
      updatedAt: stamp,
      removedAt: null,
    };
    tx.insert(sspApproval).values(row).run();
    recordAudit(tx, {
      ...auditApproval(assessmentId, row.id, actor),
      action: 'ssp_approval.created',
      before: null,
      after: approvalFields(row),
    });
    return toApproval(row);
  });
}

/** `PATCH /api/ssp/approvals/:id` (admin): only changed fields are written; a no-op writes nothing. */
export function patchApproval(
  db: AppDb,
  id: string,
  body: PatchApprovalRequest,
  actor: Actor,
): SspApproval {
  refuseFuture(body.approvedOn, actor.now, 'approvedOn', 'approval date');
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const current = requireApproval(tx, assessmentId, id);
    const { before, after } = changedFields(approvalFields(current), body, APPROVAL_KEYS);
    if (Object.keys(after).length === 0) return toApproval(current);
    const stamp = actor.now.toISOString();
    tx.update(sspApproval)
      .set({ ...after, updatedBy: actor.userId, updatedAt: stamp })
      .where(eq(sspApproval.id, id))
      .run();
    recordAudit(tx, {
      ...auditApproval(assessmentId, id, actor),
      action: 'ssp_approval.updated',
      before,
      after,
    });
    return toApproval({ ...current, ...after, updatedBy: actor.userId, updatedAt: stamp });
  });
}

/** `DELETE /api/ssp/approvals/:id` (admin): a soft removal; a second one is a 404. */
export function removeApproval(db: AppDb, id: string, actor: Actor): void {
  db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const current = requireApproval(tx, assessmentId, id);
    tx.update(sspApproval)
      .set({ removedAt: actor.now.toISOString() })
      .where(eq(sspApproval.id, id))
      .run();
    recordAudit(tx, {
      ...auditApproval(assessmentId, id, actor),
      action: 'ssp_approval.removed',
      before: approvalFields(current),
      after: null,
    });
  });
}
