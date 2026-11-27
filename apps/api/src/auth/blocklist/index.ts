// The bundled offline password blocklist. The list is imported, so tsup inlines it into the
// build and no check ever makes a network call. Apply it only when a password is set (setup,
// change, an admin's temporary password), never at sign-in, so existing accounts keep working.
import bundled from './common-passwords.json';

let blocklist: Set<string> | undefined;

/**
 * Whether `password` is on the bundled list: an exact match after lowercasing, so case doesn't
 * help and nothing is trimmed. The Set is built on the first call.
 */
export function isBlocklisted(password: string): boolean {
  blocklist ??= new Set(bundled.passwords);
  return blocklist.has(password.toLowerCase());
}
