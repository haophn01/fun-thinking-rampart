import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, user } from '../../db/schema';
import { errorEnvelopeSchema } from '../contract';
import { ADMIN, createHarness, type Client, type Harness } from '../testing/harness';

const NOTICE_URL = '/api/settings/sign-in-notice';
const NOTICE = 'Authorised use only. Use of this system is monitored.';
const CARL = { email: 'carl@example.com', password: 'carl secret password' };

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** An app with an admin, a contributor Carl, and (unless `null`) a notice set. */
async function world(
  notice: string | null = NOTICE,
): Promise<{ h: Harness; admin: Client; carlId: string }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  const created = await admin.post('/api/users', {
    ...CARL,
    displayName: 'Carl',
    role: 'contributor',
  });
  expect(created.statusCode).toBe(201);
  // U1 makes an admin-set password temporary; these sign-ins post directly, so clear it here.
  const carlId = created.json<{ user: { id: string } }>().user.id;
  h.db.update(user).set({ mustChangePassword: false }).where(eq(user.id, carlId)).run();
  if (notice !== null) {
    const set = await admin.put(NOTICE_URL, { text: notice });
    expect(set.statusCode).toBe(200);
  }
  return { h, admin, carlId };
}

function signIn(h: Harness, body: Record<string, unknown>) {
  return h.client().post('/api/session', body);
}

function events(h: Harness) {
  return h.db.select().from(auditEvent).orderBy(asc(auditEvent.id)).all();
}

function failures(h: Harness, carlId: string): number {
  return h.db.select().from(user).where(eq(user.id, carlId)).get()?.failedSignIns ?? -1;
}

function codeOf(body: string): string {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error.code;
}

describe('session reports the notice', () => {
  it('sends the text and its SHA-256 digest signed out and signed in', async () => {
    const { h, admin } = await world();
    const expected = { text: NOTICE, digest: sha256(NOTICE) };

    const signedOut = await h.client().get('/api/session');
    expect(signedOut.statusCode).toBe(200);
    expect(signedOut.json()).toMatchObject({ user: null, signInNotice: expected });

    const signedIn = await admin.get('/api/session');
    expect(signedIn.json()).toMatchObject({
      user: { email: ADMIN.email },
      signInNotice: expected,
    });
  });

  it('sends it on the sign-in answer too', async () => {
    const { h } = await world();
    const response = await signIn(h, { ...CARL, noticeDigest: sha256(NOTICE) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      signInNotice: { text: NOTICE, digest: sha256(NOTICE) },
    });
  });

  it('sends null when no notice is set', async () => {
    const { h, admin } = await world(null);
    expect((await h.client().get('/api/session')).json()).toMatchObject({ signInNotice: null });
    expect((await admin.get('/api/session')).json()).toMatchObject({ signInNotice: null });
  });
});

describe('sign-in needs the current acknowledgement', () => {
  it('refuses a missing digest with 400, counting no failure and writing no event', async () => {
    const { h, carlId } = await world();
    const before = events(h).length;

    const right = await signIn(h, CARL);
    expect(right.statusCode).toBe(400);
    expect(codeOf(right.body)).toBe('notice_not_acknowledged');
    expect(right.headers['set-cookie']).toBeUndefined();

    const wrong = await signIn(h, { ...CARL, password: 'not the password' });
    expect(wrong.statusCode).toBe(400);
    expect(codeOf(wrong.body)).toBe('notice_not_acknowledged');

    expect(failures(h, carlId)).toBe(0);
    expect(events(h)).toHaveLength(before);
  });

  it('refuses the digest of a notice that has since changed', async () => {
    const { h, admin, carlId } = await world();
    const stale = sha256(NOTICE);
    expect((await admin.put(NOTICE_URL, { text: `${NOTICE} Updated.` })).statusCode).toBe(200);
    const before = events(h).length;

    for (const password of [CARL.password, 'not the password']) {
      const response = await signIn(h, { ...CARL, password, noticeDigest: stale });
      expect(response.statusCode).toBe(400);
      expect(codeOf(response.body)).toBe('notice_not_acknowledged');
    }
    expect(failures(h, carlId)).toBe(0);
    expect(events(h)).toHaveLength(before);
  });

  it('asks for the notice before reporting a locked account', async () => {
    const { h, carlId } = await world();
    const digest = sha256(NOTICE);
    for (let i = 0; i < 5; i += 1) {
      await signIn(h, { ...CARL, password: 'not the password', noticeDigest: digest });
    }
    expect(failures(h, carlId)).toBe(5);
    const locked = await signIn(h, CARL);
    expect(locked.statusCode).toBe(400);
    expect(codeOf(locked.body)).toBe('notice_not_acknowledged');
    const acknowledged = await signIn(h, { ...CARL, noticeDigest: digest });
    expect(acknowledged.statusCode).toBe(429);
  });

  it('still counts a wrong password once the notice is acknowledged', async () => {
    const { h, carlId } = await world();
    const response = await signIn(h, {
      ...CARL,
      password: 'not the password',
      noticeDigest: sha256(NOTICE),
    });
    expect(response.statusCode).toBe(401);
    expect(failures(h, carlId)).toBe(1);
  });
});

describe('each acknowledgement is audited', () => {
  it('writes auth.notice_acknowledged then auth.signed_in, every sign-in', async () => {
    const { h, carlId } = await world();
    const digest = sha256(NOTICE);
    const before = events(h).length;

    for (let i = 0; i < 2; i += 1) {
      const response = await signIn(h, { ...CARL, noticeDigest: digest });
      expect(response.statusCode).toBe(200);
    }

    const added = events(h).slice(before);
    expect(added.map((event) => event.action)).toEqual([
      'auth.notice_acknowledged',
      'auth.signed_in',
      'auth.notice_acknowledged',
      'auth.signed_in',
    ]);
    const ids = added.map((event) => event.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    for (const event of added.filter((e) => e.action === 'auth.notice_acknowledged')) {
      expect(event).toMatchObject({
        actorUserId: carlId,
        entityType: 'user',
        entityId: carlId,
        before: null,
      });
      expect(JSON.parse(event.after ?? 'null')).toEqual({ digest });
    }
  });
});

describe('no notice, no gate', () => {
  it('ignores a sent digest when no notice is set', async () => {
    const { h } = await world(null);
    const before = events(h).length;
    const response = await signIn(h, { ...CARL, noticeDigest: sha256('anything at all') });
    expect(response.statusCode).toBe(200);
    expect(
      events(h)
        .slice(before)
        .map((event) => event.action),
    ).toEqual(['auth.signed_in']);
    expect((await signIn(h, CARL)).statusCode).toBe(200);
  });

  it('opens sign-in again once the notice is turned off', async () => {
    const { h, admin } = await world();
    expect((await admin.put(NOTICE_URL, { text: null })).statusCode).toBe(200);
    expect((await signIn(h, CARL)).statusCode).toBe(200);
  });

  it('never gates setup, and setup reports no notice', async () => {
    const h = createHarness();
    harnesses.push(h);
    const response = await h.client().post('/api/setup', ADMIN);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ signInNotice: null });
  });
});
