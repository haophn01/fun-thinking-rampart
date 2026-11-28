/// <reference lib="dom" />
// The security baseline, checked on the production serving path: the config's server (the built
// web app and the api from one process) and a hosted server of this file's own.
//
// Playwright runs spec files in name order against one database, and shell.spec.ts and
// smoke.spec.ts, which sort after this file, need a fresh install. So on the config's server this
// file only reads, signed out. The hosted checks (HSTS and the __Host- cookie) run on a server of
// their own on 3294, with its own database: hosted mode keeps the real rate limits, so it gets
// only a handful of requests. `__Host-` cookies need TLS in a browser, so the cookie is read from
// the Set-Cookie header through Playwright's request API, never from the browser's jar.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { PRODUCT_NAME } from '../apps/api/src/contract/index.ts';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/api');
const HOST = '127.0.0.1';
const HOSTED_PORT = process.env.E2E_HOSTED_PORT ?? '3294';
const HOSTED_ORIGIN = `http://${HOST}:${HOSTED_PORT}`;

// The contract's strings, spelled out here so a change to the api's constants fails this file.
const WEB_CSP =
  "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; " +
  "form-action 'self'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; " +
  "script-src 'self'; script-src-attr 'none'; style-src 'self'";
const HOSTED_WEB_CSP = `${WEB_CSP}; upgrade-insecure-requests`;
const API_CSP = "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";
const PERMISSIONS_POLICY = 'camera=(), geolocation=(), microphone=(), payment=(), usb=()';
const HSTS = 'max-age=31536000; includeSubDomains';
const IMMUTABLE = 'public, max-age=31536000, immutable';
// Hosted mode needs RAMPART_SECRET_KEY and never uses a key file. A fixed test key only.
const HOSTED_SECRET_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'.repeat(2);

// ---------- the CSP violation collector ----------

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

/**
 * Records every `securitypolicyviolation` in the page, from before the app's first script runs.
 * Playwright injects init scripts outside the page's CSP, so the collector itself never trips it.
 */
async function collectCspViolations(page: Page) {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(
        `${event.effectiveDirective} blocked ${event.blockedURI || '(inline)'} at ${event.sourceFile || document.location.pathname}:${String(event.lineNumber)}`,
      );
    });
  });
}

async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window.__cspViolations ?? [])]);
}

// ---------- header checks ----------

/** The headers every web page carries locally: the strict CSP and the rest, and no HSTS. */
function expectLocalPageHeaders(response: APIResponse, path: string) {
  const headers = response.headers();
  expect(response.status(), path).toBe(200);
  expect(headers['content-type'], path).toBe('text/html; charset=utf-8');
  expect(headers['content-security-policy'], path).toBe(WEB_CSP);
  expect(headers['x-content-type-options'], path).toBe('nosniff');
  expect(headers['referrer-policy'], path).toBe('no-referrer');
  expect(headers['permissions-policy'], path).toBe(PERMISSIONS_POLICY);
  expect(headers['x-frame-options'], path).toBe('DENY');
  expect(headers['strict-transport-security'], path).toBeUndefined();
  expect(headers['x-powered-by'], path).toBeUndefined();
}

// ---------- the config's server: signed-out reads only ----------

test.describe('production serving on the config server', () => {
  test('production HTML carries the strict CSP and headers', async ({ request }) => {
    for (const path of ['/', '/assessment']) {
      const response = await request.get(path);
      expectLocalPageHeaders(response, path);
      expect(await response.text(), path).toContain('<div id="root"></div>');
    }
  });

  test('api responses keep the api CSP', async ({ request }) => {
    const health = await request.get('/api/health');
    expect(health.status()).toBe(200);
    expect(health.headers()['content-security-policy']).toBe(API_CSP);
    expect(health.headers()['permissions-policy']).toBe(PERMISSIONS_POLICY);
    expect(health.headers()['strict-transport-security']).toBeUndefined();
    // An unknown api path is still the api: JSON 404 under the api CSP, never the page.
    const missing = await request.get('/api/nope');
    expect(missing.status()).toBe(404);
    expect(missing.headers()['content-type']).toMatch(/^application\/json/);
    expect(missing.headers()['content-security-policy']).toBe(API_CSP);
  });

  test('the config server is the production build', async ({ request }) => {
    const index = await request.get('/');
    const html = await index.text();
    const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map(
      (match) => match[1] ?? '',
    );
    // The built page loads its script and its stylesheet, and nothing else.
    expect(refs.length, html).toBeGreaterThanOrEqual(2);
    expect(refs.some((ref) => ref.endsWith('.js'))).toBe(true);
    expect(refs.some((ref) => ref.endsWith('.css'))).toBe(true);
    // No inline script or style for the CSP to block.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle="/);
    for (const ref of refs) {
      // Only hashed files under /assets/, each served immutable with its own type.
      expect(ref).toMatch(/^\/assets\/[\w.-]+-[\w-]{8}\.(?:js|css)$/);
      const asset = await request.get(ref);
      expect(asset.status(), ref).toBe(200);
      expect(asset.headers()['cache-control'], ref).toBe(IMMUTABLE);
      expect(asset.headers()['content-type'], ref).toBe(
        ref.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      );
    }
    expect(index.headers()['cache-control']).toBe('no-cache');
    // No dev server: `/@vite/client` has no extension, so it is the SPA fallback (the same
    // index.html), never Vite's client script.
    expect(html).not.toContain('/@vite/client');
    const vite = await request.get('/@vite/client');
    expect(vite.status()).toBe(200);
    expect(vite.headers()['content-type']).toBe('text/html; charset=utf-8');
    expect(await vite.text()).toBe(html);
  });

  test('the built app loads under the CSP', async ({ page }) => {
    await collectCspViolations(page);
    const session = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/session',
    );
    await page.goto('/');
    expect((await session).ok()).toBe(true);
    // A fresh install: the shell renders Setup, with the built styles and fonts in.
    await expect(
      page.getByRole('heading', { level: 1, name: `Set up ${PRODUCT_NAME}` }),
    ).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    expect(await page.title()).toContain(PRODUCT_NAME);
    expect(await cspViolations(page)).toEqual([]);

    // The collector sees a violation when there is one: a data: image the CSP must block.
    await page.evaluate(() => {
      const img = document.createElement('img');
      img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
      document.body.append(img);
    });
    await expect
      .poll(() => cspViolations(page), { timeout: 15_000 })
      .toEqual([expect.stringMatching(/^img-src blocked data/)]);
  });
});

