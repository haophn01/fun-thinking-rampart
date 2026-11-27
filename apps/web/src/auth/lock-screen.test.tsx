import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gate } from './Gate';
import { SessionProvider } from './session';

vi.setConfig({ testTimeout: 15_000 });

interface Call {
  method: string;
  path: string;
  body: unknown;
  answer: (response: Response) => void;
}

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}
function apiError(status: number, code: string, message: string, details?: unknown) {
  return json(status, {
    error: { code, message, requestId: 'r', ...(details === undefined ? {} : { details }) },
  });
}

/** A fetch stub that holds every request until the test answers it. */
function fakeApi() {
  const calls: Call[] = [];
  const waiting: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (input: string, init: RequestInit = {}) =>
        new Promise<Response>((resolve) => {
          const call: Call = {
            method: init.method ?? 'GET',
            path: input,
            body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
            answer: resolve,
          };
          calls.push(call);
          waiting.push(call);
        }),
    ),
  );
  return {
    calls,
    sent: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key),
    /** Waits for the next unanswered request, which must be `key`. */
    async request(key: string): Promise<Call> {
      await waitFor(() => {
        expect(waiting.map((c) => `${c.method} ${c.path}`)).toContain(key);
      });
      const index = waiting.findIndex((c) => `${c.method} ${c.path}` === key);
      const [call] = waiting.splice(index, 1);
      if (call === undefined) throw new Error(`no ${key}`);
      return call;
    },
    /** Answers the next `key` request with `response`. */
    async answer(key: string, response: Response): Promise<Call> {
      const call = await this.request(key);
      await act(async () => {
        call.answer(response);
        await Promise.resolve();
      });
      return call;
    },
    unanswered: () => waiting.length,
  };
}

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };

function session(over: Record<string, unknown> = {}) {
  return {
    setupRequired: false,
    user: ADMIN,
    csrfToken: 'csrf-1',
    locked: false,
    mustChangePassword: false,
    signInNotice: null,
    ...over,
  };
}

function renderGate() {
  return render(
    <SessionProvider>
      <Gate>
        <p>App content</p>
      </Gate>
    </SessionProvider>,
  );
}

/** Loads a locked session and waits for the lock screen. */
async function loadLocked(api: ReturnType<typeof fakeApi>) {
  renderGate();
  await api.answer('GET /api/session', json(200, session({ locked: true })));
  expect(await screen.findByRole('heading', { level: 1, name: 'Session locked' })).toBeVisible();
}

function passwordField() {
  return screen.getByLabelText<HTMLInputElement>('Password');
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('unlock and sign out', () => {
  it('shows who is locked out, with the password field focused', async () => {
    const api = fakeApi();
    await loadLocked(api);
    expect(screen.getByText('Ada Admin')).toBeVisible();
    expect(screen.getByText('ada@example.com')).toBeVisible();
    expect(passwordField()).toHaveAttribute('type', 'password');
    expect(passwordField()).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });

  it('unlock sends the password and returns to the app', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    await loadLocked(api);
    await user.type(passwordField(), 'right password 1');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    const call = await api.request('POST /api/session/unlock');
    expect(call.body).toEqual({ password: 'right password 1' });
    // While the answer is out, a second click sends nothing.
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(api.sent('POST /api/session/unlock')).toHaveLength(1);
    await act(async () => {
      call.answer(json(200, session({ csrfToken: 'csrf-2' })));
      await Promise.resolve();
    });
    expect(await screen.findByText('App content')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Session locked' })).not.toBeInTheDocument();
  });

  it('a wrong password shows the text and clears the field', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    await loadLocked(api);
    await user.type(passwordField(), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await api.answer(
      'POST /api/session/unlock',
      apiError(401, 'invalid_credentials', 'Password is incorrect.'),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Password is incorrect.');
    expect(passwordField().value).toBe('');
    expect(passwordField()).toHaveFocus();
    expect(screen.getByRole('heading', { level: 1, name: 'Session locked' })).toBeVisible();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });

  it('429 shows the wait', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    await loadLocked(api);
    await user.type(passwordField(), 'some password 1');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await api.answer(
      'POST /api/session/unlock',
      apiError(429, 'too_many_attempts', 'Too many attempts.', { retryAfterSeconds: 90 }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many requests. Try again in 2 minutes.',
    );
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
  });

  it('an empty password sends nothing', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    await loadLocked(api);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Enter your password.')).toBeVisible();
    expect(api.sent('POST /api/session/unlock')).toHaveLength(0);
  });

  it('Sign out signs out', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    await loadLocked(api);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await api.answer('DELETE /api/session', json(204));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(screen.queryByText('App content')).not.toBeInTheDocument();
  });
});

describe('unlocked elsewhere', () => {
  it('focus triggers refresh(), and locked: false dismisses the lock', async () => {
    const api = fakeApi();
    await loadLocked(api);
    expect(api.sent('GET /api/session')).toHaveLength(1);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    // A second focus while the first re-read is out sends nothing more.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await api.answer('GET /api/session', json(200, session()));
    expect(await screen.findByText('App content')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Session locked' })).not.toBeInTheDocument();
    expect(api.sent('GET /api/session')).toHaveLength(2);
  });

  it('a tab becoming visible re-reads; a hidden one does not', async () => {
    const api = fakeApi();
    await loadLocked(api);
    const visibility = (state: string) => {
      act(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    };
    visibility('hidden');
    expect(api.sent('GET /api/session')).toHaveLength(1);
    visibility('visible');
    // Still locked: the lock stays.
    await api.answer('GET /api/session', json(200, session({ locked: true })));
    expect(screen.getByRole('heading', { level: 1, name: 'Session locked' })).toBeVisible();
    visibility('visible');
    await api.answer('GET /api/session', json(200, session()));
    expect(await screen.findByText('App content')).toBeVisible();
  });
});
