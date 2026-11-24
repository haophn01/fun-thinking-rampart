import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from './client';

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));
const NEW_TABLES = ['audit_event', 'objective_result', 'requirement_state', 'session', 'user'];

const open: DbHandle[] = [];
const tempDirs: string[] = [];

function track(handle: DbHandle): DbHandle {
  open.push(handle);
  return handle;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rampart-db-'));
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

afterEach(() => {
  for (const handle of open.splice(0)) if (handle.sqlite.open) handle.sqlite.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tables(handle: DbHandle): string[] {
  return handle.sqlite
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .pluck()
    .all() as string[];
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

function columnsOf(handle: DbHandle, table: string): string[] {
  return (handle.sqlite.prepare(`pragma table_info(\`${table}\`)`).all() as { name: string }[]).map(
    (column) => column.name,
  );
}

function appliedMigrations(handle: DbHandle): number {
  return handle.sqlite.prepare('select count(*) from __drizzle_migrations').pluck().get() as number;
}

describe('database', () => {
  it('migrations and constraints', () => {
    const handle = track(openDb(':memory:'));
    runMigrations(handle.db);

    // assessment plus the five assessment-sprint tables (and drizzle's own journal table).
    expect(
      tables(handle)
        .filter((name) => name !== '__drizzle_migrations')
        .sort(),
    ).toEqual(['assessment', ...NEW_TABLES].sort());
    const columns = handle.sqlite.prepare('pragma table_info(assessment)').all() as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'type',
      'conditional_status_date',
      'catalog_version',
      'created_at',
      'updated_at',
    ]);
    expect(columns.find((column) => column.name === 'id')?.pk).toBe(1);
    expect(columns.find((column) => column.name === 'conditional_status_date')?.notnull).toBe(0);

    // A second run is a no-op.
    const applied = appliedMigrations(handle);
    expect(applied).toBeGreaterThan(0);
    handle.sqlite
      .prepare(
        "insert into assessment (id, catalog_version) values ('a1', 'nist-800-171-r2@1.0.0')",
      )
      .run();
    const schemaBefore = schemaSql(handle);
    runMigrations(handle.db);
    expect(appliedMigrations(handle)).toBe(applied);
    expect(schemaSql(handle)).toEqual(schemaBefore);
    expect(handle.sqlite.prepare('select count(*) from assessment').pluck().get()).toBe(1);

    // foreign_keys is on.
    expect(handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);

    // type defaults to self, timestamps default to ISO strings, and other types are rejected.
    const row = handle.sqlite.prepare("select * from assessment where id = 'a1'").get() as Record<
      string,
      unknown
    >;
    expect(row.type).toBe('self');
    expect(row.conditional_status_date).toBeNull();
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(() =>
      handle.sqlite
        .prepare("insert into assessment (id, type, catalog_version) values ('a2', 'other', 'v')")
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      handle.sqlite
        .prepare("insert into assessment (id, type, catalog_version) values ('a3', 'c3pao', 'v')")
        .run(),
    ).not.toThrow();
    expect(() => handle.sqlite.prepare("insert into assessment (id) values ('a4')").run()).toThrow(
      /NOT NULL constraint failed: assessment.catalog_version/,
    );
  });

  it('a file database gets its folder, WAL, and keeps data across a reopen', () => {
    const path = join(tempDir(), 'nested', 'deeper', 'rampart.sqlite');
    const first = track(openDb(path));
    expect(existsSync(path)).toBe(true);
    expect(first.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(first.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    runMigrations(first.db);
    first.sqlite.prepare("insert into assessment (id, catalog_version) values ('keep', 'v')").run();
    const applied = appliedMigrations(first);
    first.sqlite.close();

    const second = track(openDb(path));
    runMigrations(second.db);
    expect(appliedMigrations(second)).toBe(applied);
    expect(second.sqlite.prepare('select id from assessment').pluck().all()).toEqual(['keep']);
  });

  it('new tables have their columns, indexes and triggers', () => {
    const handle = track(openDb(':memory:'));
    runMigrations(handle.db);
    expect(columnsOf(handle, 'user')).toEqual([
      'id',
      'email',
      'display_name',
      'role',
      'password_hash',
      'active',
      'failed_sign_ins',
      'locked_until',
      'created_at',
      'updated_at',
    ]);
    expect(columnsOf(handle, 'session')).toEqual([
      'id',
      'user_id',
      'csrf_token',
      'created_at',
      'last_seen_at',
    ]);
    expect(columnsOf(handle, 'audit_event')).toEqual([
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
    ]);
    expect(columnsOf(handle, 'objective_result')).toEqual([
      'assessment_id',
      'objective_id',
      'status',
      'note',
      'updated_by',
      'updated_at',
    ]);
    expect(columnsOf(handle, 'requirement_state')).toEqual([
      'assessment_id',
      'requirement_id',
      'implementation_level',
      'implementation_statement',
      'owner_user_id',
      'updated_by',
      'updated_at',
    ]);
    const indexColumns = (index: string): string[] =>
      (handle.sqlite.prepare(`pragma index_info(\`${index}\`)`).all() as { name: string }[]).map(
        (column) => column.name,
      );
    expect(indexColumns('session_user_id_idx')).toEqual(['user_id']);
    expect(indexColumns('audit_event_entity_idx')).toEqual(['entity_type', 'entity_id', 'id']);
    const triggers = handle.sqlite
      .prepare("select name from sqlite_master where type = 'trigger' order by name")
      .pluck()
      .all();
    expect(triggers).toEqual(['audit_event_no_delete', 'audit_event_no_update']);
  });

  it('upgrades a foundation database', () => {
    // A copy of the migrations folder holding only 0000, as the foundation sprint shipped it.
    const journal = readJournal();
    expect(journal.entries[0]?.tag).toBe('0000_init');
    expect(journal.entries.length).toBeGreaterThan(1);
    const folder = migrationsUpTo(1);

    const path = join(tempDir(), 'foundation.sqlite');
    const old = track(openDb(path));
    migrate(old.db, { migrationsFolder: folder });
    expect(tables(old).filter((name) => name !== '__drizzle_migrations')).toEqual(['assessment']);
    old.sqlite
      .prepare(
        `insert into assessment (id, type, conditional_status_date, catalog_version, created_at, updated_at)
         values ('kept', 'c3pao', '2026-03-01', 'nist-800-171-r2@1.0.0',
                 '2026-01-02T03:04:05.006Z', '2026-01-02T03:04:05.006Z')`,
      )
      .run();
    const before = old.sqlite.prepare('select * from assessment').all();
    old.sqlite.close();

    const upgraded = track(openDb(path));
    runMigrations(upgraded.db);
    expect(upgraded.sqlite.prepare('select * from assessment').all()).toEqual(before);
    expect(
      tables(upgraded)
        .filter((name) => name !== '__drizzle_migrations')
        .sort(),
    ).toEqual(['assessment', ...NEW_TABLES].sort());
    expect(appliedMigrations(upgraded)).toBe(journal.entries.length);
    // The kept row is usable by the new tables.
    seedUser(upgraded, 'u1', 'admin@example.com');
    expect(() =>
      upgraded.sqlite
        .prepare(
          `insert into objective_result (assessment_id, objective_id, status, updated_by, updated_at)
           values ('kept', '3.1.1[a]', 'met', 'u1', '2026-11-23T00:00:00.000Z')`,
        )
        .run(),
    ).not.toThrow();
  });

  it('new table constraints', () => {
    const handle = track(openDb(':memory:'));
    runMigrations(handle.db);
    handle.sqlite.prepare("insert into assessment (id, catalog_version) values ('a1', 'v')").run();
    seedUser(handle, 'u1', 'A@x.com');
    const user = handle.sqlite.prepare("select * from user where id = 'u1'").get() as Record<
      string,
      unknown
    >;
    expect(user.active).toBe(1);
    expect(user.failed_sign_ins).toBe(0);
    expect(user.locked_until).toBeNull();

    // Role check, and the email is unique whatever its case (and is found whatever its case).
    expect(() => {
      seedUser(handle, 'u2', 'b@x.com', 'owner');
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      seedUser(handle, 'u3', 'c@x.com', 'contributor');
    }).not.toThrow();
    expect(() => {
      seedUser(handle, 'u4', 'a@x.com');
    }).toThrow(/UNIQUE constraint failed: user.email/);
    expect(handle.sqlite.prepare("select id from user where email = 'a@X.COM'").pluck().get()).toBe(
      'u1',
    );
    expect(() => handle.sqlite.prepare("update user set active = 2 where id = 'u1'").run()).toThrow(
      /CHECK constraint failed/,
    );

    // Objective status check, the (assessment, objective) key, and the updated_by FK.
    const putResult = (objective: string, status: string, by = 'u1', assessmentId = 'a1') =>
      handle.sqlite
        .prepare(
          `insert into objective_result (assessment_id, objective_id, status, updated_by, updated_at)
           values (?, ?, ?, ?, '2026-11-23T00:00:00.000Z')`,
        )
        .run(assessmentId, objective, status, by);
    for (const status of ['met', 'not_met', 'na', 'not_assessed']) {
      expect(() => putResult(`3.1.1[${status}]`, status)).not.toThrow();
    }
    expect(() => putResult('3.1.2[a]', 'Met')).toThrow(/CHECK constraint failed/);
    expect(() => putResult('3.1.2[a]', '')).toThrow(/CHECK constraint failed/);
    expect(() => putResult('3.1.1[met]', 'na')).toThrow(
      /UNIQUE constraint failed: objective_result.assessment_id, objective_result.objective_id/,
    );
    expect(() => putResult('3.1.3[a]', 'met', 'nobody')).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => putResult('3.1.3[a]', 'met', 'u1', 'no-assessment')).toThrow(
      /FOREIGN KEY constraint failed/,
    );

    // Requirement state: level check (null allowed), the key, and the owner and updated_by FKs.
    const putState = (requirement: string, level: string | null, owner: string | null, by = 'u1') =>
      handle.sqlite
        .prepare(
          `insert into requirement_state
             (assessment_id, requirement_id, implementation_level, owner_user_id, updated_by, updated_at)
           values ('a1', ?, ?, ?, ?, '2026-11-23T00:00:00.000Z')`,
        )
        .run(requirement, level, owner, by);
    expect(() => putState('IA.L2-3.5.3', 'partial', 'u1')).not.toThrow();
    expect(() => putState('SC.L2-3.13.11', 'none', null)).not.toThrow();
    expect(() => putState('AC.L2-3.1.1', null, null)).not.toThrow();
    expect(() => putState('AC.L2-3.1.2', 'full', null)).toThrow(/CHECK constraint failed/);
    expect(() => putState('AC.L2-3.1.1', null, null)).toThrow(/UNIQUE constraint failed/);
    expect(() => putState('AC.L2-3.1.3', null, 'ghost')).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => putState('AC.L2-3.1.4', null, null, 'ghost')).toThrow(
      /FOREIGN KEY constraint failed/,
    );

    // Sessions need a real user and go when the user row goes.
    const addSession = (id: string, userId: string) =>
      handle.sqlite
        .prepare(
          `insert into session (id, user_id, csrf_token, created_at, last_seen_at)
           values (?, ?, 'csrf', '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z')`,
        )
        .run(id, userId);
    expect(() => addSession('s-ghost', 'ghost')).toThrow(/FOREIGN KEY constraint failed/);
    addSession('s1', 'u3');
    handle.sqlite.prepare("delete from user where id = 'u3'").run();
    expect(handle.sqlite.prepare('select count(*) from session').pluck().get()).toBe(0);

    // An audit event's actor must be a real user, and may be null.
    const addAudit = (actor: string | null) =>
      handle.sqlite
        .prepare(
          `insert into audit_event (at, actor_user_id, assessment_id, action, entity_type, entity_id)
           values ('2026-11-23T00:00:00.000Z', ?, 'a1', 'user.created', 'user', 'u1')`,
        )
        .run(actor);
    expect(() => addAudit('ghost')).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => addAudit(null)).not.toThrow();
    expect(() => addAudit('u1')).not.toThrow();
  });

  it('audit is append-only', () => {
    const handle = track(openDb(':memory:'));
    runMigrations(handle.db);
    const insert = handle.sqlite.prepare(
      `insert into audit_event (at, action, entity_type, entity_id, after)
       values ('2026-11-23T00:00:00.000Z', 'user.created', 'user', 'u1', '{"role":"admin"}')`,
    );
    insert.run();
    insert.run();
    expect(() =>
      handle.sqlite.prepare("update audit_event set after = '{}' where id = 1").run(),
    ).toThrow(/audit_event is append-only/);
    expect(() => handle.sqlite.prepare('update audit_event set request_id = null').run()).toThrow(
      /audit_event is append-only/,
    );
    expect(() => handle.sqlite.prepare('delete from audit_event where id = 1').run()).toThrow(
      /audit_event is append-only/,
    );
    expect(() => handle.sqlite.prepare('delete from audit_event').run()).toThrow(
      /audit_event is append-only/,
    );
    expect(handle.sqlite.prepare('select id, after from audit_event order by id').all()).toEqual([
      { id: 1, after: '{"role":"admin"}' },
      { id: 2, after: '{"role":"admin"}' },
    ]);
    // Appending still works after the refused changes.
    insert.run();
    expect(handle.sqlite.prepare('select max(id) from audit_event').pluck().get()).toBe(3);
  });
});

function seedUser(handle: DbHandle, id: string, email: string, role = 'admin'): void {
  handle.sqlite
    .prepare(
      `insert into user (id, email, display_name, role, password_hash)
       values (?, ?, 'Someone', ?, '$argon2id$fake')`,
    )
    .run(id, email, role);
}
