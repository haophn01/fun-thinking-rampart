import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { session, user } from '../../db/schema';
import { SESSION_ABSOLUTE_LIMIT_MS, SESSION_IDLE_LIMIT_MS, type SessionUser } from '../contract';

/** A session ends 30 min after its last unlocked request. */
export const IDLE_LIMIT_MS = SESSION_IDLE_LIMIT_MS;
/** A session ends 8 h after sign-in, however busy. */
export const ABSOLUTE_LIMIT_MS = SESSION_ABSOLUTE_LIMIT_MS;
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
  /** Locked: only lock, unlock and the public routes answer until the password is entered. */
  locked: boolean;
  /** The password is temporary: only the session routes answer until it is changed. */
  mustChangePassword: boolean;
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

/** A new session: the cookie token (never stored), its CSRF token and the stored id. */
export interface NewSession {
  token: string;
  csrfToken: string;
  id: string;
}

/**
 * Starts a session for `userId`. `createdAt` defaults to `now`; rotation passes the old one so
 * the absolute limit still counts from sign-in.
 */
export function createSession(
  db: SessionStore,
  userId: string,
  now: Date,
  createdAt: string = now.toISOString(),
): NewSession {
  const token = randomToken();
  const csrfToken = randomToken();
  const id = tokenDigest(token);
  db.insert(session)
    .values({ id, userId, csrfToken, createdAt, lastSeenAt: now.toISOString() })
    .run();
  return { token, csrfToken, id };
}

/**
 * Replaces a session with one for the same user: a new token, a new CSRF token and the same
 * `created_at`, so the 8 h limit still counts from sign-in. Null when the session is gone. The
 * caller sets the cookie to the returned token.
 */
export function rotateSession(db: SessionStore, sessionId: string, now: Date): NewSession | null {
  const row = db
    .select({ userId: session.userId, createdAt: session.createdAt })
    .from(session)
    .where(eq(session.id, sessionId))
    .get();
  if (!row) return null;
  deleteSession(db, sessionId);
  return createSession(db, row.userId, now, row.createdAt);
}

/**
 * The session a cookie token names, or null. An expired session, or one whose user is inactive,
 * is deleted. A live, unlocked one has `last_seen_at` moved to `now`; a locked one keeps it, so it
 * ends 30 min after its last unlocked request however often it is polled.
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
      lockedAt: session.lockedAt,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      active: user.active,
      mustChangePassword: user.mustChangePassword,
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
  const locked = row.lockedAt !== null;
  if (!locked) {
    db.update(session).set({ lastSeenAt: now.toISOString() }).where(eq(session.id, id)).run();
  }
  return {
    id,
    csrfToken: row.csrfToken,
    user: { id: row.userId, email: row.email, displayName: row.displayName, role: row.role },
    locked,
    mustChangePassword: row.mustChangePassword,
  };
}

/** Locks a session. Returns true only when it was unlocked, so a repeat records nothing. */
export function lockSession(db: SessionStore, id: string, now: Date): boolean {
  const result = db
    .update(session)
    .set({ lockedAt: now.toISOString() })
    .where(and(eq(session.id, id), isNull(session.lockedAt)))
    .run();
  return result.changes > 0;
}

/**
 * Unlocks a session and moves `last_seen_at` to `now`. Returns true only when it was locked.
 * The token stays: tabs share the cookie.
 */
export function unlockSession(db: SessionStore, id: string, now: Date): boolean {
  const row = db
    .select({ lockedAt: session.lockedAt })
    .from(session)
    .where(eq(session.id, id))
    .get();
  db.update(session)
    .set({ lockedAt: null, lastSeenAt: now.toISOString() })
    .where(eq(session.id, id))
    .run();
  return row !== undefined && row.lockedAt !== null;
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

/** Ends every session of a user except `keepId` (a password change keeps the caller's). */
export function deleteOtherSessions(db: SessionStore, userId: string, keepId: string): void {
  db.delete(session)
    .where(and(eq(session.userId, userId), ne(session.id, keepId)))
    .run();
}

/** Compares a request's CSRF header with the session's token in constant time. */
export function csrfMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
