import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import webConfig from '../../apps/web/vite.config.ts';
import {
  pnpmCommand,
  pnpmShims,
  runStart,
  serveEnv,
  spawnRunner,
  startSteps,
  withShimOnPath,
  writePnpmShims,
  type Runner,
  type StartOptions,
} from '../../scripts/start.ts';

const root = join(import.meta.dirname, '..', '..');
const SHIMS = 'C:\\tmp\\rampart-pnpm';
const NODE = 'C:\\node\\node.exe';
const PNPM_CJS = 'C:\\corepack\\pnpm\\10.34.9\\bin\\pnpm.cjs';
const COREPACK_PNPM = join(dirname(NODE), 'node_modules', 'corepack', 'dist', 'pnpm.js');

interface Call {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** A runner that records each call and answers with the next exit code (0 when none is left). */
function fakeRunner(codes: (number | null)[] = []): { calls: Call[]; run: Runner } {
  const calls: Call[] = [];
  const run: Runner = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return Promise.resolve(codes.length > 0 ? (codes.shift() ?? null) : 0);
  };
  return { calls, run };
}

function start(run: Runner, overrides: Partial<StartOptions> = {}): Promise<number> {
  return runStart({
    env: {},
    execPath: NODE,
    exists: () => false,
    run,
    platform: 'linux',
    shimDir: SHIMS,
    log: () => undefined,
    ...overrides,
  });
}

/** Runs a command line the way a package script does: through the platform's own shell. */
function viaScriptShell(command: string): [string, string[]] {
  return process.platform === 'win32'
    ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command]]
    : ['/bin/sh', ['-c', command]];
}

