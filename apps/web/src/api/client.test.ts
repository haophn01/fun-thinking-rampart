import {
  UPLOAD_EXTENSIONS,
  evidenceItemResponseSchema,
  healthResponseSchema,
  userResponseSchema,
} from '@rampart/api/contract';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../App';
import { ApiError, apiGet, apiSend, apiUpload, setApiSessionHooks } from './client';

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
  setApiSessionHooks(null);
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

const USER = {
  id: 'u-2',
  email: 'kim@example.com',
  displayName: 'Kim',
  role: 'contributor',
  active: true,
  createdAt: '2026-11-24T10:00:00.000Z',
} as const;

function envelope(code: string, message: string, details?: unknown) {
  return JSON.stringify({
    error: { code, message, requestId: 'req-9', ...(details === undefined ? {} : { details }) },
  });
}

function hooks(token: string | null = 'csrf-1') {
  const onUnauthenticated = vi.fn();
  setApiSessionHooks({ csrfToken: () => token, onUnauthenticated, onLocked: vi.fn() });
  return onUnauthenticated;
}

function bothHooks() {
  const onUnauthenticated = vi.fn();
  const onLocked = vi.fn();
  setApiSessionHooks({ csrfToken: () => 'csrf-1', onUnauthenticated, onLocked });
  return { onUnauthenticated, onLocked };
}

describe('apiSend', () => {
  it('sends JSON with the x-csrf-token from the session store', async () => {
    hooks('csrf-1');
    const fetchMock = stubFetch(() =>
      Promise.resolve(respond(JSON.stringify({ user: USER }), 201)),
    );
    const body = { email: 'kim@example.com', displayName: 'Kim', role: 'contributor' };
    await expect(apiSend('POST', '/api/users', body, userResponseSchema)).resolves.toEqual({
      user: USER,
    });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/users');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(body));
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-csrf-token')).toBe('csrf-1');
  });

  it('sends no csrf header without a session, and no body or content type without a body', async () => {
    hooks(null);
    const fetchMock = stubFetch(() => Promise.resolve(respond(null, 204)));
    await apiSend('DELETE', '/api/session');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has('x-csrf-token')).toBe(false);
    expect(headers.has('content-type')).toBe(false);
    expect(init.body).toBeUndefined();
  });

  it('resolves a 204 to undefined, even with a schema', async () => {
    hooks();
    stubFetch(() => Promise.resolve(respond(null, 204)));
    await expect(apiSend('DELETE', '/api/session', undefined, userResponseSchema)).resolves.toBe(
      undefined,
    );
  });

  it('maps the envelope to ApiError with details', async () => {
    hooks();
    stubFetch(() =>
      Promise.resolve(
        respond(envelope('too_many_attempts', 'Locked', { retryAfterSeconds: 61 }), 429),
      ),
    );
    const error = await failure(apiSend('POST', '/api/session', { email: 'a', password: 'b' }));
    expect(error.status).toBe(429);
    expect(error.code).toBe('too_many_attempts');
    expect(error.message).toBe('Locked');
    expect(error.requestId).toBe('req-9');
    expect(error.details).toEqual({ retryAfterSeconds: 61 });
  });

  it('leaves details undefined when the envelope has none', async () => {
    hooks();
    stubFetch(() => Promise.resolve(respond(envelope('email_taken', 'Taken'), 409)));
    const error = await failure(apiSend('POST', '/api/users', {}));
    expect(error.code).toBe('email_taken');
    expect(error.details).toBeUndefined();
  });

  it('gives network_error when fetch rejects and invalid_response on a contract mismatch', async () => {
    hooks();
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect((await failure(apiSend('POST', '/api/users', {}))).code).toBe('network_error');
    stubFetch(() => Promise.resolve(respond(JSON.stringify({ nope: true }), 200)));
    expect((await failure(apiSend('POST', '/api/users', {}, userResponseSchema))).code).toBe(
      'invalid_response',
    );
  });
});

const MAX_UPLOAD = 26_214_400;
const UPLOAD_PATH = '/api/evidence/e-1/versions';
const EVIDENCE = {
  id: 'e-1',
  title: 'MFA screenshots',
  description: null,
  containsCui: false,
  objectiveIds: ['3.5.3[a]'],
  versions: [
    {
      kind: 'file',
      version: 1,
      fileName: 'Política 1.pdf',
      size: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      createdAt: '2026-11-24T10:00:00.000Z',
      createdBy: { id: 'u-1', displayName: 'Ada' },
    },
  ],
  createdAt: '2026-11-24T09:00:00.000Z',
  createdBy: { id: 'u-1', displayName: 'Ada' },
  updatedAt: '2026-11-24T10:00:00.000Z',
};

