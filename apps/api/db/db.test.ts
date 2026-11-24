import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from './client';

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

function appliedMigrations(handle: DbHandle): number {
  return handle.sqlite.prepare('select count(*) from __drizzle_migrations').pluck().get() as number;
}

describe('database', () => {
  it('migrations and constraints', () => {
    const handle = track(openDb(':memory:'));
    runMigrations(handle.db);

    // The first migration creates only assessment (plus drizzle's own journal table).
    expect(tables(handle).filter((name) => name !== '__drizzle_migrations')).toEqual([
      'assessment',
    ]);
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
      .prepare("insert into assessment (id, catalog_version) values ('a1', 'nist-800-171-r2@1.0.0')")
      .run();
    runMigrations(handle.db);
    expect(appliedMigrations(handle)).toBe(applied);
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
    expect(() =>
      handle.sqlite.prepare("insert into assessment (id) values ('a4')").run(),
    ).toThrow(/NOT NULL constraint failed: assessment.catalog_version/);
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
});
