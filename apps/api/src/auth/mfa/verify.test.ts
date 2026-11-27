import { randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, mfaRecoveryCode, session, user } from '../../../db/schema';
import {
  ERROR_MESSAGES,
  errorEnvelopeSchema,
  mfaEnrolledResponseSchema,
  mfaEnrollmentResponseSchema,
  sessionResponseSchema,
} from '../../contract';
import { encryptSecret } from '../../security/secrets';
import {
  ADMIN,
  HARNESS_MFA_SECRET,
  createHarness,
  type Client,
  type Harness,
} from '../../testing/harness';
import { createSession, tokenDigest } from '../sessions';
import { base32Decode } from './base32';
import { totpAt, totpStep } from './totp';

const VERIFY = '/api/session/mfa/verify';
const STEP_MS = 30_000;
const CARL = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'contributor password',
} as const;

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

function sessionId(c: Client): string {
  if (c.cookie === null) throw new Error('the client has no session');
  return tokenDigest(c.cookie);
}

/** Marks the client's session as waiting for its MFA step, as sign-in will (A2). */
function pend(h: Harness, c: Client): void {
  h.db
    .update(session)
    .set({ mfaPending: true })
    .where(eq(session.id, sessionId(c)))
    .run();
}

function pendingOf(h: Harness, c: Client): boolean | undefined {
  return h.db
    .select()
    .from(session)
    .where(eq(session.id, sessionId(c)))
    .get()?.mfaPending;
}

function sessionsOf(h: Harness, userId: string) {
  return h.db.select().from(session).where(eq(session.userId, userId)).all();
}

function events(h: Harness, action: string) {
  return h.db
    .select()
    .from(auditEvent)
    .orderBy(asc(auditEvent.id))
    .all()
    .filter((event) => event.action === action)
    .map((event) => ({
      actorUserId: event.actorUserId,
      entityId: event.entityId,
      after: JSON.parse(event.after ?? 'null') as unknown,
    }));
}

/** The harness secret's code `steps` steps from the clock. */
function harnessCode(h: Harness, steps = 0): string {
  return totpAt(
    base32Decode(HARNESS_MFA_SECRET),
    new Date(h.clock.now().getTime() + steps * STEP_MS),
  );
}

