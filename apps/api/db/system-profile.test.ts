import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from './client';

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));
const AT = '2026-11-23T00:00:00.000Z';
const SHA = 'b'.repeat(64);

/** The tables a 0003 database has, all of which the upgrade must keep row for row. */
const KEPT_TABLES = [
  'assessment',
  'audit_event',
  'evidence_item',
  'evidence_link',
  'evidence_version',
  'objective_result',
  'poam_item',
  'policy',
  'policy_link',
  'policy_version',
  'requirement_state',
  'session',
  'user',
];

const PROFILE_COLUMNS = [
  'assessment_id',
  'system_name',
  'system_identifier',
  'organization_name',
  'cage_code',
  'description',
  'authorization_boundary',
  'environment',
  'interconnections',
  'information_types',
  'system_owner',
  'system_owner_email',
  'security_contact',
  'security_contact_email',
  'updated_by',
  'updated_at',
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
  const dir = mkdtempSync(join(tmpdir(), 'rampart-profile-db-'));
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

/** Every table, index and trigger definition, to prove a rerun changes nothing. */
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

/** One row in every table a 0003 database has. */
function seed0003(handle: DbHandle): void {
  const run = (sql: string, ...params: unknown[]) => handle.sqlite.prepare(sql).run(...params);
  run(
    `insert into assessment (id, type, conditional_status_date, catalog_version, created_at, updated_at)
     values ('a1', 'self', null, 'nist-800-171-r2@1.0.0', ?, ?)`,
    AT,
    AT,
  );
  for (const [id, email, role] of [
    ['u1', 'admin@example.com', 'admin'],
    ['u2', 'helper@example.com', 'contributor'],
  ] as const) {
    run(
      `insert into user (id, email, display_name, role, password_hash, created_at, updated_at)
       values (?, ?, ?, ?, '$argon2id$x', ?, ?)`,
      id,
      email,
      id,
      role,
      AT,
      AT,
    );
  }
  run(
    `insert into session (id, user_id, csrf_token, created_at, last_seen_at) values (?, 'u1', 'c', ?, ?)`,
    SHA,
    AT,
    AT,
  );
  run(
    `insert into audit_event (at, actor_user_id, assessment_id, action, entity_type, entity_id, before, after)
     values (?, 'u1', 'a1', 'assessment.created', 'assessment', 'a1', null, '{"type":"self"}')`,
    AT,
  );
  run(
    `insert into objective_result (assessment_id, objective_id, status, note, updated_by, updated_at)
     values ('a1', '3.1.1[a]', 'not_met', 'gap', 'u2', ?)`,
    AT,
  );
  run(
    `insert into requirement_state
       (assessment_id, requirement_id, implementation_level, implementation_statement,
        owner_user_id, updated_by, updated_at)
     values ('a1', 'AC.L2-3.1.1', null, 'We do it', 'u2', 'u1', ?)`,
    AT,
  );
  run(
    `insert into poam_item (id, assessment_id, requirement_id, status, plan, due, milestones,
       created_by, created_at, updated_by, updated_at)
     values ('p1', 'a1', 'AC.L2-3.1.1', 'open', 'Fix it', '2027-01-01', '[]', 'u1', ?, 'u1', ?)`,
    AT,
    AT,
  );
  run(
    `insert into evidence_item (id, assessment_id, title, description, contains_cui,
       created_by, created_at, updated_by, updated_at)
     values ('e1', 'a1', 'Screenshot', null, 0, 'u1', ?, 'u1', ?)`,
    AT,
    AT,
  );
  run(
    `insert into evidence_version (evidence_id, version, contains_cui, file_name, size, sha256,
       storage_key, created_by, created_at)
     values ('e1', 1, 0, 'shot.png', 10, ?, ?, 'u1', ?)`,
    SHA,
    SHA,
    AT,
  );
  run(`insert into evidence_link (evidence_id, objective_id) values ('e1', '3.1.1[a]')`);
  run(
    `insert into policy (id, assessment_id, title, description, created_by, created_at, updated_by, updated_at)
     values ('pol1', 'a1', 'Access policy', null, 'u1', ?, 'u1', ?)`,
    AT,
    AT,
  );
  run(
    `insert into policy_version (policy_id, version, file_name, size, sha256, storage_key, created_by, created_at)
     values ('pol1', 1, 'access.pdf', 20, ?, ?, 'u1', ?)`,
    SHA,
    SHA,
    AT,
  );
  run(`insert into policy_link (policy_id, requirement_id) values ('pol1', 'AC.L2-3.1.1')`);
}

describe('system profile migration', () => {
  it('0004 is additive', () => {
    const journal = readJournal();
    const at0003 = journal.entries.findIndex((entry) => entry.tag === '0003_poam_evidence');
    expect(at0003).toBe(3);
    // 0004 is followed only by 0005_ssp_data, which has its own upgrade test (ssp-data.test.ts).
    expect(journal.entries.map((entry) => entry.tag).slice(4)).toEqual([
      '0004_system_profile',
      '0005_ssp_data',
    ]);
    const at0004 = at0003 + 1;

    // The migration's SQL only adds: one new table, no drops, alters or rewrites.
    const sql = readFileSync(join(MIGRATIONS, '0004_system_profile.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE `system_profile`/);
    const statements = sql.replace(/ON (UPDATE|DELETE) no action/g, '');
    expect(statements).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|INSERT|RENAME)\b/i);

    // A database exactly as poam-evidence left it (0000–0003), with a row in every table.
    const path = join(tempDir(), 'poam-evidence.sqlite');
    const old = track(openDb(path));
    migrate(old.db, { migrationsFolder: migrationsUpTo(at0003 + 1) });
    expect(tables(old)).toEqual(KEPT_TABLES);
    seed0003(old);
    const rowsOf = (handle: DbHandle) =>
      Object.fromEntries(
        KEPT_TABLES.map((table) => [
          table,
          handle.sqlite.prepare(`select * from \`${table}\``).all(),
        ]),
      );
    const before = rowsOf(old);
    for (const table of KEPT_TABLES) expect(before[table]?.length, table).toBeGreaterThan(0);
    const oldSchema = schemaSql(old);
    old.sqlite.close();

    // Upgrade to 0004 exactly: every row is kept, every old definition is unchanged, and the
    // table is added.
    const upTo0004 = migrationsUpTo(at0004 + 1);
    const upgraded = track(openDb(path));
    migrate(upgraded.db, { migrationsFolder: upTo0004 });
    expect(appliedMigrations(upgraded)).toBe(at0004 + 1);
    expect(tables(upgraded)).toEqual([...KEPT_TABLES, 'system_profile'].sort());
    expect(rowsOf(upgraded)).toEqual(before);
    const newSchema = schemaSql(upgraded);
    for (const definition of oldSchema) expect(newSchema).toContain(definition);

    const columns = upgraded.sqlite.prepare('pragma table_info(system_profile)').all() as {
      name: string;
      notnull: number;
      pk: number;
      dflt_value: unknown;
    }[];
    expect(columns.map((column) => column.name)).toEqual(PROFILE_COLUMNS);
    for (const column of columns) {
      const required = ['assessment_id', 'updated_by', 'updated_at'].includes(column.name);
      expect(column.notnull, column.name).toBe(required ? 1 : 0);
      expect(column.pk, column.name).toBe(column.name === 'assessment_id' ? 1 : 0);
      // Timestamps come from the app clock: no column has a default.
      expect(column.dflt_value, column.name).toBeNull();
    }
    const foreignKeys = upgraded.sqlite
      .prepare('pragma foreign_key_list(system_profile)')
      .all() as {
      table: string;
      from: string;
      to: string;
    }[];
    expect(foreignKeys.map((key) => `${key.from}->${key.table}.${key.to}`).sort()).toEqual([
      'assessment_id->assessment.id',
      'updated_by->user.id',
    ]);

    // The new table points at the kept rows, and its keys hold.
    const insert = upgraded.sqlite.prepare(
      `insert into system_profile (assessment_id, system_name, updated_by, updated_at)
       values (?, 'Prod', ?, ?)`,
    );
    expect(() => insert.run('ghost', 'u2', AT)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => insert.run('a1', 'ghost', AT)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => insert.run('a1', 'u2', AT)).not.toThrow();
    expect(() => insert.run('a1', 'u2', AT)).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      upgraded.sqlite
        .prepare(`insert into system_profile (assessment_id, updated_by) values ('a1', 'u1')`)
        .run(),
    ).toThrow(/NOT NULL constraint failed/);

    // A second run is a no-op.
    const applied = appliedMigrations(upgraded);
    const schemaBefore = schemaSql(upgraded);
    migrate(upgraded.db, { migrationsFolder: upTo0004 });
    expect(appliedMigrations(upgraded)).toBe(applied);
    expect(schemaSql(upgraded)).toEqual(schemaBefore);
    expect(upgraded.sqlite.prepare('select count(*) from system_profile').pluck().get()).toBe(1);
    expect(rowsOf(upgraded)).toEqual(before);
  });
});
