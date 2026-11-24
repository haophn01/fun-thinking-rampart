import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, session } from '../../db/schema';
import { errorEnvelopeSchema, sessionResponseSchema } from '../contract';
import { START, createHarness, type Harness } from '../testing/harness';

const SECOND = 1000;
const HOUR = 3600 * SECOND;

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

describe('expiry edges', () => {
  it('passes at 1:59:59 idle and fails at 2:00:00, deleting the row', async () => {
    const h = harness();
    const c = await h.setupAdmin();
    h.clock.advance(2 * HOUR - SECOND);
    const alive = await c.get('/api/users');
    expect(alive.statusCode).toBe(200);
    // That request moved last_seen_at forward, so the idle limit restarts from here.
    expect(sessionRows(h)[0]?.lastSeenAt).toBe(h.clock.now().toISOString());

    h.clock.advance(2 * HOUR - SECOND);
    expect((await c.get('/api/users')).statusCode).toBe(200);

    h.clock.advance(2 * HOUR);
    const dead = await c.get('/api/users');
    expect(dead.statusCode).toBe(401);
    expect(errorEnvelopeSchema.parse(dead.json()).error.code).toBe('unauthenticated');
    expect(sessionRows(h)).toHaveLength(0);
  });

  it('treats a public session check the same way', async () => {
    const h = harness();
    const c = await h.setupAdmin();
    h.clock.advance(2 * HOUR);
    const status = sessionResponseSchema.parse((await c.get('/api/session')).json());
    expect(status).toEqual({ setupRequired: false, user: null, csrfToken: null });
    expect(sessionRows(h)).toHaveLength(0);
  });

  it('ends an active session at 12 h', async () => {
    const h = harness();
    const c = await h.setupAdmin();
    for (let hour = 1; hour < 12; hour += 1) {
      h.clock.set(new Date(START.getTime() + hour * HOUR));
      expect((await c.get('/api/users')).statusCode, `hour ${String(hour)}`).toBe(200);
    }
    h.clock.set(new Date(START.getTime() + 12 * HOUR - 1));
    expect((await c.get('/api/users')).statusCode).toBe(200);
    h.clock.set(new Date(START.getTime() + 12 * HOUR));
    expect((await c.get('/api/users')).statusCode).toBe(401);
    expect(sessionRows(h)).toHaveLength(0);
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
