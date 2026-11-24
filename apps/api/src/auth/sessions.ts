import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { session, user } from '../../db/schema';
import type { SessionUser } from '../contract';

/** A session ends 2 h after its last request. */
export const IDLE_LIMIT_MS = 2 * 60 * 60 * 1000;
/** A session ends 12 h after sign-in, however busy. */
export const ABSOLUTE_LIMIT_MS = 12 * 60 * 60 * 1000;
/** The cookie's Max-Age, equal to the absolute limit. */
export const SESSION_MAX_AGE_SECONDS = ABSOLUTE_LIMIT_MS / 1000;

/** The app's database or a transaction from `db.transaction(...)`. */
export type SessionStore = Pick<AppDb, 'insert' | 'select' | 'update' | 'delete'>;

/** A valid session with its user as they are now (role changes apply on the next request). */
export interface ActiveSession {
  /** The stored id: SHA-256 hex of the cookie's token. */
  id: string;
  csrfToken: string;
  user: SessionUser;
}

/** 32 random bytes as base64url: always 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores in place of a session token. */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Whether a session last seen at `lastSeenAt` and made at `createdAt` has ended at `now`. */
export function isExpired(times: { createdAt: string; lastSeenAt: string }, now: Date): boolean {
  const at = now.getTime();
  return (
    at - Date.parse(times.lastSeenAt) >= IDLE_LIMIT_MS ||
    at - Date.parse(times.createdAt) >= ABSOLUTE_LIMIT_MS
  );
}

/** Starts a session for `userId`. Returns the cookie token (never stored) and the CSRF token. */
export function createSession(
  db: SessionStore,
  userId: string,
  now: Date,
): { token: string; csrfToken: string; id: string } {
  const token = randomToken();
  const csrfToken = randomToken();
  const id = tokenDigest(token);
  const at = now.toISOString();
  db.insert(session).values({ id, userId, csrfToken, createdAt: at, lastSeenAt: at }).run();
  return { token, csrfToken, id };
}

/**
 * The session a cookie token names, or null. An expired session, or one whose user is inactive,
 * is deleted. A live one has `last_seen_at` moved to `now`.
 */
export function resolveSession(
  db: SessionStore,
  token: string | undefined,
  now: Date,
): ActiveSession | null {
  if (token === undefined || !TOKEN.test(token)) return null;
  const id = tokenDigest(token);
  const row = db
    .select({
      id: session.id,
      csrfToken: session.csrfToken,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      active: user.active,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(eq(session.id, id))
    .get();
  if (!row) return null;
  if (!row.active || isExpired(row, now)) {
    deleteSession(db, id);
    return null;
  }
  db.update(session).set({ lastSeenAt: now.toISOString() }).where(eq(session.id, id)).run();
  return {
    id,
    csrfToken: row.csrfToken,
    user: { id: row.userId, email: row.email, displayName: row.displayName, role: row.role },
  };
}

/** Deletes the session a cookie token names, if any. */
export function deleteSessionByToken(db: SessionStore, token: string | undefined): void {
  if (token !== undefined && TOKEN.test(token)) deleteSession(db, tokenDigest(token));
}

export function deleteSession(db: SessionStore, id: string): void {
  db.delete(session).where(eq(session.id, id)).run();
}

/** Ends every session a user has (deactivation, password reset). */
export function deleteUserSessions(db: SessionStore, userId: string): void {
  db.delete(session).where(eq(session.userId, userId)).run();
}

/** Compares a request's CSRF header with the session's token in constant time. */
export function csrfMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
