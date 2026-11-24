import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  'runs-on'?: string;
  strategy?: { 'fail-fast'?: boolean; matrix?: { os?: string[] } };
  steps?: Step[];
}
interface Workflow {
  on?: { pull_request?: unknown; push?: { branches?: string[] } };
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const workflowPath = join(import.meta.dirname, '..', '..', '.github', 'workflows', 'pod-ci.yml');

function loadWorkflow(): Workflow {
  return parse(readFileSync(workflowPath, 'utf8')) as Workflow;
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

  it('secrets job runs gitleaks v2 with fetch-depth 0', () => {
    const secrets = job('secrets');
    expect(secrets['runs-on']).toBe('ubuntu-latest');
    expect(actions(secrets.steps)).toEqual(['actions/checkout', 'gitleaks/gitleaks-action']);
    const [checkout, gitleaks] = secrets.steps ?? [];
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(gitleaks?.uses).toBe('gitleaks/gitleaks-action@v2');
    expect(gitleaks?.env?.GITHUB_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
  });
});
