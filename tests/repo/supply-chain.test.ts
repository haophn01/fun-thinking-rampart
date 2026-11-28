import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..', '..');

interface WorkspaceSettings {
  allowBuilds?: Record<string, unknown>;
  onlyBuiltDependencies?: unknown;
  strictDepBuilds?: unknown;
  minimumReleaseAge?: unknown;
  trustPolicy?: unknown;
  blockExoticSubdeps?: unknown;
}

function workspace(): WorkspaceSettings {
  return parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as WorkspaceSettings;
}

describe('supply chain', () => {
  it('pnpm supply-chain settings', () => {
    const settings = workspace();
    // Exactly these three may run install scripts; any other dependency with a build script
    // fails the install (strictDepBuilds) until someone reviews it and adds it here.
    expect(settings.allowBuilds).toEqual({
      '@node-rs/argon2': true,
      'better-sqlite3': true,
      esbuild: true,
    });
    // One list only: two lists that disagree would leave which one wins to pnpm.
    expect(settings.onlyBuiltDependencies).toBeUndefined();
    expect(settings.strictDepBuilds).toBe(true);
    // Minutes: a version must be a day old before it can be resolved.
    expect(settings.minimumReleaseAge).toBe(1440);
    // A version published with weaker provenance than an earlier one is refused.
    expect(settings.trustPolicy).toBe('no-downgrade');
    // A transitive dependency may not come from git or a tarball URL.
    expect(settings.blockExoticSubdeps).toBe(true);
  });
});