describe('apiUpload', () => {
  it('sends octet-stream, the encoded name and CSRF, and parses the response', async () => {
    hooks('csrf-1');
    const fetchMock = stubFetch(() =>
      Promise.resolve(respond(JSON.stringify({ item: EVIDENCE }), 201)),
    );
    const file = new Blob(['abc']);
    await expect(
      apiUpload(UPLOAD_PATH, file, 'Política 1.pdf', evidenceItemResponseSchema),
    ).resolves.toEqual({ item: EVIDENCE });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(UPLOAD_PATH);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('x-file-name')).toBe('Pol%C3%ADtica%201.pdf');
    expect(headers.get('x-csrf-token')).toBe('csrf-1');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('maps the error envelope, a network failure and a contract mismatch', async () => {
    hooks();
    stubFetch(() =>
      Promise.resolve(respond(envelope('cui_file_refused', 'This item contains CUI'), 409)),
    );
    const refused = await failure(
      apiUpload(UPLOAD_PATH, new Blob(['abc']), 'a.pdf', evidenceItemResponseSchema),
    );
    expect(refused.status).toBe(409);
    expect(refused.code).toBe('cui_file_refused');
    expect(refused.message).toBe('This item contains CUI');
    expect(refused.requestId).toBe('req-9');

    stubFetch(() =>
      Promise.resolve(respond(envelope('unsupported_file_type', 'No', { allowed: ['.pdf'] }), 415)),
    );
    const type = await failure(
      apiUpload(UPLOAD_PATH, new Blob(['abc']), 'a.pdf', evidenceItemResponseSchema),
    );
    expect(type.details).toEqual({ allowed: ['.pdf'] });

    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(
      (await failure(apiUpload(UPLOAD_PATH, new Blob(['a']), 'a.pdf', evidenceItemResponseSchema)))
        .code,
    ).toBe('network_error');
    stubFetch(() => Promise.resolve(respond(JSON.stringify({ item: { id: 1 } }), 201)));
    expect(
      (await failure(apiUpload(UPLOAD_PATH, new Blob(['a']), 'a.pdf', evidenceItemResponseSchema)))
        .code,
    ).toBe('invalid_response');
  });

  it('calls onUnauthenticated on 401 and sends no CSRF header without a session', async () => {
    const onUnauthenticated = hooks(null);
    const fetchMock = stubFetch(() =>
      Promise.resolve(respond(envelope('unauthenticated', 'Sign in'), 401)),
    );
    const error = await failure(
      apiUpload(UPLOAD_PATH, new Blob(['abc']), 'a.pdf', evidenceItemResponseSchema),
    );
    expect(error.code).toBe('unauthenticated');
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has('x-csrf-token')).toBe(false);
  });
});