// ---------- a hosted server of this file's own ----------

let hosted: ChildProcess | null = null;
const hostedOutput: string[] = [];

function hostedRunDir() {
  return join(process.env.E2E_RUN_DIR ?? '', 'hosted');
}

/** The built api (`node dist/server.js`) in hosted mode, on a database in the run folder. */
async function startHosted() {
  const entry = join(API_DIR, 'dist', 'server.js');
  if (!existsSync(entry)) throw new Error(`${entry} is missing: the config server builds it.`);
  const runDir = hostedRunDir();
  mkdirSync(runDir, { recursive: true });
  const child = spawn(process.execPath, [entry], {
    cwd: API_DIR,
    env: {
      ...process.env,
      API_PORT: HOSTED_PORT,
      HOSTED: 'true',
      SERVE_WEB: 'true',
      DATABASE_PATH: join(runDir, 'hosted.sqlite'),
      STORAGE_PATH: join(runDir, 'files'),
      LOG_LEVEL: 'warn',
      // Hosted mode refuses any other multiplier: the real limits, so few requests.
      RATE_LIMIT_MULTIPLIER: '1',
      RAMPART_SECRET_KEY: HOSTED_SECRET_KEY,
      // Never written: the env key wins. The check below proves it.
      SECRET_KEY_PATH: join(runDir, 'never.key'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hosted = child;
  child.stdout.on('data', (chunk: Buffer) => hostedOutput.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => hostedOutput.push(chunk.toString()));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`The hosted server exited:\n${hostedOutput.join('')}`);
    try {
      if ((await fetch(`${HOSTED_ORIGIN}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`The hosted server did not answer:\n${hostedOutput.join('')}`);
}

async function stopHosted() {
  const child = hosted;
  if (child === null || child.exitCode !== null) return;
  await new Promise<void>((done) => {
    child.once('exit', () => {
      done();
    });
    child.kill();
  });
}

test.describe('hosted mode', () => {
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    await startHosted();
  });
  test.afterAll(async () => {
    await stopHosted();
  });

  test('hosted mode sends HSTS and a __Host- Secure cookie', async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: HOSTED_ORIGIN });
    try {
      // The page: HSTS, and the CSP with upgrade-insecure-requests.
      const page = await request.get('/');
      expect(page.status()).toBe(200);
      expect(page.headers()['strict-transport-security']).toBe(HSTS);
      expect(page.headers()['content-security-policy']).toBe(HOSTED_WEB_CSP);

      // Setup: the one auth request this server gets. It signs the new admin in.
      const setup = await request.post('/api/setup', {
        data: {
          email: 'hana@example.test',
          displayName: 'Hana Hosted',
          password: 'hosted-check-pass-1',
        },
      });
      expect(setup.status(), await setup.text()).toBe(201);
      expect(setup.headers()['strict-transport-security']).toBe(HSTS);
      expect(setup.headers()['content-security-policy']).toBe(API_CSP);

      const cookies = setup
        .headersArray()
        .filter((header) => header.name.toLowerCase() === 'set-cookie')
        .map((header) => header.value);
      expect(cookies).toHaveLength(1);
      const [cookie = ''] = cookies;
      const [pair = '', ...rest] = cookie.split(';').map((part) => part.trim());
      expect(pair).toMatch(/^__Host-rampart_session=[^;\s]+$/);
      const attributes = rest.map((part) => part.split('=')[0]?.toLowerCase());
      expect(attributes).toEqual(
        expect.arrayContaining(['secure', 'httponly', 'samesite', 'path']),
      );
      expect(rest).toContain('Path=/');
      expect(rest).toContain('SameSite=Strict');
      expect(attributes).not.toContain('domain');
      // The env key was used: hosted mode wrote no key file.
      expect(existsSync(join(hostedRunDir(), 'never.key'))).toBe(false);
    } finally {
      await request.dispose();
    }
  });
});
