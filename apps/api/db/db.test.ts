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
const ASSESSMENT_TABLES = [
  'audit_event',
  'objective_result',
  'requirement_state',
  'session',
  'user',
];
/** The seven tables migration 0003_poam_evidence adds. */
const POAM_EVIDENCE_TABLES = [
  'evidence_item',
  'evidence_link',
  'evidence_version',
  'poam_item',
  'policy',
  'policy_link',
  'policy_version',
];
const ALL_TABLES = [
  'assessment',
  ...ASSESSMENT_TABLES,
  ...POAM_EVIDENCE_TABLES,
  'system_profile',
].sort();
const AT = '2026-11-23T00:00:00.000Z';
const SHA = 'a'.repeat(64);

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

    // assessment, the five assessment-sprint tables and the seven POA&M and evidence tables
    // (and drizzle's own journal table).
    expect(
      tables(handle)
        .filter((name) => name !== '__drizzle_migrations')
        .sort(),
    ).toEqual(ALL_TABLES);
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
    ).toEqual(ALL_TABLES);
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

  it('upgrade keeps assessment data', () => {
    // A database exactly as the assessment sprint left it: migrations 0000 to 0002 only.
    const journal = readJournal();
    const at0002 = journal.entries.findIndex((entry) => entry.tag === '0002_audit_append_only');
    expect(at0002).toBe(2);
    const folder = migrationsUpTo(at0002 + 1);
    const path = join(tempDir(), 'assessment.sqlite');
    const old = track(openDb(path));
    migrate(old.db, { migrationsFolder: folder });
    expect(
      tables(old)
        .filter((name) => name !== '__drizzle_migrations')
        .sort(),
    ).toEqual(['assessment', ...ASSESSMENT_TABLES].sort());
    old.sqlite
      .prepare(
        `insert into assessment (id, type, conditional_status_date, catalog_version, created_at, updated_at)
         values ('a1', 'c3pao', '2026-03-01', 'nist-800-171-r2@1.0.0', ?, ?)`,
      )
      .run(AT, AT);
    seedUser(old, 'u1', 'Admin@Example.com');
    seedUser(old, 'u2', 'helper@example.com', 'contributor');
    old.sqlite
      .prepare(
        `insert into session (id, user_id, csrf_token, created_at, last_seen_at)
         values (?, 'u1', 'csrf', ?, ?)`,
      )
      .run(SHA, AT, AT);
    old.sqlite
      .prepare(
        `insert into objective_result (assessment_id, objective_id, status, note, updated_by, updated_at)
         values ('a1', '3.1.1[a]', 'met', 'checked', 'u1', ?), ('a1', '3.1.2[a]', 'not_met', null, 'u2', ?)`,
      )
      .run(AT, AT);
    old.sqlite
      .prepare(
        `insert into requirement_state
           (assessment_id, requirement_id, implementation_level, implementation_statement,
            owner_user_id, updated_by, updated_at)
         values ('a1', 'IA.L2-3.5.3', 'partial', 'MFA for admins', 'u2', 'u1', ?)`,
      )
      .run(AT);
    old.sqlite
      .prepare(
        `insert into audit_event (at, actor_user_id, assessment_id, action, entity_type, entity_id, before, after)
         values (?, 'u1', 'a1', 'objective_result.updated', 'objective_result', '3.1.1[a]',
                 '{"status":"not_assessed"}', '{"status":"met"}')`,
      )
      .run(AT);
    const kept = ['assessment', ...ASSESSMENT_TABLES];
    const rowsOf = (handle: DbHandle) =>
      Object.fromEntries(
        kept.map((table) => [table, handle.sqlite.prepare(`select * from \`${table}\``).all()]),
      );
    const before = rowsOf(old);
    for (const table of kept) expect(before[table]?.length, table).toBeGreaterThan(0);
    old.sqlite.close();

    const upgraded = track(openDb(path));
    runMigrations(upgraded.db);
    expect(appliedMigrations(upgraded)).toBe(journal.entries.length);
    expect(
      tables(upgraded)
        .filter((name) => name !== '__drizzle_migrations')
        .sort(),
    ).toEqual(ALL_TABLES);
    expect(rowsOf(upgraded)).toEqual(before);
    // The kept rows still enforce their rules, and the new tables can point at them.
    expect(() => {
      seedUser(upgraded, 'u3', 'admin@example.com');
    }).toThrow(/UNIQUE constraint failed: user.email/);
    expect(() => upgraded.sqlite.prepare('delete from audit_event').run()).toThrow(
      /audit_event is append-only/,
    );
    expect(() => {
      addPoamItem(upgraded, { id: 'p1', requirementId: 'AC.L2-3.1.2' });
    }).not.toThrow();
    expect(() => {
      addEvidence(upgraded, 'e1');
    }).not.toThrow();
    expect(() => {
      addPolicy(upgraded, 'pol1');
    }).not.toThrow();
  });

  it('poam and evidence tables have their columns and indexes', () => {
    const handle = track(openDb(':memory:'));
    runMigrations(handle.db);
    expect(columnsOf(handle, 'poam_item')).toEqual([
      'id',
      'assessment_id',
      'requirement_id',
      'status',
      'plan',
      'due',
      'milestones',
      'owner_user_id',
      'closed_on',
      'closeout_note',
      'confirmed_by',
      'c3pao_name',
      'closed_by',
      'created_by',
      'created_at',
      'updated_by',
      'updated_at',
    ]);
    expect(columnsOf(handle, 'evidence_item')).toEqual([
      'id',
      'assessment_id',
      'title',
      'description',
      'contains_cui',
      'created_by',
      'created_at',
      'updated_by',
      'updated_at',
    ]);
    expect(columnsOf(handle, 'evidence_version')).toEqual([
      'evidence_id',
      'version',
      'contains_cui',
      'file_name',
      'size',
      'sha256',
      'storage_key',
      'reference_location',
      'reference_note',
      'created_by',
      'created_at',
    ]);
    expect(columnsOf(handle, 'evidence_link')).toEqual(['evidence_id', 'objective_id']);
    expect(columnsOf(handle, 'policy')).toEqual([
      'id',
      'assessment_id',
      'title',
      'description',
      'created_by',
      'created_at',
      'updated_by',
      'updated_at',
    ]);
    expect(columnsOf(handle, 'policy_version')).toEqual([
      'policy_id',
      'version',
      'file_name',
      'size',
      'sha256',
      'storage_key',
      'created_by',
      'created_at',
    ]);
    expect(columnsOf(handle, 'policy_link')).toEqual(['policy_id', 'requirement_id']);
    const indexColumns = (index: string): string[] =>
      (handle.sqlite.prepare(`pragma index_info(\`${index}\`)`).all() as { name: string }[]).map(
        (column) => column.name,
      );
    expect(indexColumns('evidence_link_objective_id_idx')).toEqual(['objective_id']);
    expect(indexColumns('policy_link_requirement_id_idx')).toEqual(['requirement_id']);
    expect(indexColumns('poam_item_open_requirement_unique')).toEqual([
      'assessment_id',
      'requirement_id',
    ]);

    // status defaults to open and milestones to an empty JSON list; contains_cui has no default.
    seedBase(handle);
    addPoamItem(handle, { id: 'p1', requirementId: 'AC.L2-3.1.2' });
    handle.sqlite
      .prepare(
        `insert into poam_item (id, assessment_id, requirement_id, plan, due, created_by, created_at,
           updated_by, updated_at)
         values ('p2', 'a1', 'AC.L2-3.1.3', 'Fix it', '2027-01-31', 'u1', ?, 'u1', ?)`,
      )
      .run(AT, AT);
    expect(
      handle.sqlite.prepare("select status, milestones from poam_item where id = 'p2'").get(),
    ).toEqual({ status: 'open', milestones: '[]' });
    expect(() =>
      handle.sqlite
        .prepare(
          `insert into evidence_item (id, assessment_id, title, created_by, created_at, updated_by, updated_at)
           values ('e0', 'a1', 'No flag', 'u1', ?, 'u1', ?)`,
        )
        .run(AT, AT),
    ).toThrow(/NOT NULL constraint failed: evidence_item.contains_cui/);
    expect(() => {
      addEvidence(handle, 'e2', 2);
    }).toThrow(/CHECK constraint failed/);
    expect(() =>
      handle.sqlite.prepare("update poam_item set status = 'done' where id = 'p1'").run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      handle.sqlite.prepare("update poam_item set milestones = null where id = 'p1'").run(),
    ).toThrow(/NOT NULL constraint failed: poam_item.milestones/);
  });

  it('one open POA&M item per requirement', () => {
    const handle = track(openDb(':memory:'));
    runMigrations(handle.db);
    seedBase(handle);
    addPoamItem(handle, { id: 'p1', requirementId: 'AC.L2-3.1.2' });
    expect(() => {
      addPoamItem(handle, { id: 'p2', requirementId: 'AC.L2-3.1.2' });
    }).toThrow(/UNIQUE constraint failed: poam_item.assessment_id, poam_item.requirement_id/);

    // Close the first: then an open and a closed item for the same requirement coexist.
    closePoamItem(handle, 'p1');
    expect(() => {
      addPoamItem(handle, { id: 'p2', requirementId: 'AC.L2-3.1.2' });
    }).not.toThrow();
    // Any number of closed items may coexist, but reopening one beside the open one fails.
    closePoamItem(handle, 'p2');
    addPoamItem(handle, { id: 'p3', requirementId: 'AC.L2-3.1.2' });
    expect(
      handle.sqlite
        .prepare(
          "select id, status from poam_item where requirement_id = 'AC.L2-3.1.2' order by id",
        )
        .all(),
    ).toEqual([
      { id: 'p1', status: 'closed' },
      { id: 'p2', status: 'closed' },
      { id: 'p3', status: 'open' },
    ]);
    expect(() =>
      handle.sqlite
        .prepare(
          `update poam_item set status = 'open', closed_on = null, closeout_note = null,
             confirmed_by = null, c3pao_name = null, closed_by = null where id = 'p1'`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);

    // Other requirements, and the same requirement in another assessment, are separate.
    expect(() => {
      addPoamItem(handle, { id: 'p4', requirementId: 'AC.L2-3.1.3' });
    }).not.toThrow();
    handle.sqlite.prepare("insert into assessment (id, catalog_version) values ('a2', 'v')").run();
    expect(() => {
      addPoamItem(handle, { id: 'p5', requirementId: 'AC.L2-3.1.2', assessmentId: 'a2' });
    }).not.toThrow();
  });

  it('poam closeout columns', () => {
    const handle = track(openDb(':memory:'));
    runMigrations(handle.db);
    seedBase(handle);
    const closed = {
      status: 'closed',
      closedOn: '2026-11-20',
      confirmedBy: 'organization',
      closedBy: 'u1',
    } as const;
    let n = 0;
    const add = (fields: Partial<PoamFields>) => {
      n += 1;
      addPoamItem(handle, {
        id: `p${String(n)}`,
        requirementId: `AC.L2-3.1.${String(n)}`,
        ...fields,
      });
    };
    // A closed item needs all three of closed_on, confirmed_by and closed_by.
    expect(() => {
      add(closed);
    }).not.toThrow();
    expect(() => {
      add({ ...closed, confirmedBy: 'c3pao', c3paoName: 'Acme C3PAO', closeoutNote: 'Verified' });
    }).not.toThrow();
    expect(() => {
      add({ ...closed, closedOn: null });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...closed, confirmedBy: null });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...closed, closedBy: null });
    }).toThrow(/CHECK constraint failed/);
    // An open item has none of the closeout columns.
    expect(() => {
      add({ closedOn: '2026-11-20' });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ confirmedBy: 'organization' });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ closedBy: 'u1' });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ closeoutNote: 'early' });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ c3paoName: 'Acme C3PAO' });
    }).toThrow(/CHECK constraint failed/);
    // confirmed_by is one of the two confirmers, and closed_by is a real user.
    expect(() => {
      add({ ...closed, confirmedBy: 'auditor' });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...closed, closedBy: 'ghost' });
    }).toThrow(/FOREIGN KEY constraint failed/);
    // Closing an open item in one update works; dropping a column of a closed one fails.
    add({});
    const openId = `p${String(n)}`;
    expect(() => {
      closePoamItem(handle, openId);
    }).not.toThrow();
    expect(() =>
      handle.sqlite.prepare('update poam_item set closed_by = null where id = ?').run(openId),
    ).toThrow(/CHECK constraint failed/);
    expect(
      handle.sqlite.prepare('select status from poam_item where id = ?').pluck().get(openId),
    ).toBe('closed');
  });

  it('evidence version kinds', () => {
    const handle = track(openDb(':memory:'));
    runMigrations(handle.db);
    seedBase(handle);
    addEvidence(handle, 'e1');
    let version = 0;
    const add = (fields: Partial<VersionFields>) => {
      version += 1;
      addEvidenceVersion(handle, { evidenceId: 'e1', version, ...fields });
    };
    const file = { containsCui: 0, fileName: 'scan.pdf', size: 1, sha256: SHA, storageKey: SHA };
    const reference = { containsCui: 1, referenceLocation: 'CUI enclave share, folder Scans' };

    // The two good shapes.
    expect(() => {
      add(file);
    }).not.toThrow();
    expect(() => {
      add({ ...reference, referenceNote: 'Ask the FSO' });
    }).not.toThrow();
    expect(() => {
      add(reference);
    }).not.toThrow();

    // A CUI version never holds a file, and always says where the file lives.
    expect(() => {
      add({ ...reference, sha256: SHA });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...reference, fileName: 'scan.pdf' });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...reference, size: 10 });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...reference, storageKey: SHA });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ containsCui: 1 });
    }).toThrow(/CHECK constraint failed/);

    // A file version needs every file column and no reference.
    expect(() => {
      add({ ...file, sha256: null });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...file, fileName: null });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...file, size: null });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...file, storageKey: null });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...file, referenceLocation: 'somewhere' });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...file, referenceNote: 'a note' });
    }).toThrow(/CHECK constraint failed/);

    // The hash is 64 lowercase hex characters, and a file has at least one byte.
    expect(() => {
      add({ ...file, sha256: 'a'.repeat(63) });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...file, sha256: 'a'.repeat(65) });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...file, sha256: 'A'.repeat(64) });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...file, sha256: 'g'.repeat(64) });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...file, size: 0 });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      add({ ...file, size: 26_214_400 });
    }).not.toThrow();

    // contains_cui is 0 or 1, versions start at 1, and (evidence, version) is the key.
    expect(() => {
      add({ ...file, containsCui: 2 });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      addEvidenceVersion(handle, { evidenceId: 'e1', version: 0, ...file });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      addEvidenceVersion(handle, { evidenceId: 'e1', version: 1, ...file });
    }).toThrow(/UNIQUE constraint failed: evidence_version.evidence_id, evidence_version.version/);

    // Policy versions are always files, with the same hash and size rules.
    addPolicy(handle, 'pol1');
    expect(() => {
      addPolicyVersion(handle, { policyId: 'pol1', version: 1 });
    }).not.toThrow();
    expect(() => {
      addPolicyVersion(handle, { policyId: 'pol1', version: 1 });
    }).toThrow(/UNIQUE constraint failed: policy_version.policy_id, policy_version.version/);
    expect(() => {
      addPolicyVersion(handle, { policyId: 'pol1', version: 2, sha256: 'a'.repeat(63) });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      addPolicyVersion(handle, { policyId: 'pol1', version: 2, sha256: 'A'.repeat(64) });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      addPolicyVersion(handle, { policyId: 'pol1', version: 2, size: 0 });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      addPolicyVersion(handle, { policyId: 'pol1', version: 0 });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      addPolicyVersion(handle, { policyId: 'pol1', version: 2, fileName: null });
    }).toThrow(/NOT NULL constraint failed: policy_version.file_name/);
    expect(() => {
      addPolicyVersion(handle, { policyId: 'pol1', version: 2, storageKey: null });
    }).toThrow(/NOT NULL constraint failed: policy_version.storage_key/);
  });

  it('foreign keys', () => {
    const handle = track(openDb(':memory:'));
    runMigrations(handle.db);
    seedBase(handle);
    addEvidence(handle, 'e1');
    addPolicy(handle, 'pol1');
    const fk = /FOREIGN KEY constraint failed/;
    const file = { containsCui: 0, fileName: 'a.pdf', size: 1, sha256: SHA, storageKey: SHA };

    // Versions and links need a real evidence item or policy.
    expect(() => {
      addEvidenceVersion(handle, { evidenceId: 'ghost', version: 1, ...file });
    }).toThrow(fk);
    expect(() => {
      addEvidenceVersion(handle, { evidenceId: 'e1', version: 1, ...file });
    }).not.toThrow();
    expect(() => {
      addLink(handle, 'evidence_link', 'ghost', '3.1.1[a]');
    }).toThrow(fk);
    expect(() => {
      addLink(handle, 'evidence_link', 'e1', '3.1.1[a]');
    }).not.toThrow();
    expect(() => {
      addLink(handle, 'evidence_link', 'e1', '3.1.1[a]');
    }).toThrow(/UNIQUE constraint failed: evidence_link.evidence_id, evidence_link.objective_id/);
    expect(() => {
      addPolicyVersion(handle, { policyId: 'ghost', version: 1 });
    }).toThrow(fk);
    expect(() => {
      addPolicyVersion(handle, { policyId: 'pol1', version: 1 });
    }).not.toThrow();
    expect(() => {
      addLink(handle, 'policy_link', 'ghost', 'AC.L2-3.1.1');
    }).toThrow(fk);
    expect(() => {
      addLink(handle, 'policy_link', 'pol1', 'AC.L2-3.1.1');
    }).not.toThrow();
    expect(() => {
      addLink(handle, 'policy_link', 'pol1', 'AC.L2-3.1.1');
    }).toThrow(/UNIQUE constraint failed: policy_link.policy_id, policy_link.requirement_id/);
    // An evidence ID is not a policy ID, and the other way round.
    expect(() => {
      addLink(handle, 'policy_link', 'e1', 'AC.L2-3.1.1');
    }).toThrow(fk);
    expect(() => {
      addLink(handle, 'evidence_link', 'pol1', '3.1.1[a]');
    }).toThrow(fk);

    // Items need a real assessment, and every *_by column a real user.
    expect(() => {
      addEvidence(handle, 'e2', 0, { assessmentId: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addEvidence(handle, 'e2', 0, { createdBy: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addEvidence(handle, 'e2', 0, { updatedBy: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addPolicy(handle, 'pol2', { assessmentId: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addPolicy(handle, 'pol2', { createdBy: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addPolicy(handle, 'pol2', { updatedBy: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addEvidenceVersion(handle, { evidenceId: 'e1', version: 2, ...file, createdBy: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addPolicyVersion(handle, { policyId: 'pol1', version: 2, createdBy: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addPoamItem(handle, { id: 'p1', requirementId: 'AC.L2-3.1.2', assessmentId: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addPoamItem(handle, { id: 'p1', requirementId: 'AC.L2-3.1.2', ownerUserId: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addPoamItem(handle, { id: 'p1', requirementId: 'AC.L2-3.1.2', createdBy: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addPoamItem(handle, { id: 'p1', requirementId: 'AC.L2-3.1.2', updatedBy: 'ghost' });
    }).toThrow(fk);
    expect(() => {
      addPoamItem(handle, { id: 'p1', requirementId: 'AC.L2-3.1.2', ownerUserId: 'u1' });
    }).not.toThrow();

    // A referenced item can't be deleted out from under its versions and links.
    expect(() => handle.sqlite.prepare("delete from evidence_item where id = 'e1'").run()).toThrow(
      fk,
    );
    expect(() => handle.sqlite.prepare("delete from policy where id = 'pol1'").run()).toThrow(fk);
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

/** Assessment a1 with admin u1, the rows every POA&M and evidence row points at. */
function seedBase(handle: DbHandle): void {
  handle.sqlite.prepare("insert into assessment (id, catalog_version) values ('a1', 'v')").run();
  seedUser(handle, 'u1', 'admin@example.com');
}

interface PoamFields {
  id: string;
  requirementId: string;
  assessmentId: string;
  status: string;
  ownerUserId: string | null;
  closedOn: string | null;
  closeoutNote: string | null;
  confirmedBy: string | null;
  c3paoName: string | null;
  closedBy: string | null;
  createdBy: string;
  updatedBy: string;
}

function addPoamItem(
  handle: DbHandle,
  fields: Partial<PoamFields> & Pick<PoamFields, 'id' | 'requirementId'>,
): void {
  const row: PoamFields = {
    assessmentId: 'a1',
    status: 'open',
    ownerUserId: null,
    closedOn: null,
    closeoutNote: null,
    confirmedBy: null,
    c3paoName: null,
    closedBy: null,
    createdBy: 'u1',
    updatedBy: 'u1',
    ...fields,
  };
  handle.sqlite
    .prepare(
      `insert into poam_item
         (id, assessment_id, requirement_id, status, plan, due, owner_user_id, closed_on,
          closeout_note, confirmed_by, c3pao_name, closed_by, created_by, created_at, updated_by,
          updated_at)
       values (@id, @assessmentId, @requirementId, @status, 'Fix it', '2027-01-31', @ownerUserId,
               @closedOn, @closeoutNote, @confirmedBy, @c3paoName, @closedBy, @createdBy, @at,
               @updatedBy, @at)`,
    )
    .run({ ...row, at: AT });
}

function closePoamItem(handle: DbHandle, id: string): void {
  handle.sqlite
    .prepare(
      `update poam_item set status = 'closed', closed_on = '2026-11-22', closeout_note = 'Done',
         confirmed_by = 'organization', closed_by = 'u1' where id = ?`,
    )
    .run(id);
}

interface ItemRefs {
  assessmentId?: string;
  createdBy?: string;
  updatedBy?: string;
}

function addEvidence(handle: DbHandle, id: string, containsCui = 0, refs: ItemRefs = {}): void {
  handle.sqlite
    .prepare(
      `insert into evidence_item
         (id, assessment_id, title, description, contains_cui, created_by, created_at, updated_by,
          updated_at)
       values (?, ?, 'Access list', null, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      refs.assessmentId ?? 'a1',
      containsCui,
      refs.createdBy ?? 'u1',
      AT,
      refs.updatedBy ?? 'u1',
      AT,
    );
}

interface VersionFields {
  evidenceId: string;
  version: number;
  containsCui: number;
  fileName: string | null;
  size: number | null;
  sha256: string | null;
  storageKey: string | null;
  referenceLocation: string | null;
  referenceNote: string | null;
  createdBy: string;
}

function addEvidenceVersion(
  handle: DbHandle,
  fields: Partial<VersionFields> & Pick<VersionFields, 'evidenceId' | 'version'>,
): void {
  const row: VersionFields = {
    containsCui: 0,
    fileName: null,
    size: null,
    sha256: null,
    storageKey: null,
    referenceLocation: null,
    referenceNote: null,
    createdBy: 'u1',
    ...fields,
  };
  handle.sqlite
    .prepare(
      `insert into evidence_version
         (evidence_id, version, contains_cui, file_name, size, sha256, storage_key,
          reference_location, reference_note, created_by, created_at)
       values (@evidenceId, @version, @containsCui, @fileName, @size, @sha256, @storageKey,
               @referenceLocation, @referenceNote, @createdBy, @at)`,
    )
    .run({ ...row, at: AT });
}

function addPolicy(handle: DbHandle, id: string, refs: ItemRefs = {}): void {
  handle.sqlite
    .prepare(
      `insert into policy
         (id, assessment_id, title, description, created_by, created_at, updated_by, updated_at)
       values (?, ?, 'Access control policy', 'Who gets in', ?, ?, ?, ?)`,
    )
    .run(id, refs.assessmentId ?? 'a1', refs.createdBy ?? 'u1', AT, refs.updatedBy ?? 'u1', AT);
}

interface PolicyVersionFields {
  policyId: string;
  version: number;
  fileName: string | null;
  size: number;
  sha256: string;
  storageKey: string | null;
  createdBy: string;
}

function addPolicyVersion(
  handle: DbHandle,
  fields: Partial<PolicyVersionFields> & Pick<PolicyVersionFields, 'policyId' | 'version'>,
): void {
  const row: PolicyVersionFields = {
    fileName: 'policy.docx',
    size: 2048,
    sha256: SHA,
    storageKey: SHA,
    createdBy: 'u1',
    ...fields,
  };
  handle.sqlite
    .prepare(
      `insert into policy_version
         (policy_id, version, file_name, size, sha256, storage_key, created_by, created_at)
       values (@policyId, @version, @fileName, @size, @sha256, @storageKey, @createdBy, @at)`,
    )
    .run({ ...row, at: AT });
}

function addLink(
  handle: DbHandle,
  table: 'evidence_link' | 'policy_link',
  ownerId: string,
  targetId: string,
): void {
  const sql =
    table === 'evidence_link'
      ? 'insert into evidence_link (evidence_id, objective_id) values (?, ?)'
      : 'insert into policy_link (policy_id, requirement_id) values (?, ?)';
  handle.sqlite.prepare(sql).run(ownerId, targetId);
}
