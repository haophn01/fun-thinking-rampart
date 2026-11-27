import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../../../db/client';
import { auditEvent, mfaRecoveryCode, session, user } from '../../../db/schema';

const apiRoot = resolve(import.meta.dirname, '..', '..', '..');
const repoRoot = resolve(apiRoot, '..', '..');
const SEALED = 'v1.sealed-secret-not-real';
const NOW = '2026-11-23T09:00:00.000Z';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rampart-cli-'));
  dirs.push(dir);
  return dir;
}

function runCli(databasePath: string, args: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/auth/mfa/cli.ts', ...args], {
    cwd: apiRoot,
    env: {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      DATABASE_PATH: databasePath,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

interface Seed {
  ada: string;
  bob: string;
  cy: string;
}

/** A migrated DB: Ada and Bob enrolled with codes and a session each; Cy has nothing stored. */
function seededDb(path: string): Seed {
  const handle = openDb(path);
  try {
    runMigrations(handle.db);
    const ids = { ada: crypto.randomUUID(), bob: crypto.randomUUID(), cy: crypto.randomUUID() };
    const base = {
      role: 'contributor',
      passwordHash: 'x',
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    handle.db
      .insert(user)
      .values([
        {
          ...base,
          id: ids.ada,
          email: 'ada@example.com',
          displayName: 'Ada',
          mfaSecretEnc: SEALED,
          mfaLastStep: 7,
          mfaEnrolledAt: NOW,
        },
        {
          ...base,
          id: ids.bob,
          email: 'bob@example.com',
          displayName: 'Bob',
          mfaSecretEnc: SEALED,
          mfaLastStep: 9,
          mfaEnrolledAt: NOW,
        },
        { ...base, id: ids.cy, email: 'cy@example.com', displayName: 'Cy' },
      ])
      .run();
    for (const id of [ids.ada, ids.bob]) {
      handle.db
        .insert(session)
        .values({ id: `s-${id}`, userId: id, csrfToken: 'c', createdAt: NOW, lastSeenAt: NOW })
        .run();
      handle.db
        .insert(mfaRecoveryCode)
        .values([
          { userId: id, codeHash: 'h1', createdAt: NOW },
          { userId: id, codeHash: 'h2', createdAt: NOW },
        ])
        .run();
    }
    return ids;
  } finally {
    handle.sqlite.close();
  }
}

function inspect<T>(path: string, read: (db: ReturnType<typeof openDb>['db']) => T): T {
  const handle = openDb(path);
  try {
    return read(handle.db);
  } finally {
    handle.sqlite.close();
  }
}

const resets = (path: string) =>
  inspect(path, (db) => db.select().from(auditEvent).all()).filter(
    (event) => event.action === 'user.mfa_reset',
  );

describe("resets one user's MFA", () => {
  it("resets one user's MFA", () => {
    const path = join(tempDir(), 'app.sqlite');
    const ids = seededDb(path);
    const result = runCli(path, ['ada@example.com']);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain(
      'Two-step sign-in reset for ada@example.com. They set it up again at their next sign-in, and all their sessions have ended.',
    );
    const { users, codes, sessions } = inspect(path, (db) => ({
      users: db.select().from(user).all(),
      codes: db.select().from(mfaRecoveryCode).all(),
      sessions: db.select().from(session).all(),
    }));
    const ada = users.find((row) => row.id === ids.ada);
    const bob = users.find((row) => row.id === ids.bob);
    expect(ada).toMatchObject({ mfaSecretEnc: null, mfaLastStep: null, mfaEnrolledAt: null });
    expect(bob).toMatchObject({ mfaSecretEnc: SEALED, mfaLastStep: 9, mfaEnrolledAt: NOW });
    expect(codes.map((code) => code.userId)).toEqual([ids.bob, ids.bob]);
    expect(sessions.map((row) => row.userId)).toEqual([ids.bob]);
    const events = resets(path);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: null,
      requestId: null,
      entityType: 'user',
      entityId: ids.ada,
    });
    expect(result.out).not.toContain(SEALED);
  });
});

describe('argument and user edges', () => {
  it('matches the email trimmed and case-folded; refuses unknown users and bad arguments', () => {
    const path = join(tempDir(), 'app.sqlite');
    const ids = seededDb(path);

    const folded = runCli(path, [' Ada@Example.COM ']);
    expect(folded.status, folded.out).toBe(0);
    expect(resets(path).map((event) => event.entityId)).toEqual([ids.ada]);

    const unknown = runCli(path, ['nobody@example.com']);
    expect(unknown.status).toBe(1);
    expect(unknown.out).toContain('nobody@example.com');
    expect(resets(path)).toHaveLength(1);

    for (const args of [[], ['a@example.com', 'b@example.com']]) {
      const bad = runCli(path, args);
      expect(bad.status, args.join(' ')).toBe(2);
      expect(bad.out).toContain('Usage: pnpm admin:reset-mfa <email>');
    }

    const nothing = runCli(path, ['cy@example.com']);
    expect(nothing.status, nothing.out).toBe(0);
    expect(nothing.out).toContain(
      'cy@example.com has no two-step sign-in set up. Nothing changed.',
    );
    expect(resets(path)).toHaveLength(1);
  });
});

describe('never creates or migrates a database', () => {
  it('a missing path exits 1 without creating a file', () => {
    const dir = tempDir();
    const path = join(dir, 'sub', 'missing.sqlite');
    const result = runCli(path, ['ada@example.com']);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`No database at ${path}.`);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a database at migration 0005 exits 1 and stays at 0005', () => {
    const dir = tempDir();
    const folder = join(dir, 'migrations');
    cpSync(join(apiRoot, 'db', 'migrations'), folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.tag <= '0005_ssp_data');
    writeFileSync(journalPath, JSON.stringify(journal));
    const path = join(dir, 'old.sqlite');
    const sqlite = new Database(path);
    migrate(drizzle(sqlite), { migrationsFolder: folder });
    sqlite.close();

    const countMigrations = () => {
      const handle = new Database(path, { readonly: true });
      try {
        const row = handle.prepare('select count(*) as n from __drizzle_migrations').get() as {
          n: number;
        };
        return row.n;
      } finally {
        handle.close();
      }
    };
    expect(countMigrations()).toBe(6);
    const result = runCli(path, ['ada@example.com']);
    expect(result.status).toBe(1);
    expect(result.out).toContain('Start Rampart once to update the database, then run this again.');
    expect(countMigrations()).toBe(6);
    const handle = new Database(path, { readonly: true });
    const columns = handle.prepare("select name from pragma_table_info('user')").all() as {
      name: string;
    }[];
    handle.close();
    expect(columns.map((column) => column.name)).not.toContain('mfa_enrolled_at');
  });
});

describe('works while the app runs', () => {
  it('succeeds while another connection holds the WAL database open', () => {
    const path = join(tempDir(), 'app.sqlite');
    const ids = seededDb(path);
    const app = openDb(path);
    try {
      expect(app.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      // Another connection is reading mid-transaction, as a request would be.
      app.sqlite.exec('BEGIN');
      app.sqlite.prepare('select count(*) from user').get();
      const result = runCli(path, ['ada@example.com']);
      expect(result.status, result.out).toBe(0);
      app.sqlite.exec('COMMIT');
      const row = app.db
        .select()
        .from(user)
        .all()
        .find((r) => r.id === ids.ada);
      expect(row?.mfaEnrolledAt).toBeNull();
    } finally {
      app.sqlite.close();
    }
  });
});

describe('scripts are wired', () => {
  it('the root script calls the api script, which runs the cli', () => {
    const read = (dir: string) =>
      (
        JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          scripts: Record<string, string>;
        }
      ).scripts;
    expect(read(repoRoot)['admin:reset-mfa']).toBe('pnpm --filter @rampart/api admin:reset-mfa');
    expect(read(apiRoot)['admin:reset-mfa']).toBe('tsx src/auth/mfa/cli.ts');
  });
});
