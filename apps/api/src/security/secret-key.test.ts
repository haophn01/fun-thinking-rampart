import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import { expectNoSecrets } from '../testing/redaction';
import {
  loadSecretKey,
  resolveMasterKey,
  SecretKeyFileError,
  type SecretKeyConfig,
} from './secret-key';

const apiRoot = resolve(import.meta.dirname, '..', '..');
const ENV_KEY = 'fedcba9876543210'.repeat(4);
const FILE_KEY = '00112233445566778899aabbccddeeff'.repeat(2);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rampart-key-'));
  dirs.push(dir);
  return dir;
}

function local(secretKeyPath: string, secretKeyHex: string | null = null): SecretKeyConfig {
  return { hosted: false, secretKeyHex, secretKeyPath };
}

/** A real pino logger whose lines land in `lines`, parsed. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger('info', {
    write(line: string) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { lines, logger };
}

function fileError(config: SecretKeyConfig): SecretKeyFileError {
  try {
    loadSecretKey(config);
  } catch (error) {
    if (error instanceof SecretKeyFileError) return error;
    throw error;
  }
  throw new Error(`expected loadSecretKey to refuse ${config.secretKeyPath}`);
}

describe('local key file is generated once', () => {
  it('a missing file is created, with its folders, then the same key is read', () => {
    const dir = scratch();
    const folder = join(dir, 'nested', 'deeper');
    const path = join(folder, 'rampart-secret.key');
    const { lines, logger } = capture();

    const key = loadSecretKey(local(path), logger);
    expect(key).toHaveLength(32);
    const text = readFileSync(path, 'utf8');
    expect(text).toMatch(/^[0-9a-f]{64}\n$/);
    expect(text).toBe(`${key.toString('hex')}\n`);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    // No temp file is left next to it.
    expect(readdirSync(folder)).toEqual(['rampart-secret.key']);

    // One info line that names the path and never the key.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, path });
    const hex = key.toString('hex');
    expectNoSecrets(lines, [hex, hex.toUpperCase()]);
    expectNoSecrets(lines, [key.toString('base64'), key.toString('base64url')]);

    // The next start reads the same key, leaves the file alone and logs nothing.
    const again = loadSecretKey(local(path), logger);
    expect(again.equals(key)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(lines).toHaveLength(1);
  });

  it('two folders get two different keys', () => {
    const a = loadSecretKey(local(join(scratch(), 'k')));
    const b = loadSecretKey(local(join(scratch(), 'k')));
    expect(a.equals(b)).toBe(false);
  });

  it('with the env var set the file is never created, and an existing one never read', () => {
    const dir = scratch();
    const path = join(dir, 'rampart-secret.key');
    const { lines, logger } = capture();
    expect(loadSecretKey(local(path, ENV_KEY), logger).toString('hex')).toBe(ENV_KEY);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(lines).toEqual([]);

    // Even a corrupt file is left unread: the env key wins.
    writeFileSync(path, 'not a key');
    expect(loadSecretKey(local(path, ENV_KEY)).toString('hex')).toBe(ENV_KEY);
    expect(readFileSync(path, 'utf8')).toBe('not a key');
  });

  it('hosted without the env var throws and never writes a file', () => {
    const dir = scratch();
    const path = join(dir, 'rampart-secret.key');
    expect(() => loadSecretKey({ hosted: true, secretKeyHex: null, secretKeyPath: path })).toThrow(
      /RAMPART_SECRET_KEY/,
    );
    expect(readdirSync(dir)).toEqual([]);
    const hosted = loadSecretKey({ hosted: true, secretKeyHex: ENV_KEY, secretKeyPath: path });
    expect(hosted.toString('hex')).toBe(ENV_KEY);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('the default folder is one git ignores', () => {
    const ignore = readFileSync(resolve(apiRoot, '..', '..', '.gitignore'), 'utf8');
    expect(ignore.split(/\r?\n/)).toContain('apps/api/data/');
  });
});

describe('a bad key file is never replaced', () => {
  it('a wrong length, stray whitespace, an empty file or one repeated byte throws naming the path', () => {
    const bad = [
      FILE_KEY.slice(0, 63),
      `${FILE_KEY.slice(0, 63)}\n`,
      `${FILE_KEY}0\n`,
      `${FILE_KEY} `,
      `${FILE_KEY} \n`,
      `${FILE_KEY}\n\n`,
      `${FILE_KEY}\r\n\r\n`,
      `${FILE_KEY}\r`,
      `\n${FILE_KEY}`,
      `${FILE_KEY.slice(0, 63)}g\n`,
      '0'.repeat(64),
      '',
      '\n',
    ];
    for (const content of bad) {
      const path = join(scratch(), 'rampart-secret.key');
      writeFileSync(path, content);
      const before = readFileSync(path);
      const error = fileError(local(path));
      expect(error.name, JSON.stringify(content)).toBe('SecretKeyFileError');
      expect(error.path).toBe(path);
      expect(error.message).toContain(path);
      if (content.trim().length >= 16) {
        expect(error.message).not.toContain(content.trim().slice(0, 16));
      }
      // Byte-identical: never regenerated, so no stored secret is orphaned.
      expect(readFileSync(path).equals(before), JSON.stringify(content)).toBe(true);
    }
  });

  it('a folder where the file should be throws naming the path', () => {
    const path = join(scratch(), 'rampart-secret.key');
    mkdirSync(path);
    expect(fileError(local(path)).message).toContain(path);
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it('a key with no newline, one LF or one CRLF is accepted, in either case', () => {
    for (const content of [FILE_KEY, `${FILE_KEY}\n`, `${FILE_KEY}\r\n`, FILE_KEY.toUpperCase()]) {
      const path = join(scratch(), 'rampart-secret.key');
      writeFileSync(path, content);
      expect(loadSecretKey(local(path)).toString('hex'), JSON.stringify(content)).toBe(FILE_KEY);
      expect(readFileSync(path, 'utf8')).toBe(content);
    }
  });
});

describe('concurrent starts agree on one key', () => {
  const moduleUrl = pathToFileURL(join(import.meta.dirname, 'secret-key.ts')).href;
  const script = [
    'const { loadSecretKey } = await import(process.env.KEY_MODULE);',
    'const config = { hosted: false, secretKeyHex: null, secretKeyPath: process.env.KEY_PATH };',
    "process.stdout.write(loadSecretKey(config).toString('hex'));",
  ].join('\n');

  function start(path: string): Promise<{ code: number | null; out: string }> {
    return new Promise((done, fail) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          cwd: apiRoot,
          env: { ...process.env, KEY_MODULE: moduleUrl, KEY_PATH: path },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.on('error', fail);
      child.on('exit', (code) => {
        done({ code, out });
      });
    });
  }

  it('processes started at once on an empty folder all return the same key', async () => {
    const dir = scratch();
    const folder = join(dir, 'data');
    const path = join(folder, 'rampart-secret.key');
    const results = await Promise.all(Array.from({ length: 4 }, () => start(path)));
    for (const { code, out } of results) expect(code, out).toBe(0);
    const keys = new Set(results.map(({ out }) => out));
    expect(keys.size).toBe(1);
    const [key = ''] = [...keys];
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, 'utf8')).toBe(`${key}\n`);
    expect(readdirSync(folder)).toEqual(['rampart-secret.key']);
  }, 60_000);
});

describe('the key buildApp uses', () => {
  const path = join(tmpdir(), 'rampart-never-read.key');

  it('the option wins, then the config key, then a random in-memory key', () => {
    const option = Buffer.from(FILE_KEY, 'hex');
    expect(resolveMasterKey(option, local(path, ENV_KEY)).equals(option)).toBe(true);
    expect(resolveMasterKey(undefined, local(path, ENV_KEY)).toString('hex')).toBe(ENV_KEY);
    const a = resolveMasterKey(undefined, local(path));
    const b = resolveMasterKey(undefined, local(path));
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses an option that is not 32 bytes', () => {
    expect(() => resolveMasterKey(Buffer.alloc(16, 1), local(path))).toThrow(/32 bytes/);
  });
});
