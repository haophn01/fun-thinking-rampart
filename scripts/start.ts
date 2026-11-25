// One-command start from a clean clone: `corepack pnpm start`.
// Installs from the lockfile, applies migrations, then runs both dev servers.
// Node 24 runs this file directly (type stripping), so it uses `node:` imports only.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
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
  log: (line: string) => void;
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

/** Runs every step in order and returns the exit code: the first failure's, or dev's own. */
export async function runStart(options: StartOptions): Promise<number> {
  const pnpm = pnpmCommand(options.env, options.execPath, options.platform);
  let code = 0;
  for (const step of startSteps()) {
    options.log(`> pnpm ${step.args.join(' ')}`);
    const exit = await options.run(pnpm.command, [...pnpm.prefix, ...step.args], {
      env: options.env,
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

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await runStart({
    env: process.env,
    execPath: process.execPath,
    platform: process.platform,
    run: spawnRunner,
    log: (line) => {
      console.log(line);
    },
  });
}
