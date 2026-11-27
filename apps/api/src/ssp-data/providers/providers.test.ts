import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '@rampart/catalog';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type DbHandle } from '../../../db/client';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import {
  CSRF_HEADER,
  auditPageSchema,
  errorEnvelopeSchema,
  providerResponseSchema,
  providersResponseSchema,
  type AuditPage,
  type ServiceProvider,
} from '../../contract';
import { createMemoryStore } from '../../../storage';
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
import { loadProviders } from './repository';

const URL = '/api/ssp/providers';
const SECOND = 1000;

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

function providerOf(response: LightMyRequestResponse, status = 200): ServiceProvider {
  expect(response.statusCode, response.body).toBe(status);
  return providerResponseSchema.parse(response.json()).provider;
}

async function listOf(client: Client): Promise<ServiceProvider[]> {
  const response = await client.get(URL);
  expect(response.statusCode, response.body).toBe(200);
  return providersResponseSchema.parse(response.json()).providers;
}

function code(response: LightMyRequestResponse): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

async function events(client: Client): Promise<AuditPage['events']> {
  const response = await client.get('/api/audit?entityType=service_provider');
  return auditPageSchema.parse(response.json()).events;
}

function activeAssessmentId(h: Harness): string {
  const row = h.handle.sqlite.prepare('select id from assessment').pluck().get();
  if (typeof row !== 'string') throw new Error('no assessment');
  return row;
}

const REQUIREMENTS = loadCatalog().requirements.map((r) => r.id);

