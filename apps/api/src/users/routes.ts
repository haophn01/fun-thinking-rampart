import { randomUUID } from 'node:crypto';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { user } from '../../db/schema';
import { recordAudit } from '../audit/record';
import { clearSessionCookie } from '../auth/cookie';
import { clearFailures } from '../auth/lockout';
import { resetMfa } from '../auth/mfa/reset';
import { hashPassword } from '../auth/password';
import { checkNewPassword, pushPasswordHistory } from '../auth/password-policy';
import { deleteUserSessions, type SessionStore } from '../auth/sessions';
import {
  createUserRequestSchema,
  updateUserRequestSchema,
  userResponseSchema,
  usersResponseSchema,
  type User,
} from '../contract';
import { AppError } from '../errors';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';

type UserRow = typeof user.$inferSelect;

/** The fields `PATCH /api/users/:id` changes and the audit log records (never the password). */
const PROFILE_KEYS = ['displayName', 'role', 'active'] as const;
type Profile = Pick<UserRow, (typeof PROFILE_KEYS)[number]>;

const paramsSchema = z.object({ id: z.string() });

/** The public shape: no hash, no lockout state, no MFA secret (only whether it is set up). */
function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    active: row.active,
    createdAt: row.createdAt,
    mfaEnrolled: row.mfaEnrolledAt !== null,
  };
}

function findUser(db: SessionStore, id: string): UserRow | undefined {
  return db.select().from(user).where(eq(user.id, id)).get();
}

function notFound(): AppError {
  return new AppError('not_found', 'No such user.');
}

/** Active admins other than `userId`. */
function otherActiveAdmins(db: SessionStore, userId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(user)
    .where(and(eq(user.role, 'admin'), eq(user.active, true), ne(user.id, userId)))
    .get();
  return row?.n ?? 0;
}

/** The profile fields the request sets to a new value, before and after. */
export function profileChanges(
  current: Profile,
  requested: { [K in keyof Profile]?: Profile[K] | undefined },
): { before: Partial<Profile>; after: Partial<Profile> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of PROFILE_KEYS) {
    const next = requested[key];
    if (next !== undefined && next !== current[key]) {
      before[key] = current[key];
      after[key] = next;
    }
  }
  return { before, after };
}

