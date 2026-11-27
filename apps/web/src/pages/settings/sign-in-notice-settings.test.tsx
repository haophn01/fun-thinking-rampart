import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Handler = (call: Call) => Response | Promise<Response>;

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}
function fakeApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? 'GET',
        path: input.split('?')[0] ?? '',
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      const handler =
        routes[`${call.method} ${call.path}`] ??
        (call.path === '/api/health'
          ? () => json(200, { status: 'ok', db: 'ok' })
          : call.path === '/api/audit'
            ? () => json(200, { events: [], nextBefore: null })
            : call.path === '/api/users'
              ? () => json(200, { users: [] })
              : () => json(404, { error: { code: 'not_found', message: 'nf', requestId: 'r' } }));
      return Promise.resolve(handler(call));
    }),
  );
  return { sent: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key) };
}

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const DIGEST = 'c'.repeat(64);
const session = (signInNotice: unknown) => () =>
  json(200, { setupRequired: false, user: ADMIN, csrfToken: 'csrf-1', signInNotice });

async function renderSettings() {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <AuthedApp />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Settings' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sign-in notice settings', () => {
  it('edit the notice', async () => {
    const user = userEvent.setup();
    let stored: { text: string; digest: string } | null = null;
    const api = fakeApi({
      'GET /api/session': () =>
        json(200, { setupRequired: false, user: ADMIN, csrfToken: 'csrf-1', signInNotice: stored }),
      'PUT /api/settings/sign-in-notice': (call) => {
        const text = (call.body as { text: string | null }).text;
        stored = text === null ? null : { text, digest: DIGEST };
        return json(200, { signInNotice: stored });
      },
    });
    await renderSettings();
    const field = await screen.findByLabelText('Notice text');
    expect(field).toHaveValue('');

    await user.type(field, 'Authorized use only.');
    await user.click(screen.getByRole('button', { name: 'Save notice' }));
    await screen.findByText('Saved.');
    expect(api.sent('PUT /api/settings/sign-in-notice')[0]?.body).toEqual({
      text: 'Authorized use only.',
    });

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      expect(api.sent('PUT /api/settings/sign-in-notice')).toHaveLength(2);
    });
    expect(api.sent('PUT /api/settings/sign-in-notice')[1]?.body).toEqual({ text: null });
    await waitFor(() => {
      expect(screen.getByLabelText('Notice text')).toHaveValue('');
    });
  }, 15_000);

  it('edit the notice: 4001 characters is refused client-side', async () => {
    const api = fakeApi({ 'GET /api/session': session(null) });
    await renderSettings();
    const field = await screen.findByLabelText('Notice text');
    const user = userEvent.setup();
    // A programmatic value is not stopped by the browser's maxLength the way typing is.
    fireEvent.change(field, { target: { value: 'n'.repeat(4001) } });
    await user.click(screen.getByRole('button', { name: 'Save notice' }));
    await screen.findByText('Use at most 4000 characters.');
    expect(api.sent('PUT /api/settings/sign-in-notice')).toHaveLength(0);
  }, 15_000);

  it('edit the notice: a failure shows an Alert and keeps the text', async () => {
    const user = userEvent.setup();
    fakeApi({
      'GET /api/session': session(null),
      'PUT /api/settings/sign-in-notice': () =>
        json(403, { error: { code: 'forbidden', message: 'no', requestId: 'r' } }),
    });
    await renderSettings();
    await user.type(await screen.findByLabelText('Notice text'), 'Keep me');
    await user.click(screen.getByRole('button', { name: 'Save notice' }));
    await screen.findByText('Only admins can change these settings.');
    expect(screen.getByLabelText('Notice text')).toHaveValue('Keep me');
  }, 15_000);
});
