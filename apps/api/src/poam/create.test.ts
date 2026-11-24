import { loadCatalog } from '@rampart/catalog';
import { REGULATION } from '@rampart/rules/poam';
import { like } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, poamItem } from '../../db/schema';
import {
  errorEnvelopeSchema,
  poamItemResponseSchema,
  poamViewSchema,
  type ErrorEnvelope,
  type PoamItem,
} from '../contract';
import { ADMIN, createHarness, type Client, type Harness } from '../testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const ONE_POINT = 'AC.L2-3.1.3';
const MET = 'AC.L2-3.1.4';
const THREE_POINT = 'AC.L2-3.1.5';
const BARRED = 'AC.L2-3.1.20';
const ENCRYPTION = 'SC.L2-3.13.11';
const NOT_MET_CITATION = '32 CFR 170.24(c)(2)(i)(B)(6)';

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  return { h, admin: await h.setupAdmin() };
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

function envelope(body: string): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error;
}

async function create(client: Client, body: Record<string, unknown>): Promise<PoamItem> {
  const response = await client.post('/api/poam', { plan: 'Fix it', due: '2026-12-31', ...body });
  expect(response.statusCode, response.body).toBe(201);
  return poamItemResponseSchema.parse(response.json()).item;
}

function poamEvents(h: Harness) {
  return h.db.select().from(auditEvent).where(like(auditEvent.action, 'poam_item.%')).all();
}

async function refused(
  client: Client,
  requirementId: string,
): Promise<{ status: number; error: ErrorEnvelope['error'] }> {
  const response = await client.post('/api/poam', {
    requirementId,
    plan: 'Fix',
    due: '2026-12-31',
  });
  return { status: response.statusCode, error: envelope(response.body) };
}