describe('scripts/start.ts', () => {
  it('runs install, build, migrate, serve', async () => {
    expect(startSteps()).toEqual([
      { name: 'install', args: ['install', '--frozen-lockfile'] },
      { name: 'build', args: ['build'] },
      { name: 'migrate', args: ['db:migrate'] },
      { name: 'serve', args: ['--filter', '@rampart/api', 'start'] },
    ]);

    const { calls, run } = fakeRunner();
    const lines: string[] = [];
    expect(
      await start(run, {
        env: { npm_execpath: PNPM_CJS },
        platform: 'win32',
        log: (line) => lines.push(line),
      }),
    ).toBe(0);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      [NODE, PNPM_CJS, 'install', '--frozen-lockfile'],
      [NODE, PNPM_CJS, 'build'],
      [NODE, PNPM_CJS, 'db:migrate'],
      [NODE, PNPM_CJS, '--filter', '@rampart/api', 'start'],
    ]);
    // The human is told where to open the app before the server starts.
    expect(lines).toContain('serving the app on http://127.0.0.1:3000/');

    // Each failing step stops the run with its own exit code; nothing after it runs.
    for (const [index, name] of ['install', 'build', 'migrate'].entries()) {
      const failing = fakeRunner([...Array<number>(index).fill(0), 9 + index]);
      const log: string[] = [];
      expect(await start(failing.run, { log: (line) => log.push(line) }), name).toBe(9 + index);
      expect(failing.calls, name).toHaveLength(index + 1);
      expect(log.at(-1), name).toBe(`${name} failed (exit code ${String(9 + index)})`);
    }

    // serve's own exit code is the script's: Ctrl+C or a crash both come through.
    expect(await start(fakeRunner([0, 0, 0, 130]).run)).toBe(130);
    expect(await start(fakeRunner([0, 0, 0, 0]).run)).toBe(0);

    // A step killed by a signal has no exit code; that still counts as a failure.
    const killed = fakeRunner([0, null]);
    expect(await start(killed.run)).toBe(1);
    expect(killed.calls).toHaveLength(2);
  });

  it('serve step env', async () => {
    // WEB_PORT is where the human opens the app; the api listens there itself.
    expect(serveEnv({ WEB_PORT: '3240', X: '1' })).toEqual({
      WEB_PORT: '3240',
      X: '1',
      SERVE_WEB: 'true',
      API_PORT: '3240',
    });
    // Unset or empty WEB_PORT is 3000, today's address; a caller's API_PORT and SERVE_WEB lose.
    expect(serveEnv({})).toEqual({ SERVE_WEB: 'true', API_PORT: '3000' });
    expect(serveEnv({ WEB_PORT: '', API_PORT: '3001', SERVE_WEB: 'false' })).toEqual({
      WEB_PORT: '',
      API_PORT: '3000',
      SERVE_WEB: 'true',
    });

    const { calls, run } = fakeRunner();
    const env = { API_PORT: '3241', WEB_PORT: '3240', PATH: '/bin', DATABASE_PATH: '/tmp/x.db' };
    const lines: string[] = [];
    await start(run, { env, log: (line) => lines.push(line) });
    expect(calls).toHaveLength(4);
    // install, build and migrate keep the caller's env as is (PATH behind the shim folder).
    for (const call of calls.slice(0, 3)) {
      expect(call.env).toEqual({ ...env, PATH: `${SHIMS}:/bin` });
    }
    expect(calls[3]?.env).toEqual({
      ...env,
      PATH: `${SHIMS}:/bin`,
      SERVE_WEB: 'true',
      API_PORT: '3240',
    });
    expect(lines).toContain('serving the app on http://127.0.0.1:3240/');
    // The caller's env object is never changed.
    expect(env).toEqual({
      API_PORT: '3241',
      WEB_PORT: '3240',
      PATH: '/bin',
      DATABASE_PATH: '/tmp/x.db',
    });
  });

  it('web build inlines no assets', () => {
    // The config is a function of Vite's command; only `build` matters here.
    const resolve = webConfig as unknown as (env: { command: 'build' | 'serve'; mode: string }) => {
      build?: { assetsInlineLimit?: unknown };
    };
    expect(resolve({ command: 'build', mode: 'production' }).build?.assetsInlineLimit).toBe(0);

    // The build needs no dev ports, so ports the dev server would refuse can't stop it.
    const saved = { WEB_PORT: process.env.WEB_PORT, API_PORT: process.env.API_PORT };
    try {
      process.env.WEB_PORT = '3240';
      process.env.API_PORT = '3240';
      expect(resolve({ command: 'build', mode: 'production' }).build?.assetsInlineLimit).toBe(0);
      expect(() => resolve({ command: 'serve', mode: 'development' })).toThrow(/must differ/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });

  it('starts pnpm without a shell', () => {
    // Launched by pnpm: the same Node runs the same pnpm entry file.
    expect(pnpmCommand({ npm_execpath: PNPM_CJS }, NODE, () => true)).toEqual({
      command: NODE,
      prefix: [PNPM_CJS],
    });
    // A pnpm that is a native executable (not a .js/.cjs/.mjs file) runs as itself.
    expect(pnpmCommand({ npm_execpath: '/usr/local/bin/pnpm' }, NODE, () => true)).toEqual({
      command: '/usr/local/bin/pnpm',
      prefix: [],
    });
    // Plain `node scripts/start.ts`: corepack's pnpm entry next to Node, run by that Node. On
    // Windows the only other corepack is a .cmd, which can't start without a shell.
    const exists = (path: string) => path === COREPACK_PNPM;
    for (const execpath of [undefined, '']) {
      expect(pnpmCommand({ npm_execpath: execpath }, NODE, exists)).toEqual({
        command: NODE,
        prefix: [COREPACK_PNPM],
      });
    }
    // No entry file found: corepack on PATH, still without a shell.
    expect(pnpmCommand({}, NODE, () => false)).toEqual({ command: 'corepack', prefix: ['pnpm'] });

    // The script itself never asks for a shell anywhere.
    const source = readFileSync(join(root, 'scripts', 'start.ts'), 'utf8');
    expect(source).not.toMatch(/shell\s*:/);
  });

  it('puts a pnpm shim first on PATH for the scripts that call pnpm', async () => {
    // `pnpm build`, `pnpm db:migrate` and the api's start are scripts that call `pnpm` again. A
    // user who typed `corepack pnpm start` has no `pnpm` on PATH, so the shim runs the same pnpm
    // as the script.
    expect(pnpmShims({ command: NODE, prefix: [PNPM_CJS] })).toEqual([
      { name: 'pnpm.cmd', content: `@${NODE} ${PNPM_CJS} %*\r\n` },
      { name: 'pnpm', content: `#!/bin/sh\nexec ${NODE} ${PNPM_CJS} "$@"\n` },
    ]);
    expect(pnpmShims({ command: 'corepack', prefix: ['pnpm'] })).toEqual([
      { name: 'pnpm.cmd', content: '@corepack pnpm %*\r\n' },
      { name: 'pnpm', content: '#!/bin/sh\nexec corepack pnpm "$@"\n' },
    ]);
    // Only a word that needs quotes gets them; cmd.exe mis-resolves a quoted bare batch name.
    const spaced = 'C:\\Program Files\\nodejs\\node.exe';
    expect(pnpmShims({ command: spaced, prefix: [PNPM_CJS] })[0]).toEqual({
      name: 'pnpm.cmd',
      content: `@"${spaced}" ${PNPM_CJS} %*\r\n`,
    });

    // Windows spells the key `Path`; replace that key rather than adding a second one.
    expect(withShimOnPath({ Path: 'C:\\bin', X: '1' }, SHIMS, 'win32')).toEqual({
      Path: `${SHIMS};C:\\bin`,
      X: '1',
    });
    expect(withShimOnPath({ PATH: '/usr/bin' }, '/tmp/s', 'linux')).toEqual({
      PATH: '/tmp/s:/usr/bin',
    });
    expect(withShimOnPath({}, '/tmp/s', 'linux')).toEqual({ PATH: '/tmp/s' });

    const { calls, run } = fakeRunner();
    await start(run, { env: { PATH: '/usr/bin' }, shimDir: '/tmp/s' });
    expect(calls.map((call) => call.env.PATH)).toEqual(Array<string>(4).fill('/tmp/s:/usr/bin'));
  });

  it('a nested pnpm call reaches pnpm through the written shim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-start-test-'));
    try {
      const pnpm = pnpmCommand(process.env, process.execPath, existsSync);
      writePnpmShims(dir, pnpm);
      // Strip any pnpm already on PATH down to the shim folder plus Node's own folder.
      const base: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
      );
      base.PATH = dirname(process.execPath);
      const env = withShimOnPath(base, dir, process.platform);
      const [shell, args] = viaScriptShell('pnpm --version');
      expect(await spawnRunner(shell, args, { env })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('spawnRunner reports the child exit code and a spawn error', async () => {
    const env = { ...process.env };
    expect(
      await spawnRunner(process.execPath, ['-e', 'process.exit(process.env.X1_CODE)'], {
        env: { ...env, X1_CODE: '4' },
      }),
    ).toBe(4);
    expect(await spawnRunner(join(root, 'no-such-binary-x1'), [], { env })).toBe(1);
  });

  it('vitest ignores e2e specs', () => {
    expect(existsSync(join(root, 'e2e', 'shell.spec.ts')), 'e2e/shell.spec.ts exists').toBe(true);
    const listed = spawnSync(
      process.execPath,
      [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'list', '--filesOnly'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' }, timeout: 60_000 },
    );
    expect(listed.status, listed.stderr).toBe(0);
    const files = listed.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
    expect(files.some((line) => line.includes('start-script.test.ts'))).toBe(true);
    expect(files.filter((line) => /[\\/]?e2e[\\/]/.test(line) || line.includes('.spec.'))).toEqual(
      [],
    );
    // The root script that runs them is Playwright's, not Vitest's.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.e2e).toBe('playwright test');
    expect(pkg.scripts?.start).toBe('node scripts/start.ts');
  }, 90_000);
});