describe('service provider routes', () => {
  it('provider lifecycle', async () => {
    const { h, admin } = await world();
    expect(await listOf(admin)).toEqual([]);

    // Create: texts trim, blank optional texts become null, 201.
    const created = providerOf(
      await admin.post(URL, {
        name: '  zeta Cloud  ',
        providerType: 'cloud',
        fedrampStatus: ' FedRAMP Moderate ',
        services: '   ',
      }),
      201,
    );
    expect(created).toEqual({
      id: expect.any(String) as string,
      name: 'zeta Cloud',
      providerType: 'cloud',
      fedrampStatus: 'FedRAMP Moderate',
      services: null,
      agreementReference: null,
      createdAt: START.toISOString(),
      updatedAt: START.toISOString(),
    });

    h.clock.advance(SECOND);
    const alpha = providerOf(
      await admin.post(URL, { name: 'Alpha MSP', providerType: 'msp' }),
      201,
    );
    h.clock.advance(SECOND);
    // Same name as alpha but later: createdAt breaks the tie.
    const alphaTwo = providerOf(
      await admin.post(URL, { name: 'alpha msp', providerType: 'mssp' }),
      201,
    );
    h.clock.advance(SECOND);
    const beta = providerOf(await admin.post(URL, { name: 'Beta', providerType: 'other' }), 201);

    // By name, case-insensitive, then createdAt.
    expect((await listOf(admin)).map((p) => p.id)).toEqual([
      alpha.id,
      alphaTwo.id,
      beta.id,
      created.id,
    ]);
    expect(loadProviders(h.db, activeAssessmentId(h))).toEqual(await listOf(admin));

    // Created event: before null, after = every stored field.
    const createdEvent = (await events(admin)).find((e) => e.entityId === created.id);
    expect(createdEvent).toMatchObject({
      action: 'service_provider.created',
      entityType: 'service_provider',
      before: null,
      after: {
        name: 'zeta Cloud',
        providerType: 'cloud',
        fedrampStatus: 'FedRAMP Moderate',
        services: null,
        agreementReference: null,
      },
    });

    // Strict create body, required name, unknown type.
    expect(code(await admin.post(URL, { name: 'X', providerType: 'cloud', extra: 1 }))).toBe(
      'validation_failed',
    );
    expect((await admin.post(URL, { name: '   ', providerType: 'cloud' })).statusCode).toBe(400);
    expect((await admin.post(URL, { name: 'X', providerType: 'isp' })).statusCode).toBe(400);

    // Patch: only changed fields audited; a rename re-sorts.
    h.clock.advance(SECOND);
    const patched = providerOf(
      await admin.patch(`${URL}/${created.id}`, {
        name: 'Aardvark Cloud',
        providerType: 'cloud',
        agreementReference: 'MSA-7',
      }),
    );
    expect(patched).toMatchObject({
      name: 'Aardvark Cloud',
      agreementReference: 'MSA-7',
      createdAt: START.toISOString(),
      updatedAt: new Date(START.getTime() + 4 * SECOND).toISOString(),
    });
    const [updatedEvent] = await events(admin);
    expect(updatedEvent).toMatchObject({
      action: 'service_provider.updated',
      entityId: created.id,
      before: { name: 'zeta Cloud', agreementReference: null },
      after: { name: 'Aardvark Cloud', agreementReference: 'MSA-7' },
    });
    expect((await listOf(admin))[0]?.id).toBe(created.id);

    // A patch that changes nothing: 200, no event, updatedAt stays.
    const before = (await events(admin)).length;
    h.clock.advance(SECOND);
    const same = providerOf(
      await admin.patch(`${URL}/${created.id}`, { name: ' Aardvark Cloud ', services: '' }),
    );
    expect(same).toEqual(patched);
    expect(await events(admin)).toHaveLength(before);

    // Patch validation and 404s.
    expect((await admin.patch(`${URL}/${created.id}`, {})).statusCode).toBe(400);
    expect((await admin.patch(`${URL}/${created.id}`, { nope: 1 })).statusCode).toBe(400);
    expect((await admin.patch(`${URL}/${created.id}`, { name: '' })).statusCode).toBe(400);
    expect(code(await admin.patch(`${URL}/no-such-id`, { name: 'Y' }))).toBe('not_found');
    // A bad body is a 400 even on an unknown id.
    expect((await admin.patch(`${URL}/no-such-id`, {})).statusCode).toBe(400);

    // Remove: 204, a removed event with every stored field, gone from the list.
    const removed = await admin.delete(`${URL}/${beta.id}`);
    expect(removed.statusCode, removed.body).toBe(204);
    const [removedEvent] = await events(admin);
    expect(removedEvent).toMatchObject({
      action: 'service_provider.removed',
      entityId: beta.id,
      before: {
        name: 'Beta',
        providerType: 'other',
        fedrampStatus: null,
        services: null,
        agreementReference: null,
      },
      after: null,
    });
    expect((await listOf(admin)).map((p) => p.id)).not.toContain(beta.id);
    // The row is kept, softly removed.
    const row = h.handle.sqlite
      .prepare('select removed_at from service_provider where id = ?')
      .pluck()
      .get(beta.id);
    expect(row).toBe(new Date(START.getTime() + 5 * SECOND).toISOString());
    // A second delete, a patch, and an unknown id are 404 and write nothing.
    const count = (await events(admin)).length;
    expect(code(await admin.delete(`${URL}/${beta.id}`))).toBe('not_found');
    expect(code(await admin.patch(`${URL}/${beta.id}`, { name: 'Back' }))).toBe('not_found');
    expect(code(await admin.delete(`${URL}/no-such-id`))).toBe('not_found');
    expect(await events(admin)).toHaveLength(count);

    // Signed out → 401; no CSRF header → 403 csrf_failed.
    expect((await h.client().get(URL)).statusCode).toBe(401);
    expect(
      code(
        await admin.post(
          URL,
          { name: 'X', providerType: 'cloud' },
          { headers: { [CSRF_HEADER]: null } },
        ),
      ),
    ).toBe('csrf_failed');

    // No assessment: 404 on reads and writes.
    h.handle.sqlite.pragma('foreign_keys = OFF');
    h.handle.sqlite.exec('DELETE FROM assessment');
    h.handle.sqlite.pragma('foreign_keys = ON');
    expect(code(await admin.get(URL))).toBe('not_found');
    expect(code(await admin.post(URL, { name: 'X', providerType: 'cloud' }))).toBe('not_found');
  });

  it('a contributor manages providers too', async () => {
    const { h, admin } = await world();
    const made = await admin.post('/api/users', {
      email: 'carl@example.com',
      displayName: 'Carl Contributor',
      role: 'contributor',
      password: 'a long enough password',
    });
    expect(made.statusCode, made.body).toBe(201);
    const carl = await h.signIn('carl@example.com', 'a long enough password');
    const p = providerOf(await carl.post(URL, { name: 'Carl Co', providerType: 'msp' }), 201);
    providerOf(await carl.patch(`${URL}/${p.id}`, { name: 'Carl Co 2' }));
    expect((await carl.delete(`${URL}/${p.id}`)).statusCode).toBe(204);
  });

  it('survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rampart-providers-'));
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

    const first = start();
    const headers = await session(first.app, '/api/setup', ADMIN);
    const json = { ...headers, 'content-type': 'application/json' };
    const kept = providerOf(
      await first.app.inject({
        method: 'POST',
        url: URL,
        headers: json,
        payload: JSON.stringify({ name: 'Durable', providerType: 'cloud', services: 'Email' }),
      }),
      201,
    );
    const gone = providerOf(
      await first.app.inject({
        method: 'POST',
        url: URL,
        headers: json,
        payload: JSON.stringify({ name: 'Gone', providerType: 'msp' }),
      }),
      201,
    );
    const removed = await first.app.inject({
      method: 'DELETE',
      url: `${URL}/${gone.id}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
    await first.app.close();
    first.handle.sqlite.close();

    const second = start();
    const again = await session(second.app, '/api/session', {
      email: ADMIN.email,
      password: ADMIN.password,
    });
    const read = await second.app.inject({ method: 'GET', url: URL, headers: again });
    expect(providersResponseSchema.parse(read.json()).providers).toEqual([kept]);
  });
});

describe('provider in use', () => {
  it('provider in use', async () => {
    const { h, admin } = await world();
    const used = providerOf(await admin.post(URL, { name: 'Used', providerType: 'cloud' }), 201);
    const spare = providerOf(await admin.post(URL, { name: 'Spare', providerType: 'msp' }), 201);
    const last = REQUIREMENTS[REQUIREMENTS.length - 1] ?? '';
    const first = REQUIREMENTS[0] ?? '';
    const middle = REQUIREMENTS[50] ?? '';
    // Named out of catalog order; the error lists them in catalog order.
    for (const [requirementId, party] of [
      [last, 'esp'],
      [first, 'shared'],
      [middle, 'esp'],
    ] as const) {
      const put = await admin.put(`/api/ssp/responsibilities/${requirementId}`, {
        party,
        providerId: used.id,
        note: null,
      });
      expect(put.statusCode, put.body).toBe(200);
    }
    const auditCount = () =>
      h.handle.sqlite.prepare('select count(*) from audit_event').pluck().get() as number;
    const eventsBefore = auditCount();

    const refused = await admin.delete(`${URL}/${used.id}`);
    expect(refused.statusCode, refused.body).toBe(409);
    const envelope = errorEnvelopeSchema.parse(refused.json());
    expect(envelope.error.code).toBe('provider_in_use');
    expect(envelope.error.details).toEqual({ requirementIds: [first, middle, last] });
    // Nothing changed.
    expect(auditCount()).toBe(eventsBefore);
    expect((await listOf(admin)).map((p) => p.id)).toContain(used.id);
    expect(
      h.handle.sqlite
        .prepare('select removed_at from service_provider where id = ?')
        .pluck()
        .get(used.id),
    ).toBeNull();

    // Re-point two rows to the spare, clear the third: removal now works.
    for (const requirementId of [first, middle]) {
      const put = await admin.put(`/api/ssp/responsibilities/${requirementId}`, {
        party: 'esp',
        providerId: spare.id,
        note: null,
      });
      expect(put.statusCode, put.body).toBe(200);
    }
    expect(code(await admin.delete(`${URL}/${used.id}`))).toBe('provider_in_use');
    const cleared = await admin.put(`/api/ssp/responsibilities/${last}`, {
      party: 'organization',
      providerId: null,
      note: null,
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await admin.delete(`${URL}/${used.id}`)).statusCode).toBe(204);
    expect((await listOf(admin)).map((p) => p.id)).toEqual([spare.id]);
    // The spare is still named, so it stays.
    const spareRefused = await admin.delete(`${URL}/${spare.id}`);
    expect(errorEnvelopeSchema.parse(spareRefused.json()).error.details).toEqual({
      requirementIds: [first, middle],
    });
  });
});
