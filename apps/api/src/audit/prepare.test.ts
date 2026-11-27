import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client';
import { auditEvent } from '../../db/schema';
import { verifyAuditChain } from './chain';

const apiRoot = resolve(import.meta.dirname, '..', '..');
/** A1's own port, so this never meets the human's app or another slice's server. */
const PORT = 3212;
const LEGACY_EVENTS = 12;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rampart-prepare-'));
  dirs.push(dir);
  return dir;
}

/**
 * A DB as the code before the chain left it: migrated up to `upTo` (all of them by default), then
 * holding audit events with no hash, written by raw SQL as the old `recordAudit` stored them.
 */
function legacyDb(dir: string, upTo?: string): string {
  const folder = join(dir, 'migrations');
  cpSync(join(apiRoot, 'db', 'migrations'), folder, { recursive: true });
  if (upTo !== undefined) {
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((entry) => entry.tag <= upTo);
    writeFileSync(journalPath, JSON.stringify(journal));
  }
  const path = join(dir, 'legacy.sqlite');
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  const insert = sqlite.prepare(
    'insert into audit_event (at, action, entity_type, entity_id, before, after, request_id) values (?, ?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < LEGACY_EVENTS; i += 1) {
    insert.run(
      new Date(Date.UTC(2026, 10, 1, 9, i)).toISOString(),
      'objective_result.updated',
      'objective_result',
      `3.1.${String(i)}[a]`,
      i % 2 === 0 ? null : '{"status":"met"}',
      `{"status":"not_met","n":${String(i)}}`,
      i % 3 === 0 ? null : `old-${String(i)}`,
    );
  }
  sqlite.close();
  rmSync(folder, { recursive: true, force: true });
  return path;
}

/** Every event is hashed and the chain verifies, over the whole file. */
function expectChained(path: string): void {
  const handle = openDb(path);
  try {
    const rows = handle.db.select().from(auditEvent).orderBy(asc(auditEvent.id)).all();
    expect(rows).toHaveLength(LEGACY_EVENTS);
    expect(rows.every((row) => row.hash !== null)).toBe(true);
    expect(verifyAuditChain(handle.db, new Date())).toMatchObject({
      ok: true,
      checked: LEGACY_EVENTS,
      total: LEGACY_EVENTS,
      headHash: rows.at(-1)?.hash,
    });
  } finally {
    handle.sqlite.close();
  }
}

function baseEnv(dir: string, databasePath: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    DATABASE_PATH: databasePath,
    STORAGE_PATH: join(dir, 'files'),
    SECRET_KEY_PATH: join(dir, 'rampart-secret.key'),
  };
}

describe('the migrate command', () => {
  // Spawns tsx; Windows CI needs far more than vitest's 5 s.
  it('db:migrate chains a legacy log', { timeout: 120_000 }, () => {
    const dir = tempDir();
    // Built before sec-auth: the migration adds the hash columns, then the backfill fills them.
    const path = legacyDb(dir, '0005_ssp_data');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'db/migrate.ts'], {
      cwd: apiRoot,
      env: baseEnv(dir, path),
      encoding: 'utf8',
      timeout: 100_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain(`"chained":${String(LEGACY_EVENTS)}`);
    expect(output).toContain('audit events chained');
    expect(output).not.toContain('"level":40');
    expectChained(path);

    // A second run is a no-op: nothing to chain, nothing logged about it.
    const again = spawnSync(process.execPath, ['--import', 'tsx', 'db/migrate.ts'], {
      cwd: apiRoot,
      env: baseEnv(dir, path),
      encoding: 'utf8',
      timeout: 100_000,
    });
    const againOutput = `${again.stdout}${again.stderr}`;
    expect(again.status, againOutput).toBe(0);
    expect(againOutput).not.toContain('chained');
    expectChained(path);
  });
});

describe('the server', () => {
  // Spawns tsx and waits for it to listen; Windows CI needs far more than vitest's 5 s.
  it('the server chains a legacy log before it listens', { timeout: 120_000 }, async () => {
    const dir = tempDir();
    // As the human's DB is today: every migration applied, the events not yet hashed.
    const path = legacyDb(dir);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: apiRoot,
      env: { ...baseEnv(dir, path), API_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const exited = new Promise<void>((done) =>
      child.once('exit', () => {
        done();
      }),
    );
    try {
      let health: { status: number; body: unknown } | null = null;
      const deadline = Date.now() + 90_000;
      while (health === null && Date.now() < deadline && child.exitCode === null) {
        try {
          const response = await fetch(`http://127.0.0.1:${String(PORT)}/api/health`);
          health = { status: response.status, body: await response.text() };
        } catch {
          await new Promise((wait) => setTimeout(wait, 250));
        }
      }
      expect(health, output).toEqual({ status: 200, body: '{"status":"ok","db":"ok"}' });
      // The answer came from this server: it chained this DB, then listened on this port. Two
      // loggers write, so lines can land out of order; their own times say which came first.
      const lines = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as { time: number; msg: string; chained?: number });
      const chained = lines.find((line) => line.chained !== undefined);
      const listening = lines.find((line) =>
        line.msg.startsWith(`Server listening at http://127.0.0.1:${String(PORT)}`),
      );
      expect(chained?.chained, output).toBe(LEGACY_EVENTS);
      expect(listening, output).toBeDefined();
      expect(chained?.time, output).toBeLessThanOrEqual(listening?.time ?? -1);
    } finally {
      child.kill();
      await exited;
    }
    expectChained(path);
  });
});
