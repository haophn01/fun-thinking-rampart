import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../../../db/client';
import { auditEvent, sspProfile, sspRevision } from '../../../db/schema';
import { createMemoryStore } from '../../../storage';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  approvalResponseSchema,
  auditPageSchema,
  documentControlSchema,
  errorEnvelopeSchema,
  revisionResponseSchema,
  sessionResponseSchema,
  userResponseSchema,
  type AuditPage,
  type DocumentControl,
  type SspApproval,
  type SspRevision,
} from '../../contract';
import { ADMIN, START, createHarness, type Client, type Harness } from '../../testing/harness';
import { requireAssessmentId } from '../common';
import { appendExportRevision } from './repository';

const DC = '/api/ssp/document-control';
const REVISIONS = '/api/ssp/revisions';
const APPROVALS = '/api/ssp/approvals';
const HOUR = 60 * 60 * 1000;
/** START's UTC date. */
const TODAY = '2026-11-23';
const TOMORROW = '2026-11-24';
const APPROVED = '2026-11-20';

const harnesses: Harness[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const CONTRIBUTOR = {
  email: 'carl@example.com',
  displayName: 'Carl Contributor',
  role: 'contributor',
  password: 'a long enough password',
};

async function world(start = START): Promise<{ h: Harness; admin: Client; carl: Client }> {
  const h = createHarness({ start });
  harnesses.push(h);
  const admin = await h.setupAdmin();
  userResponseSchema.parse((await admin.post('/api/users', CONTRIBUTOR)).json());
  const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);
  return { h, admin, carl };
}

function errorOf(response: LightMyRequestResponse) {
  return errorEnvelopeSchema.parse(JSON.parse(response.body)).error;
}

function userIdOf(client: Client): string {
  const id = client.user?.id;
  if (id === undefined) throw new Error('client is not signed in');
  return id;
}

async function control(client: Client): Promise<DocumentControl> {
  const response = await client.get(DC);
  expect(response.statusCode, response.body).toBe(200);
  return documentControlSchema.parse(response.json());
}

async function addRevision(client: Client, body: Record<string, unknown>): Promise<SspRevision> {
  const response = await client.post(REVISIONS, body);
  expect(response.statusCode, response.body).toBe(201);
  return revisionResponseSchema.parse(response.json()).revision;
}

async function addApproval(client: Client, body: Record<string, unknown>): Promise<SspApproval> {
  const response = await client.post(APPROVALS, body);
  expect(response.statusCode, response.body).toBe(201);
  return approvalResponseSchema.parse(response.json()).approval;
}

async function events(client: Client, entityType: string): Promise<AuditPage['events']> {
  const response = await client.get(`/api/audit?entityType=${entityType}`);
  expect(response.statusCode, response.body).toBe(200);
  return auditPageSchema.parse(response.json()).events;
}

function eventCount(h: Harness): number {
  return h.db.select().from(auditEvent).all().length;
}

/** Stores the profile row as A7's `PATCH /api/ssp/profile` would. */
function storeProfile(
  h: Harness,
  admin: Client,
  review: { reviewCadenceMonths: number; nextReviewDate: string | null },
): void {
  h.db
    .insert(sspProfile)
    .values({
      assessmentId: requireAssessmentId(h.db),
      ...review,
      updatedBy: userIdOf(admin),
      updatedAt: START.toISOString(),
    })
    .run();
}

describe('document control', () => {
  it('reads an empty document control with the default cadence before any profile', async () => {
    const { carl } = await world();
    expect(await control(carl)).toEqual({
      reviewCadenceMonths: 12,
      nextReviewDate: null,
      nextReviewDue: null,
      daysToReview: null,
      reviewOverdue: false,
      revisions: [],
      approvals: [],
    });
  });

  it('is 401 signed out', async () => {
    const h = createHarness();
    harnesses.push(h);
    expect((await h.client().get(DC)).statusCode).toBe(401);
  });

  it('derives the due date from the latest live approval plus the stored cadence', async () => {
    const { h, admin } = await world();
    storeProfile(h, admin, { reviewCadenceMonths: 3, nextReviewDate: null });
    await addApproval(admin, { name: 'Ada', title: 'CEO', approvedOn: '2026-08-31' });
    const later = await addApproval(admin, { name: 'Bo', title: 'CISO', approvedOn: '2026-11-20' });
    await addApproval(admin, { name: 'Cy', title: 'CTO', approvedOn: null });
    expect(await control(admin)).toMatchObject({
      reviewCadenceMonths: 3,
      nextReviewDate: null,
      nextReviewDue: '2027-02-20',
      daysToReview: 89,
      reviewOverdue: false,
    });
    // Removing the latest approval falls back to the earlier one: 2026-08-31 + 3 is 2026-11-30.
    expect((await admin.delete(`${APPROVALS}/${later.id}`)).statusCode).toBe(204);
    expect(await control(admin)).toMatchObject({ nextReviewDue: '2026-11-30', daysToReview: 7 });
  });
});

