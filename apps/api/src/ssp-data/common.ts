import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppDb } from '../../db/client';
import { findActiveAssessment, type Actor } from '../assessment/repository';
import { AppError } from '../errors';
import type { ApiDeps } from '../routes';

// Helpers every `ssp-data` module shares, so the SSP data routes stop copying them. Older modules
// keep their own copies.

/** The app's database or a transaction inside it, for reads. */
export type Reader = Pick<AppDb, 'select'>;

/** The active assessment's ID (the earliest-created assessment); `not_found` when there is none. */
export function requireAssessmentId(db: Reader): string {
  const row = findActiveAssessment(db);
  if (!row) throw new AppError('not_found', 'There is no assessment yet. Run setup first.');
  return row.id;
}

/** The UTC calendar date of `now`, as `YYYY-MM-DD`: what "today" means everywhere. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The fields in `keys` whose value in `next` differs from `current`, before and after. An
 * undefined value in `next` means "not sent" and is skipped; `null` is a value like any other.
 */
export function changedFields<T extends Record<string, unknown>>(
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

/** A new row ID: a random v4 UUID. */
export function newId(): string {
  return randomUUID();
}

/**
 * The signed-in writer: the user, the app clock's now and the request id. The guard has already
 * refused a request without a session; this throws `unauthenticated` if one gets through.
 */
export function actorOf(request: FastifyRequest, deps: ApiDeps): Actor {
  if (!request.auth) throw new AppError('unauthenticated', 'Sign in to continue.');
  return { userId: request.auth.user.id, now: deps.now(), requestId: request.id };
}
