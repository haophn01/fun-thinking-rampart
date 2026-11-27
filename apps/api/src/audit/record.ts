import { isDeepStrictEqual } from 'node:util';
import type { AppDb } from '../../db/client';
import { auditEvent } from '../../db/schema';
import { auditHash, latestAuditHash } from './chain';

/** One change to record. `before` and `after` hold only the fields that changed. */
export interface AuditEventInput {
  /** From the app clock (`buildApp({ now })`), stored as an ISO timestamp. */
  at: Date;
  /** The signed-in user, or null when there is none. */
  actorUserId: string | null;
  assessmentId?: string | null;
  /** One of the contract's `AUDIT_ACTIONS`. */
  action: string;
  /** One of the contract's `AUDIT_ENTITY_TYPES`. */
  entityType: string;
  /** The objective ID, requirement ID, user ID or assessment ID. */
  entityId: string;
  /** Null on create. */
  before: unknown;
  after: unknown;
  requestId?: string | null;
}

/** The app's database or a transaction from `db.transaction(...)`. It reads the chain's newest hash. */
export type AuditWriter = Pick<AppDb, 'insert' | 'select'>;

/** Keys removed from `before` and `after` at any depth, so secrets never reach the audit log. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwordHash',
  'token',
  'csrfToken',
  // The column spellings, in case a caller passes a raw row.
  'password_hash',
  'csrf_token',
]);

/**
 * Appends one audit event and returns its id. Pass the caller's transaction so the event and
 * the change commit or roll back together; an insert failure throws, which rolls both back.
 * The event joins the hash chain: `prev_hash` is the newest hashed event's hash (null for the
 * first), read in the same transaction, and `hash` is `auditHash` of the stored values.
 *
 * Returns null and writes nothing when `before` and `after` are both set and deep-equal (as JSON:
 * key order and undefined keys don't count), so repeating a write is free. An event where both
 * are null (a sign-in, a password reset) has nothing to compare and is always written. The
 * comparison runs before secrets are stripped, so a change only to a secret is still recorded.
 */
export function recordAudit(db: AuditWriter, event: AuditEventInput): number | null {
  const at = event.at.toISOString();
  const before = toJson(event.before);
  const after = toJson(event.after);
  if (before !== null && after !== null && isDeepStrictEqual(before, after)) return null;

  const fields = {
    prevHash: latestAuditHash(db),
    at,
    actorUserId: event.actorUserId,
    assessmentId: event.assessmentId ?? null,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    before: before === null ? null : JSON.stringify(stripSecrets(before)),
    after: after === null ? null : JSON.stringify(stripSecrets(after)),
    requestId: event.requestId ?? null,
  };
  const result = db
    .insert(auditEvent)
    .values({ ...fields, hash: auditHash(fields) })
    .run();
  return Number(result.lastInsertRowid);
}

/** Returns a copy of `value` with every `SECRET_KEYS` key removed, at any depth. */
export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SECRET_KEYS.has(key))
        .map(([key, child]) => [key, stripSecrets(child)]),
    );
  }
  return value;
}

/** The value as JSON would store it (undefined becomes null). Throws TypeError on a cycle. */
function toJson(value: unknown): unknown {
  const text = JSON.stringify(value) as string | undefined;
  return text === undefined ? null : (JSON.parse(text) as unknown);
}
