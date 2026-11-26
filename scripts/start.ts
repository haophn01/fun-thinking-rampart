// One-command start from a clean clone: `corepack pnpm start`.
// Installs from the lockfile, builds, applies migrations, then serves the built app and the api
// from one server on WEB_PORT (default 3000): http://127.0.0.1:3000/. `pnpm dev` stays the
// development path (Vite on WEB_PORT, the api on API_PORT).
// Node 24 runs this file directly (type stripping), so it uses `node:` imports only.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Step {
  name: string;
  args: string[];
}

export interface RunOptions {
  env: NodeJS.ProcessEnv;
}

/** Runs one command to completion and resolves with its exit code (null when a signal ended it). */
export type Runner = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<number | null>;

/** pnpm as an executable plus the words before its own arguments; never a shell command line. */
export interface PnpmCommand {
  command: string;
  prefix: string[];
}

export interface StartOptions {
  env: NodeJS.ProcessEnv;
  execPath: string;
  /** Whether a file exists; finds corepack's pnpm entry next to Node. */
  exists: (path: string) => boolean;
  platform: NodeJS.Platform;
  run: Runner;
  /** A folder holding the pnpm shims from writePnpmShims(); it goes first on every step's PATH. */
  shimDir: string;
  log: (line: string) => void;
}

export interface ShimFile {
  name: string;
  content: string;
}

/** Where `pnpm start` serves when WEB_PORT is unset: the address the human already opens. */
export const DEFAULT_START_PORT = '3000';

/** The steps, in order. Each one must succeed before the next starts. */
export function startSteps(): Step[] {
  return [
    { name: 'install', args: ['install', '--frozen-lockfile'] },
    { name: 'build', args: ['build'] },
    { name: 'migrate', args: ['db:migrate'] },
    { name: 'serve', args: ['--filter', '@rampart/api', 'start'] },
  ];
}

/**
 * The serve step's env: the caller's, with the api serving the built web app and listening on
 * WEB_PORT (unset or empty: 3000). A caller's API_PORT and SERVE_WEB are overridden, since one
 * server answers both the pages and `/api`.
 */
export function serveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const port =
    env.WEB_PORT === undefined || env.WEB_PORT === '' ? DEFAULT_START_PORT : env.WEB_PORT;
  return { ...env, SERVE_WEB: 'true', API_PORT: port };
}

/**
 * How to start pnpm without a shell (as scripts/audit-gate.ts does): the entry file pnpm set in
 * `npm_execpath` when it launched this script, run by the same Node; else corepack's pnpm entry
 * next to Node (on Windows the only other corepack is a .cmd, which needs a shell); else
 * `corepack pnpm` from PATH.
 */
export function pnpmCommand(
  env: NodeJS.ProcessEnv,
  execPath: string,
  exists: (path: string) => boolean,
): PnpmCommand {
  const entry = env.npm_execpath;
  if (entry !== undefined && entry !== '') {
    return /\.[cm]?js$/i.test(entry)
      ? { command: execPath, prefix: [entry] }
      : { command: entry, prefix: [] };
  }
  const corepackPnpm = join(dirname(execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js');
  if (exists(corepackPnpm)) return { command: execPath, prefix: [corepackPnpm] };
  return { command: 'corepack', prefix: ['pnpm'] };
}

/**
 * `pnpm` launchers for the scripts that call pnpm again (`build`, `db:migrate`, the api's start):
 * a .cmd for Windows shells and a sh script for the rest. Both run the same pnpm as this script.
 */
export function pnpmShims(pnpm: PnpmCommand): ShimFile[] {
  // Quote only words that need it: cmd.exe gives a batch file called by a quoted bare name
  // (`"corepack"`) the wrong %~dp0, and npm's corepack.cmd finds corepack.js through it.
  const words = [pnpm.command, ...pnpm.prefix]
    .map((word) => (/[\s"&()^]/.test(word) ? `"${word}"` : word))
    .join(' ');
  return [
    { name: 'pnpm.cmd', content: `@${words} %*\r\n` },
    { name: 'pnpm', content: `#!/bin/sh\nexec ${words} "$@"\n` },
  ];
}

/** A copy of env with dir first on PATH, keeping the key's existing spelling (`Path` on Windows). */
export function withShimOnPath(
  env: NodeJS.ProcessEnv,
  dir: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const key =
    Object.keys(env).find((name) =>
      platform === 'win32' ? name.toLowerCase() === 'path' : name === 'PATH',
    ) ?? 'PATH';
  const current = env[key];
  const delimiter = platform === 'win32' ? ';' : ':';
  return {
    ...env,
    [key]: current === undefined || current === '' ? dir : `${dir}${delimiter}${current}`,
  };
}

/** Runs every step in order and returns the exit code: the first failure's, or serve's own. */
export async function runStart(options: StartOptions): Promise<number> {
  const pnpm = pnpmCommand(options.env, options.execPath, options.exists);
  const env = withShimOnPath(options.env, options.shimDir, options.platform);
  let code = 0;
  for (const step of startSteps()) {
    const stepEnv = step.name === 'serve' ? serveEnv(env) : env;
    if (step.name === 'serve') {
      options.log(`serving the app on http://127.0.0.1:${String(stepEnv.API_PORT)}/`);
    }
    options.log(`> pnpm ${step.args.join(' ')}`);
    const exit = await options.run(pnpm.command, [...pnpm.prefix, ...step.args], { env: stepEnv });
    code = exit ?? 1;
    if (code !== 0) {
      options.log(`${step.name} failed (exit code ${String(code)})`);
      return code;
    }
  }
  return code;
}

/** The real runner: no shell, and it inherits the terminal, so Ctrl+C reaches the server too. */
export const spawnRunner: Runner = (command, args, options) =>
  new Promise((resolvePromise) => {
    const child = spawn(command, args, { env: options.env, stdio: 'inherit' });
    child.once('error', (error) => {
      console.error(error.message);
      resolvePromise(1);
    });
    child.once('exit', (code) => {
      resolvePromise(code);
    });
  });

/** Writes the shims from pnpmShims() into dir (the sh one executable). */
export function writePnpmShims(dir: string, pnpm: PnpmCommand): void {
  for (const shim of pnpmShims(pnpm)) {
    writeFileSync(join(dir, shim.name), shim.content, { mode: 0o755 });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // Ctrl+C reaches the children through the terminal; wait for them to stop, then clean up.
  process.on('SIGINT', () => undefined);
  const shimDir = mkdtempSync(join(tmpdir(), 'rampart-pnpm-'));
  try {
    writePnpmShims(shimDir, pnpmCommand(process.env, process.execPath, existsSync));
    process.exitCode = await runStart({
      env: process.env,
      execPath: process.execPath,
      exists: existsSync,
      platform: process.platform,
      run: spawnRunner,
      shimDir,
      log: (line) => {
        console.log(line);
      },
    });
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }
}
