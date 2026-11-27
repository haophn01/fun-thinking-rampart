import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { settings } from '../../db/schema';
import type { AppDb } from '../../db/client';
import type { SignInNotice } from '../contract';

/** The app's database or a transaction from `db.transaction(...)`. */
type SettingsStore = Pick<AppDb, 'insert' | 'select'>;

/** The one settings row's id: the table's check allows no other. */
const SETTINGS_ID = 1;

/** The lowercase SHA-256 hex of the notice text's UTF-8 bytes. */
export function noticeDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The stored notice text, or null when none is set (or the settings row doesn't exist yet). */
export function getSignInNoticeText(db: SettingsStore): string | null {
  const row = db
    .select({ text: settings.signInNotice })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID))
    .get();
  return row?.text ?? null;
}

/** The notice as session responses report it, with its digest; null when none is set. */
export function getSignInNotice(db: SettingsStore): SignInNotice | null {
  const text = getSignInNoticeText(db);
  return text === null ? null : { text, digest: noticeDigest(text) };
}

/**
 * Stores the notice text (already trimmed; null turns it off), creating the settings row on the
 * first write. Pass the caller's transaction so the change and its audit event commit together.
 */
export function setSignInNotice(
  db: SettingsStore,
  text: string | null,
  updatedBy: string,
  at: Date,
): void {
  const values = { signInNotice: text, updatedBy, updatedAt: at.toISOString() };
  db.insert(settings)
    .values({ id: SETTINGS_ID, ...values })
    .onConflictDoUpdate({ target: settings.id, set: values })
    .run();
}