describe('manual revisions', () => {
  it('saves one dated today with madeBy defaulting to the actor, and audits it', async () => {
    const { h, carl } = await world();
    const revision = await addRevision(carl, { date: TODAY, description: '  First issue  ' });
    expect(revision).toEqual({
      id: expect.any(String) as string,
      kind: 'manual',
      date: TODAY,
      description: 'First issue',
      madeBy: CONTRIBUTOR.displayName,
      createdAt: START.toISOString(),
    });
    const created = await events(carl, 'ssp_revision');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      action: 'ssp_revision.created',
      entityId: revision.id,
      before: null,
      after: {
        kind: 'manual',
        date: TODAY,
        description: 'First issue',
        madeBy: CONTRIBUTOR.displayName,
      },
    });
    expect((await control(carl)).revisions).toEqual([revision]);
    expect(h.db.select().from(sspRevision).all()).toHaveLength(1);
  });

  it('keeps a madeBy that is sent, and refuses a blank one', async () => {
    const { carl } = await world();
    const named = await addRevision(carl, {
      date: '2026-01-02',
      description: 'x',
      madeBy: ' Pat ',
    });
    expect(named.madeBy).toBe('Pat');
    const blank = await carl.post(REVISIONS, { date: TODAY, description: 'x', madeBy: '   ' });
    expect(blank.statusCode).toBe(400);
  });

  it('refuses tomorrow by the UTC date, even late in the UTC day', async () => {
    const { h, carl } = await world(new Date(`${TODAY}T23:59:59.999Z`));
    const response = await carl.post(REVISIONS, { date: TOMORROW, description: 'Future' });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response)).toMatchObject({
      code: 'validation_failed',
      details: [{ path: ['date'] }],
    });
    expect(h.db.select().from(sspRevision).all()).toEqual([]);
    h.clock.advance(1);
    await addRevision(carl, { date: TOMORROW, description: 'Now today' });
  });

  it('refuses unknown keys, a blank description and an unreal date', async () => {
    const { h, carl } = await world();
    for (const body of [
      { date: TODAY, description: 'x', kind: 'export' },
      { date: TODAY, description: '  ' },
      { date: '2026-02-30', description: 'x' },
      { description: 'x' },
    ]) {
      expect((await carl.post(REVISIONS, body)).statusCode).toBe(400);
    }
    expect(h.db.select().from(sspRevision).all()).toEqual([]);
  });

  it('orders by date, then createdAt, then id', async () => {
    const { h, carl } = await world();
    const b = await addRevision(carl, { date: '2026-05-01', description: 'b' });
    h.clock.advance(1000);
    const a = await addRevision(carl, { date: '2026-01-01', description: 'a' });
    h.clock.advance(1000);
    const c = await addRevision(carl, { date: '2026-05-01', description: 'c' });
    expect((await control(carl)).revisions.map((r) => r.id)).toEqual([a.id, b.id, c.id]);
  });

  it('has no update or delete', async () => {
    const { h, admin } = await world();
    const revision = await addRevision(admin, { date: TODAY, description: 'Keep me' });
    const before = eventCount(h);
    const patched = await admin.patch(`${REVISIONS}/${revision.id}`, { description: 'Changed' });
    const removed = await admin.delete(`${REVISIONS}/${revision.id}`);
    expect([404, 405]).toContain(patched.statusCode);
    expect([404, 405]).toContain(removed.statusCode);
    expect((await control(admin)).revisions).toEqual([revision]);
    expect(eventCount(h)).toBe(before);
  });
});

