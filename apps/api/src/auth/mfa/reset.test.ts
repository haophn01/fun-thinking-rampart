import { asc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, mfaRecoveryCode, session, user } from '../../../db/schema';
import {
  errorEnvelopeSchema,
  mfaEnrolledResponseSchema,
  mfaEnrollmentResponseSchema,
  sessionResponseSchema,
  userResponseSchema,
} from '../../contract';
import { ADMIN, createHarness, type Client, type Harness } from '../../testing/harness';
import { base32Decode } from './base32';
import { resetMfa } from './reset';
import { totpAt } from './totp';

const CARL = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'contributor password',
} as const;
const DANA = { ...CARL, email: 'dana@example.com', displayName: 'Dana Contributor' } as const;
const NO_ROW = '00000000-0000-4000-8000-000000000000';

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

function userRow(h: Harness, id: string) {
  const row = h.db.select().from(user).where(eq(user.id, id)).get();
  if (!row) throw new Error(`no user ${id}`);
  return row;
}

function sessionsOf(h: Harness, userId: string) {
  return h.db.select().from(session).where(eq(session.userId, userId)).all();
}

function codesOf(h: Harness, userId: string) {
  return h.db.select().from(mfaRecoveryCode).where(eq(mfaRecoveryCode.userId, userId)).all();
}

function resets(h: Harness) {
  return h.db
    .select()
    .from(auditEvent)
    .orderBy(asc(auditEvent.id))
    .all()
    .filter((event) => event.action === 'user.mfa_reset')
    .map((event) => ({
      actorUserId: event.actorUserId,
      entityType: event.entityType,
      entityId: event.entityId,
      before: JSON.parse(event.before ?? 'null') as unknown,
      after: JSON.parse(event.after ?? 'null') as unknown,
      requestId: event.requestId,
    }));
}

async function enrollThroughApi(h: Harness, c: Client): Promise<void> {
  const started = await c.post('/api/session/mfa/enroll');
  const { secret } = mfaEnrollmentResponseSchema.parse(started.json());
  const confirmed = await c.post('/api/session/mfa/enroll/confirm', {
    code: totpAt(base32Decode(secret), h.clock.now()),
  });
  mfaEnrolledResponseSchema.parse(confirmed.json());
}

const resetUrl = (id: string) => `/api/users/${id}/mfa/reset`;

