import { loadCatalog } from '@rampart/catalog';
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

const DAY = 86_400_000;
const ONE_POINT = 'AC.L2-3.1.3';
const OTHER_ONE_POINT = 'AC.L2-3.1.4';
const CONTRIBUTOR = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'a long enough password',
};

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  expect((await admin.post('/api/users', CONTRIBUTOR)).statusCode).toBe(201);
  return { h, admin };
}

/** Moves the clock by whole days and signs in again: a session lasts 12 hours at most. */
async function daysLater(h: Harness, days: number, who: { email: string; password: string }) {
  h.clock.advance(days * DAY);
  return h.signIn(who.email, who.password);
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

async function create(client: Client, requirementId = ONE_POINT): Promise<PoamItem> {
  await mark(client, requirementId, 'not_met');
  const response = await client.post('/api/poam', {
    requirementId,
    plan: 'Fix',
    due: '2026-12-31',
  });
  expect(response.statusCode, response.body).toBe(201);
  return poamItemResponseSchema.parse(response.json()).item;
}

async function setAssessment(client: Client, body: Record<string, unknown>) {
  const response = await client.patch('/api/assessment', body);
  expect(response.statusCode, response.body).toBe(200);
}

function envelope(body: string): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error;
}

async function closeout(client: Client, item: PoamItem, body: Record<string, unknown>) {
  return client.post(`/api/poam/${item.id}/closeout`, body);
}

async function closed(client: Client, item: PoamItem, body: Record<string, unknown>) {
  const response = await closeout(client, item, body);
  expect(response.statusCode, response.body).toBe(200);
  return poamItemResponseSchema.parse(response.json()).item;
}

function poamEvents(h: Harness) {
  return h.db
    .select()
    .from(auditEvent)
    .where(like(auditEvent.action, 'poam_item.%'))
    .all()
    .map((e) => ({
      action: e.action,
      entityId: e.entityId,
      before: JSON.parse(e.before ?? 'null') as unknown,
      after: JSON.parse(e.after ?? 'null') as unknown,
    }));
}

describe('POST /api/poam/:id/closeout', () => {
  it('refusals', async () => {
    const { h, admin: first } = await world();
    const item = await create(first);
    // Today is 2026-11-25; the item was created on 2026-11-23.
    const admin = await daysLater(h, 2, ADMIN);
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
    const rows = h.db.select().from(poamItem).all();
    const events = poamEvents(h);
    const valid = { closedOn: '2026-11-24', note: 'Verified' };

    const contributor = await closeout(carl, item, valid);
    expect(contributor.statusCode).toBe(403);
    expect(envelope(contributor.body).code).toBe('forbidden');

    const notReady = await closeout(admin, item, valid);
    expect(notReady.statusCode).toBe(409);
    expect(envelope(notReady.body)).toMatchObject({
      code: 'closeout_not_ready',
      details: { requirementStatus: 'not_met' },
    });

    await mark(admin, ONE_POINT, 'met');
    const bad: [string, Record<string, unknown>][] = [
      ['tomorrow', { ...valid, closedOn: '2026-11-26' }],
      ['before creation', { ...valid, closedOn: '2026-11-22' }],
      ['c3pao name on a self-assessment', { ...valid, c3paoName: 'Acme C3PAO' }],
      ['whitespace c3pao name', { ...valid, c3paoName: '   ' }],
    ];
    for (const [label, body] of bad) {
      const response = await closeout(admin, item, body);
      expect(response.statusCode, label).toBe(400);
      expect(envelope(response.body).code, label).toBe('validation_failed');
    }

    await setAssessment(admin, { type: 'c3pao' });
    for (const body of [valid, { ...valid, c3paoName: null }]) {
      const response = await closeout(admin, item, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(envelope(response.body).code).toBe('validation_failed');
    }

    const unknown = await admin.post('/api/poam/6f1c1b1e-5b7a-4c1e-9a43-1d2a3b4c5d6e/closeout', {
      ...valid,
      c3paoName: 'Acme',
    });
    expect(unknown.statusCode).toBe(404);

    expect(h.db.select().from(poamItem).all()).toEqual(rows);
    expect(poamEvents(h)).toEqual(events);
  });

  it('records closeout', async () => {
    const { h, admin: first } = await world();
    const item = await create(first);
    await mark(first, ONE_POINT, 'met');
    const admin = await daysLater(h, 1, ADMIN);

    // The day it was created and today are both allowed; a self-assessment's null name is fine.
    const done = await closed(admin, item, {
      closedOn: '2026-11-23',
      note: '  Verified by test  ',
      c3paoName: null,
    });
    expect(done).toMatchObject({
      status: 'closed',
      updatedAt: '2026-11-24T09:00:00.000Z',
      readyToClose: false,
      overdue: false,
      closeout: {
        closedOn: '2026-11-23',
        note: 'Verified by test',
        confirmedBy: 'organization',
        c3paoName: null,
        recordedBy: { displayName: ADMIN.displayName },
        late: false,
      },
    });
    expect(poamEvents(h).at(-1)).toEqual({
      action: 'poam_item.closed',
      entityId: item.id,
      before: { status: 'open' },
      after: {
        status: 'closed',
        closedOn: '2026-11-23',
        note: 'Verified by test',
        confirmedBy: 'organization',
        c3paoName: null,
      },
    });

    const eventCount = poamEvents(h).length;
    const repeat = await closeout(admin, item, { closedOn: '2026-11-23', note: null });
    expect(repeat.statusCode).toBe(409);
    expect(envelope(repeat.body).code).toBe('poam_item_closed');
    expect(poamEvents(h)).toHaveLength(eventCount);

    // A C3PAO assessment records the C3PAO; changing the type later rewrites neither closeout.
    await setAssessment(admin, { type: 'c3pao' });
    const second = await create(admin, OTHER_ONE_POINT);
    await mark(admin, OTHER_ONE_POINT, 'met');
    const byC3pao = await closed(admin, second, {
      closedOn: '2026-11-24',
      note: null,
      c3paoName: '  Acme Assessors  ',
    });
    expect(byC3pao.closeout).toMatchObject({ confirmedBy: 'c3pao', c3paoName: 'Acme Assessors' });

    await setAssessment(admin, { type: 'self' });
    const v = poamViewSchema.parse((await admin.get('/api/poam')).json());
    expect(v.confirmer).toBe('organization');
    expect(v.items.map((i) => [i.requirementId, i.closeout?.confirmedBy])).toEqual([
      [OTHER_ONE_POINT, 'c3pao'],
      [ONE_POINT, 'organization'],
    ]);

    // 2026-05-27 + 180 days = 2026-11-23: closing on the deadline is on time, after it is late.
    await setAssessment(admin, { conditionalStatusDate: '2026-05-27' });
    const late = poamViewSchema.parse((await admin.get('/api/poam')).json());
    expect(late.closeout?.deadline).toBe('2026-11-23');
    expect(late.items.map((i) => [i.requirementId, i.closeout?.late])).toEqual([
      [OTHER_ONE_POINT, true],
      [ONE_POINT, false],
    ]);
  });
});
