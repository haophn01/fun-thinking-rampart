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
