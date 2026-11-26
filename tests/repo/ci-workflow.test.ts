import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  'runs-on'?: string;
  permissions?: unknown;
  container?: string | { image?: string };
  services?: Record<string, { image?: string }>;
  'timeout-minutes'?: number;
  strategy?: { 'fail-fast'?: boolean; matrix?: { os?: string[] } };
  steps?: Step[];
}
interface Workflow {
  on?: { pull_request?: unknown; push?: { branches?: string[] } };
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const workflowPath = join(import.meta.dirname, '..', '..', '.github', 'workflows', 'pod-ci.yml');

function workflowText(): string {
  return readFileSync(workflowPath, 'utf8');
}

function loadWorkflow(): Workflow {
  return parse(workflowText()) as Workflow;
}

/**
 * A pinned `uses:` line names an action by a full 40-hex commit SHA, followed by a
 * `# v<version>` comment saying which release that commit is. A tag or a branch can be moved to
 * other code after review; a commit SHA can't.
 */
const PINNED_USES = /^\s*(?:-\s+)?uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d+(?:\.\d+)*\s*$/;

function isPinnedUsesLine(line: string): boolean {
  return PINNED_USES.test(line);
}

/** An image pinned by its content digest; a tag alone can be pushed over. */
const PINNED_IMAGE = /^[\w.-]+(?:\/[\w.-]+)*(?::[\w.-]+)?@sha256:[0-9a-f]{64}$/;

/** Every container image the workflow pulls: job containers, services and `docker://` steps. */
function images(workflow: Workflow): string[] {
  const found: string[] = [];
  for (const each of Object.values(workflow.jobs ?? {})) {
    const container = typeof each.container === 'string' ? each.container : each.container?.image;
    if (container !== undefined) found.push(container);
    for (const service of Object.values(each.services ?? {})) {
      if (service.image !== undefined) found.push(service.image);
    }
    for (const step of each.steps ?? []) {
      if (step.uses?.startsWith('docker://')) found.push(step.uses.slice('docker://'.length));
    }
  }
  return found;
}

/** A run command as words, with folded lines and `\` continuations joined. */
function words(command: string | undefined): string[] {
  return (command ?? '')
    .replace(/\\\r?\n/g, ' ')
    .trim()
    .split(/\s+/);
}

/** Every raw `uses:` line in the workflow (comments are lost once the YAML is parsed). */
function usesLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => /^\s*(?:-\s+)?uses:/.test(line));
}

function job(name: string): Job {
  const found = loadWorkflow().jobs?.[name];
  expect(found, `job ${name}`).toBeDefined();
  return found ?? {};
}

/** Each step reduced to what it does: the action it uses or the command it runs. */
function actions(steps: Step[] | undefined): string[] {
  return (steps ?? []).map((step) => step.uses?.replace(/@.*$/, '') ?? step.run?.trim() ?? '');
}

