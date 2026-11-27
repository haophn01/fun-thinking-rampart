import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { is } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { loadConfig } from '../src/config';
import { createMemoryStore } from '../storage';
import { openDb, runMigrations, type DbHandle } from './client';
import * as schema from './schema';

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));
const AT = '2026-11-26T00:00:00.000Z';
const SHA = 'd'.repeat(64);
const HASH = 'e'.repeat(64);

/** The tables a 0005 database has, all of which the upgrade must keep row for row. */
const KEPT_TABLES = [
  'assessment',
  'asset',
  'audit_event',
  'diagram_link',
  'evidence_item',
  'evidence_link',
  'evidence_version',
  'objective_result',
  'poam_item',
  'policy',
  'policy_link',
  'policy_version',
  'requirement_state',
  'responsibility',
  'service_provider',
  'session',
  'ssp_approval',
  'ssp_profile',
  'ssp_revision',
  'system_profile',
  'system_role',
  'user',
];

/** The three tables 0006 adds, with their columns in order. */
const NEW_TABLES: Record<string, string[]> = {
  password_history: ['id', 'user_id', 'password_hash', 'created_at'],
  mfa_recovery_code: ['id', 'user_id', 'code_hash', 'created_at', 'used_at'],
  settings: ['id', 'sign_in_notice', 'updated_by', 'updated_at'],
};

/** The nine columns 0006 adds to existing tables, each at the table's end, with its value on old rows. */
const ADDED_COLUMNS: Record<string, Record<string, number | null>> = {
  user: {
    must_change_password: 0,
    password_changed_at: null,
    mfa_secret_enc: null,
    mfa_last_step: null,
    mfa_enrolled_at: null,
  },
  session: { locked_at: null, mfa_pending: 0 },
  audit_event: { prev_hash: null, hash: null },
};

const INTEGER_COLUMNS = ['id', 'must_change_password', 'mfa_last_step', 'mfa_pending'];
const NOT_NULL_DEFAULT_FALSE = ['must_change_password', 'mfa_pending'];

/** The audit columns other than the two hash columns, which the trigger keeps fixed. */
const AUDIT_FIXED_COLUMNS = [
  'id',
  'at',
  'actor_user_id',
  'assessment_id',
  'action',
  'entity_type',
  'entity_id',
  'before',
  'after',
  'request_id',
];

const open: DbHandle[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const handle of open.splice(0)) if (handle.sqlite.open) handle.sqlite.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function track(handle: DbHandle): DbHandle {
  open.push(handle);
  return handle;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rampart-sec-auth-db-'));
  tempDirs.push(dir);
  return dir;
}

interface Journal {
  entries: { tag: string }[];
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
}

/** A copy of the migrations folder holding only its first `count` migrations. */
function migrationsUpTo(count: number): string {
  const journal = readJournal();
  const folder = join(tempDir(), 'migrations');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, count);
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return folder;
}

/** Where 0005_ssp_data sits in the journal; everything up to it is what ssp-data shipped. */
function at0005(): number {
  const index = readJournal().entries.findIndex((entry) => entry.tag === '0005_ssp_data');
  expect(index).toBe(5);
  return index;
}

function tables(handle: DbHandle): string[] {
  return (
    handle.sqlite
      .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
      .pluck()
      .all() as string[]
  )
    .filter((name) => name !== '__drizzle_migrations')
    .sort();
}

/** Every table, index and trigger definition, to prove what an upgrade or a rerun changes. */
function schemaSql(handle: DbHandle): string[] {
  return handle.sqlite
    .prepare(
      "select type || ' ' || name || ' ' || coalesce(sql, '') from sqlite_master order by type, name",
    )
    .pluck()
    .all() as string[];
}

function appliedMigrations(handle: DbHandle): number {
  return handle.sqlite.prepare('select count(*) from __drizzle_migrations').pluck().get() as number;
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: unknown;
}

function columnInfo(handle: DbHandle, table: string): ColumnInfo[] {
  return handle.sqlite.prepare(`pragma table_info(\`${table}\`)`).all() as ColumnInfo[];
}

