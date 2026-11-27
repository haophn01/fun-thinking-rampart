// `pnpm admin:reset-mfa <email>`: local recovery for a user who lost their authenticator and
// recovery codes. It opens the existing database (never creating or migrating one), runs the same
// `resetMfa` as the admin route inside one transaction, and prints plain text. It never prints a
// secret, a code or a hash.
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../../db/schema';
import { loadConfig } from '../../config';
import { resetMfa } from './reset';

const USAGE = 'Usage: pnpm admin:reset-mfa <email>';
const BUSY_TIMEOUT_MS = 5000;

export interface CliResult {
  code: 0 | 1 | 2;
  message: string;
}

/** Runs the reset for `args` against the database at `databasePath`; touches nothing else. */
export function runResetMfa(
  args: readonly string[],
  databasePath: string,
  now: Date = new Date(),
): CliResult {
  const [rawEmail, ...extra] = args;
  if (rawEmail === undefined || extra.length > 0) return { code: 2, message: USAGE };
  const email = rawEmail.trim().toLowerCase();

  if (databasePath === ':memory:' || !existsSync(databasePath)) {
    return { code: 1, message: `No database at ${databasePath}.` };
  }
  const sqlite = new Database(databasePath, { fileMustExist: true });
  try {
    sqlite.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
    sqlite.pragma('foreign_keys = ON');
    const columns = sqlite.prepare("select name from pragma_table_info('user')").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === 'mfa_enrolled_at')) {
      return {
        code: 1,
        message: 'Start Rampart once to update the database, then run this again.',
      };
    }
    const db = drizzle(sqlite, { schema });
    const outcome = db.transaction((tx) => {
      const row = tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.email, email))
        .get();
      if (!row) return 'unknown' as const;
      return resetMfa(tx, row.id, { actorUserId: null, requestId: null, now })
        ? ('reset' as const)
        : ('nothing' as const);
    });
    if (outcome === 'unknown') return { code: 1, message: `No user with the email ${email}.` };
    if (outcome === 'nothing') {
      return { code: 0, message: `${email} has no two-step sign-in set up. Nothing changed.` };
    }
    return {
      code: 0,
      message: `Two-step sign-in reset for ${email}. They set it up again at their next sign-in, and all their sessions have ended.`,
    };
  } finally {
    sqlite.close();
  }
}

function main(): void {
  try {
    const config = loadConfig(process.env);
    const result = runResetMfa(process.argv.slice(2), config.databasePath);
    (result.code === 0 ? console.log : console.error)(result.message);
    process.exitCode = result.code;
  } catch (error) {
    console.error(`Could not reset: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}

main();
