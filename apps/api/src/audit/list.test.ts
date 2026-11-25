import { afterEach, describe, expect, it } from 'vitest';
import { auditPageSchema, errorEnvelopeSchema, type AuditPage } from '../contract';
import { START, createHarness, type Client, type Harness } from '../testing/harness';
import { recordAudit } from './record';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** Setup writes ids 1 and 2; this adds 3..12 as objective results on two objectives. */
async function world(): Promise<{ h: Harness; admin: Client; adminId: string }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  const adminId = admin.user?.id ?? '';
  for (let i = 0; i < 10; i += 1) {
    recordAudit(h.db, {
      at: new Date(START.getTime() + i * 1000),
      actorUserId: i === 9 ? null : adminId,
      action: 'objective_result.updated',
      entityType: 'objective_result',
      entityId: i % 2 === 0 ? '3.1.1[a]' : '3.1.1[b]',
      before: null,
      after: { status: 'met', note: `n${String(i)}`, password: 'never shown' },
      requestId: `req-${String(i)}`,
    });
  }
  return { h, admin, adminId };
}

async function page(c: Client, query: string): Promise<AuditPage> {
  const response = await c.get(`/api/audit${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return auditPageSchema.parse(response.json());
}

describe('pages the audit log', () => {
  it('lists newest first and pages with limit and before', async () => {
    const { admin, adminId } = await world();
    const all = await page(admin, '');
    expect(all.events.map((event) => event.id)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(all.nextBefore).toBeNull();

    const newest = all.events[0];
    expect(newest).toEqual({
      id: 12,
      at: new Date(START.getTime() + 9000).toISOString(),
      actor: null,
      action: 'objective_result.updated',
      entityType: 'objective_result',
      entityId: '3.1.1[b]',
      before: null,
      after: { status: 'met', note: 'n9' },
      requestId: 'req-9',
    });
    expect(all.events[1]?.actor).toEqual({ id: adminId, displayName: 'Ada Admin' });
    expect(all.events.at(-1)).toMatchObject({ action: 'user.created', entityType: 'user' });

    const first = await page(admin, '?limit=5');
    expect(first.events.map((event) => event.id)).toEqual([12, 11, 10, 9, 8]);
    expect(first.nextBefore).toBe(8);
    const second = await page(admin, `?limit=5&before=${String(first.nextBefore)}`);
    expect(second.events.map((event) => event.id)).toEqual([7, 6, 5, 4, 3]);
    expect(second.nextBefore).toBe(3);
    const last = await page(admin, `?limit=5&before=${String(second.nextBefore)}`);
    expect(last.events.map((event) => event.id)).toEqual([2, 1]);
    expect(last.nextBefore).toBeNull();

    // A page that ends exactly at the oldest event says there is nothing more.
    const exact = await page(admin, '?limit=2&before=3');
    expect(exact.events.map((event) => event.id)).toEqual([2, 1]);
    expect(exact.nextBefore).toBeNull();
    const empty = await page(admin, '?before=1');
    expect(empty).toEqual({ events: [], nextBefore: null });
  });

  it('filters by entity type and id', async () => {
    const { admin, adminId } = await world();
    const users = await page(admin, '?entityType=user');
    expect(users.events.map((event) => event.entityId)).toEqual([adminId]);

    const one = await page(
      admin,
      `?entityType=objective_result&entityId=${encodeURIComponent('3.1.1[a]')}&limit=3`,
    );
    expect(one.events.map((event) => event.id)).toEqual([11, 9, 7]);
    expect(one.nextBefore).toBe(7);
    const rest = await page(
      admin,
      `?entityType=objective_result&entityId=${encodeURIComponent('3.1.1[a]')}&before=7`,
    );
    expect(rest.events.map((event) => event.id)).toEqual([5, 3]);
    expect(rest.nextBefore).toBeNull();

    const none = await page(admin, '?entityType=requirement_state');
    expect(none.events).toEqual([]);
  });

  it('rejects a bad query with 400', async () => {
    const { admin } = await world();
    for (const query of [
      'limit=0',
      'limit=201',
      'limit=abc',
      'limit=1.5',
      'before=0',
      'entityType=poam',
      'entityId=',
      'sort=asc',
    ]) {
      const response = await admin.get(`/api/audit?${query}`);
      expect(response.statusCode, query).toBe(400);
      expect(errorEnvelopeSchema.parse(response.json()).error.code, query).toBe(
        'validation_failed',
      );
    }
    expect((await page(admin, '?limit=200')).events).toHaveLength(12);
  });

  it('is readable by a contributor', async () => {
    const { h, admin } = await world();
    await admin.post('/api/users', {
      email: 'carl@example.com',
      displayName: 'Carl',
      role: 'contributor',
      password: 'a long enough password',
    });
    const carl = await h.signIn('carl@example.com', 'a long enough password');
    const result = await page(carl, '?limit=1');
    expect(result.events[0]?.action).toBe('auth.signed_in');
  });
});
