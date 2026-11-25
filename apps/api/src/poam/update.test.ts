import { loadCatalog } from '@rampart/catalog';
import { like } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, poamItem } from '../../db/schema';
import {
  errorEnvelopeSchema,
  poamItemResponseSchema,
  userResponseSchema,
  type PoamItem,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const ONE_POINT = 'AC.L2-3.1.3';
const TODAY = '2026-11-23';
const CONTRIBUTOR = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'a long enough password',
};

async function world(): Promise<{ h: Harness; admin: Client; carlId: string }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  const created = userResponseSchema.parse((await admin.post('/api/users', CONTRIBUTOR)).json());
  await mark(admin, ONE_POINT, 'not_met');
  return { h, admin, carlId: created.user.id };
}

async function mark(client: Client, requirementId: string, status: 'met' | 'not_met') {
  const requirement = loadCatalog().requirements.find((r) => r.id === requirementId);
  if (!requirement) throw new Error(`no ${requirementId}`);
  const objectives = status === 'met' ? requirement.objectives : requirement.objectives.slice(0, 1);
  for (const objective of objectives) {
    const response = await client.put(
      `/api/assessment/objectives/${encodeURIComponent(objective.id)}`,
      { status, note: null },
    );
    expect(response.statusCode, response.body).toBe(200);
  }
}

const milestone = (due: string, doneOn: string | null = null, title = 'Step') => ({
  title,
  due,
  doneOn,
});

async function create(client: Client, body: Record<string, unknown> = {}): Promise<PoamItem> {
  const response = await client.post('/api/poam', {
    requirementId: ONE_POINT,
    plan: 'Fix it',
    due: '2026-12-31',
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return poamItemResponseSchema.parse(response.json()).item;
}

async function patch(client: Client, id: string, body: unknown): Promise<PoamItem> {
  const response = await client.patch(`/api/poam/${id}`, body);
  expect(response.statusCode, response.body).toBe(200);
  return poamItemResponseSchema.parse(response.json()).item;
}

function code(body: string): string {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error.code;
}

function poamEvents(h: Harness) {
  return h.db
    .select()
    .from(auditEvent)
    .where(like(auditEvent.action, 'poam_item.%'))
    .all()
    .map((e) => ({
      action: e.action,
      before: JSON.parse(e.before ?? 'null') as unknown,
      after: JSON.parse(e.after ?? 'null') as unknown,
    }));
}

describe('PATCH /api/poam/:id', () => {
  it('milestone and owner edges', async () => {
    const { h, admin, carlId } = await world();
    const badCreates: Record<string, unknown>[] = [
      { milestones: [milestone('2027-01-01')] },
      { milestones: [milestone('2026-12-01', '2026-11-24')] },
      { milestones: Array.from({ length: 21 }, () => milestone('2026-12-01')) },
      { ownerId: '6f1c1b1e-5b7a-4c1e-9a43-1d2a3b4c5d6e' },
    ];
    for (const body of badCreates) {
      const response = await admin.post('/api/poam', {
        requirementId: ONE_POINT,
        plan: 'Fix',
        due: '2026-12-31',
        ...body,
      });
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(code(response.body)).toBe('validation_failed');
    }
    expect(h.db.select().from(poamItem).all()).toEqual([]);

    // Due on the item's due day and done today are both fine; 20 milestones is the maximum.
    const twenty = Array.from({ length: 20 }, (_, i) =>
      milestone('2026-12-31', i === 0 ? TODAY : null, `Step ${String(i + 1)}`),
    );
    const item = await create(admin, { milestones: twenty, ownerId: carlId });
    expect(item.milestones.map((m) => m.title)).toEqual(twenty.map((m) => m.title));
    expect(item.owner).toEqual({ id: carlId, displayName: CONTRIBUTOR.displayName, active: true });

    const deactivated = await admin.patch(`/api/users/${carlId}`, { active: false });
    expect(deactivated.statusCode, deactivated.body).toBe(200);
    const row = h.db.select().from(poamItem).all();
    const events = poamEvents(h);

    const badPatches: Record<string, unknown>[] = [
      { due: '2026-12-30' },
      { milestones: [milestone('2027-01-01')] },
      { due: '2027-01-31', milestones: [milestone('2027-02-01')] },
      { milestones: [milestone('2026-12-01', '2026-11-24')] },
      { ownerId: carlId },
    ];
    for (const body of badPatches) {
      const response = await admin.patch(`/api/poam/${item.id}`, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(code(response.body)).toBe('validation_failed');
    }
    expect(h.db.select().from(poamItem).all()).toEqual(row);
    expect(poamEvents(h)).toEqual(events);

    // Moving both together is checked against the merged result, so this one passes.
    const moved = await patch(admin, item.id, {
      due: '2027-01-31',
      milestones: [milestone('2027-01-31'), milestone('2026-12-01', TODAY)],
    });
    expect(moved.milestones).toEqual([milestone('2027-01-31'), milestone('2026-12-01', TODAY)]);
    // A null owner unassigns, even while the old owner is inactive.
    expect((await patch(admin, item.id, { ownerId: null })).owner).toBeNull();
  });

  it('edits', async () => {
    const { h, admin, carlId } = await world();
    const item = await create(admin);
    h.clock.advance(60_000);

    const changed = await patch(admin, item.id, { plan: 'A better plan', due: '2026-12-31' });
    expect(changed).toMatchObject({ plan: 'A better plan', updatedAt: '2026-11-23T09:01:00.000Z' });
    expect(poamEvents(h).slice(1)).toEqual([
      {
        action: 'poam_item.updated',
        before: { plan: 'Fix it' },
        after: { plan: 'A better plan' },
      },
    ]);

    h.clock.advance(60_000);
    const same = await patch(admin, item.id, {
      plan: '  A better plan ',
      due: '2026-12-31',
      ownerId: null,
      milestones: [],
    });
    expect(same.updatedAt).toBe('2026-11-23T09:01:00.000Z');
    expect(poamEvents(h)).toHaveLength(2);

    await patch(admin, item.id, { ownerId: carlId, milestones: [milestone('2026-12-01')] });
    expect(poamEvents(h)[2]).toEqual({
      action: 'poam_item.updated',
      before: { ownerId: null, milestones: [] },
      after: { ownerId: carlId, milestones: [milestone('2026-12-01')] },
    });

    // An open item still takes edits after its requirement turns Met (so it's ineligible).
    await mark(admin, ONE_POINT, 'met');
    expect((await patch(admin, item.id, { plan: 'Done soon' })).plan).toBe('Done soon');

    const closeout = await admin.post(`/api/poam/${item.id}/closeout`, {
      closedOn: TODAY,
      note: null,
    });
    expect(closeout.statusCode, closeout.body).toBe(200);
    const row = h.db.select().from(poamItem).all();
    const eventCount = poamEvents(h).length;
    for (const body of [{ plan: 'Too late' }, { due: '2026-12-31' }]) {
      const response = await admin.patch(`/api/poam/${item.id}`, body);
      expect(response.statusCode).toBe(409);
      expect(code(response.body)).toBe('poam_item_closed');
    }
    expect(h.db.select().from(poamItem).all()).toEqual(row);
    expect(poamEvents(h)).toHaveLength(eventCount);

    const unknown = await admin.patch('/api/poam/6f1c1b1e-5b7a-4c1e-9a43-1d2a3b4c5d6e', {
      plan: 'x',
    });
    expect(unknown.statusCode).toBe(404);
    expect((await admin.patch(`/api/poam/${item.id}`, {})).statusCode).toBe(400);
  });
});
