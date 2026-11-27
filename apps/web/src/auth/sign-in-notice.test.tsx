import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../App';

vi.mock('../pages/dashboard/DashboardPage', () => ({
  DashboardPage: () => <h1>Dashboard</h1>,
}));

interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Handler = (call: Call) => Response | Promise<Response>;

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}
function apiError(status: number, code: string) {
  return json(status, { error: { code, message: code, requestId: 'r' } });
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
  return { sent: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key) };
}

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const out = (signInNotice: unknown) => ({
  setupRequired: false,
  user: null,
  csrfToken: null,
  signInNotice,
});
const SIGNED_IN = { setupRequired: false, user: ADMIN, csrfToken: 'csrf-1', signInNotice: null };

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthedApp />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'ada@example.com');
  await user.type(screen.getByLabelText('Password'), 'twelve chars');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('sign-in notice', () => {
  it('notice before sign-in', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'GET /api/session': () => json(200, out({ text: 'Authorized use only.', digest: DIGEST_A })),
      'POST /api/session': () => json(200, SIGNED_IN),
    });
    renderApp();
    await screen.findByText('System use notice');
    expect(screen.getByText('Authorized use only.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Acknowledge and continue' }));
    await fillAndSubmit(user);
    await screen.findByRole('button', { name: 'Sign out' });
    expect(api.sent('POST /api/session')[0]?.body).toEqual({
      email: 'ada@example.com',
      password: 'twelve chars',
      noticeDigest: DIGEST_A,
    });
  }, 15_000);

  it('notice before sign-in: with none the form shows at once and sends no digest', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'GET /api/session': () => json(200, out(null)),
      'POST /api/session': () => json(200, SIGNED_IN),
    });
    renderApp();
    await screen.findByLabelText('Email');
    expect(screen.queryByText('System use notice')).not.toBeInTheDocument();
    await fillAndSubmit(user);
    await screen.findByRole('button', { name: 'Sign out' });
    expect(api.sent('POST /api/session')[0]?.body).toEqual({
      email: 'ada@example.com',
      password: 'twelve chars',
    });
  }, 15_000);

  it('bad credentials keep the form and the usual message', async () => {
    const user = userEvent.setup();
    fakeApi({
      'GET /api/session': () => json(200, out({ text: 'Notice.', digest: DIGEST_A })),
      'POST /api/session': () => apiError(401, 'invalid_credentials'),
    });
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Acknowledge and continue' }));
    await fillAndSubmit(user);
    await screen.findByText('Email or password is incorrect.');
    expect(screen.queryByText('System use notice')).not.toBeInTheDocument();
  }, 15_000);

  it('notice is plain text', async () => {
    fakeApi({
      'GET /api/session': () =>
        json(200, out({ text: '<b>x</b>\nsecond line\n\nthird', digest: DIGEST_A })),
    });
    renderApp();
    await screen.findByText('System use notice');
    const text = screen.getByText(/second line/);
    expect(text.textContent).toBe('<b>x</b>\nsecond line\n\nthird');
    expect(text.querySelector('b')).toBeNull();
  }, 15_000);

  it('changed notice', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const api = fakeApi({
      'GET /api/session': () => {
        reads += 1;
        return json(
          200,
          reads === 1
            ? out({ text: 'Old text.', digest: DIGEST_A })
            : out({ text: 'New text.', digest: DIGEST_B }),
        );
      },
      'POST /api/session': () => apiError(400, 'notice_not_acknowledged'),
    });
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Acknowledge and continue' }));
    await fillAndSubmit(user);
    await screen.findByText('The notice has changed. Read it again.');
    expect(await screen.findByText('New text.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(api.sent('GET /api/session').length).toBeGreaterThanOrEqual(2);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Acknowledge and continue' })).toBeEnabled();
    });
  }, 15_000);
});
