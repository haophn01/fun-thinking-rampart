import { afterEach, describe, expect, it } from 'vitest';
import { StorageError, createMemoryStore, type MemoryFileStore } from '../../storage';
import {
  FILE_INTEGRITY_MESSAGE,
  errorEnvelopeSchema,
  evidenceItemResponseSchema,
  type EvidenceItem,
} from '../contract';
import { createHarness, type Client, type Harness } from '../testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function world(store?: MemoryFileStore): Promise<{ h: Harness; admin: Client }> {
  const h = createHarness(store ? { store } : {});
  harnesses.push(h);
  return { h, admin: await h.setupAdmin() };
}

function errorOf(body: string) {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error;
}

async function create(client: Client, containsCui: boolean): Promise<EvidenceItem> {
  const response = await client.post('/api/evidence', {
    title: 'Download me',
    description: null,
    containsCui,
  });
  expect(response.statusCode, response.body).toBe(201);
  return evidenceItemResponseSchema.parse(response.json()).item;
}

async function uploaded(client: Client, bytes: Uint8Array, name: string): Promise<EvidenceItem> {
  const item = await create(client, false);
  const response = await client.upload(`/api/evidence/${item.id}/versions`, bytes, name);
  expect(response.statusCode, response.body).toBe(201);
  return evidenceItemResponseSchema.parse(response.json()).item;
}

const fileUrl = (id: string, version: number | string) =>
  `/api/evidence/${id}/versions/${String(version)}/file`;

describe('download', () => {
  it('returns the exact bytes with attachment headers', async () => {
    const { admin } = await world();
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 10, 13, 0]);
    const item = await uploaded(admin, bytes, 'Política 1.pdf');
    const response = await admin.get(fileUrl(item.id, 1));
    expect(response.statusCode).toBe(200);
    expect(new Uint8Array(response.rawPayload)).toEqual(bytes);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="Politica 1.pdf"; filename*=UTF-8''Pol%C3%ADtica%201.pdf`,
    );
    expect(response.headers['content-length']).toBe(String(bytes.length));
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves each version its own bytes and name', async () => {
    const { admin } = await world();
    const item = await uploaded(admin, new TextEncoder().encode('one'), 'one.txt');
    await admin.upload(
      `/api/evidence/${item.id}/versions`,
      new TextEncoder().encode('two'),
      'two.txt',
    );
    const first = await admin.get(fileUrl(item.id, 1));
    const second = await admin.get(fileUrl(item.id, 2));
    expect(first.body).toBe('one');
    expect(second.body).toBe('two');
    expect(second.headers['content-disposition']).toContain('two.txt');
  });

  it('gives 404 for a reference version, an unknown version or an unknown item', async () => {
    const { admin } = await world();
    const cui = await create(admin, true);
    const ref = await admin.post(`/api/evidence/${cui.id}/references`, {
      location: 'Vault',
      note: null,
    });
    expect(ref.statusCode).toBe(201);
    expect((await admin.get(fileUrl(cui.id, 1))).statusCode).toBe(404);

    const item = await uploaded(admin, new TextEncoder().encode('x'), 'x.txt');
    expect((await admin.get(fileUrl(item.id, 2))).statusCode).toBe(404);
    expect(errorOf((await admin.get(fileUrl(item.id, 2))).body).code).toBe('not_found');
    const unknown = fileUrl('00000000-0000-4000-8000-000000000000', 1);
    expect((await admin.get(unknown)).statusCode).toBe(404);
  });

  it('gives 404 for a version that is not a positive whole number, or a malformed item ID', async () => {
    const { admin } = await world();
    const item = await uploaded(admin, new TextEncoder().encode('x'), 'x.txt');
    for (const version of ['0', '-1', '1.5', 'abc', '01', '99999999999']) {
      expect((await admin.get(fileUrl(item.id, version))).statusCode, version).toBe(404);
    }
    expect((await admin.get(fileUrl('not-a-uuid', 1))).statusCode).toBe(404);
  });

  it('needs a session', async () => {
    const { h, admin } = await world();
    const item = await uploaded(admin, new TextEncoder().encode('x'), 'x.txt');
    expect((await h.client().get(fileUrl(item.id, 1))).statusCode).toBe(401);
  });

  it('a corrupted stored file gives 500 file_integrity_failed, naming no path', async () => {
    const { h, admin } = await world();
    const item = await uploaded(admin, new TextEncoder().encode('original'), 'x.txt');
    const sha = item.versions[0]?.kind === 'file' ? item.versions[0].sha256 : '';
    h.store.corrupt(sha);
    const response = await admin.get(fileUrl(item.id, 1));
    expect(response.statusCode).toBe(500);
    const error = errorOf(response.body);
    expect(error.code).toBe('file_integrity_failed');
    expect(error.message).toBe(FILE_INTEGRITY_MESSAGE);
    expect(response.body).not.toContain(sha);
  });

  it('a missing stored file gives 500 file_integrity_failed', async () => {
    const inner = createMemoryStore();
    let gone = false;
    const store: MemoryFileStore = {
      ...inner,
      get: (key, sha256) =>
        gone ? Promise.reject(new StorageError('missing', 'gone')) : inner.get(key, sha256),
    };
    const { admin } = await world(store);
    const item = await uploaded(admin, new TextEncoder().encode('here'), 'x.txt');
    gone = true;
    const response = await admin.get(fileUrl(item.id, 1));
    expect(response.statusCode).toBe(500);
    expect(errorOf(response.body).code).toBe('file_integrity_failed');
  });
});
