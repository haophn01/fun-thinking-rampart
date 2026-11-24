import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

const apiRoot = resolve(import.meta.dirname, '..');

function configError(env: Record<string, string>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw ConfigError');
}

describe('config', () => {
  it('validates env', () => {
    // Defaults apply.
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3001,
      databasePath: join(apiRoot, 'data', 'rampart.sqlite'),
      logLevel: 'info',
    });

    // Port boundaries.
    expect(loadConfig({ API_PORT: '1' }).port).toBe(1);
    expect(loadConfig({ API_PORT: '65535' }).port).toBe(65535);
    for (const bad of ['0', '65536', 'abc']) {
      expect(configError({ API_PORT: bad }).keys).toEqual(['API_PORT']);
    }

    // One error names every bad key.
    const error = configError({ API_PORT: 'abc', LOG_LEVEL: 'loud', DATABASE_PATH: '   ' });
    expect(error.keys).toEqual(['API_PORT', 'DATABASE_PATH', 'LOG_LEVEL']);
    for (const key of error.keys) expect(error.message).toContain(key);
    expect(error.name).toBe('ConfigError');
  });

  it('rejects ports that are not plain digits', () => {
    for (const bad of ['1.5', ' 3001', '3001 ', '+80', '-1', '0x10', '1e3', '3001abc']) {
      expect(configError({ API_PORT: bad }).keys, bad).toEqual(['API_PORT']);
    }
  });

  it('treats an empty value as unset', () => {
    const config = loadConfig({ API_PORT: '', DATABASE_PATH: '', LOG_LEVEL: '' });
    expect(config.port).toBe(3001);
    expect(config.logLevel).toBe('info');
    expect(config.databasePath).toBe(join(apiRoot, 'data', 'rampart.sqlite'));
  });

  it('resolves DATABASE_PATH against apps/api, not the working directory', () => {
    expect(loadConfig({ DATABASE_PATH: 'tmp/x.sqlite' }).databasePath).toBe(
      join(apiRoot, 'tmp', 'x.sqlite'),
    );
    const absolute = resolve(apiRoot, '..', 'elsewhere.sqlite');
    expect(isAbsolute(absolute)).toBe(true);
    expect(loadConfig({ DATABASE_PATH: absolute }).databasePath).toBe(absolute);
    expect(loadConfig({ DATABASE_PATH: ':memory:' }).databasePath).toBe(':memory:');
  });

  it('accepts every pino level and nothing else', () => {
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']) {
      expect(loadConfig({ LOG_LEVEL: level }).logLevel).toBe(level);
    }
    expect(configError({ LOG_LEVEL: 'INFO' }).keys).toEqual(['LOG_LEVEL']);
  });

  it('ignores unrelated env keys', () => {
    expect(loadConfig({ PATH: '/bin', WEB_PORT: 'nope' }).port).toBe(3001);
  });
});
