// Auth hardening on the production serving path: the sign-in notice, two-step sign-in (TOTP, a
// recovery code, an admin reset), the temporary password's forced change, and the idle lock, each
// driven in the browser as a user meets it.
//
// Playwright runs spec files in name order, and shell.spec.ts and smoke.spec.ts need the config
// server's fresh install, so this file never touches that server. It starts the built api
// (`node dist/server.js`, which the config server's build makes) on 3295 with the web app served
// from it, on a database of its own in the run folder.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
  type Response,
} from '@playwright/test';
import {
  CSRF_HEADER,
  errorEnvelopeSchema,
  sessionResponseSchema,
} from '../apps/api/src/contract/index.ts';
import {
  ensureOk,
  manualKey,
  nextTotpCode,
  setUp,
  signIn,
  type SignInOptions,
} from './helpers/api';

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

/** Each account's TOTP secret (base32), as enrollment made it. */
const secrets = new Map<string, string>();
/** The admin's recovery codes, from enrollment at setup. */
let adminRecoveryCodes: string[] = [];

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

/** Sign-in through the api with the account's kept secret; keeps the secret enrollment made. */
async function apiSignIn(
  request: APIRequestContext,
  email: string,
  password: string,
  options: Omit<SignInOptions, 'totpSecret'> = {},
) {
  const secret = secrets.get(email);
  const session = await signIn(request, email, password, {
    ...options,
    ...(secret === undefined ? {} : { totpSecret: secret }),
  });
  if (session.totpSecret !== null) secrets.set(email, session.totpSecret);
  return session;
}

/** A browser context signed in as `email` (its cookie in the context's jar), and a page in it. */
async function signedIn(browser: Browser, email: string, password: string) {
  const context = await browser.newContext({ baseURL: ORIGIN });
  await apiSignIn(context.request, email, password);
  return { context, page: await context.newPage() };
}

function adminSecret(): string {
  const secret = secrets.get(ADMIN.email);
  if (secret === undefined) throw new Error('the admin has no secret yet');
  return secret;
}

/** The CSRF header for the session a request context holds. */
async function csrfOf(request: APIRequestContext) {
  const session = sessionResponseSchema.parse(await (await request.get('/api/session')).json());
  return { [CSRF_HEADER]: session.csrfToken ?? '' };
}

function codeChallenge(page: Page) {
  return page.getByRole('heading', { level: 1, name: 'Enter your code' });
}

function enrollment(page: Page) {
  return page.getByRole('heading', { level: 1, name: 'Set up two-step sign-in' });
}

/** At the challenge, types `code` and verifies; resolves with the answer. */
async function enterCode(page: Page, code: string) {
  await expect(codeChallenge(page)).toBeVisible();
  await page.getByLabel('6-digit code').fill(code);
  const sent = answer(page, 'POST', '/api/session/mfa/verify');
  await page.getByRole('button', { name: 'Verify' }).click();
  return sent;
}

/**
 * At enrollment, reads the manual key as a user would type it into an app, confirms with its
 * code, saves the recovery codes and continues. Keeps the secret for `email`.
 */