describe('apiUpload pre-checks', () => {
  it('refuses a too-large, empty or .exe file without calling fetch', async () => {
    hooks();
    const fetchMock = stubFetch(() =>
      Promise.resolve(respond(JSON.stringify({ item: EVIDENCE }), 201)),
    );
    const cases: [Blob, string, string][] = [
      [new Blob([new Uint8Array(MAX_UPLOAD + 1)]), 'big.pdf', 'payload_too_large'],
      [new Blob([]), 'empty.pdf', 'validation_failed'],
      [new Blob(['MZ']), 'setup.exe', 'unsupported_file_type'],
      [new Blob(['abc']), 'a.pdf.exe', 'unsupported_file_type'],
      [new Blob(['abc']), 'a/b.pdf', 'validation_failed'],
      [new Blob(['abc']), '..', 'validation_failed'],
      // The name is checked before the size, as on the server.
      [new Blob([new Uint8Array(MAX_UPLOAD + 1)]), 'big.exe', 'unsupported_file_type'],
    ];
    for (const [file, name, code] of cases) {
      const error = await failure(apiUpload(UPLOAD_PATH, file, name, evidenceItemResponseSchema));
      expect(error.code, name).toBe(code);
      expect(error.status, name).toBe(0);
      expect(error.message.trim(), name).not.toBe('');
    }
    expect(fetchMock).not.toHaveBeenCalled();

    const type = await failure(
      apiUpload(UPLOAD_PATH, new Blob(['MZ']), 'setup.exe', evidenceItemResponseSchema),
    );
    expect(type.details).toEqual({
      problem: 'unsupported_file_type',
      allowed: [...UPLOAD_EXTENSIONS],
    });
    const empty = await failure(
      apiUpload(UPLOAD_PATH, new Blob([]), 'a.pdf', evidenceItemResponseSchema),
    );
    expect(empty.details).toEqual({ problem: 'empty' });

    // Exactly the limit, and an upper-case allowed type, are sent.
    await apiUpload(
      UPLOAD_PATH,
      new Blob([new Uint8Array(MAX_UPLOAD)]),
      'REPORT.PDF',
      evidenceItemResponseSchema,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('unauthenticated hook', () => {
  it('calls onUnauthenticated for a 401 from any call but sign-in and setup', async () => {
    const onUnauthenticated = hooks();
    stubFetch(() => Promise.resolve(respond(envelope('unauthenticated', 'Sign in'), 401)));

    await failure(apiSend('PATCH', '/api/users/u-2', { role: 'admin' }));
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    await failure(apiGet('/api/users', userResponseSchema));
    expect(onUnauthenticated).toHaveBeenCalledTimes(2);

    await failure(apiSend('POST', '/api/session', { email: 'a', password: 'b' }));
    await failure(apiSend('POST', '/api/setup', {}));
    expect(onUnauthenticated).toHaveBeenCalledTimes(2);
  });

  it('does not call it for other failures', async () => {
    const onUnauthenticated = hooks();
    stubFetch(() => Promise.resolve(respond(envelope('forbidden', 'No'), 403)));
    await failure(apiSend('POST', '/api/users', {}));
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  function renderAppWith(routes: Record<string, () => Response>, path: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init: RequestInit = {}) => {
        const handler = routes[`${init.method ?? 'GET'} ${input}`];
        return Promise.resolve(
          handler ? handler() : respond(JSON.stringify({ status: 'ok', db: 'ok' })),
        );
      }),
    );
    return render(
      createElement(MemoryRouter, { initialEntries: [path] }, createElement(AuthedApp)),
    );
  }

  const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada', role: 'admin' };

  it('shows Sign in with "Your session ended. Sign in again." after a 401 from a non-auth call', async () => {
    renderAppWith(
      {
        'GET /api/session': () =>
          respond(JSON.stringify({ setupRequired: false, user: ADMIN, csrfToken: 'c' })),
        'GET /api/users': () => respond(envelope('unauthenticated', 'Sign in'), 401),
      },
      '/settings',
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Your session ended. Sign in again.')).toBeInTheDocument();
  });

  it('does not show it after a 401 from sign-in', async () => {
    const user = userEvent.setup();
    renderAppWith(
      {
        'GET /api/session': () =>
          respond(JSON.stringify({ setupRequired: false, user: null, csrfToken: null })),
        'POST /api/session': () =>
          respond(envelope('invalid_credentials', 'Email or password is incorrect.'), 401),
      },
      '/',
    );
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument();
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument();
  });
});

describe('lock and 401 rules', () => {
  it('lock and 401 rules', async () => {
    const { onUnauthenticated, onLocked } = bothHooks();
    const locked = () =>
      Promise.resolve(respond(envelope('session_locked', 'Your session is locked.'), 423));

    // A 423 session_locked from a read, a write and an upload alike runs onLocked.
    stubFetch(locked);
    const read = await failure(apiGet('/api/users', userResponseSchema));
    expect(read.status).toBe(423);
    expect(read.code).toBe('session_locked');
    expect(onLocked).toHaveBeenCalledTimes(1);
    await failure(apiSend('PATCH', '/api/assessment', { assessmentType: 'self' }));
    expect(onLocked).toHaveBeenCalledTimes(2);
    await failure(
      apiUpload(
        '/api/evidence/e-1/files',
        new Blob(['x']),
        'report.pdf',
        evidenceItemResponseSchema,
      ),
    );
    expect(onLocked).toHaveBeenCalledTimes(3);
    expect(onUnauthenticated).not.toHaveBeenCalled();

    // A wrong password on unlock or change is a refusal, not an ended session.
    stubFetch(() =>
      Promise.resolve(respond(envelope('invalid_credentials', 'Password is incorrect.'), 401)),
    );
    const unlock = await failure(apiSend('POST', '/api/session/unlock', { password: 'nope' }));
    expect(unlock.code).toBe('invalid_credentials');
    await failure(
      apiSend('POST', '/api/session/password', { currentPassword: 'a', newPassword: 'b' }),
    );
    expect(onUnauthenticated).not.toHaveBeenCalled();

    // The 5th failure ends every session: unlock answers 401 unauthenticated, and that does.
    stubFetch(() => Promise.resolve(respond(envelope('unauthenticated', 'Sign in'), 401)));
    await failure(apiSend('POST', '/api/session/unlock', { password: 'nope' }));
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    await failure(
      apiSend('POST', '/api/session/password', { currentPassword: 'a', newPassword: 'b' }),
    );
    expect(onUnauthenticated).toHaveBeenCalledTimes(2);

    // A 401 without an envelope still means the session is gone.
    stubFetch(() => Promise.resolve(respond('nope', 401)));
    await failure(apiGet('/api/users', userResponseSchema));
    expect(onUnauthenticated).toHaveBeenCalledTimes(3);

    // Other statuses run neither hook, and a 423 with another code is not a lock.
    stubFetch(() => Promise.resolve(respond(envelope('forbidden', 'No'), 403)));
    await failure(apiGet('/api/users', userResponseSchema));
    stubFetch(() => Promise.resolve(respond(envelope('something_else', 'x'), 423)));
    await failure(apiGet('/api/users', userResponseSchema));
    expect(onLocked).toHaveBeenCalledTimes(3);
    expect(onUnauthenticated).toHaveBeenCalledTimes(3);
  });
});
