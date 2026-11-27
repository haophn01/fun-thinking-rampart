import { createHash } from 'node:crypto';
import { asc } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, settings } from '../../db/schema';
import { errorEnvelopeSchema, signInNoticeResponseSchema } from '../contract';
import { ROUTE_MATRIX } from '../security/route-matrix';
import { createHarness, type Client, type Harness } from '../testing/harness';

const URL = '/api/settings/sign-in-notice';
const NOTICE = 'This system is for authorised use only.\nActivity is monitored.';
const CARL = { email: 'carl@example.com', password: 'carl secret password' };

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  return { h, admin };
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function settingsEvents(h: Harness) {
  return h.db
    .select()
    .from(auditEvent)
    .orderBy(asc(auditEvent.id))
    .all()
    .filter((event) => event.action === 'settings.updated');
}

function codeOf(body: string): string {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error.code;
}

describe('admin sets the notice', () => {
  it('saves the text, answers it with its digest and audits before and after', async () => {
    const { h, admin } = await world();
    const response = await admin.put(URL, { text: `  ${NOTICE}\n ` });
    expect(response.statusCode).toBe(200);
    expect(signInNoticeResponseSchema.parse(response.json())).toEqual({
      signInNotice: { text: NOTICE, digest: sha256(NOTICE) },
    });

    const row = h.db.select().from(settings).get();
    expect(row?.id).toBe(1);
    expect(row?.signInNotice).toBe(NOTICE);
    expect(row?.updatedBy).toBe(admin.user?.id);

    const events = settingsEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: admin.user?.id,
      entityType: 'settings',
      entityId: 'sign_in_notice',
    });
    expect(JSON.parse(events[0]?.before ?? 'null')).toEqual({ signInNotice: null });
    expect(JSON.parse(events[0]?.after ?? 'null')).toEqual({ signInNotice: NOTICE });
  });

  it('gives 200 with no event when the same text (after trimming) is saved again', async () => {
    const { h, admin } = await world();
    await admin.put(URL, { text: NOTICE });
    h.clock.advance(60_000);
    const again = await admin.put(URL, { text: `\n${NOTICE}  ` });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ signInNotice: { text: NOTICE, digest: sha256(NOTICE) } });
    expect(settingsEvents(h)).toHaveLength(1);
  });

  it('turns the notice off with null, and audits the change', async () => {
    const { h, admin } = await world();
    await admin.put(URL, { text: NOTICE });
    const off = await admin.put(URL, { text: null });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ signInNotice: null });
    expect(h.db.select().from(settings).get()?.signInNotice).toBeNull();

    const events = settingsEvents(h);
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1]?.before ?? 'null')).toEqual({ signInNotice: NOTICE });
    expect(JSON.parse(events[1]?.after ?? 'null')).toEqual({ signInNotice: null });
    const session = await h.client().get('/api/session');
    expect(session.json()).toMatchObject({ signInNotice: null });
  });

  it('saves whitespace as null; off while already off is a no-op', async () => {
    const { h, admin } = await world();
    const blank = await admin.put(URL, { text: ' \n\t ' });
    expect(blank.statusCode).toBe(200);
    expect(blank.json()).toEqual({ signInNotice: null });
    expect(settingsEvents(h)).toHaveLength(0);
    expect(h.db.select().from(settings).all()).toHaveLength(0);

    await admin.put(URL, { text: NOTICE });
    const cleared = await admin.put(URL, { text: '   ' });
    expect(cleared.json()).toEqual({ signInNotice: null });
    expect(settingsEvents(h)).toHaveLength(2);
  });

  it('takes 4000 characters, trimmed, and refuses 4001 with nothing changed', async () => {
    const { h, admin } = await world();
    const longest = 'a'.repeat(3999) + 'b';
    const ok = await admin.put(URL, { text: `  ${longest}  ` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ signInNotice: { text: longest } });

    const tooLong = await admin.put(URL, { text: `${longest}c` });
    expect(tooLong.statusCode).toBe(400);
    expect(codeOf(tooLong.body)).toBe('validation_failed');
    expect(h.db.select().from(settings).get()?.signInNotice).toBe(longest);
    expect(settingsEvents(h)).toHaveLength(1);
  });

  it('refuses a body without the text key or with extra keys', async () => {
    const { h, admin } = await world();
    for (const body of [{}, { text: NOTICE, extra: true }, { text: 7 }]) {
      const response = await admin.put(URL, body);
      expect(response.statusCode).toBe(400);
    }
    expect(settingsEvents(h)).toHaveLength(0);
  });

  it('digests the UTF-8 bytes of the text', async () => {
    const { admin } = await world();
    const text = 'Utilisation réservée — 認可';
    const response = await admin.put(URL, { text });
    expect(response.json()).toEqual({ signInNotice: { text, digest: sha256(text) } });
  });
});

describe('notice route access', () => {
  it('refuses a contributor (403), the signed out (401) and a missing CSRF token (403)', async () => {
    const { h, admin } = await world();
    const created = await admin.post('/api/users', {
      ...CARL,
      displayName: 'Carl',
      role: 'contributor',
    });
    expect(created.statusCode).toBe(201);
    const carl = await h.signIn(CARL.email, CARL.password);

    const contributor = await carl.put(URL, { text: NOTICE });
    expect(contributor.statusCode).toBe(403);
    expect(codeOf(contributor.body)).toBe('forbidden');

    const signedOut = await h.client().put(URL, { text: NOTICE });
    expect(signedOut.statusCode).toBe(401);
    expect(codeOf(signedOut.body)).toBe('unauthenticated');

    const noCsrf = await admin.put(URL, { text: NOTICE }, { headers: { 'x-csrf-token': null } });
    expect(noCsrf.statusCode).toBe(403);
    expect(codeOf(noCsrf.body)).toBe('csrf_failed');

    expect(h.db.select().from(settings).all()).toHaveLength(0);
    expect(settingsEvents(h)).toHaveLength(0);
  });

  it('has its matrix entry: admin, with no row id to swap', () => {
    expect(ROUTE_MATRIX[`PUT ${URL}`]).toMatchObject({
      access: 'admin',
      sample: { url: URL },
      idor: { notApplicable: 'one global setting' },
    });
  });
});
