import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../App';

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}
type Handler = (call: Call) => Response | Promise<Response>;

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}
function apiError(status: number, code: string, details?: unknown) {
  return json(status, {
    error: { code, message: code, requestId: 'r', ...(details === undefined ? {} : { details }) },
  });
}
function fakeApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? 'GET',
        path: input,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        headers: new Headers(init.headers),
      };
      calls.push(call);
      const handler =
        routes[`${call.method} ${call.path}`] ??
        (call.path === '/api/health'
          ? () => json(200, { status: 'ok', db: 'ok' })
          : () => apiError(404, 'not_found'));
      return Promise.resolve(handler(call));
    }),
  );
  return { calls, sent: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key) };
}

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthedApp />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Gate', () => {
  it('gate states', async () => {
    // Loading: nothing behind the gate shows while the session is unknown.
    let answer: (response: Response) => void = () => undefined;
    fakeApi({ 'GET /api/session': () => new Promise<Response>((resolve) => (answer = resolve)) });
    const loading = renderApp();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    answer(json(200, { setupRequired: true, user: null, csrfToken: null }));
    // Setup when setupRequired.
    expect(await screen.findByRole('heading', { level: 1, name: /Set up/ })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    loading.unmount();

    // Sign in when signed out.
    fakeApi({
      'GET /api/session': () => json(200, { setupRequired: false, user: null, csrfToken: null }),
    });
    const signedOut = renderApp();
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument();
    signedOut.unmount();

    // The Shell when signed in, at the path asked for.
    fakeApi({
      'GET /api/session': () =>
        json(200, { setupRequired: false, user: ADMIN, csrfToken: 'csrf-1' }),
    });
    const signedIn = renderApp('/poam');
    expect(await screen.findByRole('heading', { level: 1, name: 'POA&M' })).toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByText('Ada Admin')).toBeInTheDocument();
    signedIn.unmount();
  });

  it('shows an error Alert with a working Retry when the session fetch fails', async () => {
    const user = userEvent.setup();
    let fail = true;
    const api = fakeApi({
      'GET /api/session': () =>
        fail
          ? apiError(503, 'db_unavailable')
          : json(200, { setupRequired: false, user: null, csrfToken: null }),
    });
    renderApp();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Can't load your session");
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.sent('GET /api/session')).toHaveLength(2);
  });

  it('shows the error Alert when the network is down or the answer breaks the contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const down = renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't load your session");
    down.unmount();

    fakeApi({ 'GET /api/session': () => json(200, { user: 'nope' }) });
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't load your session");
  });
});
