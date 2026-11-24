import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..', '..');

interface PackageJson {
  name?: string;
  type?: string;
  packageManager?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

/** Every workspace package folder, resolved from the globs in pnpm-workspace.yaml. */
function workspacePackageDirs(): string[] {
  const workspace = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as {
    packages?: string[];
  };
  const dirs: string[] = [];
  for (const glob of workspace.packages ?? []) {
    const parent = glob.replace(/\/\*$/, '');
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json'))) {
        dirs.push(`${parent}/${entry.name}`);
      }
    }
  }
  return dirs.sort();
}

describe('repo tooling', () => {
  it('verify chains the four steps with &&', () => {
    const verify = (readJson('package.json') as PackageJson).scripts?.verify ?? '';
    // Only && between steps: `;` or `||` would keep going after a failure.
    expect(verify).not.toMatch(/;|\|\|/);
    expect(verify.split('&&').map((step) => step.trim())).toEqual([
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
    ]);
  });

  it('tsconfig.base enables every strict flag', () => {
    const { compilerOptions } = readJson('tsconfig.base.json') as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(compilerOptions).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      moduleResolution: 'Bundler',
    });
  });

  it('engines, packageManager and module type', () => {
    const rootPkg = readJson('package.json') as PackageJson;
    // An exact pnpm version, optionally with corepack's integrity hash.
    expect(rootPkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+(\+sha\d+\.[0-9a-f]+)?$/);
    expect(rootPkg.engines?.node).toBe('>=24');
    expect(rootPkg.type).toBe('module');

    const dirs = workspacePackageDirs();
    expect(dirs).toEqual(['apps/api', 'apps/web', 'packages/catalog', 'packages/rules']);
    for (const dir of dirs) {
      const pkg = readJson(`${dir}/package.json`) as PackageJson;
      expect({ dir, type: pkg.type, node: pkg.engines?.node }).toEqual({
        dir,
        type: 'module',
        node: '>=24',
      });
    }
  });
});
