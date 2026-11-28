import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../App';

vi.setConfig({ testTimeout: 15_000 });
// The Dashboard is stubbed: this file tests the password page, not the dashboard's API calls.
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
const session = (mustChangePassword: boolean, csrfToken = 'csrf-1') => ({
  setupRequired: false,
  user: ADMIN,
  csrfToken,
  mustChangePassword,
});
const PASSWORD = 'POST /api/session/password';
const CURRENT = 'old password 1';
const NEW = 'a brand new passphrase';

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthedApp />
    </MemoryRouter>,
  );
}

type User = ReturnType<typeof userEvent.setup>;

async function openPage(mustChange: boolean, routes: Record<string, Handler> = {}) {
  const api = fakeApi({
    'GET /api/session': () => json(200, session(mustChange)),
    ...routes,
  });
  renderApp(mustChange ? '/' : '/account/password');
  await screen.findByLabelText('Current password');
  return { api, user: userEvent.setup() };
}

const field = (label: string) => screen.getByLabelText(label);

async function fill(user: User, current: string, next: string, confirm = next) {
  await user.clear(field('Current password'));
  await user.clear(field('New password'));
  await user.clear(field('Confirm new password'));
  if (current) await user.type(field('Current password'), current);
  if (next) await user.type(field('New password'), next);
  if (confirm) await user.type(field('Confirm new password'), confirm);
  await user.click(screen.getByRole('button', { name: 'Change password' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('change password', () => {
  describe('client checks', () => {
    it('sends nothing for a mismatch, 11 characters or an empty current password', async () => {
      const { api, user } = await openPage(false, { [PASSWORD]: () => json(200, session(false)) });

      await fill(user, CURRENT, NEW, 'something different');
      expect(field('Confirm new password')).toHaveAccessibleDescription(
        "The passwords don't match.",
      );

      await fill(user, CURRENT, 'elevenchars');
      expect(field('New password')).toHaveAccessibleDescription('Use 12 to 128 characters.');

      await fill(user, '', NEW);
      expect(field('Current password')).toHaveAccessibleDescription('Enter your current password.');

      expect(api.sent(PASSWORD)).toHaveLength(0);
    });

    it('sends with exactly 12 characters', async () => {
      const { api, user } = await openPage(false, { [PASSWORD]: () => json(200, session(false)) });
      await fill(user, CURRENT, 'twelve chars');
      await vi.waitFor(() => {
        expect(api.sent(PASSWORD)).toHaveLength(1);
      });
      expect(api.sent(PASSWORD)[0]?.body).toEqual({
        currentPassword: CURRENT,
        newPassword: 'twelve chars',
      });
    });

    it('rejects 129 characters', async () => {
      const { api, user } = await openPage(false);
      await fill(user, CURRENT, 'ab '.repeat(43));
      expect(field('New password')).toHaveAccessibleDescription('Use 12 to 128 characters.');
      expect(api.sent(PASSWORD)).toHaveLength(0);
    });
  });

  describe('refusals', () => {
    it('shows each api refusal on the right field and keeps inputs masked', async () => {
      let answer: Response = apiError(401, 'invalid_credentials');
      const { api, user } = await openPage(false, { [PASSWORD]: () => answer });

      await fill(user, CURRENT, NEW);
      await vi.waitFor(() => {
        expect(field('Current password')).toHaveAccessibleDescription(
          'Current password is incorrect.',
        );
      });

      answer = apiError(400, 'password_too_common');
      await fill(user, CURRENT, NEW);
      await vi.waitFor(() => {
        expect(field('New password')).toHaveAccessibleDescription(
          'This password is too common. Choose another.',
        );
      });
      expect(field('Current password')).not.toHaveAccessibleDescription(
        'Current password is incorrect.',
      );

      answer = apiError(400, 'password_reused');
      await fill(user, CURRENT, NEW);
      await vi.waitFor(() => {
        expect(field('New password')).toHaveAccessibleDescription(
          'You used this password recently. Choose another.',
        );
      });

      answer = apiError(429, 'too_many_attempts', { retryAfterSeconds: 90 });
      await fill(user, CURRENT, NEW);
      expect(await screen.findByText('Too many requests. Try again in 2 minutes.')).toBeVisible();

      expect(api.sent(PASSWORD)).toHaveLength(4);
      for (const label of ['Current password', 'New password', 'Confirm new password']) {
        expect(field(label)).toHaveAttribute('type', 'password');
      }
    });
  });

  describe('success paths', () => {
    it('a forced success leaves the gate for the app', async () => {
      const { api, user } = await openPage(true, {
        [PASSWORD]: () => json(200, session(false, 'csrf-2')),
      });
      expect(screen.getByTestId('change-password-forced')).toHaveTextContent(
        'An admin set your password. Choose your own to continue.',
      );
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
      await fill(user, CURRENT, NEW);
      expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
      expect(api.sent(PASSWORD)[0]?.body).toEqual({ currentPassword: CURRENT, newPassword: NEW });
      expect(screen.queryByTestId('change-password-forced')).not.toBeInTheDocument();
    });

    it('a voluntary success shows the notice and clears the fields', async () => {
      const { user } = await openPage(false, {
        [PASSWORD]: () => json(200, session(false, 'csrf-2')),
      });
      expect(screen.queryByTestId('change-password-forced')).not.toBeInTheDocument();
      await fill(user, CURRENT, NEW);
      expect(
        await screen.findByText('Password changed. Your other sessions have ended.'),
      ).toBeVisible();
      expect(field('Current password')).toHaveValue('');
      expect(field('New password')).toHaveValue('');
      expect(field('Confirm new password')).toHaveValue('');
    });
  });

  describe('user slot link', () => {
    it('links to /account/password', async () => {
      fakeApi({ 'GET /api/session': () => json(200, session(false)) });
      renderApp('/');
      const link = await screen.findByRole('link', { name: 'Change password' });
      expect(
        within(screen.getByRole('banner')).getByRole('link', { name: 'Change password' }),
      ).toBe(link);
      expect(link).toHaveAttribute('href', '/account/password');
    });
  });
});
