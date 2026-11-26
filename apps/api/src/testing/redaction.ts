/** Shortest secret `expectNoSecrets` accepts: a shorter one would match log text by chance. */
export const MIN_SECRET_LENGTH = 8;

/**
 * Throws, naming the first line (1-based) and which secret, when any serialized log line contains
 * any of `secrets`. The line is printed with each secret replaced by `[secret N]`, so a failure
 * never repeats the value. Refuses a secret under `MIN_SECRET_LENGTH` characters before scanning.
 */
export function expectNoSecrets(logs: readonly unknown[], secrets: readonly string[]): void {
  const short = secrets.findIndex((secret) => secret.length < MIN_SECRET_LENGTH);
  if (short !== -1) {
    throw new Error(
      `expectNoSecrets: secret ${String(short + 1)} is ${String(secrets[short]?.length)} characters; ` +
        `secrets must be at least ${String(MIN_SECRET_LENGTH)} characters, to avoid false positives`,
    );
  }
  logs.forEach((line, index) => {
    const text = typeof line === 'string' ? line : JSON.stringify(line);
    const found = secrets.findIndex((secret) => text.includes(secret));
    if (found === -1) return;
    const shown = secrets.reduce(
      (masked, secret, at) => masked.split(secret).join(`[secret ${String(at + 1)}]`),
      text,
    );
    throw new Error(
      `expectNoSecrets: log line ${String(index + 1)} holds secret ${String(found + 1)}: ${shown}`,
    );
  });
}