describe('admin reset is audited and signs out everywhere', () => {
  it("clears a user's MFA and codes, ends their sessions and writes user.mfa_reset", async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const adminId = admin.user?.id ?? '';
    expect((await admin.post('/api/users', CARL)).statusCode).toBe(201);
    expect((await admin.post('/api/users', DANA)).statusCode).toBe(201);
    const carl = await h.signIn(CARL.email, CARL.password, { mfa: 'as_stored' });
    const carlId = carl.user?.id ?? '';
    await enrollThroughApi(h, carl);
    await h.signIn(CARL.email, CARL.password);
    expect(sessionsOf(h, carlId)).toHaveLength(2);
    expect(codesOf(h, carlId)).toHaveLength(10);

    // A contributor can't reset anyone, and the refusal changes nothing.
    const dana = await h.signIn(DANA.email, DANA.password);
    const refused = await dana.post(resetUrl(carlId));
    expect(refused.statusCode).toBe(403);
    expect(codeOf(refused)).toBe('forbidden');
    expect(userRow(h, carlId).mfaEnrolledAt).not.toBeNull();

    const response = await admin.post(resetUrl(carlId));
    expect(response.statusCode, response.body).toBe(200);
    expect(userResponseSchema.parse(response.json()).user).toMatchObject({
      id: carlId,
      mfaEnrolled: false,
    });
    expect(userRow(h, carlId)).toMatchObject({
      mfaSecretEnc: null,
      mfaLastStep: null,
      mfaEnrolledAt: null,
    });
    expect(codesOf(h, carlId)).toEqual([]);
    expect(sessionsOf(h, carlId)).toEqual([]);
    expect((await carl.get('/api/users')).statusCode).toBe(401);
    // The caller is someone else: their session and cookie stay.
    expect(response.headers['set-cookie']).toBeUndefined();
    expect((await admin.get('/api/users')).statusCode).toBe(200);
    expect(sessionsOf(h, adminId)).toHaveLength(1);
    expect(resets(h)).toEqual([
      {
        actorUserId: adminId,
        entityType: 'user',
        entityId: carlId,
        before: { mfaEnrolled: true },
        after: { mfaEnrolled: false },
        requestId: expect.any(String) as string,
      },
    ]);

    // Nothing stored any more: 200, no event, and a new session isn't ended.
    const carlAgain = await h.signIn(CARL.email, CARL.password, { mfa: 'as_stored' });
    const second = await admin.post(resetUrl(carlId));
    expect(second.statusCode).toBe(200);
    expect(userResponseSchema.parse(second.json()).user.mfaEnrolled).toBe(false);
    expect(resets(h)).toHaveLength(1);
    // That session wasn't ended: it waits for enrollment, and still has its user.
    const gated = await carlAgain.get('/api/users');
    expect(gated.statusCode).toBe(403);
    expect(codeOf(gated)).toBe('mfa_required');
    const status = sessionResponseSchema.parse((await carlAgain.get('/api/session')).json());
    expect(status.user?.id).toBe(carlId);

    const unknown = await admin.post(resetUrl(NO_ROW));
    expect(unknown.statusCode).toBe(404);
    expect(codeOf(unknown)).toBe('not_found');
  });

  it('a reset of your own also clears the cookie and ends your other sessions', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const adminId = admin.user?.id ?? '';
    const otherTab = await h.signIn(ADMIN.email, ADMIN.password);
    const response = await admin.post(resetUrl(adminId));
    expect(response.statusCode, response.body).toBe(200);
    expect(userResponseSchema.parse(response.json()).user.mfaEnrolled).toBe(false);
    expect(String(response.headers['set-cookie'])).toMatch(/rampart_session=;/);
    expect(admin.cookie).toBeNull();
    expect(sessionsOf(h, adminId)).toEqual([]);
    expect((await otherTab.get('/api/users')).statusCode).toBe(401);
    expect(resets(h)).toHaveLength(1);
  });

  it('a pending secret alone is cleared, signs the user out and is audited', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const adminId = admin.user?.id ?? '';
    expect((await admin.post('/api/users', CARL)).statusCode).toBe(201);
    const carl = await h.signIn(CARL.email, CARL.password, { mfa: 'as_stored' });
    const carlId = carl.user?.id ?? '';
    expect((await carl.post('/api/session/mfa/enroll')).statusCode).toBe(200);

    const response = await admin.post(resetUrl(carlId));
    expect(response.statusCode).toBe(200);
    expect(userRow(h, carlId).mfaSecretEnc).toBeNull();
    expect(sessionsOf(h, carlId)).toEqual([]);
    expect(resets(h)).toEqual([
      expect.objectContaining({
        actorUserId: adminId,
        entityId: carlId,
        before: { mfaEnrolled: false, pendingSetup: true },
        after: { mfaEnrolled: false, pendingSetup: false },
      }),
    ]);
  });

  it('resetMfa, as the CLI calls it: a null actor and request id, and whether anything changed', async () => {
    const h = harness();
    const admin = await h.setupAdmin();
    const adminId = admin.user?.id ?? '';
    const now = h.clock.now();
    const reset = () =>
      h.db.transaction((tx) => resetMfa(tx, adminId, { actorUserId: null, requestId: null, now }));
    expect(reset()).toBe(true);
    expect(reset()).toBe(false);
    expect(
      h.db.transaction((tx) => resetMfa(tx, NO_ROW, { actorUserId: null, requestId: null, now })),
    ).toBe(false);
    expect(resets(h)).toEqual([
      {
        actorUserId: null,
        entityType: 'user',
        entityId: adminId,
        before: { mfaEnrolled: true },
        after: { mfaEnrolled: false },
        requestId: null,
      },
    ]);
    expect(sessionsOf(h, adminId)).toEqual([]);
  });
});
