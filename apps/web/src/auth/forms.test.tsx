import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../App';

// The Dashboard is stubbed: this file tests the auth forms, not the dashboard's API calls.
vi.mock('../pages/dashboard/DashboardPage', () => ({
  DashboardPage: () => <h1>Dashboard</h1>,
}));

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
/** Fakes the api at the network boundary; unknown routes answer 404 like the real one. */
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
const SIGNED_OUT = { setupRequired: false, user: null, csrfToken: null };
const SIGNED_IN = { setupRequired: false, user: ADMIN, csrfToken: 'csrf-1' };
const SETUP = { setupRequired: true, user: null, csrfToken: null };

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

describe('auth forms', () => {
  it('setup form', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'GET /api/session': () => json(200, SETUP),
      'POST /api/setup': () => json(201, SIGNED_IN),
    });
    renderApp();
    await screen.findByRole('heading', { level: 1, name: /Set up/ });
    const submit = () => user.click(screen.getByRole('button', { name: 'Create admin' }));

    await user.type(screen.getByLabelText('Email'), 'Ada@Example.com');
    await user.type(screen.getByLabelText('Display name'), 'Ada Admin');
    await user.type(screen.getByLabelText('Password'), 'elevenchars');
    await user.type(screen.getByLabelText('Confirm password'), 'elevenchars');
    await submit();
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
      'Use 12 to 128 characters.',
    );
    expect(api.sent('POST /api/setup')).toHaveLength(0);

    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'twelve chars');
    await user.clear(screen.getByLabelText('Confirm password'));
    await user.type(screen.getByLabelText('Confirm password'), 'twelve charz');
    await submit();
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Confirm password')).toHaveAccessibleDescription(
      "The passwords don't match.",
    );
    expect(api.sent('POST /api/setup')).toHaveLength(0);

    await user.clear(screen.getByLabelText('Confirm password'));
    await user.type(screen.getByLabelText('Confirm password'), 'twelve chars');
    await submit();

    await screen.findByRole('button', { name: 'Sign out' });
    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('Ada Admin')).toBeInTheDocument();
    expect(within(banner).getByText('Admin')).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(api.sent('POST /api/setup')).toHaveLength(1);
    expect(api.sent('POST /api/setup')[0]?.body).toEqual({
      email: 'ada@example.com',
      displayName: 'Ada Admin',
      password: 'twelve chars',
    });
  });

  it('setup checks email and name before sending; a finished setup falls back to Sign in', async () => {
    const user = userEvent.setup();
    let setupDone = false;
    const api = fakeApi({
      'GET /api/session': () => json(200, setupDone ? SIGNED_OUT : SETUP),
      'POST /api/setup': () => {
        setupDone = true;
        return apiError(409, 'setup_complete');
      },
    });
    renderApp();
    await screen.findByRole('heading', { level: 1, name: /Set up/ });
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Display name'), '   ');
    await user.type(screen.getByLabelText('Password'), 'twelve chars');
    await user.type(screen.getByLabelText('Confirm password'), 'twelve chars');
    await user.click(screen.getByRole('button', { name: 'Create admin' }));
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Display name')).toHaveAttribute('aria-invalid', 'true');
    expect(api.sent('POST /api/setup')).toHaveLength(0);

    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Display name'), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Create admin' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });

  it('sign-in form', async () => {
    const user = userEvent.setup();
    let reply: Handler = () => apiError(401, 'invalid_credentials');
    const api = fakeApi({
      'GET /api/session': () => json(200, SIGNED_OUT),
      'POST /api/session': (call) => reply(call),
    });
    renderApp('/poam');
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await user.type(screen.getByLabelText('Email'), ' Ada@Example.com ');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    const submit = () => user.click(screen.getByRole('button', { name: 'Sign in' }));

    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(api.sent('POST /api/session')[0]?.body).toEqual({
      email: 'ada@example.com',
      password: 'wrong password',
    });

    reply = () => apiError(429, 'too_many_attempts', { retryAfterSeconds: 61 });
    await submit();
    expect(
      await screen.findByText('Too many attempts. Try again in 2 minutes.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Email or password is incorrect.')).not.toBeInTheDocument();

    reply = () => apiError(429, 'too_many_attempts', { retryAfterSeconds: 60 });
    await submit();
    expect(
      await screen.findByText('Too many attempts. Try again in 1 minute.'),
    ).toBeInTheDocument();

    reply = () => apiError(429, 'too_many_attempts');
    await submit();
    expect(await screen.findByText('Too many attempts. Try again later.')).toBeInTheDocument();

    // A double click sends one request; Submit is disabled while it is pending.
    let answer: (response: Response) => void = () => undefined;
    reply = () => new Promise<Response>((resolve) => (answer = resolve));
    const before = api.sent('POST /api/session').length;
    await user.dblClick(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('button', { name: /Sign/ })).toBeDisabled();
    expect(api.sent('POST /api/session')).toHaveLength(before + 1);
    answer(json(200, SIGNED_IN));
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(api.sent('POST /api/session')).toHaveLength(before + 1);
    // Signing in keeps the page that was asked for.
    expect(screen.getByRole('heading', { level: 1, name: 'POA&M' })).toBeInTheDocument();
  });

  it('sign-in blocks empty fields and shows a network failure', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ 'GET /api/session': () => json(200, SIGNED_OUT) });
    renderApp();
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(api.sent('POST /api/session')).toHaveLength(0);

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'some password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the API");
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('sign out', async () => {
    const user = userEvent.setup();
    let down = true;
    const api = fakeApi({
      'GET /api/session': () => json(200, SIGNED_IN),
      'DELETE /api/session': () =>
        down ? Promise.reject(new TypeError('Failed to fetch')) : json(204),
    });
    // The Dashboard is stubbed (see the mock above): its own API calls would add error alerts.
    renderApp('/');
    await screen.findByRole('button', { name: 'Sign out' });
    const banner = screen.getByRole('banner');
    const signOut = () => within(banner).getByRole('button', { name: 'Sign out' });

    // A network failure shows an Alert and stays signed in.
    await user.click(signOut());
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't sign out");
    expect(within(banner).getByText('Ada Admin')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();

    // Sign out sends DELETE with the CSRF token and returns to Sign in.
    down = false;
    await user.click(signOut());
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    const deletes = api.sent('DELETE /api/session');
    expect(deletes).toHaveLength(2);
    expect(deletes[1]?.headers.get('x-csrf-token')).toBe('csrf-1');
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument();
  });
});
