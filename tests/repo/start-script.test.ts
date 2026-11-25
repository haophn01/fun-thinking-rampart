import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  pnpmCommand,
  pnpmShims,
  runStart,
  spawnRunner,
  startSteps,
  withShimOnPath,
  writePnpmShims,
  type Runner,
} from '../../scripts/start.ts';

const root = join(import.meta.dirname, '..', '..');
const SHIMS = 'C:\\tmp\\rampart-pnpm';
const NODE = 'C:\\node\\node.exe';
const PNPM_CJS = 'C:\\corepack\\pnpm\\10.34.9\\bin\\pnpm.cjs';

interface Call {
  command: string;
  args: string[];
  shell: boolean;
  env: NodeJS.ProcessEnv;
}

/** A runner that records each call and answers with the next exit code (0 when none is left). */
function fakeRunner(codes: (number | null)[] = []): { calls: Call[]; run: Runner } {
  const calls: Call[] = [];
  const run: Runner = (command, args, options) => {
    calls.push({ command, args, shell: options.shell, env: options.env });
    return Promise.resolve(codes.length > 0 ? (codes.shift() ?? null) : 0);
  };
  return { calls, run };
}

describe('scripts/start.ts', () => {
  it('runs install, migrate, dev', async () => {
    expect(startSteps()).toEqual([
      { name: 'install', args: ['install', '--frozen-lockfile'] },
      { name: 'migrate', args: ['db:migrate'] },
      { name: 'dev', args: ['dev'] },
    ]);

    const { calls, run } = fakeRunner();
    const code = await runStart({
      env: { npm_execpath: PNPM_CJS },
      execPath: NODE,
      platform: 'win32',
      run,
      shimDir: SHIMS,
      log: () => undefined,
    });
    expect(code).toBe(0);
    expect(calls.map((call) => call.args)).toEqual([
      [PNPM_CJS, 'install', '--frozen-lockfile'],
      [PNPM_CJS, 'db:migrate'],
      [PNPM_CJS, 'dev'],
    ]);
  });

  it('stops at the first failure', async () => {
    const install = fakeRunner([7]);
    expect(
      await runStart({
        env: {},
        execPath: NODE,
        platform: 'linux',
        run: install.run,
        shimDir: SHIMS,
        log: () => undefined,
      }),
    ).toBe(7);
    expect(install.calls).toHaveLength(1);

    const migrate = fakeRunner([0, 3]);
    const lines: string[] = [];
    expect(
      await runStart({
        env: {},
        execPath: NODE,
        platform: 'linux',
        run: migrate.run,
        shimDir: SHIMS,
        log: (line) => lines.push(line),
      }),
    ).toBe(3);
    expect(migrate.calls.map((call) => call.args.at(-1))).toEqual([
      '--frozen-lockfile',
      'db:migrate',
    ]);
    expect(lines.at(-1)).toMatch(/migrate failed \(exit code 3\)/);

    // dev's own exit code is the script's: Ctrl+C or a crash both come through.
    const dev = fakeRunner([0, 0, 130]);
    expect(
      await runStart({
        env: {},
        execPath: NODE,
        platform: 'linux',
        run: dev.run,
        shimDir: SHIMS,
        log: () => undefined,
      }),
    ).toBe(130);

    // A step killed by a signal has no exit code; that still counts as a failure.
    const killed = fakeRunner([null]);
    expect(
      await runStart({
        env: {},
        execPath: NODE,
        platform: 'linux',
        run: killed.run,
        shimDir: SHIMS,
        log: () => undefined,
      }),
    ).toBe(1);
    expect(killed.calls).toHaveLength(1);
  });

  it('runner and env', async () => {
    // Launched by pnpm: the same Node runs the same pnpm entry file, no shell.
    expect(pnpmCommand({ npm_execpath: PNPM_CJS }, NODE, 'win32')).toEqual({
      command: NODE,
      prefix: [PNPM_CJS],
      shell: false,
    });
    // A pnpm that is a native executable (not a .js/.cjs/.mjs file) runs as itself.
    expect(pnpmCommand({ npm_execpath: '/usr/local/bin/pnpm' }, NODE, 'linux')).toEqual({
      command: '/usr/local/bin/pnpm',
      prefix: [],
      shell: false,
    });
    // Unset or empty: corepack pnpm. On Windows corepack is a .cmd shim, which needs a shell.
    expect(pnpmCommand({}, NODE, 'win32')).toEqual({
      command: 'corepack',
      prefix: ['pnpm'],
      shell: true,
    });
    expect(pnpmCommand({ npm_execpath: '' }, NODE, 'linux')).toEqual({
      command: 'corepack',
      prefix: ['pnpm'],
      shell: false,
    });

    const { calls, run } = fakeRunner();
    const env = { API_PORT: '3201', WEB_PORT: '3200', PATH: '/bin' };
    await runStart({
      env,
      execPath: NODE,
      platform: 'win32',
      run,
      shimDir: SHIMS,
      log: () => undefined,
    });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.command).toBe('corepack');
      expect(call.args[0]).toBe('pnpm');
      expect(call.shell).toBe(true);
      // The ports pass through; PATH keeps what it had, behind the pnpm shim folder.
      expect(call.env).toMatchObject({ API_PORT: '3201', WEB_PORT: '3200', PATH: `${SHIMS};/bin` });
    }
  });

  it('puts a pnpm shim first on PATH for the scripts that call pnpm', async () => {
    // `pnpm db:migrate` and `pnpm dev` run root scripts that call `pnpm` again. A user who typed
    // `corepack pnpm start` has no `pnpm` on PATH, so the shim runs the same pnpm as the script.
    expect(pnpmShims({ command: NODE, prefix: [PNPM_CJS], shell: false })).toEqual([
      { name: 'pnpm.cmd', content: `@${NODE} ${PNPM_CJS} %*\r\n` },
      { name: 'pnpm', content: `#!/bin/sh\nexec ${NODE} ${PNPM_CJS} "$@"\n` },
    ]);
    expect(pnpmShims({ command: 'corepack', prefix: ['pnpm'], shell: true })).toEqual([
      { name: 'pnpm.cmd', content: '@corepack pnpm %*\r\n' },
      { name: 'pnpm', content: '#!/bin/sh\nexec corepack pnpm "$@"\n' },
    ]);
    // Only a word that needs quotes gets them; cmd.exe mis-resolves a quoted bare batch name.
    const spaced = 'C:\\Program Files\\nodejs\\node.exe';
    expect(pnpmShims({ command: spaced, prefix: [PNPM_CJS], shell: false })[0]).toEqual({
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
    await runStart({
      env: { PATH: '/usr/bin' },
      execPath: NODE,
      platform: 'linux',
      run,
      shimDir: '/tmp/s',
      log: () => undefined,
    });
    expect(calls.map((call) => call.env.PATH)).toEqual([
      '/tmp/s:/usr/bin',
      '/tmp/s:/usr/bin',
      '/tmp/s:/usr/bin',
    ]);
  });

  it('a nested pnpm call reaches pnpm through the written shim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-start-test-'));
    try {
      const pnpm = pnpmCommand(process.env, process.execPath, process.platform);
      writePnpmShims(dir, pnpm);
      // Strip any pnpm already on PATH down to the shim folder plus Node's own folder.
      const base: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
      );
      base.PATH = dirname(process.execPath);
      const env = withShimOnPath(base, dir, process.platform);
      expect(await spawnRunner('pnpm', ['--version'], { env, shell: true })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('spawnRunner reports the child exit code and a spawn error', async () => {
    const env = { ...process.env };
    expect(
      await spawnRunner(process.execPath, ['-e', 'process.exit(process.env.X1_CODE)'], {
        env: { ...env, X1_CODE: '4' },
        shell: false,
      }),
    ).toBe(4);
    expect(await spawnRunner(join(root, 'no-such-binary-x1'), [], { env, shell: false })).toBe(1);
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
