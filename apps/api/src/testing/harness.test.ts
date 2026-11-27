import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../storage';
import { openDb, runMigrations } from '../../db/client';
import { session, user } from '../../db/schema';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { base32Decode } from '../auth/mfa/base32';
import { totpAt } from '../auth/mfa/totp';
import { tokenDigest } from '../auth/sessions';
import { CSRF_HEADER, SESSION_COOKIE, sessionResponseSchema } from '../contract';
import { decryptSecret, deriveKeys } from '../security/secrets';
import {
  ADMIN,
  createHarness,
  HARNESS_MFA_SECRET,
  HARNESS_SECRET_KEY,
  signInThroughApi,
  type Client,
  type MfaSecrets,
  type Harness,
  type HarnessOptions,
} from './harness';

const harnesses: Harness[] = [];

function harness(options: HarnessOptions = {}): Harness {
  const made = createHarness(options);
  harnesses.push(made);
  return made;
}

afterEach(async () => {
  for (const made of harnesses.splice(0)) await made.close();
});

interface Echo {
  method: string;
  contentType: string | null;
  fileName: string | null;
  csrf: string | null;
  cookie: string | null;
  size: number;
  sha256: string;
}

/** A test-only route that reports exactly what reached the server. */
function addEcho(app: FastifyInstance): void {
  void app.register(async (scope) => {
    await Promise.resolve();
    scope.addContentTypeParser(
      ['application/octet-stream', 'application/x-www-form-urlencoded'],
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );
    scope.post('/test/echo', (request) => {
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const header = (name: string) => {
        const value = request.headers[name];
        return typeof value === 'string' ? value : null;
      };
      const echo: Echo = {
        method: request.method,
        contentType: header('content-type'),
        fileName: header('x-file-name'),
        csrf: header(CSRF_HEADER),
        cookie: header('cookie'),
        size: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      };
      return echo;
    });
  });
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('harness', () => {
  it('upload', async () => {
    const h = harness();
    addEcho(h.app);
    const admin = await h.setupAdmin();
    expect(admin.csrfToken).not.toBeNull();

    const bytes = Uint8Array.from({ length: 300 }, (_, index) => index % 256);
    const sent = await admin.upload('/test/echo', bytes, 'Política 1.pdf');
    expect(sent.statusCode).toBe(200);
    const echo = sent.json<Echo>();
    expect(echo).toEqual({
      method: 'POST',
      contentType: 'application/octet-stream',
      fileName: 'Pol%C3%ADtica%201.pdf',
      csrf: admin.csrfToken,
      cookie: `${SESSION_COOKIE}=${String(admin.cookie)}`,
      size: 300,
      sha256: sha(bytes),
    });

    // `null` omits the name header; the rest is still sent.
    const unnamed = (await admin.upload('/test/echo', bytes, null)).json<Echo>();
    expect(unnamed.fileName).toBeNull();
    expect(unnamed.contentType).toBe('application/octet-stream');
    expect(unnamed.csrf).toBe(admin.csrfToken);

    // Options still override or drop headers, as on every request.
    const noCsrf = (
      await admin.upload('/test/echo', bytes, 'a.pdf', { headers: { [CSRF_HEADER]: null } })
    ).json<Echo>();
    expect(noCsrf.csrf).toBeNull();
    expect(noCsrf.fileName).toBe('a.pdf');

    // A view into a larger buffer sends only its own bytes.
    const backing = Uint8Array.from([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    const viewed = (await admin.upload('/test/echo', view, 'v.txt')).json<Echo>();
    expect(viewed.size).toBe(3);
    expect(viewed.sha256).toBe(sha(Uint8Array.from([1, 2, 3])));
  });

  it('rawBody sends any bytes with any content type', async () => {
    const h = harness();
    addEcho(h.app);
    const c = h.client();
    const form = (
      await c.post('/test/echo', undefined, {
        rawBody: 'a=1&b=2',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    ).json<Echo>();
    expect(form.contentType).toBe('application/x-www-form-urlencoded');
    expect(form.size).toBe(7);

    const bytes = Uint8Array.of(0, 255, 10);
    const raw = (
      await c.request('POST', '/test/echo', {
        rawBody: bytes,
        headers: { 'content-type': 'application/octet-stream' },
      })
    ).json<Echo>();
    expect(raw.sha256).toBe(sha(bytes));

    // The api still refuses a body type it doesn't read.
    const text = await c.post('/api/session', undefined, {
      rawBody: 'hello',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(415);
  });

  it('store', async () => {
    const h = harness();
    expect('store' in h).toBe(true);
    expect(h.store.keys()).toEqual([]);
    const stored = await h.store.put(Uint8Array.of(1, 2, 3));
    expect(h.store.keys()).toEqual([stored.key]);
    // Each harness gets its own store.
    expect(harness().store.keys()).toEqual([]);
  });

  it('uses a store it is given', async () => {
    const store = createMemoryStore();
    await store.put(Uint8Array.of(7));
    const h = harness({ store });
    expect(h.store).toBe(store);
    expect(h.store.keys()).toHaveLength(1);
  });

  describe('env overrides and hosted cookie', () => {
    it('defaults the rate-limit multiplier to 1000 and stays local', () => {
      expect(harness().config).toMatchObject({
        rateLimitMultiplier: 1000,
        hosted: false,
        databasePath: ':memory:',
        logLevel: 'info',
      });
    });

    it('merges env over its defaults', () => {
      // SERVE_WEB needs a built web app, so it gets a temp one with just an index.html.
      const dist = mkdtempSync(join(tmpdir(), 'rampart-harness-web-'));
      try {
        writeFileSync(join(dist, 'index.html'), '<!doctype html>');
        const h = harness({
          env: {
            RATE_LIMIT_MULTIPLIER: '1',
            HOSTED: 'true',
            SERVE_WEB: 'true',
            WEB_DIST_PATH: dist,
          },
        });
        expect(h.config).toMatchObject({
          rateLimitMultiplier: 1,
          hosted: true,
          serveWeb: true,
          webDistPath: dist,
          databasePath: ':memory:',
        });
      } finally {
        rmSync(dist, { recursive: true, force: true });
      }
      // An env LOG_LEVEL wins over the option, since env is the more specific of the two.
      expect(harness({ logLevel: 'warn', env: { LOG_LEVEL: 'error' } }).config).toMatchObject({
        logLevel: 'error',
      });
      expect(harness({ logLevel: 'warn' }).config).toMatchObject({ logLevel: 'warn' });
    });

    it('defaults the secret key to HARNESS_SECRET_KEY and takes an env override', () => {
      expect(HARNESS_SECRET_KEY).toBe('0123456789abcdef'.repeat(4));
      expect(harness().config.secretKeyHex).toBe(HARNESS_SECRET_KEY);
      // Hosted harnesses get it too, so they pass the startup rule like a real hosted server.
      expect(harness({ env: { HOSTED: 'true' } }).config.secretKeyHex).toBe(HARNESS_SECRET_KEY);
      const other = 'fedcba9876543210'.repeat(4);
      expect(harness({ env: { RAMPART_SECRET_KEY: other } }).config.secretKeyHex).toBe(other);
      // An empty value unsets it: the app then runs on a random in-memory key.
      expect(harness({ env: { RAMPART_SECRET_KEY: '' } }).config.secretKeyHex).toBeNull();
      expect(() => harness({ env: { RAMPART_SECRET_KEY: '0'.repeat(64) } })).toThrow(
        /RAMPART_SECRET_KEY/,
      );
    });

    it('a bad env value fails like the server would', () => {
      expect(() => harness({ env: { HOSTED: 'yes' } })).toThrow(/HOSTED/);
    });

    it('keeps the hosted session cookie and sends it back under its own name', async () => {
      const h = harness({ env: { HOSTED: 'true' } });
      h.app.get('/test/cookie', (request) => ({ cookie: request.headers.cookie ?? null }));
      const admin = await h.setupAdmin();
      expect(admin.cookie).not.toBeNull();
      expect(admin.csrfToken).not.toBeNull();
      const users = await admin.get('/api/users');
      expect(users.statusCode).toBe(200);
      const echoed = (await admin.get('/test/cookie')).json<{ cookie: string | null }>();
      expect(echoed.cookie).toBe(`__Host-rampart_session=${admin.cookie ?? ''}`);
      // Sign-out clears it, so the client is signed out too.
      expect((await admin.delete('/api/session')).statusCode).toBe(204);
      expect(admin.cookie).toBeNull();
      expect((await admin.get('/api/users')).statusCode).toBe(401);
    });

    it('signIn works hosted too', async () => {
      const h = harness({ env: { HOSTED: 'true' } });
      await h.setupAdmin();
      const again = await h.signIn('admin@example.com', 'correct horse battery');
      expect((await again.get('/api/users')).statusCode).toBe(200);
    });
  });

  describe('signIn and temporary passwords', () => {
    function flag(h: Harness, email: string): boolean | undefined {
      return h.db.select().from(user).where(eq(user.email, email)).get()?.mustChangePassword;
    }
    function setFlag(h: Harness, email: string): void {
      h.db.update(user).set({ mustChangePassword: true }).where(eq(user.email, email)).run();
    }

    it('clears must_change_password by default, so suites sign in to a working session', async () => {
      const h = harness();
      await h.setupAdmin();
      setFlag(h, ADMIN.email);
      const signedIn = await h.signIn(ADMIN.email, ADMIN.password);
      expect(flag(h, ADMIN.email)).toBe(false);
      const me = sessionResponseSchema.parse((await signedIn.get('/api/session')).json());
      expect(me.mustChangePassword).toBe(false);
      expect((await signedIn.get('/api/users')).statusCode).toBe(200);
    });

    it('keeps the flag with { temporary: true }', async () => {
      const h = harness();
      await h.setupAdmin();
      setFlag(h, ADMIN.email);
      const signedIn = await h.signIn(ADMIN.email, ADMIN.password, { temporary: true });
      expect(flag(h, ADMIN.email)).toBe(true);
      const me = sessionResponseSchema.parse((await signedIn.get('/api/session')).json());
      expect(me.mustChangePassword).toBe(true);
      expect((await signedIn.get('/api/users')).statusCode).toBe(403);
    });

    it('still throws on a wrong password or an unknown email', async () => {
      const h = harness();
      await h.setupAdmin();
      await expect(h.signIn(ADMIN.email, 'not the password!')).rejects.toThrow(/401/);
      await expect(h.signIn('nobody@example.com', ADMIN.password)).rejects.toThrow(/401/);
    });
  });

  describe('signIn completes MFA by default', () => {
    const CONTRIBUTOR = {
      email: 'carl@example.com',
      displayName: 'Carl Contributor',
      role: 'contributor',
      password: 'contributor password',
    } as const;

    function stored(h: Harness, email: string) {
      const row = h.db.select().from(user).where(eq(user.email, email)).get();
      if (!row) throw new Error(`no user ${email}`);
      return row;
    }
    function sessionId(c: Client): string {
      if (c.cookie === null) throw new Error('the client has no session');
      return tokenDigest(c.cookie);
    }
    function pending(h: Harness, c: Client): boolean | undefined {
      return h.db
        .select({ mfaPending: session.mfaPending })
        .from(session)
        .where(eq(session.id, sessionId(c)))
        .get()?.mfaPending;
    }
    function pend(h: Harness, c: Client): void {
      h.db
        .update(session)
        .set({ mfaPending: true })
        .where(eq(session.id, sessionId(c)))
        .run();
    }

    it('setupAdmin and signIn enroll with HARNESS_MFA_SECRET, the session not pending', async () => {
      const h = harness();
      const keys = deriveKeys(Buffer.from(h.config.secretKeyHex ?? '', 'hex'));
      const admin = await h.setupAdmin();
      const row = stored(h, ADMIN.email);
      expect(row.mfaEnrolledAt).toBe(h.clock.now().toISOString());
      expect(row.mfaLastStep).toBeNull();
      expect(row.mfaSecretEnc).toMatch(/^v1\./);
      expect(decryptSecret(keys.mfaSecret, row.mfaSecretEnc ?? '', `user:${row.id}`)).toBe(
        HARNESS_MFA_SECRET,
      );
      expect(pending(h, admin)).toBe(false);

      expect((await admin.post('/api/users', CONTRIBUTOR)).statusCode).toBe(201);
      expect(stored(h, CONTRIBUTOR.email).mfaEnrolledAt).toBeNull();
      const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
      const carlRow = stored(h, CONTRIBUTOR.email);
      expect(carlRow.mfaEnrolledAt).not.toBeNull();
      expect(decryptSecret(keys.mfaSecret, carlRow.mfaSecretEnc ?? '', `user:${carlRow.id}`)).toBe(
        HARNESS_MFA_SECRET,
      );
      expect(pending(h, carl)).toBe(false);

      // Only the new sign-in's own session is made full; an enrolled user keeps their secret.
      pend(h, carl);
      const again = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
      expect(pending(h, again)).toBe(false);
      expect(pending(h, carl)).toBe(true);
      expect(stored(h, CONTRIBUTOR.email).mfaSecretEnc).toBe(carlRow.mfaSecretEnc);
    });

    it("{ mfa: 'as_stored' } changes nothing", async () => {
      const h = harness();
      const admin = await h.setupAdmin({}, { mfa: 'as_stored' });
      expect(stored(h, ADMIN.email)).toMatchObject({
        mfaSecretEnc: null,
        mfaLastStep: null,
        mfaEnrolledAt: null,
      });
      // The session stays as setup left it: waiting for enrollment, so the gate holds.
      expect(pending(h, admin)).toBe(true);
      expect((await admin.get('/api/users')).statusCode).toBe(403);
      // A default sign-in completes MFA, so the admin can add a user.
      const full = await h.signIn(ADMIN.email, ADMIN.password);
      expect((await full.post('/api/users', CONTRIBUTOR)).statusCode).toBe(201);
      const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password, { mfa: 'as_stored' });
      expect(stored(h, CONTRIBUTOR.email).mfaEnrolledAt).toBeNull();
      // A pending session stays pending: as_stored never touches the session either.
      pend(h, carl);
      expect(pending(h, carl)).toBe(true);
      const second = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password, { mfa: 'as_stored' });
      expect(stored(h, CONTRIBUTOR.email).mfaEnrolledAt).toBeNull();
      expect(pending(h, carl)).toBe(true);
      // Sign-in leaves every session pending, and as_stored keeps it so.
      expect(pending(h, second)).toBe(true);
    });

    it('h.totp equals totpAt for the stored secret, at the clock or a given time', async () => {
      const h = harness();
      await h.setupAdmin();
      const secret = base32Decode(HARNESS_MFA_SECRET);
      expect(h.totp(ADMIN.email)).toBe(totpAt(secret, h.clock.now()));
      const later = new Date(h.clock.now().getTime() + 90_000);
      expect(h.totp(ADMIN.email, later)).toBe(totpAt(secret, later));
      h.clock.set(later);
      expect(h.totp(ADMIN.email)).toBe(totpAt(secret, later));
      expect(() => h.totp('nobody@example.com')).toThrow(/nobody@example.com/);
    });

    it('signInThroughApi finishes setup and sign-in for suites that drive buildApp, across a restart', async () => {
      const handle = openDb(':memory:');
      runMigrations(handle.db);
      const at = new Date('2026-11-23T09:00:00.000Z');
      const start = () =>
        buildApp({
          config: loadConfig({
            DATABASE_PATH: ':memory:',
            LOG_LEVEL: 'silent',
            RAMPART_SECRET_KEY: HARNESS_SECRET_KEY,
          }),
          db: handle.db,
          now: () => at,
          store: createMemoryStore(),
        });
      const secrets: MfaSecrets = new Map();
      const first = start();
      try {
        const headers = await signInThroughApi(first, '/api/setup', ADMIN, { at, secrets });
        expect(secrets.has(ADMIN.email)).toBe(true);
        const read = await first.inject({ method: 'GET', url: '/api/assessment', headers });
        expect(read.statusCode, read.body).toBe(200);
      } finally {
        await first.close();
      }
      // A restart on the same database and key; the clock hasn't moved, so the used step is skipped.
      const second = start();
      try {
        const again = await signInThroughApi(
          second,
          '/api/session',
          { email: ADMIN.email, password: ADMIN.password },
          { at, secrets },
        );
        const read = await second.inject({ method: 'GET', url: '/api/users', headers: again });
        expect(read.statusCode, read.body).toBe(200);
        await expect(
          signInThroughApi(
            second,
            '/api/session',
            { email: ADMIN.email, password: 'wrong one' },
            {
              at,
              secrets,
            },
          ),
        ).rejects.toThrow(/401/);
      } finally {
        await second.close();
        handle.sqlite.close();
      }
    });

    it('works on a random in-memory key too', async () => {
      const h = harness({ env: { RAMPART_SECRET_KEY: '' } });
      expect(h.config.secretKeyHex).toBeNull();
      await h.setupAdmin();
      expect(h.totp(ADMIN.email)).toBe(totpAt(base32Decode(HARNESS_MFA_SECRET), h.clock.now()));
    });
  });
});
