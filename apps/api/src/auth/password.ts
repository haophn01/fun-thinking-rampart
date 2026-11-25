import { hash, verify } from '@node-rs/argon2';

/**
 * An Argon2id hash (the library's default parameters) of a random value nobody knows. Sign-in
 * verifies against it when the email is unknown, so a wrong email takes as long as a wrong password.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$CBgf7VsXiZhMgBz58EqrVw$FaD55CZ7sMxDEstehjDb0a3B5hcfC0/4tIqca4KuQZg';

/** Argon2id with `@node-rs/argon2`'s defaults, so every hash starts with `$argon2id$`. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** Whether `password` matches `stored`. Pass `null` for an unknown user to spend the same time. */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  const matched = await verify(stored ?? DUMMY_HASH, password);
  return stored !== null && matched;
}
