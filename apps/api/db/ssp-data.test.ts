import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { is } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from './client';
import * as schema from './schema';

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));
const AT = '2026-11-25T00:00:00.000Z';
const SHA = 'c'.repeat(64);

/** The tables a 0004 database has, all of which the upgrade must keep row for row. */
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
  'system_profile',
  'user',
];

const STAMPS = ['created_by', 'created_at', 'updated_by', 'updated_at'];

/** The eight tables 0005 adds, with their columns in order. */
const NEW_TABLES: Record<string, string[]> = {
  ssp_profile: [
    'assessment_id',
    'categorization',
    'security_officer',
    'security_officer_email',
    'organization_address',
    'organization_phone',
    'cui_categories',
    'cui_locations',
    'cui_entry_exit',
    'topology_narrative',
    'data_flow_narrative',
    'inventory_reference',
    'maintenance_statement',
    'review_cadence_months',
    'next_review_date',
    'updated_by',
    'updated_at',
  ],
  system_role: [
    'id',
    'assessment_id',
    'title',
    'person',
    'responsibilities',
    'user_count',
    'privileged',
    ...STAMPS,
    'removed_at',
  ],
  asset: [
    'id',
    'assessment_id',
    'name',
    'category',
    'asset_type',
    'owner',
    'location',
    'treatment',
    'out_of_scope_justification',
    ...STAMPS,
    'removed_at',
  ],
  service_provider: [
    'id',
    'assessment_id',
    'name',
    'provider_type',
    'fedramp_status',
    'services',
    'agreement_reference',
    ...STAMPS,
    'removed_at',
  ],
  responsibility: [
    'assessment_id',
    'requirement_id',
    'party',
    'provider_id',
    'note',
    'updated_by',
    'updated_at',
  ],
  diagram_link: [
    'id',
    'assessment_id',
    'evidence_id',
    'version',
    'kind',
    'caption',
    ...STAMPS,
    'removed_at',
  ],
  ssp_revision: [
    'id',
    'assessment_id',
    'kind',
    'revised_on',
    'description',
    'made_by',
    'created_by',
    'created_at',
  ],
  ssp_approval: ['id', 'assessment_id', 'name', 'title', 'approved_on', ...STAMPS, 'removed_at'],
};

/** The columns that must be set. Everything else in `NEW_TABLES` is nullable. */
const REQUIRED: Record<string, string[]> = {
  ssp_profile: ['assessment_id', 'review_cadence_months', 'updated_by', 'updated_at'],
  system_role: ['id', 'assessment_id', 'title', 'user_count', 'privileged', ...STAMPS],
  asset: ['id', 'assessment_id', 'name', 'category', ...STAMPS],
  service_provider: ['id', 'assessment_id', 'name', 'provider_type', ...STAMPS],
  responsibility: ['assessment_id', 'requirement_id', 'updated_by', 'updated_at'],
  diagram_link: ['id', 'assessment_id', 'evidence_id', 'kind', 'caption', ...STAMPS],
  ssp_revision: [
    'id',
    'assessment_id',
    'kind',
    'revised_on',
    'description',
    'made_by',
    'created_by',
    'created_at',
  ],
  ssp_approval: ['id', 'assessment_id', 'name', 'title', ...STAMPS],
};

const STAMP_KEYS = ['assessment_id->assessment.id', 'created_by->user.id', 'updated_by->user.id'];

const FOREIGN_KEYS: Record<string, string[]> = {
  ssp_profile: ['assessment_id->assessment.id', 'updated_by->user.id'],
  system_role: STAMP_KEYS,
  asset: STAMP_KEYS,
  service_provider: STAMP_KEYS,
  responsibility: [
    'assessment_id->assessment.id',
    'provider_id->service_provider.id',
    'updated_by->user.id',
  ],
  diagram_link: [...STAMP_KEYS, 'evidence_id->evidence_item.id'].sort(),
  ssp_revision: ['assessment_id->assessment.id', 'created_by->user.id'],
  ssp_approval: STAMP_KEYS,
};

