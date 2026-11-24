import { healthResponseSchema } from '@rampart/api/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet } from './client';

function respond(body: BodyInit | null, status = 200) {
  return new Response(body, { status });
}

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('expected apiGet to throw');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiGet', () => {
  it('parses a valid response through the schema', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(respond(JSON.stringify({ status: 'ok', db: 'ok' }))),
    );
    await expect(apiGet('/api/health', healthResponseSchema)).resolves.toEqual({
      status: 'ok',
      db: 'ok',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.anything());
  });

  it('maps the error envelope to ApiError with code, message and requestId', async () => {
    stubFetch(() =>
      Promise.resolve(
        respond(
          JSON.stringify({
            error: { code: 'db_unavailable', message: 'Database is down', requestId: 'req-1' },
          }),
          503,
        ),
      ),
    );
    const error = await failure(apiGet('/api/health', healthResponseSchema));
    expect(error.status).toBe(503);
    expect(error.code).toBe('db_unavailable');
    expect(error.message).toBe('Database is down');
    expect(error.requestId).toBe('req-1');
  });

  it('keeps an error code the client does not know', async () => {
    stubFetch(() =>
      Promise.resolve(
        respond(
          JSON.stringify({ error: { code: 'brand_new', message: 'm', requestId: 'r' } }),
          409,
        ),
      ),
    );
    const error = await failure(apiGet('/api/health', healthResponseSchema));
    expect(error.code).toBe('brand_new');
  });

  it('gives network_error when fetch rejects', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await failure(apiGet('/api/health', healthResponseSchema));
    expect(error.code).toBe('network_error');
    expect(error.status).toBe(0);
    expect(error.requestId).toBeUndefined();
  });

  it('gives invalid_response for non-JSON on success', async () => {
    stubFetch(() => Promise.resolve(respond('<html>proxy error</html>')));
    const error = await failure(apiGet('/api/health', healthResponseSchema));
    expect(error.code).toBe('invalid_response');
    expect(error.status).toBe(200);
  });

  it('gives invalid_response for a schema mismatch', async () => {
    stubFetch(() => Promise.resolve(respond(JSON.stringify({ status: 'degraded', db: 'ok' }))));
    const error = await failure(apiGet('/api/health', healthResponseSchema));
    expect(error.code).toBe('invalid_response');
  });

  it('gives invalid_response for a failing status whose body is not the envelope', async () => {
    stubFetch(() => Promise.resolve(respond('Bad Gateway', 502)));
    const error = await failure(apiGet('/api/health', healthResponseSchema));
    expect(error.code).toBe('invalid_response');
    expect(error.status).toBe(502);
  });
});
