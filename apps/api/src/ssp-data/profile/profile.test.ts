import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from '../../../db/client';
import { sspProfile } from '../../../db/schema';
import { createMemoryStore } from '../../../storage';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import {
  CSRF_HEADER,
  DEFAULT_CATEGORIZATION,
  DEFAULT_REVIEW_CADENCE_MONTHS,
  SESSION_COOKIE,
  SSP_PROFILE_FIELDS,
  auditPageSchema,
  errorEnvelopeSchema,
  sessionResponseSchema,
  sspProfileResponseSchema,
  userResponseSchema,
  type AuditPage,
  type SspProfile,
} from '../../contract';
import { ADMIN, START, createHarness, type Client, type Harness } from '../../testing/harness';
import { loadSspProfile } from './repository';

const URL = '/api/ssp/profile';

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

/** What a profile with no saved row reads as. */
const EMPTY: SspProfile = {
  ...(Object.fromEntries(SSP_PROFILE_FIELDS.map(({ key }) => [key, null])) as Record<string, null>),
  categorization: DEFAULT_CATEGORIZATION,
  reviewCadenceMonths: DEFAULT_REVIEW_CADENCE_MONTHS,
  updatedAt: null,
  updatedBy: null,
} as SspProfile;

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  return { h, admin };
}

function profileOf(response: LightMyRequestResponse): SspProfile {
  expect(response.statusCode, response.body).toBe(200);
  return sspProfileResponseSchema.parse(response.json()).profile;
}

function code(response: LightMyRequestResponse): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

async function profileEvents(client: Client): Promise<AuditPage['events']> {
  const response = await client.get('/api/audit?entityType=ssp_profile');
  expect(response.statusCode, response.body).toBe(200);
  return auditPageSchema.parse(response.json()).events;
}

function activeAssessmentId(h: Harness): string {
  const row = h.handle.sqlite.prepare('select id from assessment').pluck().get();
  if (typeof row !== 'string') throw new Error('no assessment');
  return row;
}

function dropAssessment(h: Harness): void {
  // Setup always creates the assessment; remove it to reach the state the routes guard against.
  h.handle.sqlite.pragma('foreign_keys = OFF');
  h.handle.sqlite.exec('DELETE FROM assessment');
  h.handle.sqlite.pragma('foreign_keys = ON');
}