const PRIMARY_KEYS: Record<string, string[]> = {
  ssp_profile: ['assessment_id'],
  responsibility: ['assessment_id', 'requirement_id'],
};

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
  const dir = mkdtempSync(join(tmpdir(), 'rampart-ssp-data-db-'));
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

interface ColumnInfo {
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

/** One row in every table a 0004 database has. */
function seed0004(handle: DbHandle): void {
  const run = (sql: string, ...params: unknown[]) => handle.sqlite.prepare(sql).run(...params);
  run(
    `insert into assessment (id, type, conditional_status_date, catalog_version, created_at, updated_at)
     values ('a1', 'c3pao', '2026-03-01', 'nist-800-171-r2@1.0.0', ?, ?)`,
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
      `${id} name`,
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
     values (?, 'u1', 'a1', 'system_profile.updated', 'system_profile', 'a1', '{}', '{"systemName":"Prod"}')`,
    AT,
  );
  run(
    `insert into objective_result (assessment_id, objective_id, status, note, updated_by, updated_at)
     values ('a1', '3.1.1[a]', 'met', 'checked', 'u2', ?), ('a1', '3.1.2[a]', 'na', null, 'u1', ?)`,
    AT,
    AT,
  );
  run(
    `insert into requirement_state
       (assessment_id, requirement_id, implementation_level, implementation_statement,
        owner_user_id, updated_by, updated_at)
     values ('a1', 'AC.L2-3.1.1', null, 'We do it', 'u2', 'u1', ?),
            ('a1', 'IA.L2-3.5.3', 'partial', null, null, 'u2', ?)`,
    AT,
    AT,
  );
  run(
    `insert into poam_item (id, assessment_id, requirement_id, status, plan, due, milestones,
       created_by, created_at, updated_by, updated_at)
     values ('p1', 'a1', 'IA.L2-3.5.3', 'open', 'Roll out MFA', '2027-01-01', '[]', 'u1', ?, 'u1', ?)`,
    AT,
    AT,
  );
  run(
    `insert into evidence_item (id, assessment_id, title, description, contains_cui,
       created_by, created_at, updated_by, updated_at)
     values ('e1', 'a1', 'Network diagram', null, 0, 'u1', ?, 'u1', ?)`,
    AT,
    AT,
  );
  run(
    `insert into evidence_version (evidence_id, version, contains_cui, file_name, size, sha256,
       storage_key, created_by, created_at)
     values ('e1', 1, 0, 'network.png', 10, ?, ?, 'u1', ?)`,
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
  run(
    `insert into system_profile (assessment_id, system_name, cage_code, updated_by, updated_at)
     values ('a1', 'Prod', '1ABC2', 'u1', ?)`,
    AT,
  );
}

/** A migrated database with the rows every new table points at. */
function freshDb(): DbHandle {
  const handle = track(openDb(':memory:'));
  runMigrations(handle.db);
  seed0004(handle);
  return handle;
}

const stamps = { created_by: 'u1', created_at: AT, updated_by: 'u1', updated_at: AT };

/** A valid row for each new table; tests vary one field at a time. */
const VALID: Record<string, Row> = {
  ssp_profile: {
    assessment_id: 'a1',
    review_cadence_months: 12,
    updated_by: 'u1',
    updated_at: AT,
  },
  system_role: {
    id: 'r1',
    assessment_id: 'a1',
    title: 'System administrator',
    user_count: 2,
    privileged: 1,
    ...stamps,
  },
  asset: { id: 's1', assessment_id: 'a1', name: 'File server', category: 'cui', ...stamps },
  service_provider: {
    id: 'sp1',
    assessment_id: 'a1',
    name: 'Cloud Co',
    provider_type: 'cloud',
    ...stamps,
  },
  responsibility: {
    assessment_id: 'a1',
    requirement_id: 'AC.L2-3.1.1',
    party: 'organization',
    provider_id: null,
    updated_by: 'u1',
    updated_at: AT,
  },
  diagram_link: {
    id: 'd1',
    assessment_id: 'a1',
    evidence_id: 'e1',
    version: null,
    kind: 'network',
    caption: 'Network',
    ...stamps,
  },
  ssp_revision: {
    id: 'rev1',
    assessment_id: 'a1',
    kind: 'manual',
    revised_on: '2026-11-25',
    description: 'First issue',
    made_by: 'u1 name',
    created_by: 'u1',
    created_at: AT,
  },
  ssp_approval: {
    id: 'ap1',
    assessment_id: 'a1',
    name: 'Pat Doe',
    title: 'CEO',
    approved_on: null,
    ...stamps,
  },
};

/** Statements of a drizzle-kit migration file, without the breakpoint markers. */
function statementsOf(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

describe('ssp data migration', () => {
  it('0005 is additive', () => {
    const tags = readJournal().entries.map((entry) => entry.tag);
    expect(tags.indexOf('0005_ssp_data')).toBe(5);

    const statements = statementsOf(readFileSync(join(MIGRATIONS, '0005_ssp_data.sql'), 'utf8'));
    const created: string[] = [];
    const added: string[] = [];
    for (const statement of statements) {
      const table = /^CREATE TABLE `([a-z_]+)`/.exec(statement);
      const index = /^CREATE INDEX `[a-z_]+` ON `([a-z_]+)`/.exec(statement);
      const alter = /^ALTER TABLE `([a-z_]+)` ADD `([a-z_]+)` text;$/.exec(statement);
      if (table?.[1]) created.push(table[1]);
      else if (alter?.[1] && alter[2]) added.push(`${alter[1]}.${alter[2]}`);
      else expect(index?.[1], statement).toBeDefined();
      // Indexes go only on the new tables.
      if (index?.[1]) expect(Object.keys(NEW_TABLES), statement).toContain(index[1]);
    }
    expect(created.sort()).toEqual(Object.keys(NEW_TABLES).sort());
    expect(added).toEqual([
      'requirement_state.planned_implementation',
      'requirement_state.na_rationale',
    ]);
    // No drops, renames, data changes or table rebuilds anywhere in the file.
    const words = statements.join('\n').replace(/ON (UPDATE|DELETE) no action/g, '');
    expect(words).not.toMatch(/\b(DROP|RENAME|INSERT|UPDATE|DELETE)\b/i);
    expect(words).not.toMatch(/__new_/);
  });

  it('upgrade from 0004 keeps data', () => {
    const journal = readJournal();
    const at0004 = journal.entries.findIndex((entry) => entry.tag === '0004_system_profile');
    expect(at0004).toBe(4);
    // 0006_sec_auth follows; it has its own upgrade test (sec-auth.test.ts).
    expect(journal.entries.map((entry) => entry.tag).slice(at0004 + 1)).toEqual([
      '0005_ssp_data',
      '0006_sec_auth',
    ]);

    // A database exactly as ssp-dashboard left it (0000–0004), with a row in every table.
    const path = join(tempDir(), 'ssp-dashboard.sqlite');
    const old = track(openDb(path));
    migrate(old.db, { migrationsFolder: migrationsUpTo(at0004 + 1) });
    expect(tables(old)).toEqual(KEPT_TABLES);
    seed0004(old);
    const rowsOf = (handle: DbHandle) =>
      Object.fromEntries(
        KEPT_TABLES.map((table) => [
          table,
          handle.sqlite.prepare(`select * from \`${table}\` order by rowid`).all() as Row[],
        ]),
      );
    const before = rowsOf(old);
    for (const table of KEPT_TABLES) expect(before[table]?.length, table).toBeGreaterThan(0);
    const oldSchema = schemaSql(old);
    const oldRequirementColumns = columnInfo(old, 'requirement_state');
    old.sqlite.close();

    // Upgrade to 0005 exactly: every row is kept and the eight tables are added.
    const upTo0005 = migrationsUpTo(at0004 + 2);
    const upgraded = track(openDb(path));
    migrate(upgraded.db, { migrationsFolder: upTo0005 });
    expect(appliedMigrations(upgraded)).toBe(at0004 + 2);
    expect(tables(upgraded)).toEqual([...KEPT_TABLES, ...Object.keys(NEW_TABLES)].sort());
    expect(rowsOf(upgraded)).toEqual({
      ...before,
      requirement_state: before.requirement_state?.map((row) => ({
        ...row,
        planned_implementation: null,
        na_rationale: null,
      })),
    });

    // Every old definition is unchanged, except that requirement_state gains two columns at its
    // end: nullable text with no default, and its old columns and check stay as they were.
    const newSchema = schemaSql(upgraded);
    for (const definition of oldSchema) {
      if (definition.startsWith('table requirement_state ')) continue;
      expect(newSchema).toContain(definition);
    }
    const requirementColumns = columnInfo(upgraded, 'requirement_state');
    expect(requirementColumns.slice(0, oldRequirementColumns.length)).toEqual(
      oldRequirementColumns,
    );
    expect(requirementColumns.slice(oldRequirementColumns.length)).toEqual([
      { cid: 7, name: 'planned_implementation', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 8, name: 'na_rationale', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    ]);
    const requirementSql = newSchema.find((entry) => entry.startsWith('table requirement_state '));
    expect(requirementSql).toContain(
      'CONSTRAINT "requirement_state_level_check" CHECK("requirement_state"."implementation_level" in (\'none\', \'partial\'))',
    );

    // The new tables can point at the kept rows, and the kept rows take the new fields.
    for (const [table, row] of Object.entries(VALID)) {
      expect(() => {
        insert(upgraded, table, row);
      }, table).not.toThrow();
    }
    upgraded.sqlite
      .prepare(
        `update requirement_state set planned_implementation = 'MFA by March', na_rationale = 'n/a'
         where requirement_id = 'IA.L2-3.5.3'`,
      )
      .run();

    // A second run is a no-op.
    const applied = appliedMigrations(upgraded);
    const schemaBefore = schemaSql(upgraded);
    const rowsBefore = rowsOf(upgraded);
    migrate(upgraded.db, { migrationsFolder: upTo0005 });
    expect(appliedMigrations(upgraded)).toBe(applied);
    expect(schemaSql(upgraded)).toEqual(schemaBefore);
    expect(rowsOf(upgraded)).toEqual(rowsBefore);
    for (const table of Object.keys(NEW_TABLES)) {
      expect(
        upgraded.sqlite.prepare(`select count(*) from \`${table}\``).pluck().get(),
        table,
      ).toBe(1);
    }
  });

  it('new table constraints', () => {
    const handle = freshDb();

    // Columns, nullability, keys and foreign keys. Timestamps and `*_by` come from the api, so
    // no column has a default.
    for (const [table, names] of Object.entries(NEW_TABLES)) {
      const columns = columnInfo(handle, table);
      expect(
        columns.map((column) => column.name),
        table,
      ).toEqual(names);
      const primary = PRIMARY_KEYS[table] ?? ['id'];
      for (const column of columns) {
        const label = `${table}.${column.name}`;
        expect(column.notnull, label).toBe(REQUIRED[table]?.includes(column.name) ? 1 : 0);
        expect(column.dflt_value, label).toBeNull();
        expect(column.pk, label).toBe(primary.indexOf(column.name) + 1);
        const integerColumns = ['review_cadence_months', 'user_count', 'privileged', 'version'];
        expect(column.type, label).toBe(integerColumns.includes(column.name) ? 'INTEGER' : 'TEXT');
      }
      expect(foreignKeys(handle, table), table).toEqual([...(FOREIGN_KEYS[table] ?? [])].sort());
    }
    const indexColumns = handle.sqlite
      .prepare('pragma index_info(`responsibility_provider_id_idx`)')
      .all() as { name: string }[];
    expect(indexColumns.map((column) => column.name)).toEqual(['provider_id']);

    insert(handle, 'service_provider', VALID.service_provider ?? {});
    const accepts = (table: string, change: Row) => {
      const row = { ...VALID[table], ...change };
      expect(
        () => {
          insert(handle, table, row);
        },
        `${table} ${JSON.stringify(change)}`,
      ).not.toThrow();
    };
    const refuses = (table: string, change: Row, error: RegExp) => {
      expect(
        () => {
          insert(handle, table, { ...VALID[table], ...change });
        },
        `${table} ${JSON.stringify(change)}`,
      ).toThrow(error);
    };
    const CHECK = /CHECK constraint failed/;
    const NOT_NULL = /NOT NULL constraint failed/;
    const FOREIGN = /FOREIGN KEY constraint failed/;

    // ssp_profile: cadence 1–60 and never null; one row per assessment.
    refuses('ssp_profile', { review_cadence_months: 0 }, CHECK);
    refuses('ssp_profile', { review_cadence_months: 61 }, CHECK);
    refuses('ssp_profile', { review_cadence_months: null }, NOT_NULL);
    refuses('ssp_profile', { assessment_id: 'ghost' }, FOREIGN);
    refuses('ssp_profile', { updated_by: 'ghost' }, FOREIGN);
    accepts('ssp_profile', { review_cadence_months: 60 });
    refuses('ssp_profile', { review_cadence_months: 1 }, /UNIQUE constraint failed/);
    handle.sqlite
      .prepare("update ssp_profile set review_cadence_months = 1 where assessment_id = 'a1'")
      .run();
    expect(() =>
      handle.sqlite.prepare('update ssp_profile set review_cadence_months = 61').run(),
    ).toThrow(CHECK);

    // system_role: user_count ≥ 0, privileged is 0 or 1.
    refuses('system_role', { id: 'r0', user_count: -1 }, CHECK);
    refuses('system_role', { id: 'r0', privileged: 2 }, CHECK);
    refuses('system_role', { id: 'r0', user_count: null }, NOT_NULL);
    refuses('system_role', { id: 'r0', created_by: 'ghost' }, FOREIGN);
    accepts('system_role', { id: 'r1', user_count: 0, privileged: 0 });
    accepts('system_role', { id: 'r2', removed_at: AT });

    // asset: the five categories; out of scope needs a justification.
    for (const category of ['cui', 'spa', 'crma', 'specialized']) {
      accepts('asset', { id: `s-${category}`, category });
    }
    refuses('asset', { id: 's0', category: 'other' }, CHECK);
    refuses('asset', { id: 's0', category: 'out_of_scope' }, CHECK);
    accepts('asset', {
      id: 's-oos',
      category: 'out_of_scope',
      out_of_scope_justification: 'Guest wifi, no CUI',
    });
    accepts('asset', { id: 's-kept', category: 'spa', out_of_scope_justification: 'kept' });
    expect(() =>
      handle.sqlite
        .prepare("update asset set out_of_scope_justification = null where id = 's-oos'")
        .run(),
    ).toThrow(CHECK);

    // service_provider: the four types.
    for (const providerType of ['msp', 'mssp', 'other']) {
      accepts('service_provider', { id: `sp-${providerType}`, provider_type: providerType });
    }
    refuses('service_provider', { id: 'sp0', provider_type: 'saas' }, CHECK);

    // responsibility: esp and shared name a provider; organization and null name none.
    const requirement = (id: string) => ({ requirement_id: id });
    accepts('responsibility', { ...requirement('R1'), party: 'esp', provider_id: 'sp1' });
    accepts('responsibility', { ...requirement('R2'), party: 'shared', provider_id: 'sp1' });
    accepts('responsibility', { ...requirement('R3'), party: 'organization', provider_id: null });
    accepts('responsibility', { ...requirement('R4'), party: null, provider_id: null });
    refuses('responsibility', { ...requirement('R5'), party: 'esp', provider_id: null }, CHECK);
    refuses('responsibility', { ...requirement('R5'), party: 'shared', provider_id: null }, CHECK);
    refuses(
      'responsibility',
      { ...requirement('R5'), party: 'organization', provider_id: 'sp1' },
      CHECK,
    );
    refuses('responsibility', { ...requirement('R5'), party: null, provider_id: 'sp1' }, CHECK);
    refuses('responsibility', { ...requirement('R5'), party: 'vendor', provider_id: null }, CHECK);
    refuses(
      'responsibility',
      { ...requirement('R5'), party: 'esp', provider_id: 'ghost' },
      FOREIGN,
    );
    refuses('responsibility', requirement('R1'), /UNIQUE constraint failed/);
    expect(() =>
      handle.sqlite.prepare("delete from service_provider where id = 'sp1'").run(),
    ).toThrow(FOREIGN);

    // diagram_link: version ≥ 1 or null (always the newest); the three kinds; a real evidence item.
    accepts('diagram_link', { id: 'd1' });
    accepts('diagram_link', { id: 'd2', version: 1, kind: 'data_flow' });
    accepts('diagram_link', { id: 'd3', kind: 'other' });
    refuses('diagram_link', { id: 'd0', version: 0 }, CHECK);
    refuses('diagram_link', { id: 'd0', kind: 'photo' }, CHECK);
    refuses('diagram_link', { id: 'd0', evidence_id: 'ghost' }, FOREIGN);
    refuses('diagram_link', { id: 'd0', caption: null }, NOT_NULL);

    // ssp_revision: export or manual.
    accepts('ssp_revision', { id: 'rev1' });
    accepts('ssp_revision', { id: 'rev2', kind: 'export' });
    refuses('ssp_revision', { id: 'rev0', kind: 'draft' }, CHECK);
    refuses('ssp_revision', { id: 'rev0', made_by: null }, NOT_NULL);

    // ssp_approval: a blank signature date is allowed; stamps are not.
    accepts('ssp_approval', { id: 'ap1' });
    accepts('ssp_approval', { id: 'ap2', approved_on: '2026-11-25' });
    refuses('ssp_approval', { id: 'ap0', created_at: null }, NOT_NULL);
    refuses('ssp_approval', { id: 'ap0', updated_by: 'ghost' }, FOREIGN);
  });

  // 0006 only adds tables and columns, so everything the 0005 snapshot holds is still in
  // schema.ts unchanged; sec-auth.test.ts checks the newest snapshot equals schema.ts.
  it('schema matches the snapshot', () => {
    const journal = readJournal();
    expect(journal.entries.map((entry) => entry.tag)).toContain('0005_ssp_data');
    const snapshot = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', '0005_snapshot.json'), 'utf8'),
    ) as {
      tables: Record<
        string,
        {
          columns: Record<string, { notNull: boolean; type: string; primaryKey: boolean }>;
          checkConstraints: Record<string, unknown>;
          foreignKeys: Record<string, unknown>;
        }
      >;
    };
    const fromSchema = Object.values(schema).flatMap((value: unknown) =>
      is(value, SQLiteTable) ? [getTableConfig(value)] : [],
    );
    const schemaNames = fromSchema.map((config) => config.name);
    for (const name of Object.keys(snapshot.tables)) expect(schemaNames).toContain(name);
    for (const config of fromSchema) {
      const stored = snapshot.tables[config.name];
      if (stored === undefined) continue;
      const storedNames = Object.keys(stored.columns);
      expect(
        Object.fromEntries(
          config.columns
            .filter((column) => storedNames.includes(column.name))
            .map((column) => [column.name, { notNull: column.notNull, type: column.getSQLType() }]),
        ),
        config.name,
      ).toEqual(
        Object.fromEntries(
          Object.entries(stored.columns).map(([name, column]) => [
            name,
            { notNull: column.notNull, type: column.type },
          ]),
        ),
      );
      expect(Object.keys(stored.checkConstraints).sort(), config.name).toEqual(
        config.checks.map((check) => check.name).sort(),
      );
      expect(Object.keys(stored.foreignKeys).length, config.name).toBe(config.foreignKeys.length);
    }
    for (const table of Object.keys(NEW_TABLES)) {
      expect(Object.keys(snapshot.tables[table]?.columns ?? {}), table).toEqual(NEW_TABLES[table]);
    }
  });
});
