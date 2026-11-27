// MFA required for every user (A2): sign-in and setup leave a pending session, and the guard
// answers 403 `mfa_required` everywhere but the lock and MFA routes until the user enrolls or
// enters a code.
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { session, user } from '../../../db/schema';
import {
  assessmentViewSchema,
  errorEnvelopeSchema,
  mfaEnrolledResponseSchema,
  mfaEnrollmentResponseSchema,
  sessionResponseSchema,
  type MfaState,
} from '../../contract';
import { ADMIN, createHarness, type Client, type Harness } from '../../testing/harness';
import { tokenDigest } from '../sessions';
import { base32Decode } from './base32';
import { totpAt } from './totp';

const STEP_MS = 30_000;
const CARL = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'contributor password',
} as const;
const OBJECTIVE = `/api/assessment/objectives/${encodeURIComponent('3.1.1[a]')}`;

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

/** The `mfa` field exactly as the api sent it (no schema default filling it in). */
function rawMfa(response: LightMyRequestResponse): unknown {
  return response.json<{ mfa?: unknown }>().mfa;
}

async function mfaOf(c: Client): Promise<MfaState> {
  const response = await c.get('/api/session');
  expect(response.statusCode).toBe(200);
  return sessionResponseSchema.parse(response.json()).mfa;
}

/** Signs in through the api only, leaving the session as sign-in made it. */
async function passwordOnly(h: Harness, email: string, password: string) {
  const c = h.client();
  const response = await c.post('/api/session', { email, password });
  expect(response.statusCode, response.body).toBe(200);
  return { c, response };
}

/** Enrolls the client's user through the api; the secret and the confirm answer. */
async function enrollThroughApi(h: Harness, c: Client) {
  const started = await c.post('/api/session/mfa/enroll');
  expect(started.statusCode, started.body).toBe(200);
  const { secret } = mfaEnrollmentResponseSchema.parse(started.json());
  const confirmed = await c.post('/api/session/mfa/enroll/confirm', {
    code: totpAt(base32Decode(secret), h.clock.now()),
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return { secret, confirmed };
}

/** Every gated request: a guarded read, a contributor write, an admin read and an admin write. */
async function expectGated(c: Client, label: string): Promise<void> {
  const tries: [string, () => Promise<LightMyRequestResponse>][] = [
    ['GET /api/assessment', () => c.get('/api/assessment')],
    ['PUT objective', () => c.put(OBJECTIVE, { status: 'met', note: null })],
    ['GET /api/users', () => c.get('/api/users')],
    ['GET /api/audit', () => c.get('/api/audit')],
    ['POST /api/users', () => c.post('/api/users', { ...CARL, email: 'x@example.com' })],
    ['POST /api/session/password', () => c.post('/api/session/password', {})],
  ];
  for (const [name, send] of tries) {
    const response = await send();
    expect(response.statusCode, `${label}: ${name}`).toBe(403);
    expect(codeOf(response), `${label}: ${name}`).toBe('mfa_required');
  }
}

describe('sign-in waits for the code', () => {
  it('gives challenge, gates every guarded route, and verify makes a new full session', async () => {
    const h = harness();
    await h.setupAdmin(); // enrolled with the harness secret
    const { c, response } = await passwordOnly(h, ADMIN.email, ADMIN.password);
    expect(rawMfa(response)).toBe('challenge');
    const signedIn = sessionResponseSchema.parse(response.json());
    // A pending session still gets its user and CSRF token.
    expect(signedIn.user?.email).toBe(ADMIN.email);
    expect(signedIn.csrfToken).toEqual(expect.any(String));
    expect(await mfaOf(c)).toBe('challenge');
    await expectGated(c, 'pending');

    // Lock and unlock work while pending, and the state survives them.
    expect((await c.post('/api/session/lock')).statusCode).toBe(204);
    expect(codeOf(await c.get('/api/assessment'))).toBe('session_locked');
    const unlocked = await c.post('/api/session/unlock', { password: ADMIN.password });
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    expect(rawMfa(unlocked)).toBe('challenge');
    expect(codeOf(await c.get('/api/assessment'))).toBe('mfa_required');

    const before = c.cookie;
    const verified = await c.post('/api/session/mfa/verify', { code: h.totp(ADMIN.email) });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(rawMfa(verified)).toBe('none');
    expect(c.cookie).not.toBeNull();
    expect(c.cookie).not.toBe(before);
    expect(await mfaOf(c)).toBe('none');
    expect((await c.get('/api/assessment')).statusCode).toBe(200);
    expect((await c.get('/api/users')).statusCode).toBe(200);
    expect((await c.put(OBJECTIVE, { status: 'met', note: null })).statusCode).toBe(200);
  });

  it('signs out from a pending session', async () => {
    const h = harness();
    await h.setupAdmin();
    const { c } = await passwordOnly(h, ADMIN.email, ADMIN.password);
    expect((await c.delete('/api/session')).statusCode).toBe(204);
    expect(c.cookie).toBeNull();
    expect(h.db.select().from(session).all()).toHaveLength(1); // only setupAdmin's own session
  });

  it('a second sign-in while full gives a new pending session, not the old full one', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const again = await admin.post('/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    expect(again.statusCode).toBe(200);
    expect(rawMfa(again)).toBe('challenge');
    expect(codeOf(await admin.get('/api/assessment'))).toBe('mfa_required');
  });

  it('a pending session still ends after 30 min idle', async () => {
    const h = harness();
    await h.setupAdmin();
    const { c } = await passwordOnly(h, ADMIN.email, ADMIN.password);
    h.clock.advance(30 * 60_000);
    const late = await c.post('/api/session/mfa/verify', { code: h.totp(ADMIN.email) });
    expect(late.statusCode).toBe(401);
    expect(codeOf(late)).toBe('unauthenticated');
  });
});

describe('every user must enroll', () => {
  it('setup gives enroll; only the MFA and lock routes answer; confirm makes it none', async () => {
    const h = harness();
    const c = h.client();
    const created = await c.post('/api/setup', ADMIN);
    expect(created.statusCode).toBe(201);
    expect(rawMfa(created)).toBe('enroll');
    expect(await mfaOf(c)).toBe('enroll');
    await expectGated(c, 'enroll');

    expect((await c.post('/api/session/lock')).statusCode).toBe(204);
    const unlocked = await c.post('/api/session/unlock', { password: ADMIN.password });
    expect(unlocked.statusCode).toBe(200);
    expect(rawMfa(unlocked)).toBe('enroll');
    // Verify answers its own state check, not the gate.
    expect(codeOf(await c.post('/api/session/mfa/verify', { code: '123456' }))).toBe(
      'mfa_wrong_step',
    );

    const { confirmed } = await enrollThroughApi(h, c);
    expect(rawMfa(confirmed)).toBe('none');
    expect(mfaEnrolledResponseSchema.parse(confirmed.json()).recoveryCodes).toHaveLength(10);
    expect(await mfaOf(c)).toBe('none');
    expect((await c.get('/api/assessment')).statusCode).toBe(200);
    expect((await c.post('/api/users', CARL)).statusCode).toBe(201);
  });

  it("an unenrolled user's sign-in gives enroll", async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    expect((await admin.post('/api/users', CARL)).statusCode).toBe(201);
    h.db.update(user).set({ mustChangePassword: false }).where(eq(user.email, CARL.email)).run();
    const { c, response } = await passwordOnly(h, CARL.email, CARL.password);
    expect(rawMfa(response)).toBe('enroll');
    await expectGated(c, 'carl enroll');
    await enrollThroughApi(h, c);
    expect((await c.get('/api/assessment')).statusCode).toBe(200);
  });

  it('a second session made while unenrolled asks for the code once the user enrolls', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    expect((await admin.post('/api/users', CARL)).statusCode).toBe(201);
    h.db.update(user).set({ mustChangePassword: false }).where(eq(user.email, CARL.email)).run();
    const first = await passwordOnly(h, CARL.email, CARL.password);
    const second = await passwordOnly(h, CARL.email, CARL.password);
    await enrollThroughApi(h, first.c);
    expect(await mfaOf(second.c)).toBe('challenge');
    expect(codeOf(await second.c.get('/api/assessment'))).toBe('mfa_required');
  });
});

