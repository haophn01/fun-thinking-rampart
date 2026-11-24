import { z } from 'zod';
import { userRefSchema } from './common';

export const AUDIT_ACTIONS = [
  'user.created',
  'user.updated',
  'user.password_reset',
  'auth.signed_in',
  'auth.signed_out',
  'auth.locked_out',
  'assessment.created',
  'assessment.updated',
  'objective_result.updated',
  'requirement_state.updated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = [
  'user',
  'assessment',
  'objective_result',
  'requirement_state',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/** One append-only audit record. `before` and `after` hold only the changed fields. */
export const auditEventSchema = z.object({
  id: z.number().int(),
  at: z.iso.datetime(),
  actor: userRefSchema.nullable(),
  action: z.enum(AUDIT_ACTIONS),
  entityType: z.enum(AUDIT_ENTITY_TYPES),
  entityId: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  requestId: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** `GET /api/audit` query string. Values arrive as strings and are coerced. */
export const auditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().min(1).optional(),
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: z.string().min(1).max(64).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** `GET /api/audit`: newest first; `nextBefore` pages to older events and is `null` at the end. */
export const auditPageSchema = z.object({
  events: z.array(auditEventSchema),
  nextBefore: z.number().int().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;
