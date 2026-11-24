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
  logLevel: LogLevel;
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

const envSchema = z.object({
  API_PORT: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      // Digits only: rejects signs, decimals, exponents, hex and surrounding spaces.
      .regex(/^\d+$/, 'must be an integer from 1 to 65535')
      .transform(Number)
      .pipe(z.number().int().min(1, 'must be from 1 to 65535').max(65535, 'must be from 1 to 65535'))
      .default(3001),
  ),
  DATABASE_PATH: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .refine((value) => value.trim() !== '', 'must not be blank')
      .default('data/rampart.sqlite'),
  ),
  LOG_LEVEL: z.preprocess(unsetIfEmpty, z.enum(LOG_LEVELS).default('info')),
});

function resolveDatabasePath(value: string): string {
  if (value === ':memory:' || isAbsolute(value)) return value;
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
    logLevel: result.data.LOG_LEVEL,
  };
}
