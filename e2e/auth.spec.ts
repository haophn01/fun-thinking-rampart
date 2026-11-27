// Auth hardening on the production serving path: the sign-in notice, the temporary password's
// forced change, and the idle lock, each driven in the browser as a user meets it.
//
// Playwright runs spec files in name order, and shell.spec.ts and smoke.spec.ts need the config
// server's fresh install, so this file never touches that server. It starts the built api
// (`node dist/server.js`, which the config server's build makes) on 3295 with the web app served
// from it, on a database of its own in the run folder.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page, type Response } from '@playwright/test';
import { errorEnvelopeSchema } from '../apps/api/src/contract/index.ts';
import { ensureOk, signIn } from './helpers/api';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/api');
const HOST = '127.0.0.1';
const AUTH_PORT = process.env.E2E_AUTH_PORT ?? '3295';
const ORIGIN = `http://${HOST}:${AUTH_PORT}`;

test.use({ baseURL: ORIGIN });

const ADMIN = {
  email: 'avery@example.test',
  displayName: 'Avery Admin',
  password: 'auth-check-admin-pass',
};
const NOTICE =
  'You are accessing a system that processes CUI. Use is monitored and recorded; unauthorised use is prohibited.';
/** On the bundled blocklist, so a change to it is refused. */
const TOO_COMMON = 'QwertyUiop12';

// ---------- the server ----------

let server: ChildProcess | null = null;
const serverOutput: string[] = [];

