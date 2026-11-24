import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../storage';
import { CSRF_HEADER, SESSION_COOKIE } from '../contract';
import { createHarness, type Harness, type HarnessOptions } from './harness';

const harnesses: Harness[] = [];

function harness(options: HarnessOptions = {}): Harness {
  const made = createHarness(options);
  harnesses.push(made);
  return made;
}

afterEach(async () => {
  for (const made of harnesses.splice(0)) await made.close();
});

interface Echo {
  method: string;
  contentType: string | null;
  fileName: string | null;
  csrf: string | null;
  cookie: string | null;
  size: number;
  sha256: string;
}

/** A test-only route that reports exactly what reached the server. */
function addEcho(app: FastifyInstance): void {
  void app.register(async (scope) => {
    await Promise.resolve();
    scope.addContentTypeParser(
      ['application/octet-stream', 'application/x-www-form-urlencoded'],
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );
    scope.post('/test/echo', (request) => {
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const header = (name: string) => {
        const value = request.headers[name];
        return typeof value === 'string' ? value : null;
      };
      const echo: Echo = {
        method: request.method,
        contentType: header('content-type'),
        fileName: header('x-file-name'),
        csrf: header(CSRF_HEADER),
        cookie: header('cookie'),
        size: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      };
      return echo;
    });
  });
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('harness', () => {
  it('upload', async () => {
    const h = harness();
    addEcho(h.app);
    const admin = await h.setupAdmin();
    expect(admin.csrfToken).not.toBeNull();

    const bytes = Uint8Array.from({ length: 300 }, (_, index) => index % 256);
    const sent = await admin.upload('/test/echo', bytes, 'Política 1.pdf');
    expect(sent.statusCode).toBe(200);
    const echo = sent.json<Echo>();
    expect(echo).toEqual({
      method: 'POST',
      contentType: 'application/octet-stream',
      fileName: 'Pol%C3%ADtica%201.pdf',
      csrf: admin.csrfToken,
      cookie: `${SESSION_COOKIE}=${String(admin.cookie)}`,
      size: 300,
      sha256: sha(bytes),
    });

    // `null` omits the name header; the rest is still sent.
    const unnamed = (await admin.upload('/test/echo', bytes, null)).json<Echo>();
    expect(unnamed.fileName).toBeNull();
    expect(unnamed.contentType).toBe('application/octet-stream');
    expect(unnamed.csrf).toBe(admin.csrfToken);

    // Options still override or drop headers, as on every request.
    const noCsrf = (
      await admin.upload('/test/echo', bytes, 'a.pdf', { headers: { [CSRF_HEADER]: null } })
    ).json<Echo>();
    expect(noCsrf.csrf).toBeNull();
    expect(noCsrf.fileName).toBe('a.pdf');

    // A view into a larger buffer sends only its own bytes.
    const backing = Uint8Array.from([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    const viewed = (await admin.upload('/test/echo', view, 'v.txt')).json<Echo>();
    expect(viewed.size).toBe(3);
    expect(viewed.sha256).toBe(sha(Uint8Array.from([1, 2, 3])));
  });

  it('rawBody sends any bytes with any content type', async () => {
    const h = harness();
    addEcho(h.app);
    const c = h.client();
    const form = (
      await c.post('/test/echo', undefined, {
        rawBody: 'a=1&b=2',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    ).json<Echo>();
    expect(form.contentType).toBe('application/x-www-form-urlencoded');
    expect(form.size).toBe(7);

    const bytes = Uint8Array.of(0, 255, 10);
    const raw = (
      await c.request('POST', '/test/echo', {
        rawBody: bytes,
        headers: { 'content-type': 'application/octet-stream' },
      })
    ).json<Echo>();
    expect(raw.sha256).toBe(sha(bytes));

    // The api still refuses a body type it doesn't read.
    const text = await c.post('/api/session', undefined, {
      rawBody: 'hello',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(415);
  });

  it('store', async () => {
    const h = harness();
    expect('store' in h).toBe(true);
    expect(h.store.keys()).toEqual([]);
    const stored = await h.store.put(Uint8Array.of(1, 2, 3));
    expect(h.store.keys()).toEqual([stored.key]);
    // Each harness gets its own store.
    expect(harness().store.keys()).toEqual([]);
  });

  it('uses a store it is given', async () => {
    const store = createMemoryStore();
    await store.put(Uint8Array.of(7));
    const h = harness({ store });
    expect(h.store).toBe(store);
    expect(h.store.keys()).toHaveLength(1);
  });
});
