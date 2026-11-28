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
      storagePath: join(apiRoot, 'data', 'files'),
      logLevel: 'info',
      hosted: false,
      serveWeb: false,
      webDistPath: resolve(apiRoot, '..', 'web', 'dist'),
      rateLimitMultiplier: 1,
      secretKeyHex: null,
      secretKeyPath: join(apiRoot, 'data', 'rampart-secret.key'),
      fipsMode: 'off',
    });

    // Port boundaries.
    expect(loadConfig({ API_PORT: '1' }).port).toBe(1);
    expect(loadConfig({ API_PORT: '65535' }).port).toBe(65535);
    for (const bad of ['0', '65536', 'abc']) {
      expect(configError({ API_PORT: bad }).keys).toEqual(['API_PORT']);
    }

    // One error names every bad key.
    const error = configError({
      API_PORT: 'abc',
      LOG_LEVEL: 'loud',
      DATABASE_PATH: '   ',
      STORAGE_PATH: ' ',
    });
    expect(error.keys).toEqual(['API_PORT', 'DATABASE_PATH', 'LOG_LEVEL', 'STORAGE_PATH']);
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

  it('storage path', () => {
    // Defaults to apps/api/data/files, whatever the working directory.
    expect(loadConfig({}).storagePath).toBe(join(apiRoot, 'data', 'files'));
    // An empty value means the default.
    expect(loadConfig({ STORAGE_PATH: '' }).storagePath).toBe(join(apiRoot, 'data', 'files'));
    // A relative value resolves against apps/api, and may contain spaces.
    expect(loadConfig({ STORAGE_PATH: 'scratch/evidence files' }).storagePath).toBe(
      join(apiRoot, 'scratch', 'evidence files'),
    );
    expect(loadConfig({ STORAGE_PATH: '../outside' }).storagePath).toBe(
      resolve(apiRoot, '..', 'outside'),
    );
    // An absolute value is kept as given.
    const absolute = resolve(apiRoot, '..', 'evidence-store');
    expect(loadConfig({ STORAGE_PATH: absolute }).storagePath).toBe(absolute);
    // Whitespace only is refused, naming the key.
    for (const blank of [' ', '\t', ' \n ']) {
      const error = configError({ STORAGE_PATH: blank });
      expect(error.keys).toEqual(['STORAGE_PATH']);
      expect(error.message).toContain('STORAGE_PATH');
    }
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

  describe('hosted, serve-web, dist path and rate-limit multiplier', () => {
    it('defaults: local, no web serving, the web build next door, real limits', () => {
      const config = loadConfig({});
      expect(config.hosted).toBe(false);
      expect(config.serveWeb).toBe(false);
      expect(config.webDistPath).toBe(resolve(apiRoot, '..', 'web', 'dist'));
      expect(config.rateLimitMultiplier).toBe(1);
    });

    it('an empty value is unset', () => {
      const config = loadConfig({
        HOSTED: '',
        SERVE_WEB: '',
        WEB_DIST_PATH: '',
        RATE_LIMIT_MULTIPLIER: '',
      });
      expect(config.hosted).toBe(false);
      expect(config.serveWeb).toBe(false);
      expect(config.webDistPath).toBe(resolve(apiRoot, '..', 'web', 'dist'));
      expect(config.rateLimitMultiplier).toBe(1);
    });

    it('the booleans take exactly true or false', () => {
      expect(loadConfig({ HOSTED: 'true' }).hosted).toBe(true);
      expect(loadConfig({ HOSTED: 'false' }).hosted).toBe(false);
      expect(loadConfig({ SERVE_WEB: 'true' }).serveWeb).toBe(true);
      expect(loadConfig({ SERVE_WEB: 'false' }).serveWeb).toBe(false);
      for (const bad of ['TRUE', 'True', '1', '0', 'yes', 'no', ' true', 'true ', 'on']) {
        expect(configError({ HOSTED: bad }).keys, `HOSTED=${bad}`).toEqual(['HOSTED']);
        expect(configError({ SERVE_WEB: bad }).keys, `SERVE_WEB=${bad}`).toEqual(['SERVE_WEB']);
      }
    });

    it('the dist path resolves against apps/api; absolute is kept; blank is refused', () => {
      expect(loadConfig({ WEB_DIST_PATH: 'build/web' }).webDistPath).toBe(
        join(apiRoot, 'build', 'web'),
      );
      const absolute = resolve(apiRoot, '..', 'somewhere', 'dist');
      expect(loadConfig({ WEB_DIST_PATH: absolute }).webDistPath).toBe(absolute);
      for (const blank of [' ', '	']) {
        expect(configError({ WEB_DIST_PATH: blank }).keys).toEqual(['WEB_DIST_PATH']);
      }
    });

    it('the multiplier is digits only, from 1 to 1000', () => {
      expect(loadConfig({ RATE_LIMIT_MULTIPLIER: '1' }).rateLimitMultiplier).toBe(1);
      expect(loadConfig({ RATE_LIMIT_MULTIPLIER: '100' }).rateLimitMultiplier).toBe(100);
      expect(loadConfig({ RATE_LIMIT_MULTIPLIER: '1000' }).rateLimitMultiplier).toBe(1000);
      for (const bad of ['0', '1001', '1.5', '-1', '1e2', '+5', ' 5', '5 ', '0x10', 'abc']) {
        expect(configError({ RATE_LIMIT_MULTIPLIER: bad }).keys, bad).toEqual([
          'RATE_LIMIT_MULTIPLIER',
        ]);
      }
    });

    it('one error names every bad new key, with the old ones', () => {
      const error = configError({
        HOSTED: 'yes',
        SERVE_WEB: '1',
        WEB_DIST_PATH: ' ',
        RATE_LIMIT_MULTIPLIER: '0',
        API_PORT: 'abc',
      });
      expect(error.keys).toEqual([
        'API_PORT',
        'HOSTED',
        'RATE_LIMIT_MULTIPLIER',
        'SERVE_WEB',
        'WEB_DIST_PATH',
      ]);
      for (const key of error.keys) expect(error.message).toContain(key);
    });
  });

  describe('secret key settings', () => {
    const KEY = '0123456789abcdef'.repeat(4);

    it('a 64-hex key in either case parses to lowercase', () => {
      expect(loadConfig({ RAMPART_SECRET_KEY: KEY }).secretKeyHex).toBe(KEY);
      expect(loadConfig({ RAMPART_SECRET_KEY: KEY.toUpperCase() }).secretKeyHex).toBe(KEY);
      const mixed = 'AbCdEf0123456789'.repeat(4);
      expect(loadConfig({ RAMPART_SECRET_KEY: mixed }).secretKeyHex).toBe(mixed.toLowerCase());
    });

    it('unset or empty is null', () => {
      expect(loadConfig({}).secretKeyHex).toBeNull();
      expect(loadConfig({ RAMPART_SECRET_KEY: '' }).secretKeyHex).toBeNull();
    });

    it('refuses a wrong length, a non-hex character or one byte repeated, naming the key only', () => {
      const bad = [
        KEY.slice(0, 63),
        `${KEY}0`,
        `${KEY.slice(0, 63)}g`,
        '0'.repeat(64),
        'ab'.repeat(32),
        'FF'.repeat(32),
        ` ${KEY}`,
        `${KEY}
`,
      ];
      for (const value of bad) {
        const error = configError({ RAMPART_SECRET_KEY: value });
        expect(error.keys, JSON.stringify(value)).toEqual(['RAMPART_SECRET_KEY']);
        expect(error.message).toContain('RAMPART_SECRET_KEY');
        // The value itself never reaches the message, even a near-miss key.
        expect(error.message).not.toContain(value.trim().slice(0, 32));
      }
    });

    it('SECRET_KEY_PATH resolves against apps/api; absolute is kept; blank is refused', () => {
      expect(loadConfig({}).secretKeyPath).toBe(join(apiRoot, 'data', 'rampart-secret.key'));
      expect(loadConfig({ SECRET_KEY_PATH: '' }).secretKeyPath).toBe(
        join(apiRoot, 'data', 'rampart-secret.key'),
      );
      expect(loadConfig({ SECRET_KEY_PATH: 'scratch/k.key' }).secretKeyPath).toBe(
        join(apiRoot, 'scratch', 'k.key'),
      );
      const absolute = resolve(apiRoot, '..', 'keys', 'r.key');
      expect(loadConfig({ SECRET_KEY_PATH: absolute }).secretKeyPath).toBe(absolute);
      for (const blank of [' ', '	']) {
        expect(configError({ SECRET_KEY_PATH: blank }).keys).toEqual(['SECRET_KEY_PATH']);
      }
    });
  });

  describe('FIPS_MODE', () => {
    it('unset and empty give off; off and required parse', () => {
      expect(loadConfig({}).fipsMode).toBe('off');
      expect(loadConfig({ FIPS_MODE: '' }).fipsMode).toBe('off');
      expect(loadConfig({ FIPS_MODE: 'off' }).fipsMode).toBe('off');
      expect(loadConfig({ FIPS_MODE: 'required' }).fipsMode).toBe('required');
    });

    it('on, REQUIRED, true and " required" are refused and named', () => {
      for (const bad of ['on', 'REQUIRED', 'true', ' required', 'required ', 'Off', '1']) {
        const error = configError({ FIPS_MODE: bad });
        expect(error.keys, JSON.stringify(bad)).toEqual(['FIPS_MODE']);
        expect(error.message).toContain('FIPS_MODE');
      }
      // Named alongside the other bad keys, sorted.
      expect(configError({ FIPS_MODE: 'on', API_PORT: 'x' }).keys).toEqual([
        'API_PORT',
        'FIPS_MODE',
      ]);
    });
  });
});
