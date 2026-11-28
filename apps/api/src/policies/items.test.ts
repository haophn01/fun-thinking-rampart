import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, policy, policyLink } from '../../db/schema';
import {
  auditPageSchema,
  errorEnvelopeSchema,
  policyListSchema,
  policyResponseSchema,
  userResponseSchema,
  type AuditPage,
  type Policy,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';
import { sampleDocx } from '../uploads/testing/samples';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const CONTRIBUTOR = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'a long enough password',
};

async function world(): Promise<{ h: Harness; admin: Client; carl: Client }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  userResponseSchema.parse((await admin.post('/api/users', CONTRIBUTOR)).json());
  const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
  return { h, admin, carl };
}

function errorOf(body: string) {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error;
}

async function create(client: Client, body: Record<string, unknown>): Promise<Policy> {
  const response = await client.post('/api/policies', { description: null, ...body });
  expect(response.statusCode, response.body).toBe(201);
  return policyResponseSchema.parse(response.json()).item;
}

async function list(client: Client, query = ''): Promise<Policy[]> {
  const response = await client.get(`/api/policies${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return policyListSchema.parse(response.json()).items;
}

async function events(client: Client, id: string): Promise<AuditPage['events']> {
  const response = await client.get(`/api/audit?entityType=policy&entityId=${id}`);
  return auditPageSchema.parse(response.json()).events;
}

describe('policies', () => {
  it('create and list', async () => {
    const { h, admin } = await world();

    const zeta = await create(admin, { title: 'zeta policy', description: '  Rules  ' });
    expect(zeta).toMatchObject({
      title: 'zeta policy',
      description: 'Rules',
      requirementIds: [],
      versions: [],
      createdBy: { displayName: 'Ada Admin' },
    });
    h.clock.advance(1000);
    const alpha = await create(admin, {
      title: 'Alpha',
      requirementIds: ['AC.L2-3.1.2'],
    });
    h.clock.advance(1000);
    const beta1 = await create(admin, { title: 'beta', requirementIds: ['AC.L2-3.1.1'] });
    h.clock.advance(1000);
    const beta2 = await create(admin, { title: 'Beta', requirementIds: ['AC.L2-3.1.1'] });

    // Case-insensitive by title, then by createdAt.
    expect((await list(admin)).map((p) => p.id)).toEqual([alpha.id, beta1.id, beta2.id, zeta.id]);

    expect((await list(admin, '?requirementId=AC.L2-3.1.1')).map((p) => p.id)).toEqual([
      beta1.id,
      beta2.id,
    ]);
    // A catalog requirement nothing links to gives an empty list, not an error.
    expect(await list(admin, '?requirementId=AU.L2-3.3.1')).toEqual([]);

    const unknown = await admin.get('/api/policies?requirementId=XX.L2-9.9.9');
    expect(unknown.statusCode).toBe(400);
    expect(errorOf(unknown.body).code).toBe('validation_failed');
    // The query is strict: an unknown key is a 400 too.
    expect((await admin.get('/api/policies?objectiveId=3.1.1%5Ba%5D')).statusCode).toBe(400);

    // Saved: a fresh session reads the same list.
    const again = await h.signIn('admin@example.com', 'correct horse battery');
    expect((await list(again)).map((p) => p.title)).toEqual([
      'Alpha',
      'beta',
      'Beta',
      'zeta policy',
    ]);
  });

  it('refuses a bad create and writes nothing', async () => {
    const { h, admin } = await world();
    for (const body of [
      { title: '   ', description: null },
      { title: 'x'.repeat(201), description: null },
      { title: 'Ok', description: null, containsCui: false },
      { title: 'Ok' },
    ]) {
      const response = await admin.post('/api/policies', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(h.db.select().from(policy).all()).toEqual([]);
    expect(
      h.db
        .select()
        .from(auditEvent)
        .all()
        .filter((e) => e.entityType === 'policy'),
    ).toEqual([]);
  });

  it('requirement links', async () => {
    const { h, admin } = await world();

    const bad = await admin.post('/api/policies', {
      title: 'Access',
      description: null,
      requirementIds: ['AC.L2-3.1.1', 'NOPE-1', '3.1.1'],
    });
    expect(bad.statusCode).toBe(400);
    const badError = errorOf(bad.body);
    expect(badError.code).toBe('validation_failed');
    expect(JSON.stringify(badError.details)).toContain('NOPE-1');
    expect(JSON.stringify(badError.details)).toContain('3.1.1');
    expect(h.db.select().from(policy).all()).toEqual([]);

    // Duplicates collapse and the list comes back in catalog order.
    const item = await create(admin, {
      title: 'Access',
      requirementIds: ['SC.L2-3.13.11', 'AC.L2-3.1.2', 'AC.L2-3.1.1', 'AC.L2-3.1.2'],
    });
    expect(item.requirementIds).toEqual(['AC.L2-3.1.1', 'AC.L2-3.1.2', 'SC.L2-3.13.11']);
    expect(h.db.select().from(policyLink).all()).toHaveLength(3);

    const url = `/api/policies/${item.id}/requirements`;

    // The same set, reordered and with a duplicate, writes no event.
    const same = await admin.put(url, {
      requirementIds: ['AC.L2-3.1.2', 'SC.L2-3.13.11', 'AC.L2-3.1.1', 'AC.L2-3.1.1'],
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(policyResponseSchema.parse(same.json()).item).toEqual(item);
    expect((await events(admin, item.id)).map((e) => e.action)).toEqual(['policy.created']);

    // Unknown IDs on PUT give 400 and leave the links alone.
    const badPut = await admin.put(url, { requirementIds: ['AC.L2-3.1.1', 'AC.L2-3.1.999'] });
    expect(badPut.statusCode).toBe(400);
    expect(JSON.stringify(errorOf(badPut.body).details)).toContain('AC.L2-3.1.999');

    h.clock.advance(60_000);
    const changed = await admin.put(url, { requirementIds: ['AU.L2-3.3.1', 'AC.L2-3.1.1'] });
    expect(changed.statusCode, changed.body).toBe(200);
    const after = policyResponseSchema.parse(changed.json()).item;
    expect(after.requirementIds).toEqual(['AC.L2-3.1.1', 'AU.L2-3.3.1']);
    expect(after.updatedAt).toBe(h.clock.now().toISOString());

    const [latest] = await events(admin, item.id);
    expect(latest).toMatchObject({
      action: 'policy.links_updated',
      before: { requirementIds: ['AC.L2-3.1.1', 'AC.L2-3.1.2', 'SC.L2-3.13.11'] },
      after: { requirementIds: ['AC.L2-3.1.1', 'AU.L2-3.3.1'] },
    });

    // An empty set clears every link.
    const cleared = await admin.put(url, { requirementIds: [] });
    expect(policyResponseSchema.parse(cleared.json()).item.requirementIds).toEqual([]);

    // Unknown policy: 404. Malformed body: 400.
    const missing = await admin.put(
      '/api/policies/00000000-0000-4000-8000-000000000000/requirements',
      {
        requirementIds: [],
      },
    );
    expect(missing.statusCode).toBe(404);
    expect((await admin.put(url, { requirementIds: 'AC.L2-3.1.1' })).statusCode).toBe(400);
    expect((await admin.put(url, {})).statusCode).toBe(400);
  });

  it('patch', async () => {
    const { h, admin } = await world();
    const item = await create(admin, { title: 'Access', description: 'Old' });
    const url = `/api/policies/${item.id}`;

    h.clock.advance(1000);
    const renamed = await admin.patch(url, { title: 'Access control', description: 'Old' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(policyResponseSchema.parse(renamed.json()).item).toMatchObject({
      title: 'Access control',
      description: 'Old',
      updatedAt: h.clock.now().toISOString(),
    });
    const [updated] = await events(admin, item.id);
    expect(updated).toMatchObject({
      action: 'policy.updated',
      before: { title: 'Access' },
      after: { title: 'Access control' },
    });

    // A no-op patch writes nothing and leaves updatedAt alone.
    h.clock.advance(1000);
    const noop = await admin.patch(url, { title: 'Access control' });
    expect(noop.statusCode).toBe(200);
    expect(policyResponseSchema.parse(noop.json()).item.updatedAt).toBe(
      policyResponseSchema.parse(renamed.json()).item.updatedAt,
    );
    expect(await events(admin, item.id)).toHaveLength(2);

    // A blank description becomes null.
    const blank = await admin.patch(url, { description: '   ' });
    expect(policyResponseSchema.parse(blank.json()).item.description).toBeNull();

    expect((await admin.patch(url, {})).statusCode).toBe(400);
    expect((await admin.patch(url, { requirementIds: [] })).statusCode).toBe(400);
    expect((await admin.patch(url, { title: '' })).statusCode).toBe(400);
    expect(
      (await admin.patch('/api/policies/00000000-0000-4000-8000-000000000000', { title: 'x' }))
        .statusCode,
    ).toBe(404);
    expect((await admin.patch('/api/policies/not-a-uuid', { title: 'x' })).statusCode).toBe(404);
  });

  it('contributor writes and audit', async () => {
    const { h, carl } = await world();
    const item = await create(carl, {
      title: 'Incident response',
      description: 'IR plan',
      requirementIds: ['IR.L2-3.6.1'],
    });
    expect(item.createdBy.displayName).toBe('Carl Contributor');

    const patched = await carl.patch(`/api/policies/${item.id}`, { title: 'IR policy' });
    expect(patched.statusCode, patched.body).toBe(200);
    const linked = await carl.put(`/api/policies/${item.id}/requirements`, {
      requirementIds: ['IR.L2-3.6.1', 'IR.L2-3.6.2'],
    });
    expect(linked.statusCode, linked.body).toBe(200);
    const bytes = sampleDocx();
    const uploaded = await carl.upload(`/api/policies/${item.id}/versions`, bytes, 'ir.docx');
    expect(uploaded.statusCode, uploaded.body).toBe(201);

    const all = await events(carl, item.id);
    expect(all.map((e) => e.action)).toEqual([
      'policy.version_added',
      'policy.links_updated',
      'policy.updated',
      'policy.created',
    ]);
    for (const event of all) {
      expect(event.actor?.displayName).toBe('Carl Contributor');
      expect(event.entityType).toBe('policy');
      expect(event.entityId).toBe(item.id);
    }
    expect(all[3]).toMatchObject({
      before: null,
      after: {
        title: 'Incident response',
        description: 'IR plan',
        requirementIds: ['IR.L2-3.6.1'],
      },
    });
    expect(all[0]).toMatchObject({
      before: null,
      after: {
        version: 1,
        kind: 'file',
        fileName: 'ir.docx',
        size: bytes.byteLength,
        sha256: h.store.keys()[0],
      },
    });
    // The bytes themselves are never audited.
    const rows = h.db.select().from(auditEvent).all();
    expect(JSON.stringify(rows)).not.toContain('IR policy v1');
  });

  it('is guarded: 401 without a session, 403 without CSRF, nothing written', async () => {
    const { h, admin } = await world();
    const anonymous = h.client();
    expect((await anonymous.get('/api/policies')).statusCode).toBe(401);
    expect(
      (await anonymous.post('/api/policies', { title: 'x', description: null })).statusCode,
    ).toBe(401);
    const noCsrf = await admin.post(
      '/api/policies',
      { title: 'x', description: null },
      { headers: { 'x-csrf-token': null } },
    );
    expect(noCsrf.statusCode).toBe(403);
    expect(errorOf(noCsrf.body).code).toBe('csrf_failed');
    expect(h.db.select().from(policy).all()).toEqual([]);
  });
});
