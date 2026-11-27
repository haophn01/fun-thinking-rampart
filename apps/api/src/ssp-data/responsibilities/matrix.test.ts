import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '@rampart/catalog';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from '../../../db/client';
import { createMemoryStore } from '../../../storage';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import {
  CSRF_HEADER,
  auditPageSchema,
  errorEnvelopeSchema,
  providerResponseSchema,
  responsibilityMatrixSchema,
  responsibilityRowResponseSchema,
  type AuditPage,
  type ResponsibilityRow,
  type ServiceProvider,
} from '../../contract';
import {
  ADMIN,
  HARNESS_SECRET_KEY,
  START,
  createHarness,
  signInThroughApi,
  type Client,
  type Harness,
  type MfaSecrets,
} from '../../testing/harness';
import { loadResponsibilityMatrix } from './repository';

const URL = '/api/ssp/responsibilities';
const PROVIDERS = '/api/ssp/providers';
const SECOND = 1000;
const REQUIREMENTS = loadCatalog().requirements.map((r) => r.id);
const FIRST = REQUIREMENTS[0] ?? '';
const SECOND_REQ = REQUIREMENTS[1] ?? '';

const harnesses: Harness[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness();
  harnesses.push(h);
  const admin = await h.setupAdmin();
  return { h, admin };
}

async function addProvider(client: Client, name: string): Promise<ServiceProvider> {
  const response = await client.post(PROVIDERS, { name, providerType: 'cloud' });
  expect(response.statusCode, response.body).toBe(201);
  return providerResponseSchema.parse(response.json()).provider;
}

async function matrixOf(client: Client): Promise<ResponsibilityRow[]> {
  const response = await client.get(URL);
  expect(response.statusCode, response.body).toBe(200);
  return responsibilityMatrixSchema.parse(response.json()).rows;
}

function rowOf(response: LightMyRequestResponse): ResponsibilityRow {
  expect(response.statusCode, response.body).toBe(200);
  return responsibilityRowResponseSchema.parse(response.json()).row;
}

function code(response: LightMyRequestResponse): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

async function events(client: Client): Promise<AuditPage['events']> {
  const response = await client.get('/api/audit?entityType=responsibility');
  return auditPageSchema.parse(response.json()).events;
}

function storedRows(h: Harness): number {
  return h.handle.sqlite.prepare('select count(*) from responsibility').pluck().get() as number;
}

function activeAssessmentId(h: Harness): string {
  const row = h.handle.sqlite.prepare('select id from assessment').pluck().get();
  if (typeof row !== 'string') throw new Error('no assessment');
  return row;
}

const empty = (requirementId: string): ResponsibilityRow => ({
  requirementId,
  party: null,
  provider: null,
  note: null,
  updatedAt: null,
});