describe('pod-ci workflow', () => {
  it('every action is pinned to a commit SHA', () => {
    // The check itself: a tag, a branch, a short SHA, a local path or a missing or non-version
    // comment fails.
    for (const bad of [
      'uses: actions/checkout@v5',
      'uses: actions/checkout@main',
      'uses: actions/checkout@v5.1.0 # v5.1.0',
      'uses: actions/checkout@fbc6f39 # v5.1.0',
      'uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
      'uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # main',
      'uses: ./local-action',
    ]) {
      expect(isPinnedUsesLine(bad), bad).toBe(false);
    }
    expect(
      isPinnedUsesLine(
        '      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0',
      ),
    ).toBe(true);

    const lines = usesLines(workflowText());
    // Every step with `uses` is its own `uses:` line, so none escapes the line check.
    const parsedUses = Object.values(loadWorkflow().jobs ?? {}).flatMap((found) =>
      (found.steps ?? []).filter((step) => step.uses !== undefined),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).toHaveLength(parsedUses.length);
    for (const line of lines) {
      expect(isPinnedUsesLine(line), line.trim()).toBe(true);
    }
  });

  it('container images are pinned by digest', () => {
    for (const bad of [
      'semgrep/semgrep',
      'semgrep/semgrep:latest',
      'semgrep/semgrep:1.186.0',
      'semgrep/semgrep@sha256:6e1b0434',
      'semgrep/semgrep@sha512:' + 'a'.repeat(64),
    ]) {
      expect(PINNED_IMAGE.test(bad), bad).toBe(false);
    }
    expect(PINNED_IMAGE.test(`semgrep/semgrep:1.186.0@sha256:${'0'.repeat(64)}`)).toBe(true);

    const found = images(loadWorkflow());
    // At least semgrep's own image; none may escape the pin.
    expect(found.some((image) => image.startsWith('semgrep/semgrep'))).toBe(true);
    for (const image of found) {
      expect(PINNED_IMAGE.test(image), image).toBe(true);
    }
  });

  it('jobs and permissions', () => {
    const workflow = loadWorkflow();
    expect(Object.keys(workflow.jobs ?? {})).toEqual([
      'verify',
      'secrets',
      'e2e',
      'audit',
      'semgrep',
    ]);
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    // No job widens the top-level permissions.
    for (const [name, each] of Object.entries(workflow.jobs ?? {})) {
      expect(each.permissions, name).toBeUndefined();
    }
  });

  it('audit job gates the repo and proves itself on the fixture', () => {
    const audit = job('audit');
    expect(audit['runs-on']).toBe('ubuntu-latest');
    expect(actions(audit.steps)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'corepack enable',
      'node scripts/audit-gate.ts',
      'node scripts/audit-gate.ts --expect-findings --dir tests/fixtures/supply-chain/vulnerable',
    ]);
    const setupNode = audit.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(String(setupNode?.with?.['node-version'])).toBe('24');
    // Same trap as verify: setup-node v5 would call pnpm before corepack enable.
    expect(setupNode?.with?.['package-manager-cache']).toBe(false);
  });

  it('semgrep job fails on high-severity findings', () => {
    const semgrep = job('semgrep');
    expect(semgrep['runs-on']).toBe('ubuntu-latest');
    const image =
      typeof semgrep.container === 'string' ? semgrep.container : semgrep.container?.image;
    expect(image).toMatch(/^semgrep\/semgrep(?::[\w.-]+)?@sha256:[0-9a-f]{64}$/);
    const steps = semgrep.steps ?? [];
    expect(steps).toHaveLength(2);
    expect(steps[0]?.uses).toMatch(/^actions\/checkout@/);
    const scan = words(steps[1]?.run);
    expect(scan.slice(0, 2)).toEqual(['semgrep', 'scan']);
    const configs = scan.flatMap((word, index) => (word === '--config' ? [scan[index + 1]] : []));
    expect(configs).toEqual(['p/default', 'p/typescript', 'p/react']);
    // ERROR only, and a finding fails the job (semgrep exits 0 on findings without --error).
    expect(scan[scan.indexOf('--severity') + 1]).toBe('ERROR');
    expect(scan.filter((word) => word === '--severity')).toHaveLength(1);
    expect(scan).toContain('--error');
    expect(scan[scan.indexOf('--metrics') + 1]).toBe('off');
    // Only --exclude-rule <id> may be added; nothing that drops whole files or turns off --error.
    const known = new Set(['--config', '--severity', '--metrics', '--exclude-rule']);
    for (const [index, word] of scan.entries()) {
      if (index < 2 || !word.startsWith('--') || word === '--error') continue;
      expect(known.has(word), word).toBe(true);
    }

    const ignore = readFileSync(join(import.meta.dirname, '..', '..', '.semgrepignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());
    for (const path of ['node_modules/', 'tests/fixtures/', 'templates/', 'dist/']) {
      expect(ignore, path).toContain(path);
    }
  });

  it('triggers on pull_request and push to main', () => {
    const workflow = loadWorkflow();
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on?.push?.branches).toEqual(['main']);
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  });

  it('verify job runs frozen install and pnpm verify on both OSes', () => {
    const verify = job('verify');
    expect(verify.strategy?.matrix?.os).toEqual(['ubuntu-latest', 'windows-latest']);
    expect(verify.strategy?.['fail-fast']).toBe(false);
    expect(verify['runs-on']).toBe('${{ matrix.os }}');
    expect(actions(verify.steps)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'corepack enable',
      'pnpm install --frozen-lockfile',
      'pnpm verify',
    ]);
    const setupNode = verify.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(String(setupNode?.with?.['node-version'])).toBe('24');
  });

  it('pnpm is available before setup-node caches', () => {
    // setup-node v5 caches by packageManager by default and runs pnpm to find
    // the store, before `corepack enable` has put pnpm on PATH. Either corepack
    // runs first, or setup-node's package-manager cache is off.
    const steps = job('verify').steps ?? [];
    const setupNodeIndex = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
    const corepackIndex = steps.findIndex((step) => step.run?.trim() === 'corepack enable');
    expect(setupNodeIndex, 'setup-node step').toBeGreaterThanOrEqual(0);
    expect(corepackIndex, 'corepack enable step').toBeGreaterThanOrEqual(0);
    const setupNode = steps[setupNodeIndex];
    const cacheOff =
      setupNode?.with?.['package-manager-cache'] === false && setupNode.with.cache === undefined;
    const corepackFirst = corepackIndex < setupNodeIndex;
    expect(
      cacheOff || corepackFirst,
      'corepack before setup-node, or package-manager-cache: false',
    ).toBe(true);
  });

  it('e2e job installs chromium and runs pnpm e2e on both OSes', () => {
    const e2e = job('e2e');
    expect(e2e.strategy?.matrix?.os).toEqual(['ubuntu-latest', 'windows-latest']);
    expect(e2e.strategy?.['fail-fast']).toBe(false);
    expect(e2e['runs-on']).toBe('${{ matrix.os }}');
    expect(e2e['timeout-minutes']).toBe(20);
    expect(actions(e2e.steps)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'corepack enable',
      'pnpm install --frozen-lockfile',
      'pnpm exec playwright install --with-deps chromium',
      'pnpm e2e',
      'actions/upload-artifact',
    ]);
    const steps = e2e.steps ?? [];
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(String(setupNode?.with?.['node-version'])).toBe('24');
    // Same trap as verify: setup-node v5 would call pnpm before corepack enable.
    expect(setupNode?.with?.['package-manager-cache']).toBe(false);
    expect(setupNode?.with?.cache).toBeUndefined();
    const upload = steps.at(-1);
    expect(upload?.if).toBe('failure()');
    expect(upload?.with?.path).toEqual(expect.stringContaining('playwright-report'));
  });

  it('secrets job runs gitleaks with fetch-depth 0', () => {
    const secrets = job('secrets');
    expect(secrets['runs-on']).toBe('ubuntu-latest');
    expect(actions(secrets.steps)).toEqual(['actions/checkout', 'gitleaks/gitleaks-action']);
    const [checkout, gitleaks] = secrets.steps ?? [];
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    // Still v2, now pinned by the commit of a v2 release.
    const gitleaksLine = usesLines(workflowText()).find((line) =>
      line.includes('gitleaks/gitleaks-action@'),
    );
    expect(gitleaksLine).toMatch(/gitleaks\/gitleaks-action@[0-9a-f]{40}\s+#\s*v2\./);
    expect(gitleaks?.env?.GITHUB_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
  });
});