/** The built api, serving the built web app, on a fresh database in the run folder. */
async function startServer() {
  const entry = join(API_DIR, 'dist', 'server.js');
  if (!existsSync(entry)) throw new Error(`${entry} is missing: the config server builds it.`);
  const runDir = join(process.env.E2E_RUN_DIR ?? '', 'auth');
  mkdirSync(runDir, { recursive: true });
  const child = spawn(process.execPath, [entry], {
    cwd: API_DIR,
    env: {
      ...process.env,
      API_PORT: AUTH_PORT,
      SERVE_WEB: 'true',
      DATABASE_PATH: join(runDir, 'auth.sqlite'),
      STORAGE_PATH: join(runDir, 'files'),
      LOG_LEVEL: 'warn',
      // The real limits stay on, raised so this file's traffic never trips them.
      RATE_LIMIT_MULTIPLIER: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  child.stdout.on('data', (chunk: Buffer) => serverOutput.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => serverOutput.push(chunk.toString()));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`The auth server exited:\n${serverOutput.join('')}`);
    try {
      if ((await fetch(`${ORIGIN}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`The auth server did not answer:\n${serverOutput.join('')}`);
}

async function stopServer() {
  const child = server;
  if (child === null || child.exitCode !== null) return;
  await new Promise<void>((done) => {
    child.once('exit', () => {
      done();
    });
    child.kill();
  });
}

// ---------- helpers ----------

const pathOf = (response: Response) => new URL(response.url()).pathname;

/** The next response to `method path`. Start waiting before the action that sends it. */
function answer(page: Page, method: string, path: string) {
  return page.waitForResponse(
    (response) => response.request().method() === method && pathOf(response) === path,
  );
}

/** A browser context signed in as `email` (its cookie in the context's jar), and a page in it. */
async function signedIn(browser: Browser, email: string, password: string) {
  const context = await browser.newContext({ baseURL: ORIGIN });
  await signIn(context.request, email, password);
  return { context, page: await context.newPage() };
}

async function errorCode(response: { json(): Promise<unknown> }): Promise<string> {
  return errorEnvelopeSchema.parse(await response.json()).error.code;
}

/** The sign-in form, filled and sent; resolves with the sign-in answer. */
async function submitSignIn(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const sent = answer(page, 'POST', '/api/session');
  await page.getByRole('button', { name: 'Sign in' }).click();
  return sent;
}

function dashboard(page: Page) {
  return page.getByRole('heading', { level: 1, name: 'Dashboard' });
}

/** The audit log entry for `label`, as Settings › Audit log lists it. */
function auditEntry(page: Page, label: string) {
  return page.getByRole('listitem', { name: new RegExp(`^Audit event \\d+: ${label}$`) });
}

// ---------- the tests ----------

test.describe('auth', () => {
  // One server and database for the file: a failure stops the rest rather than re-running setup.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(90_000);
    await startServer();
    const request = await playwright.request.newContext({ baseURL: ORIGIN });
    await ensureOk(await request.post('/api/setup', { data: ADMIN }), 'POST /api/setup');
    await request.dispose();
  });
  test.afterAll(async () => {
    await stopServer();
  });

  test('sign-in with the notice', async ({ browser }) => {
    const { context, page } = await signedIn(browser, ADMIN.email, ADMIN.password);

    // The admin sets the notice in Settings.
    await page.goto('/settings');
    const section = page.getByRole('region', { name: /Sign-in notice/ });
    await expect(section.getByText('Off. Sign-in shows no notice.')).toBeVisible();
    await section.getByLabel('Notice text').fill(NOTICE);
    const saved = answer(page, 'PUT', '/api/settings/sign-in-notice');
    await section.getByRole('button', { name: 'Save notice' }).click();
    expect((await saved).status()).toBe(200);
    await expect(section.getByText('Saved.', { exact: true })).toBeVisible();
    await expect(
      section.getByText('On. Everyone acknowledges this notice before signing in.'),
    ).toBeVisible();

    // Signed out, sign-in shows the notice first, and no form until it is acknowledged.
    const signedOut = answer(page, 'DELETE', '/api/session');
    await page.getByRole('button', { name: 'Sign out' }).click();
    expect((await signedOut).ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    const notice = page.getByRole('region', { name: 'System use notice' });
    await expect(notice.getByText(NOTICE, { exact: true })).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveCount(0);
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    // The api refuses a sign-in that skips the notice, too.
    const skipped = await page.request.post('/api/session', {
      data: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(skipped.status()).toBe(400);
    expect(await errorCode(skipped)).toBe('notice_not_acknowledged');

    await notice.getByRole('button', { name: 'Acknowledge and continue' }).click();
    await expect(notice).toHaveCount(0);
    const answered = await submitSignIn(page, ADMIN.email, ADMIN.password);
    expect(answered.status()).toBe(200);
    expect(JSON.parse(answered.request().postData() ?? '{}')).toHaveProperty('noticeDigest');
    // Back in the app, on the page signed out from.
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

    // The acknowledgement is in the audit log, after a reload.
    await page.reload();
    await expect(auditEntry(page, 'Sign-in notice acknowledged').first()).toBeVisible();
    await expect(auditEntry(page, 'Settings changed').first()).toBeVisible();

    // Clear it, so the other tests sign in without it.
    const cleared = answer(page, 'PUT', '/api/settings/sign-in-notice');
    await page
      .getByRole('region', { name: /Sign-in notice/ })
      .getByRole('button', { name: 'Clear' })
      .click();
    expect((await cleared).status()).toBe(200);
    await expect(page.getByText('Off. Sign-in shows no notice.')).toBeVisible();
    await context.close();
  });

  test('temporary password is changed at first sign-in', async ({ browser }) => {
    const tess = {
      email: 'tess@example.test',
      displayName: 'Tess Temporary',
      temporary: 'tess-temporary-pass-1',
      chosen: 'tess-chosen-pass-2026',
    };

    // The admin adds Tess with a temporary password.
    const admin = await signedIn(browser, ADMIN.email, ADMIN.password);
    await admin.page.goto('/settings');
    const form = admin.page.getByRole('form', { name: 'Add a user' });
    await form.getByLabel('Email').fill(tess.email);
    await form.getByLabel('Display name').fill(tess.displayName);
    await form.getByLabel('Role').selectOption('contributor');
    await form.getByLabel('Temporary password').fill(tess.temporary);
    const created = answer(admin.page, 'POST', '/api/users');
    await form.getByRole('button', { name: 'Add user' }).click();
    expect((await created).status()).toBe(201);
    await admin.context.close();

    // Tess signs in with it: the change page, and nothing else, until she picks her own.
    const context = await browser.newContext({ baseURL: ORIGIN });
    const page = await context.newPage();
    await page.goto('/');
    expect((await submitSignIn(page, tess.email, tess.temporary)).status()).toBe(200);
    const forced = page.getByTestId('change-password-forced');
    await expect(forced).toBeVisible();
    await expect(forced.getByRole('heading', { level: 1, name: 'Change password' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
    const gated = await page.request.get('/api/assessment');
    expect(gated.status()).toBe(403);
    expect(await errorCode(gated)).toBe('password_change_required');

    const change = async (next: string) => {
      await page.getByLabel('Current password').fill(tess.temporary);
      await page.getByLabel('New password', { exact: true }).fill(next);
      await page.getByLabel('Confirm new password').fill(next);
      const sent = answer(page, 'POST', '/api/session/password');
      await page.getByRole('button', { name: 'Change password' }).click();
      return sent;
    };

    // Too common: refused.
    expect((await change(TOO_COMMON)).status()).toBe(400);
    await expect(
      page.getByText('This password is too common. Choose another.', { exact: true }),
    ).toBeVisible();
    await expect(forced).toBeVisible();

    // The temporary one again: refused as reused.
    expect((await change(tess.temporary)).status()).toBe(400);
    await expect(
      page.getByText('You used this password recently. Choose another.', { exact: true }),
    ).toBeVisible();
    await expect(forced).toBeVisible();

    // Her own: the app opens, and stays open after a reload.
    expect((await change(tess.chosen)).status()).toBe(200);
    await expect(dashboard(page)).toBeVisible();
    await expect(forced).toHaveCount(0);
    await page.reload();
    await expect(dashboard(page)).toBeVisible();
    await context.close();

    // The new password signs in with nothing left to change; the temporary one no longer does.
    const fresh = await browser.newContext({ baseURL: ORIGIN });
    const session = await signIn(fresh.request, tess.email, tess.chosen);
    expect(session.mustChangePassword).toBe(false);
    const old = await fresh.request.post('/api/session', {
      data: { email: tess.email, password: tess.temporary },
    });
    expect(old.status()).toBe(401);
    await fresh.close();
  });

  test('lock and unlock', async ({ browser }) => {
    const { context, page } = await signedIn(browser, ADMIN.email, ADMIN.password);
    // The page's clock runs on, and fast-forwards on demand.
    await page.clock.install();
    await page.goto('/settings');
    const settings = page.getByRole('heading', { level: 1, name: 'Settings' });
    await expect(settings).toBeVisible();
    // A draft the lock must keep.
    const draft = page.getByRole('form', { name: 'Add a user' }).getByLabel('Display name');
    await draft.fill('Draft kept behind the lock');

    // Ten minutes in: still open.
    await page.clock.fastForward('10:00');
    await expect(settings).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Session locked' })).toHaveCount(0);

    // Fifteen minutes without input: locked, the content hidden, and the api agrees.
    const locked = answer(page, 'POST', '/api/session/lock');
    await page.clock.fastForward('05:00');
    expect((await locked).status()).toBe(204);
    await expect(page.getByRole('heading', { level: 1, name: 'Session locked' })).toBeVisible();
    await expect(page.getByTestId('gate-app')).toBeHidden();
    await expect(settings).toBeHidden();
    const refused = await page.request.get('/api/assessment');
    expect(refused.status()).toBe(423);
    expect(await errorCode(refused)).toBe('session_locked');

    // A wrong password is refused and the lock stays.
    await page.getByLabel('Password', { exact: true }).fill('not-the-admin-password');
    const wrong = answer(page, 'POST', '/api/session/unlock');
    await page.getByRole('button', { name: 'Unlock' }).click();
    expect((await wrong).status()).toBe(401);
    await expect(page.getByText('Password is incorrect.', { exact: true })).toBeVisible();
    await expect(settings).toBeHidden();

    // The right one unlocks, back where it was, the draft intact.
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    const right = answer(page, 'POST', '/api/session/unlock');
    await page.getByRole('button', { name: 'Unlock' }).click();
    expect((await right).status()).toBe(200);
    await expect(settings).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Session locked' })).toHaveCount(0);
    await expect(draft).toHaveValue('Draft kept behind the lock');
    expect((await page.request.get('/api/assessment')).status()).toBe(200);

    // Both are in the audit log, after a reload.
    await page.reload();
    await expect(auditEntry(page, 'Session locked').first()).toBeVisible();
    await expect(auditEntry(page, 'Session unlocked').first()).toBeVisible();
    await context.close();
  });
});
