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
  'poam_item.created',
  'poam_item.updated',
  'poam_item.closed',
  'evidence.created',
  'evidence.updated',
  'evidence.links_updated',
  'evidence.version_added',
  'policy.created',
  'policy.updated',
  'policy.links_updated',
  'policy.version_added',
  'system_profile.updated',
  'ssp_profile.updated',
  'system_role.created',
  'system_role.updated',
  'system_role.removed',
  'asset.created',
  'asset.updated',
  'asset.removed',
  'service_provider.created',
  'service_provider.updated',
  'service_provider.removed',
  'responsibility.updated',
  'diagram_link.created',
  'diagram_link.updated',
  'diagram_link.removed',
  'ssp_revision.created',
  'ssp_approval.created',
  'ssp_approval.updated',
  'ssp_approval.removed',
  'auth.password_changed',
  'auth.session_locked',
  'auth.session_unlocked',
  'auth.notice_acknowledged',
  'settings.updated',
  'auth.mfa_enrolled',
  'auth.mfa_verified',
  'user.mfa_reset',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = [
  'user',
  'assessment',
  'objective_result',
  'requirement_state',
  /** The entity ID is the row's UUID for these three. */
  'poam_item',
  'evidence_item',
  'policy',
  /** The entity ID is the assessment ID: one profile per assessment. */
  'system_profile',
  /** The entity ID is the assessment ID: one SSP profile per assessment. */
  'ssp_profile',
  /** The entity ID is the row's UUID, except for `responsibility`. */
  'system_role',
  'asset',
  'service_provider',
  /** The entity ID is the requirement ID: one row per requirement. */
  'responsibility',
  'diagram_link',
  'ssp_revision',
  'ssp_approval',
  /** The entity ID names the setting: `sign_in_notice`. */
  'settings',
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