describe('ssp profile routes', () => {
  it('empty profile', async () => {
    const { h, admin } = await world();

    expect(profileOf(await admin.get(URL))).toEqual(EMPTY);
    // Reading creates nothing, through the route or the exported read path.
    expect(h.db.select().from(sspProfile).all()).toEqual([]);
    expect(loadSspProfile(h.db, activeAssessmentId(h))).toEqual(EMPTY);
    expect(loadSspProfile(h.db, 'no-such-assessment')).toEqual(EMPTY);
    expect(h.db.select().from(sspProfile).all()).toEqual([]);
  });

  it('audit edges', async () => {
    const { h, admin } = await world();
    const assessmentId = activeAssessmentId(h);
    const adminRef = { id: admin.user?.id, displayName: ADMIN.displayName };

    // Effective no-ops on an empty profile: the default text, the default cadence and blanks.
    for (const body of [
      { categorization: DEFAULT_CATEGORIZATION },
      { categorization: `  ${DEFAULT_CATEGORIZATION} ` },
      { categorization: null },
      { categorization: '   ' },
      { reviewCadenceMonths: 12 },
      { securityOfficer: '  ', cuiCategories: '', nextReviewDate: null },
    ]) {
      expect(profileOf(await admin.patch(URL, body)), JSON.stringify(body)).toEqual(EMPTY);
    }
    expect(h.db.select().from(sspProfile).all()).toEqual([]);
    expect(await profileEvents(admin)).toEqual([]);

    // The first change creates the row (cadence stored as 12) and audits with before null.
    h.clock.advance(60_000);
    const firstAt = h.clock.now().toISOString();
    const first = profileOf(
      await admin.patch(URL, {
        securityOfficer: '  Sam Officer ',
        securityOfficerEmail: ' Sam@Example.com ',
        organizationPhone: '+1 (555) 010-0000 x12',
        reviewCadenceMonths: 12,
        categorization: DEFAULT_CATEGORIZATION,
      }),
    );
    expect(first).toEqual({
      ...EMPTY,
      securityOfficer: 'Sam Officer',
      securityOfficerEmail: 'sam@example.com',
      organizationPhone: '+1 (555) 010-0000 x12',
      updatedAt: firstAt,
      updatedBy: adminRef,
    });
    const rows = h.db.select().from(sspProfile).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assessmentId,
      categorization: null,
      reviewCadenceMonths: 12,
      updatedAt: firstAt,
    });
    let events = await profileEvents(admin);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      at: firstAt,
      actor: adminRef,
      action: 'ssp_profile.updated',
      entityType: 'ssp_profile',
      entityId: assessmentId,
      before: null,
      after: {
        securityOfficer: 'Sam Officer',
        securityOfficerEmail: 'sam@example.com',
        organizationPhone: '+1 (555) 010-0000 x12',
      },
    });
    expect(events[0]?.after).not.toHaveProperty('reviewCadenceMonths');
    expect(events[0]?.after).not.toHaveProperty('categorization');

    // A change audits only the changed fields; a past review date is accepted.
    h.clock.advance(60_000);
    const secondAt = h.clock.now().toISOString();
    const second = profileOf(
      await admin.patch(URL, {
        securityOfficer: 'Sam Officer',
        categorization: ' High impact ',
        reviewCadenceMonths: 6,
        nextReviewDate: '2020-01-31',
        securityOfficerEmail: null,
      }),
    );
    expect(second).toMatchObject({
      securityOfficer: 'Sam Officer',
      categorization: 'High impact',
      reviewCadenceMonths: 6,
      nextReviewDate: '2020-01-31',
      securityOfficerEmail: null,
      updatedAt: secondAt,
    });
    events = await profileEvents(admin);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      at: secondAt,
      before: {
        categorization: DEFAULT_CATEGORIZATION,
        reviewCadenceMonths: 12,
        nextReviewDate: null,
        securityOfficerEmail: 'sam@example.com',
      },
      after: {
        categorization: 'High impact',
        reviewCadenceMonths: 6,
        nextReviewDate: '2020-01-31',
        securityOfficerEmail: null,
      },
    });
    expect(events[0]?.before).not.toHaveProperty('securityOfficer');

    // The same values again, spelled differently, change nothing and keep the save stamp.
    h.clock.advance(60_000);
    const again = profileOf(
      await admin.patch(URL, {
        categorization: 'High impact  ',
        reviewCadenceMonths: 6,
        securityOfficerEmail: ' ',
      }),
    );
    expect(again).toEqual(second);
    expect(await profileEvents(admin)).toHaveLength(2);
    expect(h.db.select().from(sspProfile).all()[0]?.updatedAt).toBe(secondAt);

    // Null categorization resets to the default, stored as null.
    h.clock.advance(60_000);
    const reset = profileOf(await admin.patch(URL, { categorization: null }));
    expect(reset.categorization).toBe(DEFAULT_CATEGORIZATION);
    expect(h.db.select().from(sspProfile).all()[0]?.categorization).toBeNull();
    events = await profileEvents(admin);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      before: { categorization: 'High impact' },
      after: { categorization: DEFAULT_CATEGORIZATION },
    });

    // Sending the default text over a custom value is a reset too: stored null.
    await admin.patch(URL, { categorization: 'Low' });
    profileOf(await admin.patch(URL, { categorization: DEFAULT_CATEGORIZATION }));
    expect(h.db.select().from(sspProfile).all()[0]?.categorization).toBeNull();
    expect(await profileEvents(admin)).toHaveLength(5);

    // The cadence edges: 1 and 60 pass.
    expect(profileOf(await admin.patch(URL, { reviewCadenceMonths: 1 })).reviewCadenceMonths).toBe(
      1,
    );
    expect(profileOf(await admin.patch(URL, { reviewCadenceMonths: 60 })).reviewCadenceMonths).toBe(
      60,
    );
  });

  it('access', async () => {
    const { h, admin } = await world();
    const created = userResponseSchema.parse((await admin.post('/api/users', CONTRIBUTOR)).json());
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);

    // A contributor reads and writes, and is the one recorded.
    profileOf(await carl.get(URL));
    const saved = profileOf(await carl.patch(URL, { cuiCategories: 'Controlled Technical Info' }));
    expect(saved.cuiCategories).toBe('Controlled Technical Info');
    expect(saved.updatedBy).toEqual({ id: created.user.id, displayName: CONTRIBUTOR.displayName });
    expect((await profileEvents(admin))[0]?.actor?.id).toBe(created.user.id);

    // Signed out: 401 for both.
    const anonymous = h.client();
    const signedOutGet = await anonymous.get(URL);
    expect(signedOutGet.statusCode).toBe(401);
    expect(code(signedOutGet)).toBe('unauthenticated');
    expect((await anonymous.patch(URL, { securityOfficer: 'X' })).statusCode).toBe(401);

    // A missing CSRF token: 403 csrf_failed, and nothing changes.
    const forged = await carl.patch(
      URL,
      { securityOfficer: 'Forged' },
      { headers: { [CSRF_HEADER]: null } },
    );
    expect(forged.statusCode).toBe(403);
    expect(code(forged)).toBe('csrf_failed');

    // Bad bodies: 400, and nothing changes.
    for (const body of [
      {},
      { nope: 1 },
      { reviewCadenceMonths: 0 },
      { reviewCadenceMonths: 61 },
      { reviewCadenceMonths: 1.5 },
      { reviewCadenceMonths: null },
      { reviewCadenceMonths: '12' },
      { nextReviewDate: '2026-02-30' },
      { securityOfficerEmail: 'not an email' },
      { organizationPhone: 'call me' },
      { securityOfficer: 'x'.repeat(201) },
      { cuiCategories: 'x'.repeat(20_001) },
      { inventoryReference: 'x'.repeat(2_001) },
    ]) {
      const bad = await carl.patch(URL, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
      expect(code(bad)).toBe('validation_failed');
    }
    expect(profileOf(await admin.get(URL))).toEqual(saved);
    expect(await profileEvents(admin)).toHaveLength(1);

    // No assessment: 404 for both, but a bad body is still a 400 first.
    dropAssessment(h);
    const missingGet = await admin.get(URL);
    expect(missingGet.statusCode).toBe(404);
    expect(code(missingGet)).toBe('not_found');
    const missingPatch = await admin.patch(URL, { securityOfficer: 'Y' });
    expect(missingPatch.statusCode).toBe(404);
    expect(code(missingPatch)).toBe('not_found');
    expect((await admin.patch(URL, {})).statusCode).toBe(400);
  });

  it('persists across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-ssp-profile-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'rampart.sqlite');
    const now = () => START;

    function start(): { app: FastifyInstance; handle: DbHandle } {
      const handle = openDb(path);
      runMigrations(handle.db);
      const config = loadConfig({ DATABASE_PATH: path, LOG_LEVEL: 'silent' });
      const app = buildApp({ config, db: handle.db, now, store: createMemoryStore() });
      cleanups.push(async () => {
        await app.close();
        if (handle.sqlite.open) handle.sqlite.close();
      });
      return { app, handle };
    }

    async function session(app: FastifyInstance, url: string, payload: unknown) {
      const response = await app.inject({ method: 'POST', url, payload: payload as object });
      expect(response.statusCode, response.body).toBeLessThan(300);
      const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
      const { csrfToken } = sessionResponseSchema.parse(response.json());
      return { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrfToken ?? '' };
    }

    const first = start();
    const headers = await session(first.app, '/api/setup', ADMIN);
    const saved = profileOf(
      await first.app.inject({
        method: 'PATCH',
        url: URL,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: JSON.stringify({
          categorization: 'Moderate',
          cuiLocations: 'File server FS-01',
          reviewCadenceMonths: 24,
          nextReviewDate: '2027-06-30',
        }),
      }),
    );
    await first.app.close();
    first.handle.sqlite.close();

    const second = start();
    const again = await session(second.app, '/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    const read = profileOf(await second.app.inject({ method: 'GET', url: URL, headers: again }));
    expect(read).toEqual(saved);
    expect(read).toMatchObject({
      categorization: 'Moderate',
      cuiLocations: 'File server FS-01',
      reviewCadenceMonths: 24,
      nextReviewDate: '2027-06-30',
      updatedAt: START.toISOString(),
    });
  });
});
