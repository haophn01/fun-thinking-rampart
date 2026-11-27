import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Config } from '../config';

const KEY_BYTES = 32;

/** 64 hex characters, then at most one `\n` or `\r\n`. */
const KEY_FILE = /^([0-9a-fA-F]{64})(?:\r?\n)?$/;

/** What `loadSecretKey` reads from the config. */
export type SecretKeyConfig = Pick<Config, 'hosted' | 'secretKeyHex' | 'secretKeyPath'>;

/** The one log call `loadSecretKey` makes: a pino logger fits. */
export interface SecretKeyLog {
  info(fields: Record<string, unknown>, message: string): void;
}

/**
 * The key file exists but can't be used. The message names the path and why, never what the file
 * holds. The file is left exactly as it is: a new key would orphan every secret sealed with it.
 */
export class SecretKeyFileError extends Error {
  constructor(
    readonly path: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(
      `The secret key file ${path} ${reason}. Fix or restore it; it is never replaced.`,
      options,
    );
    this.name = 'SecretKeyFileError';
  }
}

const oneByteRepeated = (key: Buffer) => key.every((byte) => byte === key[0]);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** The key in an existing file, or null when there is no file. */
function readKeyFile(path: string): Buffer | null {
  let text: string;
  try {
    text = readFileSync(path, 'latin1');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new SecretKeyFileError(path, `can't be read (${errorCode(error) ?? 'unknown error'})`);
  }
  const hex = KEY_FILE.exec(text)?.[1];
  if (hex === undefined) {
    throw new SecretKeyFileError(
      path,
      'must hold exactly 64 hex characters and one optional newline',
    );
  }
  const key = Buffer.from(hex, 'hex');
  if (oneByteRepeated(key)) throw new SecretKeyFileError(path, 'holds one byte repeated 32 times');
  return key;
}

/**
 * Creates the key file atomically: the key goes to a temp file next to it, which is then linked
 * to the path. `link` fails with EEXIST when another start won the race, so no start ever sees a
 * half-written file and every start ends up with the winner's key. Returns null when it lost.
 */
function createKeyFile(path: string): Buffer | null {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true });
  const key = randomBytes(KEY_BYTES);
  const temp = join(
    folder,
    `.${basename(path)}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  writeFileSync(temp, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(temp, path);
    return key;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null;
    throw new SecretKeyFileError(path, `can't be created (${errorCode(error) ?? 'unknown error'})`);
  } finally {
    unlinkSync(temp);
  }
}

/**
 * The master key. `RAMPART_SECRET_KEY` wins, and then the file is never read or written. Hosted,
 * the env var is required (the startup check has already refused without it). Locally, the key
 * file is read, or created on the first start with one info line naming its path.
 */
export function loadSecretKey(config: SecretKeyConfig, log?: SecretKeyLog): Buffer {
  if (config.secretKeyHex !== null) return Buffer.from(config.secretKeyHex, 'hex');
  if (config.hosted) {
    throw new Error('HOSTED=true needs RAMPART_SECRET_KEY; no key file is used when hosted');
  }
  const path = config.secretKeyPath;
  const existing = readKeyFile(path);
  if (existing !== null) return existing;
  const created = createKeyFile(path);
  if (created === null) {
    // Another start created it first: its key is complete, since it was linked whole.
    const winner = readKeyFile(path);
    if (winner === null) throw new SecretKeyFileError(path, 'vanished while being created');
    return winner;
  }
  log?.info({ path }, 'created the secret key file; back it up with the database');
  return created;
}

/**
 * The key `buildApp` derives its keys from: the option, else `RAMPART_SECRET_KEY`, else a random
 * in-memory key, for tests (the server always passes the loaded key).
 */
export function resolveMasterKey(option: Buffer | undefined, config: SecretKeyConfig): Buffer {
  if (option !== undefined) {
    if (option.length !== KEY_BYTES) throw new RangeError('The secret key must be 32 bytes');
    return option;
  }
  if (config.secretKeyHex !== null) return Buffer.from(config.secretKeyHex, 'hex');
  return randomBytes(KEY_BYTES);
}
