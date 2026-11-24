import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

/**
 * `apps/api/db/migrations`. This file is in `db/` and the tsup bundle is in `dist/`, both one level
 * below `apps/api`, so the same relative URL finds the folder from source and from the build.
 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../db/migrations', import.meta.url));

export type AppDb = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  /** The raw connection, for PRAGMAs and closing. */
  sqlite: Database.Database;
  db: AppDb;
}

/**
 * Opens the SQLite database at `path` (absolute, or `:memory:`), creating its folder if missing.
 * File databases use WAL; every connection enforces foreign keys.
 */
export function openDb(path: string): DbHandle {
  const inMemory = path === ':memory:';
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  try {
    if (!inMemory) sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

/** Applies every pending migration. Already-applied migrations are skipped, so reruns are no-ops. */
export function runMigrations(db: AppDb): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
