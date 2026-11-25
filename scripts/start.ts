// One-command start from a clean clone: `corepack pnpm start`.
// Installs from the lockfile, applies migrations, then runs both dev servers.
// Node 24 runs this file directly (type stripping), so it uses `node:` imports only.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Step {
  name: string;
  args: string[];
}

export interface RunOptions {
  env: NodeJS.ProcessEnv;
  shell: boolean;
}

/** Runs one command to completion and resolves with its exit code (null when a signal ended it). */
export type Runner = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<number | null>;

export interface PnpmCommand {
  command: string;
  prefix: string[];
  shell: boolean;
}

export interface StartOptions {
  env: NodeJS.ProcessEnv;
  execPath: string;
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

/** The steps, in order. Each one must succeed before the next starts. */
export function startSteps(): Step[] {
  return [
    { name: 'install', args: ['install', '--frozen-lockfile'] },
    { name: 'migrate', args: ['db:migrate'] },
    { name: 'dev', args: ['dev'] },
  ];
}

/**
 * The pnpm that launched this script: pnpm sets `npm_execpath` to its entry file, which the same
 * Node runs. Without it (run as plain `node scripts/start.ts`), fall back to `corepack pnpm`,
 * which on Windows is a .cmd shim and so needs a shell.
 */
export function pnpmCommand(
  env: NodeJS.ProcessEnv,
  execPath: string,
  platform: NodeJS.Platform,
): PnpmCommand {
  const entry = env.npm_execpath;
  if (entry !== undefined && entry !== '') {
    return /\.[cm]?js$/i.test(entry)
      ? { command: execPath, prefix: [entry], shell: false }
      : { command: entry, prefix: [], shell: false };
  }
  return { command: 'corepack', prefix: ['pnpm'], shell: platform === 'win32' };
}

/**
 * `pnpm` launchers for the scripts that call pnpm again (`db:migrate`, `dev`): a .cmd for Windows
 * shells and a sh script for the rest. Both run the same pnpm as this script.
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

/** Runs every step in order and returns the exit code: the first failure's, or dev's own. */
export async function runStart(options: StartOptions): Promise<number> {
  const pnpm = pnpmCommand(options.env, options.execPath, options.platform);
  const env = withShimOnPath(options.env, options.shimDir, options.platform);
  let code = 0;
  for (const step of startSteps()) {
    options.log(`> pnpm ${step.args.join(' ')}`);
    const exit = await options.run(pnpm.command, [...pnpm.prefix, ...step.args], {
      env,
      shell: pnpm.shell,
    });
    code = exit ?? 1;
    if (code !== 0) {
      options.log(`${step.name} failed (exit code ${String(code)})`);
      return code;
    }
  }
  return code;
}

/** The real runner: inherits the terminal, so Ctrl+C reaches the dev servers too. */
export const spawnRunner: Runner = (command, args, options) =>
  new Promise((resolvePromise) => {
    // With a shell, Node wants one command line (passing args too is deprecated, DEP0190).
    // Every argument here is a fixed word from startSteps(), so joining needs no quoting.
    const child = options.shell
      ? spawn([command, ...args].join(' '), { env: options.env, shell: true, stdio: 'inherit' })
      : spawn(command, args, { env: options.env, stdio: 'inherit' });
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
    writePnpmShims(shimDir, pnpmCommand(process.env, process.execPath, process.platform));
    process.exitCode = await runStart({
      env: process.env,
      execPath: process.execPath,
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
