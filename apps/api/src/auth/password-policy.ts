import { and, desc, eq, notInArray } from 'drizzle-orm';
import { passwordHistory } from '../../db/schema';
import { ERROR_MESSAGES, PASSWORD_HISTORY_DEPTH } from '../contract';
import { AppError } from '../errors';
import { isBlocklisted } from './blocklist';
import { verifyPassword } from './password';
import type { SessionStore } from './sessions';

/** History rows kept per user: the current hash counts as the depth's first password. */
const HISTORY_ROWS = PASSWORD_HISTORY_DEPTH - 1;

/**
 * Throws `password_too_common` for a password on the bundled blocklist. Only for a password
 * being set (setup, change, an admin's temporary password), never at sign-in.
 */
export function checkNewPassword(password: string): void {
  if (isBlocklisted(password)) {
    throw new AppError('password_too_common', ERROR_MESSAGES.password_too_common);
  }
}

/** The user's newest history hashes, newest first; same-moment rows are ordered by id. */
function recentHashes(db: SessionStore, userId: string): string[] {
  return db
    .select({ hash: passwordHistory.passwordHash })
    .from(passwordHistory)
    .where(eq(passwordHistory.userId, userId))
    .orderBy(desc(passwordHistory.id))
    .limit(HISTORY_ROWS)
    .all()
    .map((row) => row.hash);
}

/**
 * Throws `password_reused` when `password` matches the current hash or one of the user's newest
 * `PASSWORD_HISTORY_DEPTH - 1` earlier hashes.
 */
export async function assertNotReused(
  db: SessionStore,
  userId: string,
  currentHash: string,
  password: string,
): Promise<void> {
  for (const stored of [currentHash, ...recentHashes(db, userId)]) {
    if (await verifyPassword(stored, password)) {
      throw new AppError('password_reused', ERROR_MESSAGES.password_reused);
    }
  }
}

/** Moves a replaced hash into the user's history and drops rows beyond the depth. */
export function pushPasswordHistory(
  db: SessionStore,
  userId: string,
  replacedHash: string,
  now: Date,
): void {
  db.insert(passwordHistory)
    .values({ userId, passwordHash: replacedHash, createdAt: now.toISOString() })
    .run();
  const keep = db
    .select({ id: passwordHistory.id })
    .from(passwordHistory)
    .where(eq(passwordHistory.userId, userId))
    .orderBy(desc(passwordHistory.id))
    .limit(HISTORY_ROWS)
    .all()
    .map((row) => row.id);
  db.delete(passwordHistory)
    .where(and(eq(passwordHistory.userId, userId), notInArray(passwordHistory.id, keep)))
    .run();
}