describe('POST /api/poam', () => {
  it('eligibility enforced', async () => {
    const { h, admin } = await world();
    expect(REGULATION.poamNotMetOnly.citation).toBe(NOT_MET_CITATION);
    await mark(admin, ONE_POINT, 'not_met');
    await mark(admin, MET, 'met');
    await mark(admin, THREE_POINT, 'not_met');
    await mark(admin, BARRED, 'not_met');

    const response = await admin.post('/api/poam', {
      requirementId: ONE_POINT,
      plan: '  Turn on the lockout  ',
      due: '2026-12-31',
      milestones: [{ title: 'Draft', due: '2026-12-01', doneOn: null }],
    });
    expect(response.statusCode, response.body).toBe(201);
    const { item } = poamItemResponseSchema.parse(response.json());
    expect(item).toMatchObject({
      requirementId: ONE_POINT,
      status: 'open',
      plan: 'Turn on the lockout',
      due: '2026-12-31',
      milestones: [{ title: 'Draft', due: '2026-12-01', doneOn: null }],
      owner: null,
      closeout: null,
      createdAt: '2026-11-23T09:00:00.000Z',
      updatedAt: '2026-11-23T09:00:00.000Z',
      createdBy: { displayName: ADMIN.displayName },
      requirementStatus: 'not_met',
      eligibility: { eligible: true },
      daysToDue: 38,
      overdue: false,
      dueAfterDeadline: false,
      readyToClose: false,
    });
    const events = poamEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'poam_item.created',
      entityType: 'poam_item',
      entityId: item.id,
      before: null,
    });
    expect(JSON.parse(events[0]?.after ?? 'null')).toEqual({
      requirementId: ONE_POINT,
      plan: 'Turn on the lockout',
      due: '2026-12-31',
      ownerId: null,
      milestones: [{ title: 'Draft', due: '2026-12-01', doneOn: null }],
    });

    expect(await refused(admin, MET)).toMatchObject({
      status: 409,
      error: {
        code: 'poam_ineligible',
        details: { reasons: [{ code: 'not_not_met', citation: NOT_MET_CITATION }] },
      },
    });
    // Not assessed is not Not Met either.
    expect((await refused(admin, 'AC.L2-3.1.6')).error.details).toEqual({
      reasons: [{ code: 'not_not_met', citation: NOT_MET_CITATION }],
    });
    expect(await refused(admin, BARRED)).toMatchObject({
      status: 409,
      error: {
        code: 'poam_ineligible',
        details: { reasons: [{ code: 'barred', citation: '32 CFR 170.21(a)(2)(iii)' }] },
      },
    });
    expect(await refused(admin, THREE_POINT)).toMatchObject({
      status: 409,
      error: {
        code: 'poam_ineligible',
        details: {
          reasons: [{ code: 'exceeds_point_limit', citation: '32 CFR 170.21(a)(2)(ii)' }],
        },
      },
    });
    // Every reason, in order: a barred requirement that is Met.
    await mark(admin, 'AC.L2-3.1.22', 'met');
    expect((await refused(admin, 'AC.L2-3.1.22')).error.details).toEqual({
      reasons: [
        { code: 'not_not_met', citation: NOT_MET_CITATION },
        { code: 'barred', citation: '32 CFR 170.21(a)(2)(iii)' },
      ],
    });
    expect(await refused(admin, 'AC.L2-9.9.9')).toMatchObject({
      status: 404,
      error: { code: 'not_found' },
    });

    expect(h.db.select().from(poamItem).all()).toHaveLength(1);
    expect(poamEvents(h)).toHaveLength(1);
  });

  it('3.13.11 exception', async () => {
    const { h, admin } = await world();
    await mark(admin, ENCRYPTION, 'not_met');
    const level = async (implementationLevel: string | null) => {
      const response = await admin.patch(`/api/assessment/requirements/${ENCRYPTION}`, {
        implementationLevel,
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    const pointLimit = {
      status: 409,
      error: {
        code: 'poam_ineligible',
        details: {
          reasons: [{ code: 'exceeds_point_limit', citation: '32 CFR 170.21(a)(2)(ii)' }],
        },
      },
    };

    expect(await refused(admin, ENCRYPTION)).toMatchObject(pointLimit);
    await level('none');
    expect(await refused(admin, ENCRYPTION)).toMatchObject(pointLimit);
    expect(h.db.select().from(poamItem).all()).toEqual([]);

    await level('partial');
    const item = await create(admin, { requirementId: ENCRYPTION });
    expect(item.eligibility).toEqual({ eligible: true });
  });

  it('one open item', async () => {
    const { h, admin } = await world();
    await mark(admin, ONE_POINT, 'not_met');
    const first = await create(admin, { requirementId: ONE_POINT });

    expect(await refused(admin, ONE_POINT)).toMatchObject({
      status: 409,
      error: { code: 'poam_item_exists', details: { itemId: first.id } },
    });
    expect(h.db.select().from(poamItem).all()).toHaveLength(1);

    await mark(admin, ONE_POINT, 'met');
    const closed = await admin.post(`/api/poam/${first.id}/closeout`, {
      closedOn: '2026-11-23',
      note: 'Verified',
    });
    expect(closed.statusCode, closed.body).toBe(200);
    // Met again, so a new item is refused for eligibility, not for the closed one.
    expect((await refused(admin, ONE_POINT)).error.code).toBe('poam_ineligible');

    await mark(admin, ONE_POINT, 'not_met');
    const second = await create(admin, { requirementId: ONE_POINT });
    expect(second.id).not.toBe(first.id);

    const v = poamViewSchema.parse((await admin.get('/api/poam')).json());
    expect(v.items.map((i) => [i.id, i.status])).toEqual([
      [second.id, 'open'],
      [first.id, 'closed'],
    ]);
    expect(v.candidates).toEqual([]);
  });

  it('accepts a past due, and the item is then overdue', async () => {
    const { admin } = await world();
    await mark(admin, ONE_POINT, 'not_met');
    const item = await create(admin, { requirementId: ONE_POINT, due: '2026-11-20' });
    expect(item).toMatchObject({ daysToDue: -3, overdue: true });
  });

  it('guarded', async () => {
    const { h, admin } = await world();
    await mark(admin, ONE_POINT, 'not_met');
    const body = { requirementId: ONE_POINT, plan: 'Fix', due: '2026-12-31' };

    const anonymous = h.client();
    expect((await anonymous.get('/api/poam')).statusCode).toBe(401);
    const noSession = await anonymous.post('/api/poam', body);
    expect(noSession.statusCode).toBe(401);
    expect(envelope(noSession.body).code).toBe('unauthenticated');

    const noCsrf = await admin.post('/api/poam', body, { headers: { 'x-csrf-token': null } });
    expect(noCsrf.statusCode).toBe(403);
    expect(envelope(noCsrf.body).code).toBe('csrf_failed');
    expect(h.db.select().from(poamItem).all()).toEqual([]);

    const item = await create(admin, { requirementId: ONE_POINT });
    const before = h.db.select().from(poamItem).all();
    const eventCount = poamEvents(h).length;
    for (const [url, payload] of [
      [`/api/poam/${item.id}`, { plan: 'Changed' }],
      [`/api/poam/${item.id}/closeout`, { closedOn: '2026-11-23', note: null }],
    ] as const) {
      const patchOrPost = url.endsWith('closeout') ? 'post' : 'patch';
      const unsigned = await anonymous[patchOrPost](url, payload);
      expect(unsigned.statusCode, url).toBe(401);
      const forged = await admin[patchOrPost](url, payload, { headers: { 'x-csrf-token': null } });
      expect(forged.statusCode, url).toBe(403);
      expect(envelope(forged.body).code).toBe('csrf_failed');
    }
    expect(h.db.select().from(poamItem).all()).toEqual(before);
    expect(poamEvents(h)).toHaveLength(eventCount);
  });
});