describe('export revision', () => {
  it('adds an export entry dated UTC today, with its event, inside the caller transaction', async () => {
    const { h, admin } = await world(new Date(`${TODAY}T23:30:00.000Z`));
    const actor = { userId: userIdOf(admin), now: h.clock.now(), requestId: 'req-1' };
    h.db.transaction((tx) => {
      const assessmentId = requireAssessmentId(tx);
      appendExportRevision(tx, { assessmentId, actor, description: 'Exported SSP' });
      appendExportRevision(tx, { assessmentId, actor, description: 'Exported SSP' });
    });
    const { revisions } = await control(admin);
    expect(revisions).toHaveLength(2);
    for (const revision of revisions) {
      expect(revision).toMatchObject({
        kind: 'export',
        date: TODAY,
        description: 'Exported SSP',
        madeBy: ADMIN.displayName,
      });
    }
    const created = await events(admin, 'ssp_revision');
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      action: 'ssp_revision.created',
      before: null,
      after: {
        kind: 'export',
        date: TODAY,
        description: 'Exported SSP',
        madeBy: ADMIN.displayName,
      },
    });
  });

  it('adds neither the entry nor its event when the transaction rolls back', async () => {
    const { h, admin } = await world();
    const actor = { userId: userIdOf(admin), now: h.clock.now(), requestId: 'req-2' };
    const before = eventCount(h);
    expect(() =>
      h.db.transaction((tx) => {
        appendExportRevision(tx, {
          assessmentId: requireAssessmentId(tx),
          actor,
          description: 'Exported SSP',
        });
        throw new Error('export failed');
      }),
    ).toThrow('export failed');
    expect(h.db.select().from(sspRevision).all()).toEqual([]);
    expect(eventCount(h)).toBe(before);
  });
});

describe('approvals', () => {
  it('lets an admin create, patch and remove, each with its event', async () => {
    const { h, admin } = await world();
    const approval = await addApproval(admin, { name: ' Ada ', title: 'CEO', approvedOn: null });
    expect(approval).toEqual({
      id: expect.any(String) as string,
      name: 'Ada',
      title: 'CEO',
      approvedOn: null,
      createdAt: START.toISOString(),
      updatedAt: START.toISOString(),
    });

    h.clock.advance(HOUR);
    const patched = await admin.patch(`${APPROVALS}/${approval.id}`, { approvedOn: APPROVED });
    expect(patched.statusCode, patched.body).toBe(200);
    const changedAt = new Date(START.getTime() + HOUR).toISOString();
    expect(approvalResponseSchema.parse(patched.json()).approval).toMatchObject({
      approvedOn: APPROVED,
      updatedAt: changedAt,
    });

    // Sending what is stored changes nothing: no event, updatedAt kept.
    h.clock.advance(HOUR);
    const before = eventCount(h);
    const same = await admin.patch(`${APPROVALS}/${approval.id}`, {
      name: 'Ada',
      approvedOn: APPROVED,
    });
    expect(same.statusCode).toBe(200);
    expect(approvalResponseSchema.parse(same.json()).approval.updatedAt).toBe(changedAt);
    expect(eventCount(h)).toBe(before);

    expect((await admin.delete(`${APPROVALS}/${approval.id}`)).statusCode).toBe(204);
    expect((await control(admin)).approvals).toEqual([]);

    const log = await events(admin, 'ssp_approval');
    expect(log).toHaveLength(3);
    const byAction = Object.fromEntries(log.map((e) => [e.action, e]));
    expect(byAction['ssp_approval.created']).toMatchObject({
      entityId: approval.id,
      before: null,
      after: { name: 'Ada', title: 'CEO', approvedOn: null },
    });
    expect(byAction['ssp_approval.updated']).toEqual(
      expect.objectContaining({ before: { approvedOn: null }, after: { approvedOn: APPROVED } }),
    );
    expect(byAction['ssp_approval.removed']).toMatchObject({
      before: { name: 'Ada', title: 'CEO', approvedOn: APPROVED },
      after: null,
    });

    // A removed approval is gone for good.
    expect((await admin.delete(`${APPROVALS}/${approval.id}`)).statusCode).toBe(404);
    expect((await admin.patch(`${APPROVALS}/${approval.id}`, { name: 'X' })).statusCode).toBe(404);
  });

  it('refuses a contributor with 403 before reading the body, and lets them read', async () => {
    const { admin, carl } = await world();
    const approval = await addApproval(admin, { name: 'Ada', title: 'CEO', approvedOn: TODAY });
    for (const response of [
      await carl.post(APPROVALS, { name: 'Carl', title: 'Me', approvedOn: null }),
      await carl.post(APPROVALS, { bogus: true }),
      await carl.patch(`${APPROVALS}/${approval.id}`, { name: 'Carl' }),
      await carl.delete(`${APPROVALS}/${approval.id}`),
    ]) {
      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe('forbidden');
    }
    expect((await control(carl)).approvals).toEqual([approval]);
  });

  it('refuses a future approvedOn on create and patch, and allows today and null', async () => {
    const { h, admin } = await world();
    const created = await admin.post(APPROVALS, { name: 'A', title: 'B', approvedOn: TOMORROW });
    expect(created.statusCode).toBe(400);
    expect(errorOf(created)).toMatchObject({ details: [{ path: ['approvedOn'] }] });
    const ok = await addApproval(admin, { name: 'A', title: 'B', approvedOn: TODAY });
    const future = await admin.patch(`${APPROVALS}/${ok.id}`, { approvedOn: TOMORROW });
    expect(future.statusCode).toBe(400);
    expect(errorOf(future)).toMatchObject({ details: [{ path: ['approvedOn'] }] });
    expect((await admin.patch(`${APPROVALS}/${ok.id}`, { approvedOn: null })).statusCode).toBe(200);
    // approvedOn is a required key, though it may be null; a patch must name something.
    expect((await admin.post(APPROVALS, { name: 'A', title: 'B' })).statusCode).toBe(400);
    expect((await admin.patch(`${APPROVALS}/${ok.id}`, {})).statusCode).toBe(400);
    expect((await admin.patch(`${APPROVALS}/${ok.id}`, { title: ' ' })).statusCode).toBe(400);
    expect((await admin.patch(`${APPROVALS}/nope`, { title: 'x' })).statusCode).toBe(404);
    expect((await admin.delete(`${APPROVALS}/nope`)).statusCode).toBe(404);
    const approvalEvents = h.db
      .select()
      .from(auditEvent)
      .all()
      .filter((e) => e.action.startsWith('ssp_approval'));
    expect(approvalEvents).toHaveLength(2);
  });

  it('orders by createdAt, then id', async () => {
    const { h, admin } = await world();
    const first = await addApproval(admin, { name: 'Zed', title: 'B', approvedOn: TODAY });
    h.clock.advance(1000);
    const second = await addApproval(admin, { name: 'Amy', title: 'B', approvedOn: '2026-01-01' });
    expect((await control(admin)).approvals.map((a) => a.id)).toEqual([first.id, second.id]);
  });
});

