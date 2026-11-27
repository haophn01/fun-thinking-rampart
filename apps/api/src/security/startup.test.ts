import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { assertSafeStartup, StartupCheckError } from './startup';

const apiRoot = resolve(import.meta.dirname, '..', '..');

function startupError(env: Record<string, string>): StartupCheckError {
  try {
    assertSafeStartup(loadConfig(env));
  } catch (error) {
    if (error instanceof StartupCheckError) return error;
    throw error;
  }
  throw new Error(`expected assertSafeStartup to refuse ${JSON.stringify(env)}`);
}

const SECRET_KEY = 'fedcba9876543210'.repeat(4);

describe('unsafe hosted combinations are refused', () => {
  const safeHosted = { HOSTED: 'true', SERVE_WEB: 'true', RAMPART_SECRET_KEY: SECRET_KEY };

  it('a hosted app that serves the web with real limits and a quiet log passes', () => {
    expect(() => {
      assertSafeStartup(loadConfig(safeHosted));
    }).not.toThrow();
    for (const level of ['fatal', 'error', 'warn', 'info', 'silent']) {
      expect(() => {
        assertSafeStartup(loadConfig({ ...safeHosted, LOG_LEVEL: level }));
      }, level).not.toThrow();
    }
  });

  it('hosted-needs-serve-web fires alone', () => {
    for (const serveWeb of [{}, { SERVE_WEB: 'false' }]) {
      const error = startupError({ HOSTED: 'true', RAMPART_SECRET_KEY: SECRET_KEY, ...serveWeb });
      expect(error.rules).toEqual(['hosted-needs-serve-web']);
      expect(error.name).toBe('StartupCheckError');
      expect(error.message).toContain('hosted-needs-serve-web');
    }
  });

  it('hosted-real-rate-limits fires alone, for any multiplier but 1', () => {
    for (const multiplier of ['2', '100', '1000']) {
      const error = startupError({ ...safeHosted, RATE_LIMIT_MULTIPLIER: multiplier });
      expect(error.rules, multiplier).toEqual(['hosted-real-rate-limits']);
      expect(error.message).toContain('hosted-real-rate-limits');
    }
  });

  it('hosted-log-level fires alone, for debug and trace', () => {
    for (const level of ['debug', 'trace']) {
      const error = startupError({ ...safeHosted, LOG_LEVEL: level });
      expect(error.rules, level).toEqual(['hosted-log-level']);
      expect(error.message).toContain('hosted-log-level');
    }
  });

  it('hosted-needs-secret-key fires alone, for a missing or empty key', () => {
    const { RAMPART_SECRET_KEY: _key, ...withoutKey } = safeHosted;
    for (const env of [withoutKey, { ...withoutKey, RAMPART_SECRET_KEY: '' }]) {
      const error = startupError(env);
      expect(error.rules).toEqual(['hosted-needs-secret-key']);
      expect(error.message).toContain('hosted-needs-secret-key');
      expect(error.message).toContain('RAMPART_SECRET_KEY');
    }
  });

  it('several broken rules are all listed, in order, the secret key last', () => {
    const error = startupError({ HOSTED: 'true', RATE_LIMIT_MULTIPLIER: '5', LOG_LEVEL: 'trace' });
    expect(error.rules).toEqual([
      'hosted-needs-serve-web',
      'hosted-real-rate-limits',
      'hosted-log-level',
      'hosted-needs-secret-key',
    ]);
    const at = error.rules.map((rule) => error.message.indexOf(rule));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    expect(
      startupError({ HOSTED: 'true', LOG_LEVEL: 'debug', RAMPART_SECRET_KEY: SECRET_KEY }).rules,
    ).toEqual(['hosted-needs-serve-web', 'hosted-log-level']);
    expect(startupError({ HOSTED: 'true', SERVE_WEB: 'true', LOG_LEVEL: 'debug' }).rules).toEqual([
      'hosted-log-level',
      'hosted-needs-secret-key',
    ]);
  });

  it('local mode passes any combination, with or without a secret key', () => {
    expect(() => {
      assertSafeStartup(loadConfig({ RAMPART_SECRET_KEY: SECRET_KEY }));
    }).not.toThrow();
    for (const serveWeb of ['true', 'false']) {
      for (const multiplier of ['1', '1000']) {
        for (const level of ['info', 'debug', 'trace']) {
          const env = { SERVE_WEB: serveWeb, RATE_LIMIT_MULTIPLIER: multiplier, LOG_LEVEL: level };
          expect(() => {
            assertSafeStartup(loadConfig(env));
          }, JSON.stringify(env)).not.toThrow();
          expect(() => {
            assertSafeStartup(loadConfig({ ...env, HOSTED: 'false' }));
          }).not.toThrow();
        }
      }
    }
  });
});

describe('server refuses an unsafe hosted config before opening the database', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Runs the real entry file on a scratch folder: its database, files and key file all live there.
   * A server that wrongly starts is killed by the timeout.
   */
  function runServer(env: Record<string, string>, prepare?: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-startup-'));
    dirs.push(dir);
    prepare?.(dir);
    const databasePath = join(dir, 'never.sqlite');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: apiRoot,
      env: {
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        API_PORT: '3221',
        DATABASE_PATH: databasePath,
        STORAGE_PATH: join(dir, 'files'),
        SECRET_KEY_PATH: join(dir, 'rampart-secret.key'),
        ...env,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { result, dir, databasePath, output: `${result.stdout}${result.stderr}` };
  }

  it('HOSTED=true without SERVE_WEB exits 1, names the rule and creates no database', () => {
    const { result, dir, databasePath, output } = runServer({ HOSTED: 'true' });
    expect(result.status, output).toBe(1);
    expect(output).toContain('hosted-needs-serve-web');
    expect(output).toContain('"level":60');
    expect(existsSync(databasePath)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  }, 40_000);
});

describe('server refuses a bad key before opening the database', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('a corrupt key file exits 1 naming the file, leaves it alone and creates no database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-startup-key-'));
    dirs.push(dir);
    const keyPath = join(dir, 'rampart-secret.key');
    const corrupt = `${'ab12'.repeat(15)}xyz
`;
    writeFileSync(keyPath, corrupt);
    const databasePath = join(dir, 'never.sqlite');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: apiRoot,
      env: {
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        API_PORT: '3221',
        DATABASE_PATH: databasePath,
        STORAGE_PATH: join(dir, 'files'),
        SECRET_KEY_PATH: keyPath,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(1);
    expect(output).toContain('"level":60');
    expect(output).toContain('SecretKeyFileError');
    // JSON log lines escape the path's backslashes on Windows.
    expect(output).toContain(JSON.stringify(keyPath).slice(1, -1));
    expect(output).not.toContain(corrupt.trim());
    expect(existsSync(databasePath)).toBe(false);
    expect(readdirSync(dir)).toEqual(['rampart-secret.key']);
    expect(readFileSync(keyPath, 'utf8')).toBe(corrupt);
  }, 40_000);
});
