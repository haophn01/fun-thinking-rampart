import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../../../db/client';
import { systemRole } from '../../../db/schema';
import type { Actor } from '../../assessment/repository';
import { recordAudit } from '../../audit/record';
import type {
  CreateSystemRoleRequest,
  PatchSystemRoleRequest,
  RolesResponse,
  SystemRole,
} from '../../contract';
import { AppError } from '../../errors';
import { changedFields, newId, requireAssessmentId, type Reader } from '../common';

type RoleRow = typeof systemRole.$inferSelect;
/** The fields a user sets, and what the audit log records. */
type RoleFields = Pick<
  SystemRole,
  'title' | 'person' | 'responsibilities' | 'userCount' | 'privileged'
>;

const ROLE_KEYS = ['title', 'person', 'responsibilities', 'userCount', 'privileged'] as const;

function fieldsOf(row: RoleFields): RoleFields {
  return {
    title: row.title,
    person: row.person,
    responsibilities: row.responsibilities,
    userCount: row.userCount,
    privileged: row.privileged,
  };
}

function toRole(row: RoleRow): SystemRole {
  return { id: row.id, ...fieldsOf(row), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** The live roles of an assessment, by `createdAt` then `id`. */
export function loadSystemRoles(db: Reader, assessmentId: string): SystemRole[] {
  return db
    .select()
    .from(systemRole)
    .where(and(eq(systemRole.assessmentId, assessmentId), isNull(systemRole.removedAt)))
    .orderBy(asc(systemRole.createdAt), asc(systemRole.id))
    .all()
    .map(toRole);
}

/** Sums the users of the given roles, and of the privileged ones among them. */
export function roleTotals(roles: readonly SystemRole[]): RolesResponse['totals'] {
  let users = 0;
  let privilegedUsers = 0;
  for (const role of roles) {
    users += role.userCount;
    if (role.privileged) privilegedUsers += role.userCount;
  }
  return { users, privilegedUsers };
}

/** `GET /api/ssp/roles`. Throws `not_found` when there is no assessment. */
export function listSystemRoles(db: Reader): RolesResponse {
  const roles = loadSystemRoles(db, requireAssessmentId(db));
  return { roles, totals: roleTotals(roles) };
}

/** A live role of the assessment; `not_found` for an unknown or removed one. */
function requireRole(db: Reader, assessmentId: string, id: string): RoleRow {
  const row = db
    .select()
    .from(systemRole)
    .where(
      and(
        eq(systemRole.id, id),
        eq(systemRole.assessmentId, assessmentId),
        isNull(systemRole.removedAt),
      ),
    )
    .get();
  if (!row) throw new AppError('not_found', 'No such system role.');
  return row;
}

function audit(actor: Actor, assessmentId: string, id: string) {
  return {
    at: actor.now,
    actorUserId: actor.userId,
    assessmentId,
    entityType: 'system_role',
    entityId: id,
    requestId: actor.requestId,
  };
}

/** `POST /api/ssp/roles`, audited as `system_role.created` with every field after. */
export function createSystemRole(
  db: AppDb,
  body: CreateSystemRoleRequest,
  actor: Actor,
): SystemRole {
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const id = newId();
    const at = actor.now.toISOString();
    const fields = fieldsOf(body);
    tx.insert(systemRole)
      .values({
        id,
        assessmentId,
        ...fields,
        createdBy: actor.userId,
        createdAt: at,
        updatedBy: actor.userId,
        updatedAt: at,
        removedAt: null,
      })
      .run();
    recordAudit(tx, {
      ...audit(actor, assessmentId, id),
      action: 'system_role.created',
      before: null,
      after: fields,
    });
    return toRole(requireRole(tx, assessmentId, id));
  });
}

/**
 * `PATCH /api/ssp/roles/:id`. Writes and audits only the changed fields; a patch that changes
 * nothing writes neither the row nor an event and keeps `updatedAt`.
 */
export function patchSystemRole(
  db: AppDb,
  id: string,
  body: PatchSystemRoleRequest,
  actor: Actor,
): SystemRole {
  return db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const row = requireRole(tx, assessmentId, id);
    const { before, after } = changedFields<RoleFields>(fieldsOf(row), body, ROLE_KEYS);
    if (Object.keys(after).length === 0) return toRole(row);
    tx.update(systemRole)
      .set({ ...after, updatedBy: actor.userId, updatedAt: actor.now.toISOString() })
      .where(eq(systemRole.id, id))
      .run();
    recordAudit(tx, {
      ...audit(actor, assessmentId, id),
      action: 'system_role.updated',
      before,
      after,
    });
    return toRole(requireRole(tx, assessmentId, id));
  });
}

/** `DELETE /api/ssp/roles/:id`: sets `removed_at`, audited with every field before. */
export function removeSystemRole(db: AppDb, id: string, actor: Actor): void {
  db.transaction((tx) => {
    const assessmentId = requireAssessmentId(tx);
    const row = requireRole(tx, assessmentId, id);
    const at = actor.now.toISOString();
    tx.update(systemRole)
      .set({ removedAt: at, updatedBy: actor.userId, updatedAt: at })
      .where(eq(systemRole.id, id))
      .run();
    recordAudit(tx, {
      ...audit(actor, assessmentId, id),
      action: 'system_role.removed',
      before: fieldsOf(row),
      after: null,
    });
  });
}