describe('existing account enrolls at next use and keeps its data', () => {
  /** Puts the admin back as a pre-sprint database had it: no MFA columns, a full session. */
  function asBeforeThisSprint(h: Harness, c: Client): void {
    h.db
      .update(user)
      .set({ mfaSecretEnc: null, mfaLastStep: null, mfaEnrolledAt: null })
      .where(eq(user.email, ADMIN.email))
      .run();
    if (c.cookie === null) throw new Error('no session');
    h.db
      .update(session)
      .set({ mfaPending: false })
      .where(eq(session.id, tokenDigest(c.cookie)))
      .run();
  }

  it('reads enroll, enrolls, reads its assessment unchanged and still signs in', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const written = await admin.put(OBJECTIVE, { status: 'met', note: 'kept across the change' });
    expect(written.statusCode).toBe(200);
    const before = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    asBeforeThisSprint(h, admin);

    expect(await mfaOf(admin)).toBe('enroll');
    expect(codeOf(await admin.get('/api/assessment'))).toBe('mfa_required');
    await enrollThroughApi(h, admin);
    const after = assessmentViewSchema.parse((await admin.get('/api/assessment')).json());
    expect(after).toEqual(before);

    h.clock.advance(STEP_MS);
    const { c, response } = await passwordOnly(h, ADMIN.email, ADMIN.password);
    expect(rawMfa(response)).toBe('challenge');
    expect(
      (await c.post('/api/session/mfa/verify', { code: h.totp(ADMIN.email) })).statusCode,
    ).toBe(200);
    expect(assessmentViewSchema.parse((await c.get('/api/assessment')).json())).toEqual(before);
  });

  it('an old full session of an unenrolled user never skips the code once they enroll elsewhere', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const other = await h.signIn(ADMIN.email, ADMIN.password);
    asBeforeThisSprint(h, admin);
    asBeforeThisSprint(h, other);
    expect(await mfaOf(other)).toBe('enroll');
    await enrollThroughApi(h, admin);
    expect(await mfaOf(other)).toBe('challenge');
    expect(codeOf(await other.get('/api/assessment'))).toBe('mfa_required');
  });
});

describe('reset forces re-enrollment', () => {
  it("after an admin reset the user's next sign-in reads enroll", async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const created = await admin.post('/api/users', CARL);
    expect(created.statusCode).toBe(201);
    const carlId = created.json<{ user: { id: string } }>().user.id;
    const carl = await h.signIn(CARL.email, CARL.password);
    expect(await mfaOf(carl)).toBe('none');

    const reset = await admin.post(`/api/users/${carlId}/mfa/reset`);
    expect(reset.statusCode, reset.body).toBe(200);
    expect((await carl.get('/api/assessment')).statusCode).toBe(401);

    const { c, response } = await passwordOnly(h, CARL.email, CARL.password);
    expect(rawMfa(response)).toBe('enroll');
    expect(codeOf(await c.get('/api/assessment'))).toBe('mfa_required');
  });
});
