import { asc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, mfaRecoveryCode, session, user } from '../../../db/schema';
import {
  ERROR_MESSAGES,
  errorEnvelopeSchema,
  mfaEnrolledResponseSchema,
  mfaEnrollmentResponseSchema,
  recoveryCodeSchema,
  type MfaEnrollmentResponse,
} from '../../contract';
import { decryptSecret } from '../../security/secrets';
import { ADMIN, createHarness, type Client, type Harness } from '../../testing/harness';
import { tokenDigest } from '../sessions';
import { base32Decode } from './base32';
import { hashRecoveryCode, normalizeRecoveryCode } from './recovery-codes';
import { totpAt, totpStep } from './totp';

const ENROLL = '/api/session/mfa/enroll';
const CONFIRM = '/api/session/mfa/enroll/confirm';
const STEP_MS = 30_000;

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

function harness(): Harness {
  const h = createHarness();
  harnesses.push(h);
  return h;
}

function codeOf(response: LightMyRequestResponse): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

function userRow(h: Harness, email: string) {
  const row = h.db.select().from(user).where(eq(user.email, email)).get();
  if (!row) throw new Error(`no user ${email}`);
  return row;
}

function mfaEvents(h: Harness) {
  return h.db
    .select()
    .from(auditEvent)
    .orderBy(asc(auditEvent.id))
    .all()
    .filter((event) => event.action.startsWith('auth.mfa_') || event.action === 'user.mfa_reset');
}

async function enroll(c: Client): Promise<MfaEnrollmentResponse> {
  const response = await c.post(ENROLL);
  expect(response.statusCode, response.body).toBe(200);
  return mfaEnrollmentResponseSchema.parse(response.json());
}

/** The code for `secret` at `at`. */
function codeFor(secret: string, at: Date): string {
  return totpAt(base32Decode(secret), at);
}

/** A 6-digit code that matches no step in the window around `at`. */
function wrongCode(secret: string, at: Date): string {
  const near = [-1, 0, 1].map((n) => codeFor(secret, new Date(at.getTime() + n * STEP_MS)));
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, '0');
    if (!near.includes(candidate)) return candidate;
  }
}

/** An admin who has not set up MFA: the harness leaves them as the api did. */
async function unenrolledAdmin(h: Harness): Promise<Client> {
  return h.setupAdmin({}, { mfa: 'as_stored' });
}

