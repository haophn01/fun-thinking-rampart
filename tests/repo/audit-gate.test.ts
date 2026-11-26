import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditArgs,
  evaluateAudit,
  gateExitCode,
  parseGateArgs,
  pnpmLauncher,
  runGate,
  type AllowlistEntry,
  type AuditRun,
  type GateDeps,
} from '../../scripts/audit-gate.ts';

const root = join(import.meta.dirname, '..', '..');
const fixtures = join(root, 'tests', 'fixtures', 'supply-chain');

function report(name: string): string {
  return readFileSync(join(fixtures, `audit-${name}.json`), 'utf8');
}

const TODAY = '2026-11-26';

interface Recorded {
  logs: string[];
  warnings: string[];
  runs: { dir: string; args: string[] }[];
}

/** Deps for runGate: answers the audit with `output` and records what the gate does. */
function fakeDeps(
  output: string,
  options: { allowlist?: unknown; files?: string[]; status?: number | null } = {},
): { deps: GateDeps; recorded: Recorded } {
  const recorded: Recorded = { logs: [], warnings: [], runs: [] };
  const files = new Set(options.files ?? ['pnpm-lock.yaml', 'pnpm-workspace.yaml']);
  const deps: GateDeps = {
    runAudit: (dir, args): AuditRun => {
      recorded.runs.push({ dir, args });
      return { stdout: output, status: options.status === undefined ? 1 : options.status };
    },
    readAllowlist: () => JSON.stringify(options.allowlist ?? []),
    exists: (path) => files.has(path.replace(/^.*[\\/]/, '')),
    today: () => TODAY,
    log: (line) => recorded.logs.push(line),
    warn: (line) => recorded.warnings.push(line),
  };
  return { deps, recorded };
}

function entry(id: string, until: string): AllowlistEntry {
  return { id, reason: 'no patched version yet; not reachable from our code', until };
}