function foreignKeys(handle: DbHandle, table: string): string[] {
  const keys = handle.sqlite.prepare(`pragma foreign_key_list(\`${table}\`)`).all() as {
    table: string;
    from: string;
    to: string;
  }[];
  return keys.map((key) => `${key.from}->${key.table}.${key.to}`).sort();
}

function indexColumns(handle: DbHandle, index: string): string[] {
  return (handle.sqlite.prepare(`pragma index_info(\`${index}\`)`).all() as { name: string }[]).map(
    (column) => column.name,
  );
}

type Row = Record<string, string | number | null>;

/** Inserts `row` into `table`, naming exactly its keys. */
function insert(handle: DbHandle, table: string, row: Row): void {
  const keys = Object.keys(row);
  handle.sqlite
    .prepare(
      `insert into \`${table}\` (${keys.map((key) => `\`${key}\``).join(', ')})
       values (${keys.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(row));
}

function rowsOf(handle: DbHandle, names: string[]): Record<string, Row[]> {
  return Object.fromEntries(
    names.map((table) => [
      table,
      handle.sqlite.prepare(`select * from \`${table}\` order by rowid`).all() as Row[],
    ]),
  );
}

const stamps = { created_by: 'u1', created_at: AT, updated_by: 'u1', updated_at: AT };

/** One row (or more) in every table a 0005 database has. */
function seed0005(handle: DbHandle, passwordHash = '$argon2id$x'): void {
  insert(handle, 'assessment', {
    id: 'a1',
    type: 'c3pao',
    conditional_status_date: '2026-03-01',
    catalog_version: 'nist-800-171-r2@1.0.0',
    created_at: AT,
    updated_at: AT,
  });
  for (const [id, email, role] of [
    ['u1', 'admin@example.com', 'admin'],
    ['u2', 'helper@example.com', 'contributor'],
  ] as const) {
    insert(handle, 'user', {
      id,
      email,
      display_name: `${id} name`,
      role,
      password_hash: passwordHash,
      created_at: AT,
      updated_at: AT,
    });
  }
  insert(handle, 'session', {
    id: SHA,
    user_id: 'u1',
    csrf_token: 'c',
    created_at: AT,
    last_seen_at: AT,
  });
  for (const entity of ['a1', 'a2']) {
    insert(handle, 'audit_event', {
      at: AT,
      actor_user_id: 'u1',
      assessment_id: 'a1',
      action: 'system_profile.updated',
      entity_type: 'system_profile',
      entity_id: entity,
      before: '{}',
      after: '{"systemName":"Prod"}',
      request_id: 'r1',
    });
  }
  insert(handle, 'objective_result', {
    assessment_id: 'a1',
    objective_id: '3.1.1[a]',
    status: 'met',
    note: 'checked',
    updated_by: 'u2',
    updated_at: AT,
  });
  insert(handle, 'requirement_state', {
    assessment_id: 'a1',
    requirement_id: 'IA.L2-3.5.3',
    implementation_level: 'partial',
    implementation_statement: 'MFA for admins',
    owner_user_id: 'u2',
    updated_by: 'u1',
    updated_at: AT,
    planned_implementation: 'MFA by March',
    na_rationale: null,
  });
  insert(handle, 'poam_item', {
    id: 'p1',
    assessment_id: 'a1',
    requirement_id: 'IA.L2-3.5.3',
    status: 'open',
    plan: 'Roll out MFA',
    due: '2027-01-01',
    milestones: '[]',
    ...stamps,
  });
  insert(handle, 'evidence_item', {
    id: 'e1',
    assessment_id: 'a1',
    title: 'Network diagram',
    contains_cui: 0,
    ...stamps,
  });
  insert(handle, 'evidence_version', {
    evidence_id: 'e1',
    version: 1,
    contains_cui: 0,
    file_name: 'network.png',
    size: 10,
    sha256: SHA,
    storage_key: SHA,
    created_by: 'u1',
    created_at: AT,
  });
  insert(handle, 'evidence_link', { evidence_id: 'e1', objective_id: '3.1.1[a]' });
  insert(handle, 'policy', { id: 'pol1', assessment_id: 'a1', title: 'Access policy', ...stamps });
  insert(handle, 'policy_version', {
    policy_id: 'pol1',
    version: 1,
    file_name: 'access.pdf',
    size: 20,
    sha256: SHA,
    storage_key: SHA,
    created_by: 'u1',
    created_at: AT,
  });
  insert(handle, 'policy_link', { policy_id: 'pol1', requirement_id: 'AC.L2-3.1.1' });
  insert(handle, 'system_profile', {
    assessment_id: 'a1',
    system_name: 'Prod',
    cage_code: '1ABC2',
    updated_by: 'u1',
    updated_at: AT,
  });
  insert(handle, 'ssp_profile', {
    assessment_id: 'a1',
    review_cadence_months: 12,
    updated_by: 'u1',
    updated_at: AT,
  });
  insert(handle, 'system_role', {
    id: 'r1',
    assessment_id: 'a1',
    title: 'System administrator',
    user_count: 2,
    privileged: 1,
    ...stamps,
  });
  insert(handle, 'asset', {
    id: 's1',
    assessment_id: 'a1',
    name: 'File server',
    category: 'cui',
    ...stamps,
  });
  insert(handle, 'service_provider', {
    id: 'sp1',
    assessment_id: 'a1',
    name: 'Cloud Co',
    provider_type: 'cloud',
    ...stamps,
  });
  insert(handle, 'responsibility', {
    assessment_id: 'a1',
    requirement_id: 'AC.L2-3.1.1',
    party: 'esp',
    provider_id: 'sp1',
    updated_by: 'u1',
    updated_at: AT,
  });
  insert(handle, 'diagram_link', {
    id: 'd1',
    assessment_id: 'a1',
    evidence_id: 'e1',
    kind: 'network',
    caption: 'Network',
    ...stamps,
  });
  insert(handle, 'ssp_revision', {
    id: 'rev1',
    assessment_id: 'a1',
    kind: 'manual',
    revised_on: '2026-11-25',
    description: 'First issue',
    made_by: 'u1 name',
    created_by: 'u1',
    created_at: AT,
  });
  insert(handle, 'ssp_approval', {
    id: 'ap1',
    assessment_id: 'a1',
    name: 'Pat Doe',
    title: 'CEO',
    ...stamps,
  });
}

