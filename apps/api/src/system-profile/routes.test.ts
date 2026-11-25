import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from '../../db/client';
import { auditEvent, systemProfile } from '../../db/schema';
import { createMemoryStore } from '../../storage';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  SYSTEM_PROFILE_FIELDS,
  auditPageSchema,
  errorEnvelopeSchema,
  sessionResponseSchema,
  systemProfileResponseSchema,
  userResponseSchema,
  type AuditPage,
  type SystemProfile,
} from '../contract';
import { ADMIN, START, createHarness, type Client, type Harness } from '../testing/harness';
import { loadSystemProfile } from './repository';

const URL = '/api/system-profile';
const DAY = 24 * 60 * 60 * 1000;

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

const EMPTY_FIELDS = Object.fromEntries(SYSTEM_PROFILE_FIELDS.map(({ key }) => [key, null]));

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  return { h, admin };
}

function profileOf(response: LightMyRequestResponse): SystemProfile {
  expect(response.statusCode, response.body).toBe(200);
  return systemProfileResponseSchema.parse(response.json()).profile;
}

function code(response: LightMyRequestResponse): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

async function profileEvents(client: Client): Promise<AuditPage['events']> {
  const response = await client.get('/api/audit?entityType=system_profile');
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

describe('system profile routes', () => {
  it('empty profile', async () => {
    const { h, admin } = await world();

    const profile = profileOf(await admin.get(URL));
    expect(profile).toEqual({ ...EMPTY_FIELDS, updatedAt: null, updatedBy: null });
    // Reading creates nothing.
    expect(h.db.select().from(systemProfile).all()).toEqual([]);
    expect(loadSystemProfile(h.db, activeAssessmentId(h))).toEqual(profile);
    // An unknown assessment reads as empty too: the read path never throws for a missing row.
    expect(loadSystemProfile(h.db, 'no-such-assessment')).toEqual(profile);
  });

  it('audit edges', async () => {
    const { h, admin } = await world();
    const assessmentId = activeAssessmentId(h);
    const adminRef = { id: admin.user?.id, displayName: ADMIN.displayName };

    // A patch that sets nothing new (only nulls on an empty profile) writes no row and no event.
    const noop = profileOf(await admin.patch(URL, { systemName: '   ', cageCode: null }));
    expect(noop).toEqual({ ...EMPTY_FIELDS, updatedAt: null, updatedBy: null });
    expect(h.db.select().from(systemProfile).all()).toEqual([]);
    expect(await profileEvents(admin)).toEqual([]);

    // The first save creates the row and audits with `before` null and the set fields after.
    h.clock.advance(60_000);
    const firstAt = h.clock.now().toISOString();
    const first = profileOf(
      await admin.patch(URL, {
        systemName: '  Prod Enclave  ',
        cageCode: '1abc2',
        systemOwnerEmail: ' Owner@Example.com ',
        description: '',
      }),
    );
    expect(first).toEqual({
      ...EMPTY_FIELDS,
      systemName: 'Prod Enclave',
      cageCode: '1ABC2',
      systemOwnerEmail: 'owner@example.com',
      updatedAt: firstAt,
      updatedBy: adminRef,
    });
    let events = await profileEvents(admin);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      at: firstAt,
      actor: adminRef,
      action: 'system_profile.updated',
      entityType: 'system_profile',
      entityId: assessmentId,
      before: null,
      after: {
        systemName: 'Prod Enclave',
        cageCode: '1ABC2',
        systemOwnerEmail: 'owner@example.com',
      },
    });
    expect(events[0]?.requestId).toEqual(expect.any(String));

    // A change audits only the changed fields, even when unchanged ones are sent along.
    h.clock.advance(60_000);
    const secondAt = h.clock.now().toISOString();
    const second = profileOf(
      await admin.patch(URL, {
        systemName: 'Prod Enclave',
        cageCode: '1ABC2',
        systemIdentifier: 'SYS-01',
        systemOwnerEmail: null,
      }),
    );
    expect(second).toMatchObject({
      systemName: 'Prod Enclave',
      systemIdentifier: 'SYS-01',
      cageCode: '1ABC2',
      systemOwnerEmail: null,
      updatedAt: secondAt,
    });
    events = await profileEvents(admin);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      at: secondAt,
      before: { systemIdentifier: null, systemOwnerEmail: 'owner@example.com' },
      after: { systemIdentifier: 'SYS-01', systemOwnerEmail: null },
    });

    // An identical patch, even spelled differently, writes no event and keeps the save stamp.
    h.clock.advance(60_000);
    const again = profileOf(
      await admin.patch(URL, { systemName: ' Prod Enclave ', cageCode: '1abc2', description: ' ' }),
    );
    expect(again).toEqual(second);
    expect(await profileEvents(admin)).toHaveLength(2);
    const rows = h.db.select().from(systemProfile).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedAt).toBe(secondAt);

    // Every audit row ties back to the assessment.
    const stored = h.db.select().from(auditEvent).all();
    for (const row of stored.filter((event) => event.entityType === 'system_profile')) {
      expect(row.assessmentId).toBe(assessmentId);
    }
  });

  it('access', async () => {
    const { h, admin } = await world();
    const created = userResponseSchema.parse((await admin.post('/api/users', CONTRIBUTOR)).json());
    const carl = await h.signIn(CONTRIBUTOR.email, CONTRIBUTOR.password);

    // A contributor reads and writes, and is the one recorded.
    profileOf(await carl.get(URL));
    const saved = profileOf(await carl.patch(URL, { organizationName: 'Acme Defense' }));
    expect(saved.organizationName).toBe('Acme Defense');
    expect(saved.updatedBy).toEqual({ id: created.user.id, displayName: CONTRIBUTOR.displayName });
    expect((await profileEvents(admin))[0]?.actor?.id).toBe(created.user.id);

    // Signed out: 401 for both.
    const anonymous = h.client();
    const signedOutGet = await anonymous.get(URL);
    expect(signedOutGet.statusCode).toBe(401);
    expect(code(signedOutGet)).toBe('unauthenticated');
    const signedOutPatch = await anonymous.patch(URL, { systemName: 'X' });
    expect(signedOutPatch.statusCode).toBe(401);

    // A missing CSRF token: 403 csrf_failed, and nothing changes.
    const forged = await carl.patch(
      URL,
      { systemName: 'Forged' },
      { headers: { [CSRF_HEADER]: null } },
    );
    expect(forged.statusCode).toBe(403);
    expect(code(forged)).toBe('csrf_failed');
    // Bad bodies: 400, and nothing changes.
    for (const body of [{}, { systemName: 'x'.repeat(201) }, { cageCode: 'ABCD' }, { nope: 1 }]) {
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
    const missingPatch = await admin.patch(URL, { systemName: 'Y' });
    expect(missingPatch.statusCode).toBe(404);
    expect(code(missingPatch)).toBe('not_found');
    expect((await admin.patch(URL, {})).statusCode).toBe(400);
  });

  it('a session moved past its idle limit has to sign in again before saving', async () => {
    const { h, admin } = await world();
    h.clock.advance(3 * DAY);
    expect((await admin.patch(URL, { systemName: 'Late' })).statusCode).toBe(401);
    const fresh = await h.signIn(ADMIN.email, ADMIN.password);
    const saved = profileOf(await fresh.patch(URL, { systemName: 'Late' }));
    expect(saved.updatedAt).toBe(new Date(START.getTime() + 3 * DAY).toISOString());
  });

  it('persists across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-profile-'));
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
    const written = await first.app.inject({
      method: 'PATCH',
      url: URL,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ systemName: 'Durable', securityContactEmail: 'SOC@example.com' }),
    });
    const saved = profileOf(written);
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
      systemName: 'Durable',
      securityContactEmail: 'soc@example.com',
      updatedAt: START.toISOString(),
    });
  });
});