/** Enrolls the client's user through the api; returns the secret and the recovery codes. */
async function enrollThroughApi(h: Harness, c: Client) {
  const started = await c.post('/api/session/mfa/enroll');
  expect(started.statusCode, started.body).toBe(200);
  const { secret } = mfaEnrollmentResponseSchema.parse(started.json());
  const confirmed = await c.post('/api/session/mfa/enroll/confirm', {
    code: totpAt(base32Decode(secret), h.clock.now()),
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return { secret, recoveryCodes: mfaEnrolledResponseSchema.parse(confirmed.json()).recoveryCodes };
}

async function carlSignedIn(h: Harness, admin: Client, options: { mfa?: 'as_stored' } = {}) {
  expect((await admin.post('/api/users', CARL)).statusCode).toBe(201);
  return h.signIn(CARL.email, CARL.password, options);
}

describe('replay guard accepts each step once', () => {
  it('verifies the current code once, then only a later step', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const adminId = admin.user?.id ?? '';
    const now = h.clock.now();
    pend(h, admin);

    // Outside the window: refused before any step is accepted.
    for (const steps of [-2, 2]) {
      const far = await admin.post(VERIFY, { code: harnessCode(h, steps) });
      expect(far.statusCode, `step ${String(steps)}`).toBe(401);
      expect(codeOf(far)).toBe('invalid_mfa_code');
    }

    const old = { cookie: admin.cookie, csrfToken: admin.csrfToken };
    const code = harnessCode(h);
    const ok = await admin.post(VERIFY, { code });
    expect(ok.statusCode, ok.body).toBe(200);
    const body = sessionResponseSchema.parse(ok.json());
    expect(body).toMatchObject({ mfa: 'none', locked: false, user: { id: adminId } });
    expect(admin.cookie).not.toBe(old.cookie);
    expect(body.csrfToken).not.toBe(old.csrfToken);
    expect(pendingOf(h, admin)).toBe(false);
    expect(
      h.db
        .select()
        .from(session)
        .where(eq(session.id, tokenDigest(old.cookie ?? '')))
        .get(),
    ).toBeUndefined();
    expect(userRow(h, ADMIN.email)).toMatchObject({ mfaLastStep: totpStep(now), failedSignIns: 0 });
    expect(events(h, 'auth.mfa_verified')).toEqual([
      { actorUserId: adminId, entityId: adminId, after: { method: 'totp' } },
    ]);

    // The same code on a session pending again: a replay.
    pend(h, admin);
    const replay = await admin.post(VERIFY, { code });
    expect(replay.statusCode).toBe(401);
    expect(codeOf(replay)).toBe('invalid_mfa_code');
    expect(pendingOf(h, admin)).toBe(true);

    // At the same clock the next step's code passes, and then the previous step's can't.
    const next = await admin.post(VERIFY, { code: harnessCode(h, 1) });
    expect(next.statusCode, next.body).toBe(200);
    expect(userRow(h, ADMIN.email).mfaLastStep).toBe(totpStep(now) + 1);
    pend(h, admin);
    for (const steps of [-1, 0, 1]) {
      const used = await admin.post(VERIFY, { code: harnessCode(h, steps) });
      expect(used.statusCode, `step ${String(steps)}`).toBe(401);
    }
    expect(events(h, 'auth.mfa_verified')).toHaveLength(2);
  });

  it("the enrollment code can't be used to verify", async () => {
    const h = harness();
    const admin = await h.setupAdmin({}, { mfa: 'as_stored' });
    const { secret } = await enrollThroughApi(h, admin);
    pend(h, admin);
    const code = totpAt(base32Decode(secret), h.clock.now());
    const replay = await admin.post(VERIFY, { code });
    expect(replay.statusCode).toBe(401);
    expect(codeOf(replay)).toBe('invalid_mfa_code');
    h.clock.advance(STEP_MS);
    const later = await admin.post(VERIFY, { code: totpAt(base32Decode(secret), h.clock.now()) });
    expect(later.statusCode, later.body).toBe(200);
  });
});

describe('concurrent replay', () => {
  it('two verifies with the same code at once: exactly one gives 200', async () => {
    const h = harness();
    const first = await h.setupAdmin();
    const second = await h.signIn(ADMIN.email, ADMIN.password);
    pend(h, first);
    pend(h, second);
    const code = harnessCode(h);
    const answers = await Promise.all([
      first.post(VERIFY, { code }),
      second.post(VERIFY, { code }),
    ]);
    expect(answers.map((a) => a.statusCode).sort()).toEqual([200, 401]);
    expect(answers.map((a) => (a.statusCode === 401 ? codeOf(a) : 'ok')).sort()).toEqual([
      'invalid_mfa_code',
      'ok',
    ]);
    expect(events(h, 'auth.mfa_verified')).toHaveLength(1);
  });
});

describe('recovery codes are single-use', () => {
  it('each code works once in any spelling, never for another user, and TOTP still works', async () => {
    const h = harness();
    const admin = await h.setupAdmin({}, { mfa: 'as_stored' });
    const adminId = admin.user?.id ?? '';
    const { secret, recoveryCodes } = await enrollThroughApi(h, admin);
    const carl = await carlSignedIn(h, admin, { mfa: 'as_stored' });
    const carlCodes = (await enrollThroughApi(h, carl)).recoveryCodes;

    pend(h, admin);
    const [first = '', ...rest] = recoveryCodes;
    const upper = await admin.post(VERIFY, { recoveryCode: first.toUpperCase() });
    expect(upper.statusCode, upper.body).toBe(200);
    expect(pendingOf(h, admin)).toBe(false);
    expect(events(h, 'auth.mfa_verified').at(-1)).toEqual({
      actorUserId: adminId,
      entityId: adminId,
      after: { method: 'recovery_code', remaining: 9 },
    });

    pend(h, admin);
    for (const reuse of [first, first.replace('-', ''), ` ${first.toUpperCase()} `]) {
      const again = await admin.post(VERIFY, { recoveryCode: reuse });
      expect(again.statusCode, reuse).toBe(401);
      expect(codeOf(again)).toBe('invalid_mfa_code');
      // Clear the run so the reuse checks don't lock the account.
      h.db.update(user).set({ failedSignIns: 0 }).where(eq(user.id, adminId)).run();
    }
    const others = await admin.post(VERIFY, { recoveryCode: carlCodes[0] ?? '' });
    expect(others.statusCode).toBe(401);
    expect(codeOf(others)).toBe('invalid_mfa_code');

    // The other nine, spelled every way the input allows.
    const spellings = [
      (c: string) => c.replace('-', ''),
      (c: string) => c.replace('-', ' '),
      (c: string) => ` ${c.toUpperCase()} `,
    ];
    for (const [i, code] of rest.entries()) {
      const spell = spellings[i % spellings.length] ?? ((c: string) => c);
      const used = await admin.post(VERIFY, { recoveryCode: spell(code) });
      expect(used.statusCode, used.body).toBe(200);
      expect(events(h, 'auth.mfa_verified').at(-1)?.after).toEqual({
        method: 'recovery_code',
        remaining: 8 - i,
      });
      pend(h, admin);
    }
    const all = h.db
      .select()
      .from(mfaRecoveryCode)
      .where(eq(mfaRecoveryCode.userId, adminId))
      .all();
    expect(all.every((row) => row.usedAt !== null)).toBe(true);
    // Carl's codes are untouched.
    const carlId = carl.user?.id ?? '';
    const carlRows = h.db
      .select()
      .from(mfaRecoveryCode)
      .where(eq(mfaRecoveryCode.userId, carlId))
      .all();
    expect(carlRows.every((row) => row.usedAt === null)).toBe(true);

    // With every code used, TOTP still works (at a step after the enrollment's).
    h.clock.advance(STEP_MS);
    const totp = await admin.post(VERIFY, { code: totpAt(base32Decode(secret), h.clock.now()) });
    expect(totp.statusCode, totp.body).toBe(200);
  });
});

describe('verify failures share the lockout', () => {
  it('counts with sign-in failures; the 5th ends every session and is audited', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const carl = await carlSignedIn(h, admin);
    const carlId = carl.user?.id ?? '';
    const other = await h.signIn(CARL.email, CARL.password);
    for (let i = 0; i < 2; i++) {
      const wrong = await h.client().post('/api/session', {
        email: CARL.email,
        password: 'not the password',
      });
      expect(wrong.statusCode).toBe(401);
    }
    pend(h, carl);
    const wrongCode = harnessCode(h, 5);
    for (let i = 0; i < 2; i++) {
      const wrong = await carl.post(VERIFY, { code: wrongCode });
      expect(wrong.statusCode).toBe(401);
      expect(errorEnvelopeSchema.parse(wrong.json()).error).toMatchObject({
        code: 'invalid_mfa_code',
        message: ERROR_MESSAGES.invalid_mfa_code,
      });
    }
    expect(userRow(h, CARL.email).failedSignIns).toBe(4);

    // A bad body is refused first and counts nothing.
    for (const body of [
      { code: '12345' },
      { code: '12a456' },
      { recoveryCode: 'abcde-fghjl' },
      { code: '123456', recoveryCode: 'abcde-fghjk' },
      {},
      undefined,
    ]) {
      const bad = await carl.post(VERIFY, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(userRow(h, CARL.email).failedSignIns).toBe(4);
    expect(events(h, 'auth.locked_out')).toEqual([]);

    const fifth = await carl.post(VERIFY, { code: wrongCode });
    expect(fifth.statusCode).toBe(401);
    expect(codeOf(fifth)).toBe('unauthenticated');
    expect(String(fifth.headers['set-cookie'])).toMatch(/rampart_session=;/);
    expect(carl.cookie).toBeNull();
    expect(sessionsOf(h, carlId)).toEqual([]);
    expect((await other.get('/api/users')).statusCode).toBe(401);
    expect(events(h, 'auth.locked_out')).toEqual([
      { actorUserId: null, entityId: carlId, after: null },
    ]);
    const locked = userRow(h, CARL.email);
    expect(locked.lockedUntil).not.toBeNull();

    // While locked, verify answers 429 and counts nothing, even with the right code.
    const made = createSession(h.db, carlId, h.clock.now());
    h.db.update(session).set({ mfaPending: true }).where(eq(session.id, made.id)).run();
    const stuck = h.client();
    stuck.cookie = made.token;
    stuck.csrfToken = made.csrfToken;
    const refused = await stuck.post(VERIFY, { code: harnessCode(h) });
    expect(refused.statusCode).toBe(429);
    expect(codeOf(refused)).toBe('too_many_attempts');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(userRow(h, CARL.email)).toMatchObject({
      failedSignIns: locked.failedSignIns,
      lockedUntil: locked.lockedUntil,
    });
    expect(events(h, 'auth.locked_out')).toHaveLength(1);

    // Once the lock ends, the right code verifies and the run starts again.
    h.clock.advance(15 * 60 * 1000);
    const after = await stuck.post(VERIFY, { code: harnessCode(h) });
    expect(after.statusCode, after.body).toBe(200);
    expect(userRow(h, CARL.email)).toMatchObject({ failedSignIns: 0, lockedUntil: null });
  });

  it('409 on a session that is not pending, or for a user not enrolled', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const notPending = await admin.post(VERIFY, { code: harnessCode(h) });
    expect(notPending.statusCode).toBe(409);
    expect(codeOf(notPending)).toBe('mfa_wrong_step');

    const carl = await carlSignedIn(h, admin, { mfa: 'as_stored' });
    pend(h, carl);
    for (const body of [{ code: harnessCode(h) }, { recoveryCode: 'abcde-fghjk' }]) {
      const unenrolled = await carl.post(VERIFY, body);
      expect(unenrolled.statusCode).toBe(409);
      expect(codeOf(unenrolled)).toBe('mfa_wrong_step');
    }
    // A pending secret alone is not an enrollment.
    await carl.post('/api/session/mfa/enroll');
    pend(h, carl);
    expect(codeOf(await carl.post(VERIFY, { code: '123456' }))).toBe('mfa_wrong_step');
    expect(userRow(h, CARL.email).failedSignIns).toBe(0);
    expect(userRow(h, ADMIN.email).failedSignIns).toBe(0);
  });
});

describe('undecryptable secret', () => {
  it('a secret sealed under another key is a 500 that logs the user id, never the secret', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const adminId = admin.user?.id ?? '';
    const sealed = encryptSecret(randomBytes(32), HARNESS_MFA_SECRET, `user:${adminId}`);
    h.db.update(user).set({ mfaSecretEnc: sealed }).where(eq(user.id, adminId)).run();
    pend(h, admin);
    h.logs.length = 0;

    const code = harnessCode(h);
    const response = await admin.post(VERIFY, { code });
    expect(response.statusCode).toBe(500);
    expect(codeOf(response)).toBe('internal_error');
    expect(response.body).not.toContain(HARNESS_MFA_SECRET);
    expect(userRow(h, ADMIN.email)).toMatchObject({ failedSignIns: 0, mfaLastStep: null });
    expect(pendingOf(h, admin)).toBe(true);

    const logged = JSON.stringify(h.logs);
    expect(h.logs.some((line) => line.userId === adminId)).toBe(true);
    for (const leak of [HARNESS_MFA_SECRET, HARNESS_MFA_SECRET.toLowerCase(), sealed, code]) {
      expect(logged).not.toContain(leak);
    }
    expect(logged).not.toContain(base32Decode(HARNESS_MFA_SECRET).toString('hex'));
  });

  it('confirm answers the same 500 for an undecryptable pending secret', async () => {
    const h = harness();
    const admin = await h.setupAdmin({}, { mfa: 'as_stored' });
    const adminId = admin.user?.id ?? '';
    await admin.post('/api/session/mfa/enroll');
    // Sealed to another user: the aad doesn't match.
    const sealed = encryptSecret(h.keys.mfaSecret, HARNESS_MFA_SECRET, 'user:someone-else');
    h.db.update(user).set({ mfaSecretEnc: sealed }).where(eq(user.id, adminId)).run();
    const response = await admin.post('/api/session/mfa/enroll/confirm', { code: harnessCode(h) });
    expect(response.statusCode).toBe(500);
    expect(codeOf(response)).toBe('internal_error');
    expect(userRow(h, ADMIN.email).mfaEnrolledAt).toBeNull();
    expect(h.logs.some((line) => line.userId === adminId)).toBe(true);
  });
});