describe('responsibility matrix', () => {
  it('full matrix', async () => {
    const { h, admin } = await world();
    const rows = await matrixOf(admin);
    expect(REQUIREMENTS).toHaveLength(110);
    expect(rows).toEqual(REQUIREMENTS.map(empty));
    // Reading stores nothing.
    expect(storedRows(h)).toBe(0);
    expect(loadResponsibilityMatrix(h.db, activeAssessmentId(h))).toEqual({ rows });

    // A stored row sits at its catalog position; the rest still read null.
    const provider = await addProvider(admin, 'Cloudy');
    const last = REQUIREMENTS[109] ?? '';
    rowOf(
      await admin.put(`${URL}/${last}`, { party: 'shared', providerId: provider.id, note: 'x' }),
    );
    const after = await matrixOf(admin);
    expect(after.map((r) => r.requirementId)).toEqual(REQUIREMENTS);
    expect(after[109]).toEqual({
      requirementId: last,
      party: 'shared',
      provider: { id: provider.id, name: 'Cloudy' },
      note: 'x',
      updatedAt: START.toISOString(),
    });
    expect(after.slice(0, 109)).toEqual(REQUIREMENTS.slice(0, 109).map(empty));

    // Signed out → 401; no assessment → 404.
    expect((await h.client().get(URL)).statusCode).toBe(401);
    h.handle.sqlite.pragma('foreign_keys = OFF');
    h.handle.sqlite.exec('DELETE FROM assessment');
    h.handle.sqlite.pragma('foreign_keys = ON');
    expect(code(await admin.get(URL))).toBe('not_found');
    expect(
      code(await admin.put(`${URL}/${FIRST}`, { party: null, providerId: null, note: null })),
    ).toBe('not_found');
  });

  it('put edges', async () => {
    const { h, admin } = await world();
    const provider = await addProvider(admin, 'Cloudy');
    const other = await addProvider(admin, 'Other');

    // First PUT that sets anything stores the row, before: null.
    h.clock.advance(SECOND);
    const stored = rowOf(
      await admin.put(`${URL}/${FIRST}`, {
        party: 'esp',
        providerId: provider.id,
        note: ' Hosted ',
      }),
    );
    const at1 = new Date(START.getTime() + SECOND).toISOString();
    expect(stored).toEqual({
      requirementId: FIRST,
      party: 'esp',
      provider: { id: provider.id, name: 'Cloudy' },
      note: 'Hosted',
      updatedAt: at1,
    });
    const [created] = await events(admin);
    expect(created).toMatchObject({
      action: 'responsibility.updated',
      entityType: 'responsibility',
      entityId: FIRST,
      before: null,
      after: { party: 'esp', providerId: provider.id, note: 'Hosted' },
    });
    expect(storedRows(h)).toBe(1);

    // A repeat writes nothing: no event, updatedAt stays.
    h.clock.advance(SECOND);
    const repeat = rowOf(
      await admin.put(`${URL}/${FIRST}`, { party: 'esp', providerId: provider.id, note: 'Hosted' }),
    );
    expect(repeat).toEqual(stored);
    expect(await events(admin)).toHaveLength(1);

    // A change audits only the changed fields.
    h.clock.advance(SECOND);
    const moved = rowOf(
      await admin.put(`${URL}/${FIRST}`, { party: 'shared', providerId: other.id, note: 'Hosted' }),
    );
    expect(moved).toMatchObject({ party: 'shared', provider: { id: other.id, name: 'Other' } });
    expect(moved.updatedAt).toBe(new Date(START.getTime() + 3 * SECOND).toISOString());
    const [changed] = await events(admin);
    expect(changed).toMatchObject({
      before: { party: 'esp', providerId: provider.id },
      after: { party: 'shared', providerId: other.id },
    });
    expect(changed?.before).not.toHaveProperty('note');

    // An all-null PUT on a requirement with no row stores nothing.
    const nothing = rowOf(
      await admin.put(`${URL}/${SECOND_REQ}`, { party: null, providerId: null, note: '  ' }),
    );
    expect(nothing).toEqual(empty(SECOND_REQ));
    expect(storedRows(h)).toBe(1);
    expect(await events(admin)).toHaveLength(2);

    // An all-null PUT on a stored row clears it (kept as a row, audited).
    h.clock.advance(SECOND);
    const cleared = rowOf(
      await admin.put(`${URL}/${FIRST}`, { party: null, providerId: null, note: null }),
    );
    expect(cleared).toEqual({
      ...empty(FIRST),
      updatedAt: new Date(START.getTime() + 4 * SECOND).toISOString(),
    });
    const [clearedEvent] = await events(admin);
    expect(clearedEvent).toMatchObject({
      before: { party: 'shared', providerId: other.id, note: 'Hosted' },
      after: { party: null, providerId: null, note: null },
    });

    // Organization with a note and no provider.
    const org = rowOf(
      await admin.put(`${URL}/${SECOND_REQ}`, {
        party: 'organization',
        providerId: null,
        note: 'In house',
      }),
    );
    expect(org).toMatchObject({ party: 'organization', provider: null, note: 'In house' });
  });

  it('validation order', async () => {
    const { h, admin } = await world();
    const provider = await addProvider(admin, 'Cloudy');
    const removed = await addProvider(admin, 'Removed');
    expect((await admin.delete(`${PROVIDERS}/${removed.id}`)).statusCode).toBe(204);
    const unknownId = '00000000-0000-4000-8000-000000000000';

    async function expect400(url: string, body: unknown, path?: unknown[]) {
      const response = await admin.put(url, body);
      expect(response.statusCode, response.body).toBe(400);
      const envelope = errorEnvelopeSchema.parse(response.json());
      expect(envelope.error.code).toBe('validation_failed');
      if (path) {
        expect(envelope.error.details).toEqual(
          expect.arrayContaining([expect.objectContaining({ path })]),
        );
      }
    }

    // Unknown or removed provider: 400 on providerId.
    await expect400(`${URL}/${FIRST}`, { party: 'esp', providerId: unknownId, note: null }, [
      'providerId',
    ]);
    await expect400(`${URL}/${FIRST}`, { party: 'shared', providerId: removed.id, note: null }, [
      'providerId',
    ]);
    // Schema edges: missing keys, extra keys, a party without its provider, a provider without one.
    await expect400(`${URL}/${FIRST}`, { party: 'esp', providerId: provider.id });
    await expect400(`${URL}/${FIRST}`, { party: null, providerId: null, note: null, extra: 1 });
    await expect400(`${URL}/${FIRST}`, { party: 'esp', providerId: null, note: null });
    await expect400(`${URL}/${FIRST}`, {
      party: 'organization',
      providerId: provider.id,
      note: null,
    });
    await expect400(`${URL}/${FIRST}`, { party: 'vendor', providerId: null, note: null });

    // Unknown requirement: 404, but only once the body is good.
    const unknownReq = await admin.put(`${URL}/XX.L2-9.9.9`, {
      party: 'esp',
      providerId: provider.id,
      note: null,
    });
    expect(unknownReq.statusCode).toBe(404);
    expect(code(unknownReq)).toBe('not_found');
    await expect400(`${URL}/XX.L2-9.9.9`, { party: 'esp', providerId: null, note: null });
    await expect400(`${URL}/XX.L2-9.9.9`, { party: 'esp', providerId: unknownId, note: null }, [
      'providerId',
    ]);
    // Requirement IDs match exactly.
    expect(
      (
        await admin.put(`${URL}/${FIRST.toLowerCase()}`, {
          party: null,
          providerId: null,
          note: null,
        })
      ).statusCode,
    ).toBe(404);

    // CSRF before body.
    const noCsrf = await admin.put(
      `${URL}/${FIRST}`,
      { party: 'vendor' },
      { headers: { [CSRF_HEADER]: null } },
    );
    expect(code(noCsrf)).toBe('csrf_failed');
    expect((await h.client().put(`${URL}/${FIRST}`, { party: 'vendor' })).statusCode).toBe(401);

    // Nothing was stored or audited.
    expect(storedRows(h)).toBe(0);
    expect(await events(admin)).toHaveLength(0);
  });

  it('reads follow providers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-matrix-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'rampart.sqlite');
    const now = () => START;

    function start(): { app: FastifyInstance; handle: DbHandle } {
      const handle = openDb(path);
      runMigrations(handle.db);
      const config = loadConfig({
        DATABASE_PATH: path,
        LOG_LEVEL: 'silent',
        RAMPART_SECRET_KEY: HARNESS_SECRET_KEY,
      });
      const app = buildApp({ config, db: handle.db, now, store: createMemoryStore() });
      cleanups.push(async () => {
        await app.close();
        if (handle.sqlite.open) handle.sqlite.close();
      });
      return { app, handle };
    }

    // Setup or sign-in, then the MFA step as a user would, the secret kept across the restart.
    const secrets: MfaSecrets = new Map();
    async function session(app: FastifyInstance, url: string, payload: object) {
      return signInThroughApi(app, url, payload, { at: now(), secrets });
    }

    async function send(
      app: FastifyInstance,
      headers: object,
      method: 'POST' | 'PUT' | 'PATCH',
      url: string,
      body: unknown,
    ) {
      return app.inject({
        method,
        url,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });
    }

    const first = start();
    const headers = await session(first.app, '/api/setup', ADMIN);
    const created = await send(first.app, headers, 'POST', PROVIDERS, {
      name: 'Old Name',
      providerType: 'msp',
    });
    const provider = providerResponseSchema.parse(created.json()).provider;
    rowOf(
      await send(first.app, headers, 'PUT', `${URL}/${SECOND_REQ}`, {
        party: 'esp',
        providerId: provider.id,
        note: 'Managed',
      }),
    );
    // A rename shows in the matrix at once.
    const renamed = await send(first.app, headers, 'PATCH', `${PROVIDERS}/${provider.id}`, {
      name: 'New Name',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const read1 = await first.app.inject({ method: 'GET', url: URL, headers });
    const rows1 = responsibilityMatrixSchema.parse(read1.json()).rows;
    expect(rows1[1]?.provider).toEqual({ id: provider.id, name: 'New Name' });
    await first.app.close();
    first.handle.sqlite.close();

    // After a restart the rows are still there.
    const second = start();
    const again = await session(second.app, '/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    const read2 = await second.app.inject({ method: 'GET', url: URL, headers: again });
    const rows2 = responsibilityMatrixSchema.parse(read2.json()).rows;
    expect(rows2).toEqual(rows1);
    expect(rows2[1]).toEqual({
      requirementId: SECOND_REQ,
      party: 'esp',
      provider: { id: provider.id, name: 'New Name' },
      note: 'Managed',
      updatedAt: START.toISOString(),
    });
  });
});
