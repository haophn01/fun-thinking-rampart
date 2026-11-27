import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, session } from '../../db/schema';
import {
  SESSION_ABSOLUTE_LIMIT_MS,
  SESSION_IDLE_LIMIT_MS,
  errorEnvelopeSchema,
  sessionResponseSchema,
} from '../contract';
import { ADMIN, START, createHarness, type Harness } from '../testing/harness';
import { ABSOLUTE_LIMIT_MS, IDLE_LIMIT_MS, SESSION_MAX_AGE_SECONDS } from './sessions';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
function harness(): Harness {
  const h = createHarness();
  harnesses.push(h);
  return h;
}

function sessionRows(h: Harness) {
  return h.db.select().from(session).all();
}

describe('30 min idle and 8 h absolute', () => {
  it('passes at 29:59.999 idle and fails at 30:00.000, deleting the row', async () => {
    const h = harness();
    const c = await h.setupAdmin();
    h.clock.advance(30 * MINUTE - 1);
    const alive = await c.get('/api/users');
    expect(alive.statusCode).toBe(200);
    // That request moved last_seen_at forward, so the idle limit restarts from here.
    expect(sessionRows(h)[0]?.lastSeenAt).toBe(h.clock.now().toISOString());

    h.clock.advance(30 * MINUTE - 1);
    expect((await c.get('/api/users')).statusCode).toBe(200);

    h.clock.advance(30 * MINUTE);
    const dead = await c.get('/api/users');
    expect(dead.statusCode).toBe(401);
    expect(errorEnvelopeSchema.parse(dead.json()).error.code).toBe('unauthenticated');
    expect(sessionRows(h)).toHaveLength(0);
  });

  it('treats a public session check the same way', async () => {
    const h = harness();
    const c = await h.setupAdmin();
    h.clock.advance(30 * MINUTE);
    const status = sessionResponseSchema.parse((await c.get('/api/session')).json());
    expect(status).toEqual({
      setupRequired: false,
      user: null,
      csrfToken: null,
      locked: false,
      mustChangePassword: false,
      signInNotice: null,
      mfa: 'none',
    });
    expect(sessionRows(h)).toHaveLength(0);
  });

  it('ends a busy session at exactly 8 h after sign-in', async () => {
    const h = harness();
    const c = await h.setupAdmin();
    // A request every 20 minutes keeps it from idling out.
    for (let at = 20 * MINUTE; at < 8 * HOUR; at += 20 * MINUTE) {
      h.clock.set(new Date(START.getTime() + at));
      expect((await c.get('/api/users')).statusCode, `at ${String(at / MINUTE)} min`).toBe(200);
    }
    h.clock.set(new Date(START.getTime() + 8 * HOUR - 1));
    expect((await c.get('/api/users')).statusCode).toBe(200);
    h.clock.set(new Date(START.getTime() + 8 * HOUR));
    expect((await c.get('/api/users')).statusCode).toBe(401);
    expect(sessionRows(h)).toHaveLength(0);
  });

  it('sets Max-Age 28800 on the cookie and keeps the old constant names', async () => {
    expect(IDLE_LIMIT_MS).toBe(SESSION_IDLE_LIMIT_MS);
    expect(ABSOLUTE_LIMIT_MS).toBe(SESSION_ABSOLUTE_LIMIT_MS);
    expect(SESSION_MAX_AGE_SECONDS).toBe(28800);
    const h = harness();
    await h.setupAdmin();
    const signedIn = await h.client().post('/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    const cookie = signedIn.cookies.find((item) => item.name === 'rampart_session');
    expect(cookie?.maxAge).toBe(28800);
  });

  it('answers 401 for a missing, unknown or malformed cookie', async () => {
    const h = harness();
    await h.setupAdmin();
    const c = h.client();
    expect((await c.get('/api/users')).statusCode).toBe(401);
    for (const value of ['nope', '', 'a'.repeat(43), '%%%']) {
      c.cookie = value;
      const response = await c.get('/api/users', {
        headers: { cookie: `rampart_session=${value}` },
      });
      expect(response.statusCode, value).toBe(401);
    }
  });
});

describe('rotation at sign-in', () => {
  it('issues a new token and deletes the cookie’s old session', async () => {
    const h = harness();
    const c = await h.setupAdmin();
    const oldToken = c.cookie;
    const oldCsrf = c.csrfToken;
    const oldId = sessionRows(h)[0]?.id;
    h.clock.advance(MINUTE);

    const again = await c.post('/api/session', { email: ADMIN.email, password: ADMIN.password });
    expect(again.statusCode).toBe(200);
    expect(c.cookie).not.toBeNull();
    expect(c.cookie).not.toBe(oldToken);
    expect(c.csrfToken).not.toBe(oldCsrf);
    const rows = sessionRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(oldId);
    // A fresh sign-in starts a fresh 8 h.
    expect(rows[0]?.createdAt).toBe(h.clock.now().toISOString());

    const stale = h.client();
    stale.cookie = oldToken;
    expect((await stale.get('/api/users')).statusCode).toBe(401);
    expect((await c.get('/api/users')).statusCode).toBe(200);
  });
});

describe('sign out is idempotent', () => {
  it('gives 204, deletes the row, clears the cookie and audits once', async () => {
    const h = harness();
    const c = await h.setupAdmin();
    const token = c.cookie;
    expect(sessionRows(h)).toHaveLength(1);

    const out = await c.delete('/api/session');
    expect(out.statusCode).toBe(204);
    expect(out.body).toBe('');
    const cleared = out.cookies.find((item) => item.name === 'rampart_session');
    expect(cleared?.value).toBe('');
    expect(cleared).toMatchObject({ path: '/', httpOnly: true, sameSite: 'Strict' });
    expect(new Date(cleared?.expires ?? Date.now()).getTime()).toBeLessThanOrEqual(Date.now());
    expect(sessionRows(h)).toHaveLength(0);

    // The old token is dead.
    const stale = h.client();
    stale.cookie = token;
    expect((await stale.get('/api/users')).statusCode).toBe(401);

    const repeat = await c.delete('/api/session');
    expect(repeat.statusCode).toBe(204);
    const anonymous = await h.client().delete('/api/session');
    expect(anonymous.statusCode).toBe(204);

    const signOuts = h.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, 'auth.signed_out'))
      .all();
    expect(signOuts).toHaveLength(1);
  });

  it('needs the csrf token when there is a session', async () => {
    const h = harness();
    const c = await h.setupAdmin();
    const refused = await c.delete('/api/session', { headers: { 'x-csrf-token': null } });
    expect(refused.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(refused.json()).error.code).toBe('csrf_failed');
    expect(sessionRows(h)).toHaveLength(1);
  });
});
