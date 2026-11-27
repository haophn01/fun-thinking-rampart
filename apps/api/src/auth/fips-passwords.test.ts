import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type AppDb, type DbHandle } from '../../db/client';
import { passwordHistory, user } from '../../db/schema';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { errorEnvelopeSchema } from '../contract';
import { createMemoryStore } from '../../storage';
import {
  ADMIN,
  HARNESS_SECRET_KEY,
  START,
  createHarness,
  signInThroughApi,
  type Harness,
  type MfaSecrets,
  type SessionHeaders,
} from '../testing/harness';

const PBKDF2 = /^\$pbkdf2-sha256\$i=600000\$/;
const ARGON2 = /^\$argon2id\$/;
const CHANGE = '/api/session/password';
const CARL = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'carl temporary password',
} as const;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function hashOf(db: AppDb, email: string): string {
  const row = db
    .select({ passwordHash: user.passwordHash })
    .from(user)
    .where(eq(user.email, email))
    .get();
  if (!row) throw new Error(`no ${email}`);
  return row.passwordHash;
}

function code(response: { json: () => unknown }): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

describe('FIPS_MODE=required stores PBKDF2 hashes for setup, change and temporary passwords', () => {
  it('setup, an admin-created temporary password, a reset and a change all store $pbkdf2-sha256$, and sign-in works', async () => {
    const h: Harness = createHarness({ env: { FIPS_MODE: 'required' } });
    cleanups.push(() => h.close());

    const admin = await h.setupAdmin();
    expect(hashOf(h.db, ADMIN.email)).toMatch(PBKDF2);

    // An admin-created user: a temporary password, then the user's own change.
    expect((await admin.post('/api/users', CARL)).statusCode).toBe(201);
    expect(hashOf(h.db, CARL.email)).toMatch(PBKDF2);
    const carl = await h.signIn(CARL.email, CARL.password, { temporary: true });
    const changed = await carl.post(CHANGE, {
      currentPassword: CARL.password,
      newPassword: 'carl chose this one',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const carlHash = hashOf(h.db, CARL.email);
    expect(carlHash).toMatch(PBKDF2);
    expect(await h.signIn(CARL.email, 'carl chose this one')).toBeTruthy();

    // An admin's reset is a temporary password too.
    const carlId = h.db.select().from(user).where(eq(user.email, CARL.email)).get()?.id ?? '';
    const reset = await admin.patch(`/api/users/${carlId}`, { password: 'carl reset password' });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(hashOf(h.db, CARL.email)).toMatch(PBKDF2);
    expect(hashOf(h.db, CARL.email)).not.toBe(carlHash);

    // The admin signs in again, locks and unlocks against the PBKDF2 hash.
    const again = await h.signIn(ADMIN.email, ADMIN.password);
    expect((await again.post('/api/session/lock')).statusCode).toBe(204);
    const wrong = await again.post('/api/session/unlock', { password: 'not the admin password' });
    expect(code(wrong)).toBe('invalid_credentials');
    const unlocked = await again.post('/api/session/unlock', { password: ADMIN.password });
    expect(unlocked.statusCode, unlocked.body).toBe(200);

    // A wrong password and an unknown email are both refused the same way.
    for (const attempt of [
      { email: ADMIN.email, password: 'not the admin password' },
      { email: 'nobody@example.com', password: ADMIN.password },
    ]) {
      const response = await h.client().post('/api/session', attempt);
      expect(response.statusCode, attempt.email).toBe(401);
      expect(code(response)).toBe('invalid_credentials');
    }
  });
});

/** Two apps, one after the other, on the same database file: a restart with a new FIPS_MODE. */
function restartableApi() {
  const dir = mkdtempSync(join(tmpdir(), 'rampart-fips-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'rampart.sqlite');
  const secrets: MfaSecrets = new Map();
  let at = START;
  let running: { app: FastifyInstance; handle: DbHandle } | null = null;

  async function start(fipsMode: 'off' | 'required') {
    if (running) {
      await running.app.close();
      running.handle.sqlite.close();
    }
    const handle = openDb(path);
    runMigrations(handle.db);
    const config = loadConfig({
      DATABASE_PATH: path,
      LOG_LEVEL: 'silent',
      RAMPART_SECRET_KEY: HARNESS_SECRET_KEY,
      FIPS_MODE: fipsMode,
    });
    const app = buildApp({ config, db: handle.db, now: () => at, store: createMemoryStore() });
    const current = { app, handle };
    running = current;
    cleanups.push(async () => {
      await app.close();
      if (handle.sqlite.open) handle.sqlite.close();
    });
    return current;
  }

  async function session(app: FastifyInstance, url: string, payload: unknown) {
    // A minute on per sign-in, so each MFA step is a fresh one.
    at = new Date(at.getTime() + 60_000);
    return signInThroughApi(app, url, payload, { at, secrets });
  }

  async function post(
    app: FastifyInstance,
    url: string,
    headers: SessionHeaders,
    body: unknown,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  return { start, session, post };
}

describe('accounts from before FIPS_MODE still sign in', () => {
  it('an admin set up with FIPS off still signs in after a restart with FIPS required, and their next change stores PBKDF2', async () => {
    const api = restartableApi();
    const off = await api.start('off');
    await api.session(off.app, '/api/setup', ADMIN);
    const before = hashOf(off.handle.db, ADMIN.email);
    expect(before).toMatch(ARGON2);

    const required = await api.start('required');
    const headers = await api.session(required.app, '/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    // No rehash at sign-in: the stored hash is the one setup wrote.
    expect(hashOf(required.handle.db, ADMIN.email)).toBe(before);

    const changed = await api.post(required.app, CHANGE, headers, {
      currentPassword: ADMIN.password,
      newPassword: 'a fips era password',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(hashOf(required.handle.db, ADMIN.email)).toMatch(PBKDF2);
    await api.session(required.app, '/api/session', {
      email: ADMIN.email,
      password: 'a fips era password',
    });

    // Back to off: the PBKDF2 hash still verifies.
    const offAgain = await api.start('off');
    await api.session(offAgain.app, '/api/session', {
      email: ADMIN.email,
      password: 'a fips era password',
    });
  });
});

describe('reuse check spans both schemes', () => {
  it('reusing a password whose history hash is argon2 is refused while the current hash is PBKDF2', async () => {
    const api = restartableApi();
    const off = await api.start('off');
    await api.session(off.app, '/api/setup', ADMIN);

    const required = await api.start('required');
    const headers = await api.session(required.app, '/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    const next = 'a fips era password';
    const changed = await api.post(required.app, CHANGE, headers, {
      currentPassword: ADMIN.password,
      newPassword: next,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const db = required.handle.db;
    expect(hashOf(db, ADMIN.email)).toMatch(PBKDF2);
    const history = db
      .select({ passwordHash: passwordHistory.passwordHash })
      .from(passwordHistory)
      .orderBy(asc(passwordHistory.id))
      .all()
      .map((row) => row.passwordHash);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatch(ARGON2);

    const fresh = await api.session(required.app, '/api/session', {
      email: ADMIN.email,
      password: next,
    });
    const reused = await api.post(required.app, CHANGE, fresh, {
      currentPassword: next,
      newPassword: ADMIN.password,
    });
    expect(reused.statusCode, reused.body).toBe(400);
    expect(code(reused)).toBe('password_reused');
    // And the current PBKDF2 password itself.
    const same = await api.post(required.app, CHANGE, fresh, {
      currentPassword: next,
      newPassword: next,
    });
    expect(code(same)).toBe('password_reused');
  });
});