describe('enroll stores an encrypted secret', () => {
  it('answers a secret, a URI naming the email and a QR path, and stores only ciphertext', async () => {
    const h = harness();
    const admin = await unenrolledAdmin(h);
    // A step left over from an earlier enrollment is cleared by a new secret.
    h.db.update(user).set({ mfaLastStep: 123 }).where(eq(user.email, ADMIN.email)).run();

    const first = await enroll(admin);
    expect(first.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(first.otpauthUri).toContain(`:${encodeURIComponent(ADMIN.email)}?`);
    expect(first.otpauthUri).toContain(`secret=${first.secret}&`);
    expect(first.qr.size).toBeGreaterThanOrEqual(21);
    expect(first.qr.path.length).toBeGreaterThan(0);

    const row = userRow(h, ADMIN.email);
    const enc = row.mfaSecretEnc ?? '';
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain(first.secret);
    expect(enc.toLowerCase()).not.toContain(first.secret.toLowerCase());
    expect(enc).not.toContain(base32Decode(first.secret).toString('hex'));
    expect(enc).not.toContain(base32Decode(first.secret).toString('base64url'));
    expect(decryptSecret(h.keys.mfaSecret, enc, `user:${row.id}`)).toBe(first.secret);
    expect(row.mfaLastStep).toBeNull();
    expect(row.mfaEnrolledAt).toBeNull();
    // Starting enrollment is not an event: only finishing it is.
    expect(mfaEvents(h)).toEqual([]);

    // Showing enrollment again (a reload) keeps the pending secret, so a QR already scanned
    // into an authenticator app keeps working.
    const second = await enroll(admin);
    expect(second.secret).toBe(first.secret);
    expect(second.otpauthUri).toBe(first.otpauthUri);
    expect(userRow(h, ADMIN.email).mfaSecretEnc).toBe(enc);
    const now = h.clock.now();
    const scanned = await admin.post(CONFIRM, { code: codeFor(first.secret, now) });
    expect(scanned.statusCode, scanned.body).toBe(200);
  });
});

describe('confirm enrolls and rotates', () => {
  it('answers 10 codes and a new session, and stores the enrollment, hashes and one event', async () => {
    const h = harness();
    const admin = await unenrolledAdmin(h);
    const adminId = admin.user?.id ?? '';
    // Codes from an earlier enrollment are replaced, never kept.
    h.db
      .insert(mfaRecoveryCode)
      .values({ userId: adminId, codeHash: 'stale', createdAt: h.clock.now().toISOString() })
      .run();
    const { secret } = await enroll(admin);
    const old = { cookie: admin.cookie, csrfToken: admin.csrfToken };
    h.clock.advance(5_000);
    const now = h.clock.now();

    const response = await admin.post(CONFIRM, { code: ` ${codeFor(secret, now)} ` });
    expect(response.statusCode, response.body).toBe(200);
    const body = mfaEnrolledResponseSchema.parse(response.json());
    expect(response.body).not.toContain(secret);
    expect(body.mfa).toBe('none');
    expect(body.user?.id).toBe(adminId);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(new Set(body.recoveryCodes).size).toBe(10);
    for (const code of body.recoveryCodes) expect(recoveryCodeSchema.parse(code)).toBe(code);

    // A rotated session: new cookie, new CSRF token, not pending; the old one is gone.
    expect(admin.cookie).not.toBeNull();
    expect(admin.cookie).not.toBe(old.cookie);
    expect(admin.csrfToken).toBe(body.csrfToken);
    expect(body.csrfToken).not.toBe(old.csrfToken);
    const rotated = h.db
      .select()
      .from(session)
      .where(eq(session.id, tokenDigest(admin.cookie ?? '')))
      .get();
    expect(rotated?.mfaPending).toBe(false);
    const stale = h.client();
    stale.cookie = old.cookie;
    stale.csrfToken = old.csrfToken;
    const refused = await stale.post('/api/session/lock');
    expect(refused.statusCode).toBe(401);
    expect(codeOf(refused)).toBe('unauthenticated');
    expect((await admin.get('/api/users')).statusCode).toBe(200);

    const row = userRow(h, ADMIN.email);
    expect(row.mfaEnrolledAt).toBe(now.toISOString());
    expect(row.mfaLastStep).toBe(totpStep(now));

    const stored = h.db
      .select()
      .from(mfaRecoveryCode)
      .where(eq(mfaRecoveryCode.userId, adminId))
      .all();
    expect(stored).toHaveLength(10);
    const hashes = stored.map((r) => r.codeHash);
    for (const code of body.recoveryCodes) {
      expect(hashes).not.toContain(code);
      expect(hashes).not.toContain(code.replace('-', ''));
      expect(hashes).toContain(
        hashRecoveryCode(h.keys.recoveryCode, normalizeRecoveryCode(code) ?? ''),
      );
    }
    expect(stored.every((r) => r.usedAt === null && r.createdAt === now.toISOString())).toBe(true);

    const events = mfaEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'auth.mfa_enrolled',
      actorUserId: adminId,
      entityType: 'user',
      entityId: adminId,
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});

describe('confirm edges', () => {
  it('a wrong code is 401 and counts nothing; the wrong step is 409; a bad body is 400', async () => {
    const h = harness();
    const admin = await unenrolledAdmin(h);

    const early = await admin.post(CONFIRM, { code: '123456' });
    expect(early.statusCode).toBe(409);
    expect(codeOf(early)).toBe('mfa_wrong_step');

    const { secret } = await enroll(admin);
    const now = h.clock.now();
    for (let i = 0; i < 6; i++) {
      const wrong = await admin.post(CONFIRM, { code: wrongCode(secret, now) });
      expect(wrong.statusCode).toBe(401);
      expect(errorEnvelopeSchema.parse(wrong.json()).error).toMatchObject({
        code: 'invalid_mfa_code',
        message: ERROR_MESSAGES.invalid_mfa_code,
      });
    }
    expect(userRow(h, ADMIN.email)).toMatchObject({
      failedSignIns: 0,
      lockedUntil: null,
      mfaEnrolledAt: null,
      mfaLastStep: null,
    });

    for (const body of [
      undefined,
      {},
      { code: '12345' },
      { code: '12a456' },
      { code: '123456', x: 1 },
    ]) {
      const bad = await admin.post(CONFIRM, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
    }

    // Still unlocked after 6 wrong codes: the right one enrolls.
    const ok = await admin.post(CONFIRM, { code: codeFor(secret, now) });
    expect(ok.statusCode, ok.body).toBe(200);

    for (const url of [ENROLL, CONFIRM]) {
      const again = await admin.post(
        url,
        url === CONFIRM ? { code: codeFor(secret, now) } : undefined,
      );
      expect(again.statusCode, url).toBe(409);
      expect(codeOf(again), url).toBe('mfa_wrong_step');
    }
    // A refused enroll leaves the enrolled secret as it was.
    const row = userRow(h, ADMIN.email);
    expect(decryptSecret(h.keys.mfaSecret, row.mfaSecretEnc ?? '', `user:${row.id}`)).toBe(secret);
    expect(mfaEvents(h).map((e) => e.action)).toEqual(['auth.mfa_enrolled']);
  });

  it('confirm accepts the next step for clock drift and stores it', async () => {
    const h = harness();
    const admin = await unenrolledAdmin(h);
    const { secret } = await enroll(admin);
    const next = new Date(h.clock.now().getTime() + STEP_MS);
    const ok = await admin.post(CONFIRM, { code: codeFor(secret, next) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(userRow(h, ADMIN.email).mfaLastStep).toBe(totpStep(next));
  });

  it('needs a session and the CSRF token', async () => {
    const h = harness();
    const admin = await unenrolledAdmin(h);
    for (const url of [ENROLL, CONFIRM]) {
      const signedOut = await h.client().post(url, { code: '123456' });
      expect(signedOut.statusCode, url).toBe(401);
      const noCsrf = await admin.post(
        url,
        { code: '123456' },
        { headers: { 'x-csrf-token': null } },
      );
      expect(codeOf(noCsrf), url).toBe('csrf_failed');
    }
    expect(userRow(h, ADMIN.email).mfaSecretEnc).toBeNull();
  });
});
