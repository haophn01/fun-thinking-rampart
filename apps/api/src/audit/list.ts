import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDb } from '../../db/client';
import { auditEvent, user } from '../../db/schema';
import { auditPageSchema, auditQuerySchema, type AuditPage, type AuditQuery } from '../contract';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';

function parseJson(text: string | null): unknown {
  return text === null ? null : (JSON.parse(text) as unknown);
}

/**
 * One page of the audit log, newest first (id desc). `nextBefore` is the last id on the page when
 * older matching events exist, so `?before=<nextBefore>` reads the next page; otherwise null.
 */
export function listAudit(db: Pick<AppDb, 'select'>, query: AuditQuery): AuditPage {
  const filters: SQL[] = [];
  if (query.before !== undefined) filters.push(lt(auditEvent.id, query.before));
  if (query.entityType !== undefined) filters.push(eq(auditEvent.entityType, query.entityType));
  if (query.entityId !== undefined) filters.push(eq(auditEvent.entityId, query.entityId));

  const rows = db
    .select({ event: auditEvent, actorName: user.displayName })
    .from(auditEvent)
    .leftJoin(user, eq(user.id, auditEvent.actorUserId))
    .where(and(...filters))
    .orderBy(desc(auditEvent.id))
    // One extra row says whether an older page exists.
    .limit(query.limit + 1)
    .all();

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    events: page.map(({ event, actorName }) => ({
      id: event.id,
      at: event.at,
      actor:
        event.actorUserId === null ? null : { id: event.actorUserId, displayName: actorName ?? '' },
      action: event.action as AuditPage['events'][number]['action'],
      entityType: event.entityType as AuditPage['events'][number]['entityType'],
      entityId: event.entityId,
      before: parseJson(event.before),
      after: parseJson(event.after),
      requestId: event.requestId,
    })),
    nextBefore: rows.length > query.limit && last ? last.event.id : null,
  };
}

/** `GET /api/audit`: any signed-in user. */
export function registerAuditRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/audit', (request) =>
    respond(auditPageSchema, listAudit(deps.db, auditQuerySchema.parse(request.query))),
  );
}