describe('audit gate', () => {
  it('fails on high or critical only', () => {
    const high = evaluateAudit(report('high'), [], TODAY);
    expect(high.verdict).toBe('findings');
    expect(high.failures.join('\n')).toContain('GHSA-35jh-r3h4-6jhm');
    expect(high.failures.join('\n')).toContain('lodash');

    const critical = evaluateAudit(report('critical'), [], TODAY);
    expect(critical.verdict).toBe('findings');
    expect(critical.failures.join('\n')).toContain('GHSA-xvch-5gv4-984h');

    // moderate, low and info together pass.
    const below = evaluateAudit(report('below-high'), [], TODAY);
    expect(below).toEqual({ verdict: 'pass', failures: [], warnings: [] });
    expect(evaluateAudit(report('clean'), [], TODAY).verdict).toBe('pass');

    // An unknown severity can't be judged, so it fails closed instead of passing.
    const odd = JSON.parse(report('high')) as { advisories: Record<string, { severity: string }> };
    for (const advisory of Object.values(odd.advisories)) advisory.severity = 'severe';
    expect(evaluateAudit(JSON.stringify(odd), [], TODAY).verdict).toBe('error');
  });

  it('fails closed', () => {
    for (const output of ['', 'not json', 'WARN something\n{"advisories":{}}', '[]', 'null']) {
      const result = evaluateAudit(output, [], TODAY);
      expect(result.verdict, JSON.stringify(output)).toBe('error');
      expect(result.failures.length).toBeGreaterThan(0);
    }
    const network = evaluateAudit(report('network-error'), [], TODAY);
    expect(network.verdict).toBe('error');
    expect(network.failures.join('\n')).toContain('ECONNREFUSED');
    // Valid JSON without the advisories map isn't a report either.
    expect(evaluateAudit('{"metadata":{}}', [], TODAY).verdict).toBe('error');

    // Through runGate: a network error exits 1, and so does a dir without a lockfile, where
    // pnpm would quietly audit a parent workspace instead.
    const { deps } = fakeDeps(report('network-error'));
    expect(runGate([], deps)).toBe(1);
    const noLock = fakeDeps(report('clean'), { files: [] });
    expect(runGate(['--dir', 'somewhere'], noLock.deps)).toBe(1);
    expect(noLock.recorded.runs).toEqual([]);
    expect(noLock.recorded.logs.join('\n')).toContain('pnpm-lock.yaml');
  });

  it('allowlist entries expire', () => {
    // By the numeric npm id or by the GHSA id, up to and including `until` (a UTC date).
    for (const id of ['GHSA-35jh-r3h4-6jhm', '1106913']) {
      expect(evaluateAudit(report('high'), [entry(id, '2026-12-01')], '2026-11-26').verdict).toBe(
        'pass',
      );
      expect(evaluateAudit(report('high'), [entry(id, '2026-12-01')], '2026-12-01').verdict).toBe(
        'pass',
      );
    }
    // The day after, the entry no longer counts: the finding fails and so does the entry.
    const expired = evaluateAudit(
      report('high'),
      [entry('GHSA-35jh-r3h4-6jhm', '2026-12-01')],
      '2026-12-02',
    );
    expect(expired.verdict).toBe('findings');
    expect(expired.failures.join('\n')).toMatch(/GHSA-35jh-r3h4-6jhm.*expired 2026-12-01/);

    // An expired entry fails even when it matches nothing, so stale exceptions get removed.
    const expiredStale = evaluateAudit(
      report('clean'),
      [entry('GHSA-zzzz-zzzz-zzzz', '2026-11-25')],
      TODAY,
    );
    expect(expiredStale.verdict).toBe('findings');

    // A live entry that matches nothing passes with a warning.
    const stale = evaluateAudit(
      report('clean'),
      [entry('GHSA-zzzz-zzzz-zzzz', '2026-12-20')],
      TODAY,
    );
    expect(stale.verdict).toBe('pass');
    expect(stale.warnings.join('\n')).toContain('GHSA-zzzz-zzzz-zzzz');

    // An allowlisted high passes while another high in the same report still fails.
    const both = JSON.parse(report('high')) as { advisories: Record<string, unknown> };
    const critical = JSON.parse(report('critical')) as { advisories: Record<string, unknown> };
    both.advisories = { ...both.advisories, ...critical.advisories };
    const partial = evaluateAudit(
      JSON.stringify(both),
      [entry('GHSA-35jh-r3h4-6jhm', '2026-12-01')],
      TODAY,
    );
    expect(partial.verdict).toBe('findings');
    expect(partial.failures.join('\n')).toContain('GHSA-xvch-5gv4-984h');
    expect(partial.failures.join('\n')).not.toContain('GHSA-35jh-r3h4-6jhm');

    // A malformed allowlist can't be trusted: missing reason, a non-date, an impossible date,
    // an `until` more than 30 days ahead, or not a list at all.
    for (const allowlist of [
      [{ id: 'GHSA-35jh-r3h4-6jhm', reason: '', until: '2026-12-01' }],
      [{ id: 'GHSA-35jh-r3h4-6jhm', reason: 'x', until: 'next week' }],
      [{ id: 'GHSA-35jh-r3h4-6jhm', reason: 'x', until: '2026-02-30' }],
      [{ id: 'GHSA-35jh-r3h4-6jhm', reason: 'x', until: '2026-12-27' }],
      [{ reason: 'x', until: '2026-12-01' }],
      { id: 'GHSA-35jh-r3h4-6jhm' },
    ]) {
      expect(
        evaluateAudit(report('clean'), allowlist, TODAY).verdict,
        JSON.stringify(allowlist),
      ).toBe('error');
    }
    // Exactly 30 days ahead is still allowed.
    expect(
      evaluateAudit(report('high'), [entry('GHSA-35jh-r3h4-6jhm', '2026-12-26')], TODAY).verdict,
    ).toBe('pass');

    // The repo's own allowlist is well-formed today.
    const repoAllowlist = JSON.parse(
      readFileSync(join(root, 'audit-allowlist.json'), 'utf8'),
    ) as unknown;
    expect(evaluateAudit(report('clean'), repoAllowlist, TODAY).verdict).not.toBe('error');
  });

  it('expect-findings inverts the gate', () => {
    expect(runGate(['--expect-findings'], fakeDeps(report('high')).deps)).toBe(0);
    expect(runGate(['--expect-findings'], fakeDeps(report('critical')).deps)).toBe(0);
    expect(runGate(['--expect-findings'], fakeDeps(report('clean'), { status: 0 }).deps)).toBe(1);
    expect(runGate(['--expect-findings'], fakeDeps(report('below-high')).deps)).toBe(1);
    // A gate that broke proves nothing, so a network error still exits 1.
    expect(runGate(['--expect-findings'], fakeDeps(report('network-error')).deps)).toBe(1);
    // Without the flag: findings exit 1, a clean report 0.
    expect(runGate([], fakeDeps(report('high')).deps)).toBe(1);
    expect(runGate([], fakeDeps(report('clean'), { status: 0 }).deps)).toBe(0);

    expect(gateExitCode('findings', true)).toBe(0);
    expect(gateExitCode('pass', true)).toBe(1);
    expect(gateExitCode('error', true)).toBe(1);
    expect(gateExitCode('findings', false)).toBe(1);
    expect(gateExitCode('pass', false)).toBe(0);
    expect(gateExitCode('error', false)).toBe(1);
  });

  it('runs pnpm audit at level high in the given dir, as its own project', () => {
    expect(parseGateArgs([])).toEqual({ dir: '.', expectFindings: false });
    expect(
      parseGateArgs(['--expect-findings', '--dir', 'tests/fixtures/supply-chain/vulnerable']),
    ).toEqual({ dir: 'tests/fixtures/supply-chain/vulnerable', expectFindings: true });
    expect(() => parseGateArgs(['--dir'])).toThrow(/--dir/);
    expect(() => parseGateArgs(['--level', 'low'])).toThrow(/--level/);

    // The repo root is a workspace: audit every importer.
    expect(auditArgs(true)).toEqual(['audit', '--audit-level', 'high', '--json']);
    // A folder inside the repo (the fixture) must not be resolved to the parent workspace.
    expect(auditArgs(false)).toEqual([
      'audit',
      '--audit-level',
      'high',
      '--json',
      '--ignore-workspace',
    ]);

    const fixture = fakeDeps(report('high'), { files: ['pnpm-lock.yaml'] });
    runGate(['--dir', 'tests/fixtures/supply-chain/vulnerable'], fixture.deps);
    expect(fixture.recorded.runs).toHaveLength(1);
    expect(fixture.recorded.runs[0]?.dir).toMatch(
      /tests[\\/]fixtures[\\/]supply-chain[\\/]vulnerable$/,
    );
    expect(fixture.recorded.runs[0]?.args).toContain('--ignore-workspace');
    // Findings are printed so the CI log says what failed.
    expect(fixture.recorded.logs.join('\n')).toContain('GHSA-35jh-r3h4-6jhm');
  });

  it('launches pnpm without a shell', () => {
    const node = join('opt', 'node', 'node.exe');
    // Started through pnpm: that pnpm's entry file, run by this Node.
    expect(pnpmLauncher({ npm_execpath: 'C:\\corepack\\pnpm.cjs' }, node, () => false)).toEqual({
      command: node,
      prefix: ['C:\\corepack\\pnpm.cjs'],
    });
    // Plain `node scripts/audit-gate.ts`: corepack's pnpm entry next to Node, so Windows needs
    // neither the .cmd shim nor a shell.
    const corepackPnpm = join('opt', 'node', 'node_modules', 'corepack', 'dist', 'pnpm.js');
    expect(pnpmLauncher({}, node, (path) => path === corepackPnpm)).toEqual({
      command: node,
      prefix: [corepackPnpm],
    });
    // Neither: pnpm on PATH, as in CI after `corepack enable`.
    expect(pnpmLauncher({ npm_execpath: '' }, node, () => false)).toEqual({
      command: 'pnpm',
      prefix: [],
    });
  });

  it('the vulnerable fixture pins a version with a known high advisory', () => {
    const lock = readFileSync(join(fixtures, 'vulnerable', 'pnpm-lock.yaml'), 'utf8');
    expect(lock).toMatch(/^lockfileVersion: '9\.0'/);
    // lodash 4.17.20: GHSA-35jh-r3h4-6jhm (command injection, high), fixed in 4.17.21.
    expect(lock).toContain('lodash@4.17.20:');
    const pkg = JSON.parse(readFileSync(join(fixtures, 'vulnerable', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({ lodash: '4.17.20' });
  });
});
