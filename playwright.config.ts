import { mkdtempSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// `@rampart/catalog` imports its JSON data without `with { type: 'json' }` (Vite, Vitest, tsx and
// tsup don't need it), but Playwright loads specs through Node's own ESM loader, which refuses
// that import. This resolve hook marks .json imports as JSON. Every Playwright process that runs
// specs loads this config, so each one gets the hook.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    const isJson = /\.json$/i.test(new URL(result.url).pathname);
    if (isJson && context.importAttributes.type === undefined) {
      return { ...result, importAttributes: { ...context.importAttributes, type: 'json' } };
    }
    return result;
  },
});

// Fresh state every run: one new folder per `pnpm e2e`, shared by every worker through the env.
process.env.E2E_RUN_DIR ??= mkdtempSync(join(tmpdir(), 'rampart-e2e-'));
const runDir = process.env.E2E_RUN_DIR;

const HOST = '127.0.0.1';
// One server, the production serving path: the api serves the built web app and `/api` together.
const webPort = process.env.E2E_WEB_PORT ?? '3290';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: `http://${HOST}:${webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Build first (SERVE_WEB needs apps/web/dist/index.html), then the built api, as `pnpm start`
    // serves it, on a database and file store that live only for this run. The server migrates.
    command: 'pnpm build && pnpm --filter @rampart/api start',
    url: `http://${HOST}:${webPort}/api/health`,
    env: {
      API_PORT: webPort,
      SERVE_WEB: 'true',
      DATABASE_PATH: join(runDir, 'e2e.sqlite'),
      STORAGE_PATH: join(runDir, 'files'),
      LOG_LEVEL: 'warn',
      // The real limits stay on, raised so the suite's own traffic never trips them.
      RATE_LIMIT_MULTIPLIER: '100',
    },
    reuseExistingServer: false,
    // A clean build of every package comes first.
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
