import { afterEach, describe, expect, it } from 'vitest';
import { evidenceLink } from '../../db/schema';
import {
  auditPageSchema,
  errorEnvelopeSchema,
  evidenceItemResponseSchema,
  evidenceListSchema,
  userResponseSchema,
  type AuditPage,
  type EvidenceItem,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';

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

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  return { h, admin: await h.setupAdmin() };
}

function errorOf(body: string) {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error;
}

async function create(client: Client, body: Record<string, unknown>): Promise<EvidenceItem> {
  const response = await client.post('/api/evidence', {
    description: null,
    containsCui: false,
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return evidenceItemResponseSchema.parse(response.json()).item;
}

async function list(client: Client, query = ''): Promise<EvidenceItem[]> {
  const response = await client.get(`/api/evidence${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return evidenceListSchema.parse(response.json()).items;
}

async function events(client: Client, id: string): Promise<AuditPage['events']> {
  const response = await client.get(`/api/audit?entityType=evidence_item&entityId=${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return auditPageSchema.parse(response.json()).events;
}

describe('create and list', () => {
  it('creates an item with no versions and the creator as createdBy', async () => {
    const { h, admin } = await world();
    const item = await create(admin, {
      title: '  Access policy screenshot  ',
      description: 'From the IdP admin console',
      objectiveIds: ['3.1.1[a]'],
    });
    expect(item).toMatchObject({
      title: 'Access policy screenshot',
      description: 'From the IdP admin console',
      containsCui: false,
      objectiveIds: ['3.1.1[a]'],
      versions: [],
      createdAt: h.clock.now().toISOString(),
      updatedAt: h.clock.now().toISOString(),
      createdBy: { displayName: 'Ada Admin' },
    });
    const [event] = await events(admin, item.id);
    expect(event).toMatchObject({
      action: 'evidence.created',
      entityType: 'evidence_item',
      entityId: item.id,
      before: null,
      after: {
        title: 'Access policy screenshot',
        description: 'From the IdP admin console',
        containsCui: false,
        objectiveIds: ['3.1.1[a]'],
      },
    });
  });

  it('lists by title case-insensitively, then createdAt, then id', async () => {
    const { h, admin } = await world();
    const b = await create(admin, { title: 'beta' });
    h.clock.advance(1000);
    const a2 = await create(admin, { title: 'Alpha' });
    h.clock.advance(1000);
    const c = await create(admin, { title: 'Charlie' });
    h.clock.set(new Date(h.clock.now().getTime() - 5000));
    const a1 = await create(admin, { title: 'alpha' });
    const items = await list(admin);
    expect(items.map((i) => i.id)).toEqual([a1.id, a2.id, b.id, c.id]);
  });

  it('filters by objectiveId, and an objective not in the catalog gives 400', async () => {
    const { admin } = await world();
    const linked = await create(admin, { title: 'Linked', objectiveIds: ['3.1.1[b]'] });
    await create(admin, { title: 'Other', objectiveIds: ['3.1.2[a]'] });
    await create(admin, { title: 'None' });

    const filtered = await list(admin, `?objectiveId=${encodeURIComponent('3.1.1[b]')}`);
    expect(filtered.map((i) => i.id)).toEqual([linked.id]);
    expect(await list(admin, `?objectiveId=${encodeURIComponent('3.1.3[a]')}`)).toEqual([]);

    for (const bad of ['3.1.1[z]', 'AC.L2-3.1.1', '']) {
      const response = await admin.get(`/api/evidence?objectiveId=${encodeURIComponent(bad)}`);
      expect(response.statusCode, bad).toBe(400);
      expect(errorOf(response.body).code).toBe('validation_failed');
    }
    expect((await admin.get('/api/evidence?requirementId=AC.L2-3.1.1')).statusCode).toBe(400);
  });

  it('needs a session to read and CSRF to write; a contributor can create', async () => {
    const { h, admin } = await world();
    expect((await h.client().get('/api/evidence')).statusCode).toBe(401);
    const noCsrf = await admin.post(
      '/api/evidence',
      { title: 'x', description: null, containsCui: false },
      { headers: { 'x-csrf-token': null } },
    );
    expect(noCsrf.statusCode).toBe(403);
    expect(await list(admin)).toEqual([]);

    expect((await admin.post('/api/users', CONTRIBUTOR)).statusCode).toBe(201);
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
    const item = await create(carl, { title: 'By Carl' });
    expect(item.createdBy.displayName).toBe('Carl Contributor');
  });

  it('gives 404 for an unknown item on every item route', async () => {
    const { admin } = await world();
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await admin.patch(`/api/evidence/${id}`, { title: 'x' })).statusCode).toBe(404);
    const put = await admin.put(`/api/evidence/${id}/objectives`, { objectiveIds: [] });
    expect(put.statusCode).toBe(404);
    const ref = await admin.post(`/api/evidence/${id}/references`, { location: 'x', note: null });
    expect(ref.statusCode).toBe(404);
    expect((await admin.patch('/api/evidence/not-a-uuid', { title: 'x' })).statusCode).toBe(404);
  });
});

describe('objective links', () => {
  it('gives 400 with the unknown IDs in details, and writes nothing', async () => {
    const { h, admin } = await world();
    const response = await admin.post('/api/evidence', {
      title: 'Bad links',
      description: null,
      containsCui: false,
      objectiveIds: ['3.1.1[a]', '3.1.1[z]', 'nope'],
    });
    expect(response.statusCode).toBe(400);
    const error = errorOf(response.body);
    expect(error.code).toBe('validation_failed');
    expect(JSON.stringify(error.details)).toContain('3.1.1[z]');
    expect(JSON.stringify(error.details)).toContain('nope');
    expect(JSON.stringify(error.details)).not.toContain('3.1.1[a]');
    expect(await list(admin)).toEqual([]);

    const item = await create(admin, { title: 'Good' });
    const put = await admin.put(`/api/evidence/${item.id}/objectives`, {
      objectiveIds: ['3.1.2[a]', '9.9.9[a]'],
    });
    expect(put.statusCode).toBe(400);
    expect(JSON.stringify(errorOf(put.body).details)).toContain('9.9.9[a]');
    expect(h.db.select().from(evidenceLink).all()).toEqual([]);
  });

  it('collapses duplicates and returns catalog order', async () => {
    const { h, admin } = await world();
    const item = await create(admin, {
      title: 'Ordered',
      objectiveIds: ['3.1.2[a]', '3.1.1[b]', '3.1.1[a]', '3.1.2[a]', '3.1.1[b]'],
    });
    expect(item.objectiveIds).toEqual(['3.1.1[a]', '3.1.1[b]', '3.1.2[a]']);
    expect(h.db.select().from(evidenceLink).all()).toHaveLength(3);

    const response = await admin.put(`/api/evidence/${item.id}/objectives`, {
      objectiveIds: ['3.13.11[a]', '3.1.1[a]', '3.13.11[a]'],
    });
    expect(response.statusCode, response.body).toBe(200);
    const updated = evidenceItemResponseSchema.parse(response.json()).item;
    expect(updated.objectiveIds).toEqual(['3.1.1[a]', '3.13.11[a]']);
    expect((await list(admin))[0]?.objectiveIds).toEqual(['3.1.1[a]', '3.13.11[a]']);
  });

  it('a PUT replaces the set and audits before and after; the same set again writes nothing', async () => {
    const { h, admin } = await world();
    const item = await create(admin, { title: 'Links', objectiveIds: ['3.1.1[a]'] });
    h.clock.advance(60_000);
    const url = `/api/evidence/${item.id}/objectives`;
    const first = await admin.put(url, { objectiveIds: ['3.1.2[a]', '3.1.1[b]'] });
    expect(first.statusCode).toBe(200);
    const changed = evidenceItemResponseSchema.parse(first.json()).item;
    expect(changed.updatedAt).toBe(h.clock.now().toISOString());

    h.clock.advance(60_000);
    const again = await admin.put(url, { objectiveIds: ['3.1.1[b]', '3.1.2[a]', '3.1.2[a]'] });
    expect(again.statusCode).toBe(200);
    expect(evidenceItemResponseSchema.parse(again.json()).item.updatedAt).toBe(changed.updatedAt);

    const linkEvents = (await events(admin, item.id)).filter(
      (e) => e.action === 'evidence.links_updated',
    );
    expect(linkEvents).toHaveLength(1);
    expect(linkEvents[0]).toMatchObject({
      before: { objectiveIds: ['3.1.1[a]'] },
      after: { objectiveIds: ['3.1.1[b]', '3.1.2[a]'] },
    });

    const cleared = await admin.put(url, { objectiveIds: [] });
    expect(evidenceItemResponseSchema.parse(cleared.json()).item.objectiveIds).toEqual([]);
    expect(h.db.select().from(evidenceLink).all()).toEqual([]);
  });
});

describe('patch', () => {
  it('gives 400 for containsCui, an empty patch or an unknown key, and changes nothing', async () => {
    const { admin } = await world();
    const item = await create(admin, { title: 'Fixed flag' });
    for (const body of [{ containsCui: true }, { title: 'x', containsCui: false }, {}, { x: 1 }]) {
      const response = await admin.patch(`/api/evidence/${item.id}`, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorOf(response.body).code).toBe('validation_failed');
    }
    const [stored] = await list(admin);
    expect(stored).toMatchObject({ title: 'Fixed flag', containsCui: false });
    expect(await events(admin, item.id)).toHaveLength(1);
  });

  it('a title change audits only that field; a no-op writes nothing', async () => {
    const { h, admin } = await world();
    const item = await create(admin, { title: 'Old', description: 'Keep me' });
    h.clock.advance(60_000);
    const response = await admin.patch(`/api/evidence/${item.id}`, {
      title: 'New',
      description: 'Keep me',
    });
    expect(response.statusCode, response.body).toBe(200);
    const updated = evidenceItemResponseSchema.parse(response.json()).item;
    expect(updated).toMatchObject({ title: 'New', description: 'Keep me' });
    expect(updated.updatedAt).toBe(h.clock.now().toISOString());
    expect(updated.createdAt).toBe(item.createdAt);

    h.clock.advance(60_000);
    const same = await admin.patch(`/api/evidence/${item.id}`, { title: 'New' });
    expect(same.statusCode).toBe(200);
    expect(evidenceItemResponseSchema.parse(same.json()).item.updatedAt).toBe(updated.updatedAt);

    const patched = (await events(admin, item.id)).filter((e) => e.action === 'evidence.updated');
    expect(patched).toHaveLength(1);
    expect(patched[0]).toMatchObject({ before: { title: 'Old' }, after: { title: 'New' } });

    const cleared = await admin.patch(`/api/evidence/${item.id}`, { description: null });
    expect(evidenceItemResponseSchema.parse(cleared.json()).item.description).toBeNull();
  });
});

describe('contributor', () => {
  it('a contributor can patch and link, and is recorded as the actor', async () => {
    const { h, admin } = await world();
    const created = userResponseSchema.parse((await admin.post('/api/users', CONTRIBUTOR)).json());
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
    const item = await create(admin, { title: 'Shared' });
    expect(
      (await carl.patch(`/api/evidence/${item.id}`, { title: 'Carl was here' })).statusCode,
    ).toBe(200);
    const put = await carl.put(`/api/evidence/${item.id}/objectives`, {
      objectiveIds: ['3.1.1[a]'],
    });
    expect(put.statusCode).toBe(200);
    const carlEvents = (await events(admin, item.id)).filter(
      (e) => e.actor?.id === created.user.id,
    );
    expect(carlEvents.map((e) => e.action).sort()).toEqual([
      'evidence.links_updated',
      'evidence.updated',
    ]);
  });
});