/** A database at 0005 exactly, as sec-baseline left it, with a row in every table. */
function database0005(path: string, passwordHash?: string): void {
  const old = track(openDb(path));
  migrate(old.db, { migrationsFolder: migrationsUpTo(at0005() + 1) });
  expect(tables(old)).toEqual(KEPT_TABLES);
  seed0005(old, passwordHash);
  old.sqlite.close();
}

/** A fully migrated in-memory database with two users and an assessment. */
function freshDb(): DbHandle {
  const handle = track(openDb(':memory:'));
  runMigrations(handle.db);
  seed0005(handle);
  return handle;
}

/** Statements of a drizzle-kit migration file, without the breakpoint markers. */
function statementsOf(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const APPEND_ONLY = /audit_event is append-only/;
const CHECK = /CHECK constraint failed/;
const NOT_NULL = /NOT NULL constraint failed/;
const FOREIGN = /FOREIGN KEY constraint failed/;

describe('sec-auth migration', () => {
  it('0006 is additive', () => {
    const tags = readJournal().entries.map((entry) => entry.tag);
    expect(tags.slice(at0005())).toEqual(['0005_ssp_data', '0006_sec_auth']);

    const statements = statementsOf(readFileSync(join(MIGRATIONS, '0006_sec_auth.sql'), 'utf8'));
    const created: string[] = [];
    const added: string[] = [];
    const indexed: string[] = [];
    const triggers: string[] = [];
    const rest: string[] = [];
    for (const statement of statements) {
      // Comment lines (the trigger block's header) are not SQL.
      const body = statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim();
      const table = /^CREATE TABLE `([a-z_]+)`/.exec(body);
      const index = /^CREATE INDEX `[a-z_]+` ON `([a-z_]+)`/.exec(body);
      const alter =
        /^ALTER TABLE `([a-z_]+)` ADD `([a-z_]+)` [a-z]+( DEFAULT false NOT NULL)?;$/.exec(body);
      if (table?.[1]) {
        created.push(table[1]);
        rest.push(body);
      } else if (index?.[1]) {
        indexed.push(index[1]);
        rest.push(body);
      } else if (alter?.[1] && alter[2]) added.push(`${alter[1]}.${alter[2]}`);
      else if (/^DROP TRIGGER `audit_event_no_update`;$/.test(body)) triggers.push('drop');
      else if (/^CREATE TRIGGER `audit_event_no_update` BEFORE UPDATE ON `audit_event`/.test(body))
        triggers.push('create');
      else expect.fail(`unexpected statement: ${body}`);
    }
    expect(created.sort()).toEqual(Object.keys(NEW_TABLES).sort());
    // Indexes go only on the new tables.
    for (const name of indexed) expect(Object.keys(NEW_TABLES)).toContain(name);
    expect(added.sort()).toEqual(
      Object.entries(ADDED_COLUMNS)
        .flatMap(([name, columns]) => Object.keys(columns).map((column) => `${name}.${column}`))
        .sort(),
    );
    // The old trigger goes first, then its narrowed replacement; nothing else touches triggers.
    expect(triggers).toEqual(['drop', 'create']);
    // No other drops, renames, data changes or table rebuilds anywhere in the file.
    const words = rest.join('\n').replace(/ON (UPDATE|DELETE) no action/g, '');
    expect(words).not.toMatch(/\b(DROP|RENAME|INSERT|UPDATE|DELETE|TRIGGER)\b/i);
    expect(statements.join('\n')).not.toMatch(/__new_/);
    expect(statements.join('\n')).not.toMatch(/\bRENAME\b/i);
  });

  it('upgrade from 0005 keeps data', () => {
    const journal = readJournal();
    const path = join(tempDir(), 'sec-baseline.sqlite');
    database0005(path);
    const old = track(openDb(path));
    const before = rowsOf(old, KEPT_TABLES);
    for (const table of KEPT_TABLES) expect(before[table]?.length, table).toBeGreaterThan(0);
    const oldSchema = schemaSql(old);
    const oldColumns = Object.fromEntries(
      Object.keys(ADDED_COLUMNS).map((table) => [table, columnInfo(old, table)]),
    );
    old.sqlite.close();

    // Upgrade: every row is kept, the three tables are added, and old rows read the new columns
    // as false or null.
    const upgraded = track(openDb(path));
    runMigrations(upgraded.db);
    expect(appliedMigrations(upgraded)).toBe(journal.entries.length);
    expect(tables(upgraded)).toEqual([...KEPT_TABLES, ...Object.keys(NEW_TABLES)].sort());
    const expected = { ...before };
    for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
      expected[table] = (before[table] ?? []).map((row) => ({ ...row, ...added }));
    }
    expect(rowsOf(upgraded, KEPT_TABLES)).toEqual(expected);
    for (const table of Object.keys(NEW_TABLES)) {
      expect(rowsOf(upgraded, [table])[table], table).toEqual([]);
    }

    // Every old definition is unchanged except the three widened tables and the narrowed
    // trigger. The widened tables keep their old columns and checks; the new ones go at the end.
    const newSchema = schemaSql(upgraded);
    const changed = [
      ...Object.keys(ADDED_COLUMNS).map((table) => `table ${table} `),
      'trigger audit_event_no_update ',
    ];
    for (const definition of oldSchema) {
      if (changed.some((prefix) => definition.startsWith(prefix))) continue;
      expect(newSchema).toContain(definition);
    }
    expect(newSchema).toContain(
      oldSchema.find((entry) => entry.startsWith('trigger audit_event_no_delete ')),
    );
    for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
      const columns = columnInfo(upgraded, table);
      const kept = oldColumns[table] ?? [];
      expect(columns.slice(0, kept.length), table).toEqual(kept);
      expect(
        columns.slice(kept.length).map((column) => column.name),
        table,
      ).toEqual(Object.keys(added));
    }
    const userSql = newSchema.find((entry) => entry.startsWith('table user '));
    expect(userSql).toContain('CONSTRAINT "user_role_check"');
    expect(userSql).toContain('CONSTRAINT "user_active_check"');

    // The kept rows still hold their rules: the old audit rows can be hash-filled once, and
    // no other change.
    expect(() => upgraded.sqlite.prepare('delete from audit_event').run()).toThrow(APPEND_ONLY);
    expect(() => upgraded.sqlite.prepare("update audit_event set action = 'x'").run()).toThrow(
      APPEND_ONLY,
    );
    upgraded.sqlite
      .prepare('update audit_event set prev_hash = null, hash = ? where id = 1')
      .run(HASH);
    upgraded.sqlite
      .prepare('update audit_event set prev_hash = ?, hash = ? where id = 2')
      .run(HASH, SHA);
    // The new tables can point at the kept rows.
    insert(upgraded, 'password_history', {
      user_id: 'u1',
      password_hash: '$argon2id$x',
      created_at: AT,
    });
    insert(upgraded, 'mfa_recovery_code', { user_id: 'u2', code_hash: HASH, created_at: AT });
    insert(upgraded, 'settings', {
      id: 1,
      sign_in_notice: 'Authorized use only.',
      updated_by: 'u1',
      updated_at: AT,
    });

    // A second run is a no-op.
    const applied = appliedMigrations(upgraded);
    const schemaBefore = schemaSql(upgraded);
    const allTables = [...KEPT_TABLES, ...Object.keys(NEW_TABLES)];
    const rowsBefore = rowsOf(upgraded, allTables);
    runMigrations(upgraded.db);
    expect(appliedMigrations(upgraded)).toBe(applied);
    expect(schemaSql(upgraded)).toEqual(schemaBefore);
    expect(rowsOf(upgraded, allTables)).toEqual(rowsBefore);
    upgraded.sqlite.close();

    // And so is starting again on the upgraded file.
    const reopened = track(openDb(path));
    runMigrations(reopened.db);
    expect(appliedMigrations(reopened)).toBe(applied);
    expect(schemaSql(reopened)).toEqual(schemaBefore);
    expect(rowsOf(reopened, allTables)).toEqual(rowsBefore);
  });

  it('existing account still signs in', async () => {
    const password = 'an old but good password';
    const path = join(tempDir(), 'sign-in.sqlite');
    database0005(path, await hashPassword(password));

    // The app migrates on start, as the server does.
    const handle = track(openDb(path));
    runMigrations(handle.db);
    expect(columnInfo(handle, 'user').map((column) => column.name)).toEqual(
      expect.arrayContaining(Object.keys(ADDED_COLUMNS.user ?? {})),
    );
    const config = loadConfig({ DATABASE_PATH: path, LOG_LEVEL: 'silent' });
    const app = buildApp({ config, db: handle.db, store: createMemoryStore() });
    try {
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/session',
        payload: { email: 'admin@example.com', password: 'not the password' },
      });
      expect(wrong.statusCode).toBe(401);
      const signedIn = await app.inject({
        method: 'POST',
        url: '/api/session',
        payload: { email: 'admin@example.com', password },
      });
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json<{ user: { id: string } | null }>().user?.id).toBe('u1');
      const cookie = [signedIn.headers['set-cookie']].flat()[0]?.split(';')[0] ?? '';
      const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
      expect(session.statusCode).toBe(200);
      expect(session.json<{ user: { id: string } | null }>().user?.id).toBe('u1');
    } finally {
      await app.close();
    }
    // The account is not asked to change its password, and its new session is a plain one.
    expect(
      handle.sqlite
        .prepare("select must_change_password, password_changed_at from user where id = 'u1'")
        .get(),
    ).toEqual({ must_change_password: 0, password_changed_at: null });
    expect(
      handle.sqlite
        .prepare('select locked_at, mfa_pending from session where id <> ? order by rowid')
        .all(SHA),
    ).toEqual([{ locked_at: null, mfa_pending: 0 }]);
  });

  it('audit trigger allows only a one-time hash fill', () => {
    const handle = freshDb();
    const triggers = handle.sqlite
      .prepare("select name from sqlite_master where type = 'trigger' order by name")
      .pluck()
      .all();
    expect(triggers).toEqual(['audit_event_no_delete', 'audit_event_no_update']);
    const audit = () =>
      handle.sqlite.prepare('select * from audit_event order by id').all() as Row[];
    const original = audit();
    expect(original.map((row) => [row.prev_hash, row.hash])).toEqual([
      [null, null],
      [null, null],
    ]);
    const update = (set: string, id: number, ...params: unknown[]) =>
      handle.sqlite.prepare(`update audit_event set ${set} where id = ?`).run(...params, id);

    // Any other column, alone or alongside a valid fill, aborts.
    const other: Record<string, string | number | null> = {
      id: 99,
      at: '2027-01-01T00:00:00.000Z',
      actor_user_id: 'u2',
      assessment_id: null,
      action: 'user.updated',
      entity_type: 'user',
      entity_id: 'u2',
      before: null,
      after: '{}',
      request_id: null,
    };
    expect(Object.keys(other)).toEqual(AUDIT_FIXED_COLUMNS);
    for (const [column, value] of Object.entries(other)) {
      expect(() => update(`\`${column}\` = ?`, 1, value), column).toThrow(APPEND_ONLY);
      expect(
        () => update(`\`${column}\` = ?, prev_hash = ?, hash = ?`, 1, value, null, HASH),
        column,
      ).toThrow(APPEND_ONLY);
    }
    // Setting a column to its own value is still an edit attempt, and so is a fill with no hash.
    expect(() => update('action = action', 1)).toThrow(APPEND_ONLY);
    expect(() => update('hash = null', 1)).toThrow(APPEND_ONLY);
    expect(() => update('prev_hash = ?', 1, HASH)).toThrow(APPEND_ONLY);
    expect(audit()).toEqual(original);

    // The first row of a chain has no previous hash; later rows have one. Each fills once.
    update('prev_hash = null, hash = ?', 1, HASH);
    update('prev_hash = ?, hash = ?', 2, HASH, SHA);
    expect(audit()).toEqual([
      { ...original[0], prev_hash: null, hash: HASH },
      { ...original[1], prev_hash: HASH, hash: SHA },
    ]);
    const filled = audit();
    expect(() => update('hash = ?', 1, SHA)).toThrow(APPEND_ONLY);
    expect(() => update('prev_hash = ?', 1, SHA)).toThrow(APPEND_ONLY);
    expect(() => update('hash = ?', 2, SHA)).toThrow(APPEND_ONLY);
    expect(() => update('prev_hash = null, hash = null', 2)).toThrow(APPEND_ONLY);

    // A row written with its hash already set can never be changed.
    insert(handle, 'audit_event', {
      at: AT,
      action: 'user.created',
      entity_type: 'user',
      entity_id: 'u2',
      prev_hash: SHA,
      hash: HASH,
    });
    expect(() => update('hash = ?', 3, SHA)).toThrow(APPEND_ONLY);

    // DELETE still aborts, one row or all.
    expect(() => handle.sqlite.prepare('delete from audit_event where id = 1').run()).toThrow(
      APPEND_ONLY,
    );
    expect(() => handle.sqlite.prepare('delete from audit_event').run()).toThrow(APPEND_ONLY);
    expect(audit().slice(0, 2)).toEqual(filled);
    expect(audit()).toHaveLength(3);
  });

  it('new table constraints', () => {
    const handle = freshDb();

    // Columns, nullability, keys, types and foreign keys. Timestamps come from the api, so no
    // new-table column has a default.
    const REQUIRED: Record<string, string[]> = {
      password_history: ['id', 'user_id', 'password_hash', 'created_at'],
      mfa_recovery_code: ['id', 'user_id', 'code_hash', 'created_at'],
      settings: ['id', 'updated_by', 'updated_at'],
    };
    for (const [table, names] of Object.entries(NEW_TABLES)) {
      const columns = columnInfo(handle, table);
      expect(
        columns.map((column) => column.name),
        table,
      ).toEqual(names);
      for (const column of columns) {
        const label = `${table}.${column.name}`;
        expect(column.notnull, label).toBe(REQUIRED[table]?.includes(column.name) ? 1 : 0);
        expect(column.dflt_value, label).toBeNull();
        expect(column.pk, label).toBe(column.name === 'id' ? 1 : 0);
        expect(column.type, label).toBe(INTEGER_COLUMNS.includes(column.name) ? 'INTEGER' : 'TEXT');
      }
    }
    expect(foreignKeys(handle, 'password_history')).toEqual(['user_id->user.id']);
    expect(foreignKeys(handle, 'mfa_recovery_code')).toEqual(['user_id->user.id']);
    expect(foreignKeys(handle, 'settings')).toEqual(['updated_by->user.id']);
    expect(indexColumns(handle, 'password_history_user_id_idx')).toEqual(['user_id', 'id']);
    expect(indexColumns(handle, 'mfa_recovery_code_user_id_idx')).toEqual(['user_id']);
    // Ids are never reused (AUTOINCREMENT) for the two history-like tables.
    const tableSql = (name: string) =>
      handle.sqlite
        .prepare("select sql from sqlite_master where type = 'table' and name = ?")
        .pluck()
        .get(name) as string;
    expect(tableSql('password_history')).toMatch(/`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL/);
    expect(tableSql('mfa_recovery_code')).toMatch(
      /`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL/,
    );
    expect(tableSql('settings')).not.toMatch(/AUTOINCREMENT/);

    // The nine added columns: types, and the two flags are not null and false by default.
    for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
      const columns = columnInfo(handle, table);
      for (const name of Object.keys(added)) {
        const column = columns.find((entry) => entry.name === name);
        const label = `${table}.${name}`;
        expect(column?.type, label).toBe(INTEGER_COLUMNS.includes(name) ? 'INTEGER' : 'TEXT');
        expect(column?.notnull, label).toBe(NOT_NULL_DEFAULT_FALSE.includes(name) ? 1 : 0);
        expect(column?.dflt_value, label).toBe(
          NOT_NULL_DEFAULT_FALSE.includes(name) ? 'false' : null,
        );
      }
    }
    insert(handle, 'user', {
      id: 'u3',
      email: 'new@example.com',
      display_name: 'New',
      role: 'contributor',
      password_hash: '$argon2id$x',
    });
    expect(
      handle.sqlite
        .prepare(
          "select must_change_password, password_changed_at, mfa_secret_enc, mfa_last_step, mfa_enrolled_at from user where id = 'u3'",
        )
        .get(),
    ).toEqual(ADDED_COLUMNS.user);
    insert(handle, 'session', {
      id: 'tok',
      user_id: 'u3',
      csrf_token: 'c',
      created_at: AT,
      last_seen_at: AT,
    });
    expect(
      handle.sqlite.prepare("select locked_at, mfa_pending from session where id = 'tok'").get(),
    ).toEqual(ADDED_COLUMNS.session);
    expect(() =>
      handle.sqlite.prepare("update user set must_change_password = null where id = 'u3'").run(),
    ).toThrow(NOT_NULL);
    expect(() =>
      handle.sqlite.prepare("update session set mfa_pending = null where id = 'tok'").run(),
    ).toThrow(NOT_NULL);
    handle.sqlite
      .prepare(
        "update user set must_change_password = 1, mfa_last_step = 59, password_changed_at = ? where id = 'u3'",
      )
      .run(AT);
    handle.sqlite
      .prepare("update session set mfa_pending = 1, locked_at = ? where id = 'tok'")
      .run(AT);

    const refuses = (table: string, row: Row, error: RegExp) => {
      expect(
        () => {
          insert(handle, table, row);
        },
        `${table} ${JSON.stringify(row)}`,
      ).toThrow(error);
    };

    // password_history: a real user, a hash and a time; ids keep counting.
    const history = { user_id: 'u1', password_hash: '$argon2id$old', created_at: AT };
    insert(handle, 'password_history', history);
    insert(handle, 'password_history', { ...history, password_hash: '$argon2id$older' });
    refuses('password_history', { ...history, user_id: 'ghost' }, FOREIGN);
    refuses('password_history', { ...history, user_id: null }, NOT_NULL);
    refuses('password_history', { ...history, password_hash: null }, NOT_NULL);
    refuses('password_history', { ...history, created_at: null }, NOT_NULL);
    expect(
      handle.sqlite.prepare('select id from password_history order by id').pluck().all(),
    ).toEqual([1, 2]);
    expect(() => handle.sqlite.prepare("delete from user where id = 'u1'").run()).toThrow(FOREIGN);

    // mfa_recovery_code: a real user, a hash and a time; used_at starts empty.
    const code = { user_id: 'u2', code_hash: HASH, created_at: AT };
    insert(handle, 'mfa_recovery_code', code);
    insert(handle, 'mfa_recovery_code', { ...code, used_at: AT });
    refuses('mfa_recovery_code', { ...code, user_id: 'ghost' }, FOREIGN);
    refuses('mfa_recovery_code', { ...code, code_hash: null }, NOT_NULL);
    refuses('mfa_recovery_code', { ...code, created_at: null }, NOT_NULL);
    expect(
      handle.sqlite.prepare('select used_at from mfa_recovery_code order by id').pluck().all(),
    ).toEqual([null, AT]);

    // settings: one row, id 1, created by the first write; a second row is refused.
    const settings = { updated_by: 'u1', updated_at: AT };
    refuses('settings', { id: 2, ...settings }, CHECK);
    refuses('settings', { id: 0, ...settings }, CHECK);
    refuses('settings', { id: 1, ...settings, updated_by: 'ghost' }, FOREIGN);
    refuses('settings', { id: 1, ...settings, updated_by: null }, NOT_NULL);
    refuses('settings', { id: 1, updated_by: 'u1', updated_at: null }, NOT_NULL);
    insert(handle, 'settings', settings);
    expect(handle.sqlite.prepare('select * from settings').all()).toEqual([
      { id: 1, sign_in_notice: null, ...settings },
    ]);
    refuses('settings', settings, CHECK);
    refuses('settings', { id: 1, ...settings }, /UNIQUE constraint failed|PRIMARY KEY/);
    expect(() => handle.sqlite.prepare('update settings set id = 2').run()).toThrow(CHECK);
    handle.sqlite
      .prepare("update settings set sign_in_notice = 'Authorized use only.', updated_by = 'u2'")
      .run();
    expect(handle.sqlite.prepare('select count(*) from settings').pluck().get()).toBe(1);
  });

  it('schema matches the snapshot', () => {
    const journal = readJournal();
    expect(journal.entries.at(-1)?.tag).toBe('0006_sec_auth');
    const snapshot = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', '0006_snapshot.json'), 'utf8'),
    ) as {
      tables: Record<
        string,
        {
          columns: Record<
            string,
            { notNull: boolean; type: string; primaryKey: boolean; autoincrement?: boolean }
          >;
          indexes: Record<string, { columns: string[] }>;
          checkConstraints: Record<string, unknown>;
          foreignKeys: Record<string, unknown>;
        }
      >;
    };
    const fromSchema = Object.values(schema).flatMap((value: unknown) =>
      is(value, SQLiteTable) ? [getTableConfig(value)] : [],
    );
    expect(Object.keys(snapshot.tables).sort()).toEqual(
      fromSchema.map((config) => config.name).sort(),
    );
    for (const config of fromSchema) {
      const stored = snapshot.tables[config.name];
      expect(stored, config.name).toBeDefined();
      expect(
        Object.fromEntries(
          config.columns.map((column) => [
            column.name,
            { notNull: column.notNull, type: column.getSQLType() },
          ]),
        ),
        config.name,
      ).toEqual(
        Object.fromEntries(
          Object.entries(stored?.columns ?? {}).map(([name, column]) => [
            name,
            { notNull: column.notNull, type: column.type },
          ]),
        ),
      );
      expect(Object.keys(stored?.checkConstraints ?? {}).sort(), config.name).toEqual(
        config.checks.map((check) => check.name).sort(),
      );
      expect(Object.keys(stored?.foreignKeys ?? {}).length, config.name).toBe(
        config.foreignKeys.length,
      );
      // drizzle-kit stores a unique column as an index too.
      expect(Object.keys(stored?.indexes ?? {}).sort(), config.name).toEqual(
        [
          ...config.indexes.map((index) => index.config.name),
          ...config.columns.flatMap((column) => (column.isUnique ? [column.uniqueName] : [])),
        ].sort(),
      );
    }
    for (const table of Object.keys(NEW_TABLES)) {
      expect(Object.keys(snapshot.tables[table]?.columns ?? {}), table).toEqual(NEW_TABLES[table]);
    }
    for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
      expect(
        Object.keys(snapshot.tables[table]?.columns ?? {}).slice(-Object.keys(added).length),
        table,
      ).toEqual(Object.keys(added));
    }
    expect(snapshot.tables.settings?.checkConstraints).toHaveProperty('settings_single_row_check');
  });
});