async function createUser(deps: ApiDeps, request: FastifyRequest): Promise<UserRow> {
  const body = createUserRequestSchema.parse(request.body);
  checkNewPassword(body.password);
  const taken = () => new AppError('email_taken', 'That email is already used.');
  if (deps.db.select({ id: user.id }).from(user).where(eq(user.email, body.email)).get()) {
    throw taken();
  }
  const passwordHash = await hashPassword(body.password);
  const now = deps.now();
  const at = now.toISOString();
  return deps.db.transaction((tx) => {
    if (tx.select({ id: user.id }).from(user).where(eq(user.email, body.email)).get()) {
      throw taken();
    }
    const id = randomUUID();
    const created = {
      email: body.email,
      displayName: body.displayName,
      role: body.role,
      active: true,
    };
    // An admin-set password is temporary: the user chooses their own at first sign-in.
    tx.insert(user)
      .values({
        id,
        ...created,
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: at,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    recordAudit(tx, {
      at: now,
      actorUserId: request.auth?.user.id ?? null,
      action: 'user.created',
      entityType: 'user',
      entityId: id,
      before: null,
      after: created,
      requestId: request.id,
    });
    const row = findUser(tx, id);
    if (!row) throw new Error('created user is missing');
    return row;
  });
}

async function updateUser(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<UserRow> {
  const { id } = paramsSchema.parse(request.params);
  const body = updateUserRequestSchema.parse(request.body);
  if (!findUser(deps.db, id)) throw notFound();
  if (body.password !== undefined) checkNewPassword(body.password);
  const passwordHash = body.password === undefined ? null : await hashPassword(body.password);
  const now = deps.now();
  const actorUserId = request.auth?.user.id ?? null;

  const { row, endedOwnSession } = deps.db.transaction((tx) => {
    const current = findUser(tx, id);
    if (!current) throw notFound();
    const { before, after } = profileChanges(current, body);
    const changed = Object.keys(after).length > 0;
    if (!changed && passwordHash === null) return { row: current, endedOwnSession: false };

    const losesAdmin = after.role === 'contributor' || after.active === false;
    if (current.role === 'admin' && current.active && losesAdmin) {
      if (otherActiveAdmins(tx, id) === 0) {
        throw new AppError('last_admin', 'At least one active admin must remain.');
      }
    }

    if (passwordHash !== null) {
      // A reset is temporary and remembered: the replaced hash goes to history, the user must
      // choose their own at next sign-in, and a lockout lifts so the new password works at once.
      pushPasswordHistory(tx, id, current.passwordHash, now);
      clearFailures(tx, id);
    }
    tx.update(user)
      .set({
        ...after,
        ...(passwordHash === null
          ? {}
          : { passwordHash, mustChangePassword: true, passwordChangedAt: now.toISOString() }),
        updatedAt: now.toISOString(),
      })
      .where(eq(user.id, id))
      .run();
    if (changed) {
      recordAudit(tx, {
        at: now,
        actorUserId,
        action: 'user.updated',
        entityType: 'user',
        entityId: id,
        before,
        after,
        requestId: request.id,
      });
    }
    if (passwordHash !== null) {
      recordAudit(tx, {
        at: now,
        actorUserId,
        action: 'user.password_reset',
        entityType: 'user',
        entityId: id,
        before: null,
        after: null,
        requestId: request.id,
      });
    }
    // A reset, a deactivation or a real role change signs the user out everywhere.
    const endsSessions =
      passwordHash !== null || after.active === false || after.role !== undefined;
    if (endsSessions) deleteUserSessions(tx, id);
    const updated = findUser(tx, id);
    if (!updated) throw notFound();
    return { row: updated, endedOwnSession: endsSessions && id === actorUserId };
  });
  if (endedOwnSession) {
    clearSessionCookie(reply, deps);
  }
  return row;
}

/**
 * `POST /api/users/:id/mfa/reset`: clears the user's two-step sign-in and ends all their sessions
 * (clearing the cookie when they are the caller). Nothing stored: 200 with nothing changed.
 */
function resetUserMfa(deps: ApiDeps, request: FastifyRequest, reply: FastifyReply): UserRow {
  const { id } = paramsSchema.parse(request.params);
  const actorUserId = request.auth?.user.id ?? null;
  const now = deps.now();
  const { row, changed } = deps.db.transaction((tx) => {
    if (!findUser(tx, id)) throw notFound();
    const changed = resetMfa(tx, id, { actorUserId, requestId: request.id, now });
    const updated = findUser(tx, id);
    if (!updated) throw notFound();
    return { row: updated, changed };
  });
  if (changed && id === actorUserId) clearSessionCookie(reply, deps);
  return row;
}

/** Users: any signed-in user lists them; only admins create or change them. Never deleted. */
export function registerUserRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/users', () => {
    const rows = deps.db
      .select()
      .from(user)
      .orderBy(sql`${user.displayName} collate nocase`, asc(user.displayName), asc(user.email))
      .all();
    return respond(usersResponseSchema, { users: rows.map(toUser) });
  });

  app.post('/api/users', { config: { role: 'admin' } }, async (request, reply) => {
    const row = await createUser(deps, request);
    return reply.code(201).send(respond(userResponseSchema, { user: toUser(row) }));
  });

  app.patch('/api/users/:id', { config: { role: 'admin' } }, async (request, reply) => {
    const row = await updateUser(deps, request, reply);
    return respond(userResponseSchema, { user: toUser(row) });
  });

  app.post('/api/users/:id/mfa/reset', { config: { role: 'admin' } }, (request, reply) => {
    const row = resetUserMfa(deps, request, reply);
    return respond(userResponseSchema, { user: toUser(row) });
  });
}
