import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * The `apps/api` folder. This file sits one level below it in source (`src/`) and the tsup bundle
 * does too (`dist/`), so the same relative URL works in dev and in the build.
 */
const API_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  /** Fixed: the api never listens beyond this machine. */
  host: '127.0.0.1';
  port: number;
  /** An absolute file path, or `:memory:`. */
  databasePath: string;
  /** Absolute: the evidence store's folder, created on its first write. */
  storagePath: string;
  logLevel: LogLevel;
  /** `HOSTED`: the api sits behind one local reverse proxy that terminates HTTPS. */
  hosted: boolean;
  /** `SERVE_WEB`: the api serves the built web app as well as `/api`. */
  serveWeb: boolean;
  /** Absolute: the built web app `SERVE_WEB` serves. */
  webDistPath: string;
  /** Scales every rate limit's `max`; 1 is the real limits, and hosted mode needs it. */
  rateLimitMultiplier: number;
  /**
   * `RAMPART_SECRET_KEY`: the 32-byte master key as 64 lowercase hex characters, or null when
   * unset (locally, `loadSecretKey` then uses the key file). Never log it.
   */
  secretKeyHex: string | null;
  /** Absolute: the local key file `loadSecretKey` reads, or creates when it is missing. */
  secretKeyPath: string;
}

/** Thrown when the environment is invalid. `keys` names every bad variable, sorted. */
export class ConfigError extends Error {
  constructor(
    readonly keys: string[],
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** An empty value means "not set", so `API_PORT= pnpm dev` falls back to the default. */
const unsetIfEmpty = (value: unknown) => (value === '' ? undefined : value);

/** A path setting: empty means the default, whitespace only is refused. */
const pathSetting = (fallback: string) =>
  z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .refine((value) => value.trim() !== '', 'must not be blank')
      .default(fallback),
  );

/** Exactly `true` or `false`: `TRUE`, `1`, `yes` and padded values are refused. */
const booleanSetting = z.preprocess(
  unsetIfEmpty,
  z
    .enum(['true', 'false'], { error: 'must be true or false' })
    .default('false')
    .transform((value) => value === 'true'),
);

/** True when every byte of a hex key is the same one, such as 64 zeros: never a real key. */
const oneByteRepeated = (hex: string) => hex === hex.slice(0, 2).repeat(hex.length / 2);

/**
 * 64 hex characters in either case, stored lowercase. The messages never echo the value, so a
 * near-miss key never reaches a log line.
 */
const secretKeySetting = z.preprocess(
  unsetIfEmpty,
  z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be exactly 64 hex characters (32 bytes)')
    .transform((value) => value.toLowerCase())
    .refine((value) => !oneByteRepeated(value), 'must not be one byte repeated 32 times')
    .optional(),
);

const envSchema = z.object({
  API_PORT: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      // Digits only: rejects signs, decimals, exponents, hex and surrounding spaces.
      .regex(/^\d+$/, 'must be an integer from 1 to 65535')
      .transform(Number)
      .pipe(
        z.number().int().min(1, 'must be from 1 to 65535').max(65535, 'must be from 1 to 65535'),
      )
      .default(3001),
  ),
  DATABASE_PATH: pathSetting('data/rampart.sqlite'),
  HOSTED: booleanSetting,
  LOG_LEVEL: z.preprocess(unsetIfEmpty, z.enum(LOG_LEVELS).default('info')),
  RAMPART_SECRET_KEY: secretKeySetting,
  RATE_LIMIT_MULTIPLIER: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .regex(/^\d+$/, 'must be an integer from 1 to 1000')
      .transform(Number)
      .pipe(z.number().int().min(1, 'must be from 1 to 1000').max(1000, 'must be from 1 to 1000'))
      .default(1),
  ),
  SECRET_KEY_PATH: pathSetting('data/rampart-secret.key'),
  SERVE_WEB: booleanSetting,
  STORAGE_PATH: pathSetting('data/files'),
  WEB_DIST_PATH: pathSetting('../web/dist'),
});

function resolveDatabasePath(value: string): string {
  if (value === ':memory:' || isAbsolute(value)) return value;
  return resolve(API_ROOT, value);
}

/** Relative paths resolve against `apps/api`, never the working directory. */
function resolveApiPath(value: string): string {
  return resolve(API_ROOT, value);
}

/** Reads and validates the api's settings from environment variables. Pure: touches no files. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = new Map<string, string>();
    for (const issue of result.error.issues) {
      const key = String(issue.path[0]);
      if (!problems.has(key)) problems.set(key, issue.message);
    }
    const keys = [...problems.keys()].sort();
    const detail = keys.map((key) => `${key} ${problems.get(key) ?? 'is invalid'}`).join('; ');
    throw new ConfigError(keys, `Invalid configuration: ${detail}`);
  }
  return {
    host: '127.0.0.1',
    port: result.data.API_PORT,
    databasePath: resolveDatabasePath(result.data.DATABASE_PATH),
    storagePath: resolveApiPath(result.data.STORAGE_PATH),
    logLevel: result.data.LOG_LEVEL,
    hosted: result.data.HOSTED,
    serveWeb: result.data.SERVE_WEB,
    webDistPath: resolveApiPath(result.data.WEB_DIST_PATH),
    rateLimitMultiplier: result.data.RATE_LIMIT_MULTIPLIER,
    secretKeyHex: result.data.RAMPART_SECRET_KEY ?? null,
    secretKeyPath: resolveApiPath(result.data.SECRET_KEY_PATH),
  };
}