describe('overdue and persistence', () => {
  it('a past nextReviewDate makes the review overdue, and wins over the approvals', async () => {
    const { h, admin } = await world();
    await addApproval(admin, { name: 'Ada', title: 'CEO', approvedOn: TODAY });
    expect(await control(admin)).toMatchObject({
      nextReviewDue: '2027-11-23',
      reviewOverdue: false,
    });
    storeProfile(h, admin, { reviewCadenceMonths: 12, nextReviewDate: '2026-11-01' });
    expect(await control(admin)).toMatchObject({
      reviewCadenceMonths: 12,
      nextReviewDate: '2026-11-01',
      nextReviewDue: '2026-11-01',
      daysToReview: -22,
      reviewOverdue: true,
    });
  });

  it('keeps revisions and approvals across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-doc-control-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'rampart.sqlite');
    const now = () => START;

    function start(): FastifyInstance {
      const handle = openDb(path);
      runMigrations(handle.db);
      const config = loadConfig({ DATABASE_PATH: path, LOG_LEVEL: 'silent' });
      const app = buildApp({ config, db: handle.db, now, store: createMemoryStore() });
      cleanups.push(async () => {
        await app.close();
        if (handle.sqlite.open) handle.sqlite.close();
      });
      return app;
    }

    async function session(app: FastifyInstance, url: string, payload: object) {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode, response.body).toBeLessThan(300);
      const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
      const { csrfToken } = sessionResponseSchema.parse(response.json());
      return { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrfToken ?? '' };
    }

    const first = start();
    const headers = await session(first, '/api/setup', ADMIN);
    const writes: [string, object][] = [
      [REVISIONS, { date: TODAY, description: 'Issued' }],
      [APPROVALS, { name: 'Ada', title: 'CEO', approvedOn: TODAY }],
    ];
    for (const [url, payload] of writes) {
      const response = await first.inject({ method: 'POST', url, headers, payload });
      expect(response.statusCode, response.body).toBe(201);
    }
    const written = documentControlSchema.parse(
      (await first.inject({ method: 'GET', url: DC, headers })).json(),
    );
    await first.close();

    const second = start();
    const again = await session(second, '/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    const read = documentControlSchema.parse(
      (await second.inject({ method: 'GET', url: DC, headers: again })).json(),
    );
    expect(read).toEqual(written);
    expect(read.revisions).toHaveLength(1);
    expect(read.approvals).toHaveLength(1);
  });
});
