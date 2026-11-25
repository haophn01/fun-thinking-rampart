import { createHash } from 'node:crypto';
import { catalogKey, loadCatalog } from '@rampart/catalog';
import { asc } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { assessment, auditEvent, session, user } from '../../db/schema';
import { errorEnvelopeSchema, sessionResponseSchema } from '../contract';
import { ADMIN, START, createHarness, type Harness } from '../testing/harness';

const harnesses: Harness[] = [];
function harness(...args: Parameters<typeof createHarness>): Harness {
  const h = createHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

describe('first run setup', () => {
  it('creates the admin and the self assessment, audits both and signs the admin in', async () => {
    const h = harness();
    const anon = h.client();
    const before = await anon.get('/api/session');
    expect(before.statusCode).toBe(200);
    expect(sessionResponseSchema.parse(before.json())).toEqual({
      setupRequired: true,
      user: null,
      csrfToken: null,
    });

    const c = h.client();
    const response = await c.post('/api/setup', {
      email: '  Ada@Example.COM ',
      displayName: ' Ada Admin ',
      password: ADMIN.password,
    });
    expect(response.statusCode).toBe(201);
    const body = sessionResponseSchema.parse(response.json());
    expect(body.setupRequired).toBe(false);
    expect(body.user).toEqual({
      id: expect.any(String) as string,
      email: 'ada@example.com',
      displayName: 'Ada Admin',
      role: 'admin',
    });
    expect(body.csrfToken).toEqual(expect.any(String));

    const cookie = response.cookies.find((item) => item.name === 'rampart_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 43200 });
    expect(String(response.headers['set-cookie'])).not.toMatch(/secure/i);

    const users = h.db.select().from(user).all();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: 'ada@example.com', role: 'admin', active: true });
    expect(users[0]?.createdAt).toBe(START.toISOString());

    const assessments = h.db.select().from(assessment).all();
    expect(assessments).toHaveLength(1);
    expect(assessments[0]).toMatchObject({
      type: 'self',
      catalogVersion: catalogKey(loadCatalog()),
      conditionalStatusDate: null,
    });

    const events = h.db.select().from(auditEvent).orderBy(asc(auditEvent.id)).all();
    expect(events.map((event) => [event.action, event.entityType, event.entityId])).toEqual([
      ['user.created', 'user', users[0]?.id],
      ['assessment.created', 'assessment', assessments[0]?.id],
    ]);
    for (const event of events) {
      expect(event.actorUserId).toBe(users[0]?.id);
      expect(event.before).toBeNull();
      expect(event.at).toBe(START.toISOString());
    }
    expect(JSON.parse(events[0]?.after ?? 'null')).toEqual({
      email: 'ada@example.com',
      displayName: 'Ada Admin',
      role: 'admin',
      active: true,
    });

    // The cookie is a live session, and setup is now done for everyone.
    const mine = sessionResponseSchema.parse((await c.get('/api/session')).json());
    expect(mine.user?.email).toBe('ada@example.com');
    expect(mine.csrfToken).toBe(body.csrfToken);
    const theirs = sessionResponseSchema.parse((await anon.get('/api/session')).json());
    expect(theirs).toEqual({ setupRequired: false, user: null, csrfToken: null });

    // A second call is refused and changes nothing.
    const again = await h.client().post('/api/setup', {
      email: 'other@example.com',
      displayName: 'Other',
      password: 'another long password',
    });
    expect(again.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(again.json()).error.code).toBe('setup_complete');
    expect(h.db.select().from(user).all()).toHaveLength(1);
    expect(h.db.select().from(auditEvent).all()).toHaveLength(2);
  });

  it('keeps an existing assessment instead of adding one', async () => {
    const h = harness();
    h.db.insert(assessment).values({ id: 'existing', catalogVersion: 'old@0.0.1' }).run();
    await h.setupAdmin();
    const rows = h.db.select().from(assessment).all();
    expect(rows.map((row) => row.id)).toEqual(['existing']);
    const actions = h.db
      .select()
      .from(auditEvent)
      .all()
      .map((event) => event.action);
    expect(actions).toEqual(['user.created']);
  });

  it('rejects a short password and a bad email with 400 and creates nothing', async () => {
    const h = harness();
    for (const body of [
      { ...ADMIN, password: 'x'.repeat(11) },
      { ...ADMIN, email: 'not-an-email' },
      { ...ADMIN, displayName: '   ' },
      { ...ADMIN, role: 'admin' },
    ]) {
      const response = await h.client().post('/api/setup', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('validation_failed');
    }
    expect(h.db.select().from(user).all()).toHaveLength(0);
    expect(h.db.select().from(assessment).all()).toHaveLength(0);
  });
});

describe('secrets never leave', () => {
  it('stores an argon2id hash and the token hash, and leaks neither password nor token', async () => {
    const h = harness({ logLevel: 'trace' });
    const c = await h.setupAdmin();
    await c.get('/api/session');
    await c.get('/api/users');
    await c.post('/api/users', {
      email: 'carl@example.com',
      displayName: 'Carl',
      role: 'contributor',
      password: 'carl secret password',
    });
    const carl = await h.signIn('carl@example.com', 'carl secret password');
    const carlId = carl.user?.id ?? '';
    await c.patch(`/api/users/${carlId}`, { password: 'carl newer password' });
    await h.client().post('/api/session', { email: ADMIN.email, password: 'wrong password!' });
    await c.get('/api/audit');

    const token = c.cookie ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = h.db.select().from(user).all();
    for (const row of stored) expect(row.passwordHash).toMatch(/^\$argon2id\$/);

    const sessions = h.db.select().from(session).all();
    const digest = createHash('sha256').update(token).digest('hex');
    expect(sessions.map((row) => row.id)).toContain(digest);
    expect(JSON.stringify(sessions)).not.toContain(token);

    const secrets = [
      ADMIN.password,
      'carl secret password',
      'carl newer password',
      'wrong password!',
      token,
      carl.cookie ?? 'unused',
      ...stored.map((row) => row.passwordHash),
    ];
    const logText = JSON.stringify(h.logs);
    const auditText = JSON.stringify(h.db.select().from(auditEvent).all());
    expect(h.logs.length).toBeGreaterThan(5);
    for (const secret of secrets) {
      expect(logText).not.toContain(secret);
      expect(auditText).not.toContain(secret);
    }

    // Every response body the app sends, replayed.
    const bodies = [
      (await c.get('/api/session')).body,
      (await c.get('/api/users')).body,
      (await c.get('/api/audit')).body,
      (await c.patch(`/api/users/${carlId}`, { displayName: 'Carl C' })).body,
    ];
    for (const text of bodies) {
      for (const secret of secrets) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/passwordHash|password_hash|\$argon2/);
    }
  });
});