async function enrollInUi(page: Page, email: string) {
  await expect(enrollment(page)).toBeVisible();
  const secret = manualKey(await page.getByTestId('mfa-manual-key').innerText());
  secrets.set(email, secret);
  await page.getByLabel('6-digit code').fill(await nextTotpCode(secret));
  const confirmed = answer(page, 'POST', '/api/session/mfa/enroll/confirm');
  await page.getByRole('button', { name: 'Confirm' }).click();
  expect((await confirmed).status()).toBe(200);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Save your recovery codes' }),
  ).toBeVisible();
  // The box is the Look's: its native input is visually hidden, so click the label.
  await page.getByText('I saved my recovery codes', { exact: true }).click();
  await expect(page.getByLabel('I saved my recovery codes')).toBeChecked();
  await page.getByRole('button', { name: 'Continue' }).click();
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
  // Each code waits for a 30 s step no sign-in has used yet, so a test may wait more than once.
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(90_000);
    await startServer();
    const request = await playwright.request.newContext({ baseURL: ORIGIN });
    // Setup, then enrollment: the admin's secret and recovery codes, for the tests below.
    const admin = await setUp(request, ADMIN);
    expect(admin.mfa).toBe('none');
    if (admin.totpSecret === null) throw new Error('setup enrolled no secret');
    secrets.set(ADMIN.email, admin.totpSecret);
    adminRecoveryCodes = admin.recoveryCodes;
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
    // Then the code from the authenticator app.
    expect((await enterCode(page, await nextTotpCode(adminSecret()))).status()).toBe(200);
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

  test('sign-in with TOTP', async ({ browser }) => {
    // The notice is on for this sign-in.
    const admin = await signedIn(browser, ADMIN.email, ADMIN.password);
    await ensureOk(
      await admin.context.request.put('/api/settings/sign-in-notice', {
        headers: await csrfOf(admin.context.request),
        data: { text: NOTICE },
      }),
      'set notice',
    );
    await admin.context.close();

    // Notice, password, then the code: the app opens.
    const context = await browser.newContext({ baseURL: ORIGIN });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Acknowledge and continue' }).click();
    expect((await submitSignIn(page, ADMIN.email, ADMIN.password)).status()).toBe(200);
    await expect(codeChallenge(page)).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
    const gated = await page.request.get('/api/assessment');
    expect(gated.status()).toBe(403);
    expect(await errorCode(gated)).toBe('mfa_required');
    const code = await nextTotpCode(adminSecret());
    expect((await enterCode(page, code)).status()).toBe(200);
    await expect(dashboard(page)).toBeVisible();
    await page.reload();
    await expect(dashboard(page)).toBeVisible();

    // The same code on a second sign-in in the same step: refused.
    const second = await browser.newContext({ baseURL: ORIGIN });
    const pending = await apiSignIn(second.request, ADMIN.email, ADMIN.password, {
      mfa: 'password_only',
    });
    expect(pending.mfa).toBe('challenge');
    const replayed = await second.request.post('/api/session/mfa/verify', {
      headers: { [CSRF_HEADER]: pending.csrfToken ?? '' },
      data: { code },
    });
    expect(replayed.status()).toBe(401);
    expect(await errorCode(replayed)).toBe('invalid_mfa_code');
    await second.close();

    // A recovery code works once: in the browser, then refused through the api.
    const [recoveryCode = ''] = adminRecoveryCodes;
    const byCode = await browser.newContext({ baseURL: ORIGIN });
    const codePage = await byCode.newPage();
    await codePage.goto('/');
    await codePage.getByRole('button', { name: 'Acknowledge and continue' }).click();
    expect((await submitSignIn(codePage, ADMIN.email, ADMIN.password)).status()).toBe(200);
    await expect(codeChallenge(codePage)).toBeVisible();
    await codePage.getByRole('button', { name: 'Use a recovery code' }).click();
    await codePage.getByLabel('Recovery code').fill(recoveryCode);
    const recovered = answer(codePage, 'POST', '/api/session/mfa/verify');
    await codePage.getByRole('button', { name: 'Verify' }).click();
    expect((await recovered).status()).toBe(200);
    await expect(dashboard(codePage)).toBeVisible();
    await byCode.close();
    const again = await browser.newContext({ baseURL: ORIGIN });
    const pendingAgain = await apiSignIn(again.request, ADMIN.email, ADMIN.password, {
      mfa: 'password_only',
    });
    const reused = await again.request.post('/api/session/mfa/verify', {
      headers: { [CSRF_HEADER]: pendingAgain.csrfToken ?? '' },
      data: { recoveryCode },
    });
    expect(reused.status()).toBe(401);
    expect(await errorCode(reused)).toBe('invalid_mfa_code');
    await again.close();

    // The audit log shows the verified sign-ins, after a reload.
    await page.goto('/settings');
    await expect(auditEntry(page, 'Two-step sign-in verified').first()).toBeVisible();
    await expect(auditEntry(page, 'Two-step sign-in set up').first()).toBeVisible();

    // Clear the notice for the tests after this one.
    await ensureOk(
      await page.request.put('/api/settings/sign-in-notice', {
        headers: await csrfOf(page.request),
        data: { text: null },
      }),
      'clear notice',
    );
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
    // Two-step sign-in first, then the password.
    await enrollInUi(page, tess.email);
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
    const session = await apiSignIn(fresh.request, tess.email, tess.chosen);
    expect(session.mustChangePassword).toBe(false);
    const old = await fresh.request.post('/api/session', {
      data: { email: tess.email, password: tess.temporary },
    });
    expect(old.status()).toBe(401);
    await fresh.close();
  });

  test('admin reset forces re-enrollment', async ({ browser }) => {
    const tess = {
      email: 'tess@example.test',
      name: 'Tess Temporary',
      password: 'tess-chosen-pass-2026',
    };
    const admin = await signedIn(browser, ADMIN.email, ADMIN.password);
    await admin.page.goto('/settings');
    const row = admin.page.getByRole('listitem', { name: tess.name });
    await expect(row.getByText('Two-step sign-in: Set up', { exact: true })).toBeVisible();
    const reset = admin.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /^\/api\/users\/[^/]+\/mfa\/reset$/.test(pathOf(response)),
    );
    await row.getByRole('button', { name: 'Reset two-step sign-in' }).click();
    expect((await reset).status()).toBe(200);
    await expect(
      admin.page.getByText(
        `Two-step sign-in reset for ${tess.name}. They set it up again at their next sign-in.`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(row.getByText('Two-step sign-in: Not set up', { exact: true })).toBeVisible();

    // Tess's next sign-in asks her to set it up again.
    const context = await browser.newContext({ baseURL: ORIGIN });
    const page = await context.newPage();
    await page.goto('/');
    expect((await submitSignIn(page, tess.email, tess.password)).status()).toBe(200);
    await expect(enrollment(page)).toBeVisible();
    await expect(page.getByTestId('mfa-manual-key')).toBeVisible();
    await context.close();

    // The audit log shows the reset, after a reload.
    await admin.page.reload();
    await expect(auditEntry(admin.page, 'Two-step sign-in reset').first()).toBeVisible();
    await admin.context.close();
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
