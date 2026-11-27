import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiSend } from '../api/client';
import { AuthedApp } from '../App';
import { Gate } from './Gate';
import { SESSION_ENDED, SessionProvider, useSession } from './session';

vi.setConfig({ testTimeout: 15_000 });

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

/** A full session answer, with the three sec-auth fields A1 adds. */
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
const SIGNED_OUT = session({ user: null, csrfToken: null });

describe('rate-limited session load', () => {
  it('rate-limited session load', async () => {
    const user = userEvent.setup();
    let limited = true;
    const api = fakeApi({
      'GET /api/session': () =>
        limited
          ? apiError(429, 'too_many_attempts', { retryAfterSeconds: 30 })
          : json(200, SIGNED_OUT),
    });
    renderApp();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many requests. Try again in 30 seconds.');
    expect(screen.queryByText(/load your session/)).not.toBeInTheDocument();

    // A Retry inside the wait is limited again; after the wait it loads the session.
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(api.sent('GET /api/session')).toHaveLength(2);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    limited = false;
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.sent('GET /api/session')).toHaveLength(3);
  });

  it('shows the minutes, or "later" when the 429 gives no wait', async () => {
    fakeApi({
      'GET /api/session': () => apiError(429, 'too_many_attempts', { retryAfterSeconds: 61 }),
    });
    const minutes = renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many requests. Try again in 2 minutes.',
    );
    minutes.unmount();

    fakeApi({ 'GET /api/session': () => apiError(429, 'too_many_attempts') });
    renderApp();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many requests. Try again later.');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a later error that is not a 429 shows the session error again', async () => {
    const user = userEvent.setup();
    let code = 429;
    fakeApi({
      'GET /api/session': () =>
        code === 429
          ? apiError(429, 'too_many_attempts', { retryAfterSeconds: 5 })
          : apiError(503, 'db_unavailable'),
    });
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    code = 503;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/load your session/)).toBeInTheDocument();
    expect(screen.queryByText(/Too many requests/)).not.toBeInTheDocument();
  });
});

describe('gate states for lock and password change', () => {
  it('gate states for lock and password change', async () => {
    // A page that loads into a locked session mounts only the lock screen.
    fakeApi({ 'GET /api/session': () => json(200, session({ locked: true })) });
    const locked = renderApp('/poam');
    expect(await screen.findByRole('heading', { level: 1, name: 'Session locked' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'POA&M', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByTestId('gate-app')).not.toBeInTheDocument();
    locked.unmount();

    // A temporary password shows the forced change page in the auth frame, not the shell.
    fakeApi({ 'GET /api/session': () => json(200, session({ mustChangePassword: true })) });
    const forced = renderApp('/poam');
    expect(await screen.findByRole('heading', { level: 1, name: 'Change password' })).toBeVisible();
    expect(screen.getByTestId('change-password-forced')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { hidden: true })).not.toBeInTheDocument();
    forced.unmount();

    // Locked wins over a required change.
    fakeApi({
      'GET /api/session': () => json(200, session({ locked: true, mustChangePassword: true })),
    });
    const both = renderApp();
    expect(await screen.findByRole('heading', { level: 1, name: 'Session locked' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Change password' })).not.toBeInTheDocument();
    both.unmount();

    // A 423 from any call while signed in locks the gate.
    fakeApi({
      'GET /api/session': () => json(200, session()),
      'GET /api/users': () => apiError(423, 'session_locked'),
    });
    renderApp('/settings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Session locked' })).toBeVisible();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

/** A typed draft behind the gate. */
function Draft() {
  const [text, setText] = useState('');
  return (
    <label>
      Draft
      <textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
    </label>
  );
}

/** The session store's state and methods, outside the gate. */
function Probe() {
  const s = useSession();
  const [failure, setFailure] = useState('');
  const run = (action: () => Promise<unknown>) => () => {
    setFailure('');
    action().catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : 'failed');
    });
  };
  return (
    <div data-testid="probe">
      <output data-testid="status">{s.status}</output>
      <output data-testid="failure">{failure}</output>
      <output data-testid="notice">{s.notice ?? ''}</output>
      <button type="button" onClick={() => void s.lock()}>
        Probe lock
      </button>
      <button type="button" onClick={run(() => s.unlock('right password 1'))}>
        Probe unlock
      </button>
      <button
        type="button"
        onClick={run(() => s.changePassword('old password 12', 'new password 12'))}
      >
        Probe change
      </button>
      <button type="button" onClick={run(() => s.signIn('ada@example.com', 'pw', 'a'.repeat(64)))}>
        Probe sign in with digest
      </button>
      <button type="button" onClick={run(() => s.signIn('ada@example.com', 'pw'))}>
        Probe sign in
      </button>
      <button type="button" onClick={run(() => apiSend('POST', '/api/poam', {}))}>
        Probe write
      </button>
      <button type="button" onClick={() => void s.refresh()}>
        Probe refresh
      </button>
      <button type="button" onClick={s.endSession}>
        Probe end
      </button>
    </div>
  );
}

function renderProbe() {
  return render(
    <MemoryRouter>
      <SessionProvider>
        <Probe />
        <Gate>
          <Draft />
        </Gate>
      </SessionProvider>
    </MemoryRouter>,
  );
}

const status = () => screen.getByTestId('status');

describe('lock keeps the app mounted but hidden', () => {
  it('lock keeps the app mounted but hidden', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'GET /api/session': () => json(200, session()),
      'POST /api/session/lock': () => json(204),
      'POST /api/session/unlock': () => json(200, session({ csrfToken: 'csrf-2' })),
    });
    renderProbe();
    await user.type(await screen.findByLabelText('Draft'), 'half-written finding');

    await user.click(screen.getByRole('button', { name: 'Probe lock' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Session locked' })).toBeVisible();
    const draft = screen.getByLabelText<HTMLTextAreaElement>('Draft');
    expect(draft).not.toBeVisible();
    const app = screen.getByTestId('gate-app');
    expect(app).toHaveAttribute('hidden');
    expect(app).toHaveAttribute('inert');
    expect(app).toContainElement(draft);
    expect(draft.value).toBe('half-written finding');
    await waitFor(() => {
      expect(api.sent('POST /api/session/lock')).toHaveLength(1);
    });

    await user.type(screen.getByLabelText('Password'), 'right password 1');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Session locked' })).not.toBeInTheDocument();
    });
    expect(api.sent('POST /api/session/unlock')[0]?.body).toEqual({
      password: 'right password 1',
    });
    const after = screen.getByLabelText<HTMLTextAreaElement>('Draft');
    expect(after).toBe(draft);
    expect(after).toBeVisible();
    expect(after.value).toBe('half-written finding');
    expect(screen.getByTestId('gate-app')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('gate-app')).not.toHaveAttribute('inert');
  });

  it('a wrong unlock password keeps the lock and the draft', async () => {
    const user = userEvent.setup();
    fakeApi({
      'GET /api/session': () => json(200, session()),
      'POST /api/session/lock': () => json(204),
      'POST /api/session/unlock': () => apiError(401, 'invalid_credentials'),
    });
    renderProbe();
    await user.type(await screen.findByLabelText('Draft'), 'keep me');
    await user.click(screen.getByRole('button', { name: 'Probe lock' }));
    await user.type(await screen.findByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(status()).toHaveTextContent('locked');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Draft').value).toBe('keep me');
  });
});

describe('session methods', () => {
  it('session methods', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'GET /api/session': () => json(200, session()),
      'POST /api/session/lock': () => apiError(500, 'internal_error'),
      'POST /api/session/unlock': () => json(200, session({ csrfToken: 'csrf-2' })),
      'POST /api/session/password': () => json(200, session({ csrfToken: 'csrf-3' })),
      'POST /api/poam': () => json(201, {}),
    });
    renderProbe();
    await waitFor(() => {
      expect(status()).toHaveTextContent('signed_in');
    });

    // lock() shows the lock at once, and a failing POST doesn't undo it.
    await user.click(screen.getByRole('button', { name: 'Probe lock' }));
    expect(status()).toHaveTextContent('locked');
    await waitFor(() => {
      expect(api.sent('POST /api/session/lock')).toHaveLength(1);
    });
    expect(api.sent('POST /api/session/lock')[0]?.headers.get('x-csrf-token')).toBe('csrf-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(status()).toHaveTextContent('locked');
    expect(screen.getByRole('heading', { level: 1, name: 'Session locked' })).toBeVisible();

    // unlock applies the returned session, its CSRF token included.
    await user.click(screen.getByRole('button', { name: 'Probe unlock' }));
    await waitFor(() => {
      expect(status()).toHaveTextContent('signed_in');
    });
    await user.click(screen.getByRole('button', { name: 'Probe write' }));
    await waitFor(() => {
      expect(api.sent('POST /api/poam')).toHaveLength(1);
    });
    expect(api.sent('POST /api/poam')[0]?.headers.get('x-csrf-token')).toBe('csrf-2');

    // changePassword sends both passwords and applies the rotated session.
    await user.click(screen.getByRole('button', { name: 'Probe change' }));
    await waitFor(() => {
      expect(api.sent('POST /api/session/password')).toHaveLength(1);
    });
    expect(api.sent('POST /api/session/password')[0]?.body).toEqual({
      currentPassword: 'old password 12',
      newPassword: 'new password 12',
    });
    await user.click(screen.getByRole('button', { name: 'Probe write' }));
    await waitFor(() => {
      expect(api.sent('POST /api/poam')).toHaveLength(2);
    });
    expect(api.sent('POST /api/poam')[1]?.headers.get('x-csrf-token')).toBe('csrf-3');
    expect(status()).toHaveTextContent('signed_in');
  });

  it('a forced change ends in the app once the new session no longer needs one', async () => {
    const user = userEvent.setup();
    fakeApi({
      'GET /api/session': () => json(200, session({ mustChangePassword: true })),
      'POST /api/session/password': () => json(200, session({ csrfToken: 'csrf-3' })),
    });
    renderProbe();
    expect(await screen.findByRole('heading', { level: 1, name: 'Change password' })).toBeVisible();
    expect(status()).toHaveTextContent('password_change');
    await user.click(screen.getByRole('button', { name: 'Probe change' }));
    expect(await screen.findByLabelText('Draft')).toBeVisible();
    expect(status()).toHaveTextContent('signed_in');
  });

  it('signIn sends the notice digest only when given', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'GET /api/session': () => json(200, SIGNED_OUT),
      'POST /api/session': () => apiError(401, 'invalid_credentials'),
    });
    renderProbe();
    await waitFor(() => {
      expect(status()).toHaveTextContent('signed_out');
    });
    await user.click(screen.getByRole('button', { name: 'Probe sign in with digest' }));
    await user.click(screen.getByRole('button', { name: 'Probe sign in' }));
    await waitFor(() => {
      expect(api.sent('POST /api/session')).toHaveLength(2);
    });
    const [withDigest, without] = api.sent('POST /api/session');
    expect(withDigest?.body).toEqual({
      email: 'ada@example.com',
      password: 'pw',
      noticeDigest: 'a'.repeat(64),
    });
    expect(without?.body).toEqual({ email: 'ada@example.com', password: 'pw' });
  });

  it('endSession works from locked and from a required change', async () => {
    const user = userEvent.setup();
    fakeApi({ 'GET /api/session': () => json(200, session({ locked: true })) });
    const locked = renderProbe();
    await waitFor(() => {
      expect(status()).toHaveTextContent('locked');
    });
    await user.click(screen.getByRole('button', { name: 'Probe end' }));
    expect(status()).toHaveTextContent('signed_out');
    expect(screen.getByTestId('notice')).toHaveTextContent(SESSION_ENDED);
    locked.unmount();

    fakeApi({ 'GET /api/session': () => json(200, session({ mustChangePassword: true })) });
    renderProbe();
    await waitFor(() => {
      expect(status()).toHaveTextContent('password_change');
    });
    await user.click(screen.getByRole('button', { name: 'Probe end' }));
    expect(status()).toHaveTextContent('signed_out');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });

  it('lock() does nothing when no one is signed in', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ 'GET /api/session': () => json(200, SIGNED_OUT) });
    renderProbe();
    await waitFor(() => {
      expect(status()).toHaveTextContent('signed_out');
    });
    await user.click(screen.getByRole('button', { name: 'Probe lock' }));
    expect(status()).toHaveTextContent('signed_out');
    expect(api.sent('POST /api/session/lock')).toHaveLength(0);
  });

  it('a late session answer does not undo a lock', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => undefined;
    let first = true;
    const api = fakeApi({
      'GET /api/session': () => {
        if (first) {
          first = false;
          return json(200, session());
        }
        return new Promise<Response>((resolve) => (answer = resolve));
      },
      'POST /api/session/lock': () => json(204),
    });
    renderProbe();
    await waitFor(() => {
      expect(status()).toHaveTextContent('signed_in');
    });
    await user.click(screen.getByRole('button', { name: 'Probe refresh' }));
    await waitFor(() => {
      expect(api.sent('GET /api/session')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Probe lock' }));
    answer(json(200, session()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(status()).toHaveTextContent('locked');
  });

  it('a failed refresh while signed in keeps the app and its drafts', async () => {
    const user = userEvent.setup();
    let fail = false;
    const api = fakeApi({
      'GET /api/session': () => (fail ? apiError(503, 'db_unavailable') : json(200, session())),
    });
    renderProbe();
    await user.type(await screen.findByLabelText('Draft'), 'not lost');
    fail = true;
    await user.click(screen.getByRole('button', { name: 'Probe refresh' }));
    await waitFor(() => {
      expect(api.sent('GET /api/session')).toHaveLength(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(status()).toHaveTextContent('signed_in');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Draft').value).toBe('not lost');
    expect(screen.queryByText(/load your session/)).not.toBeInTheDocument();
  });
});

describe('a lock the api has not confirmed', () => {
  it('a lock the api has not confirmed survives a re-read', async () => {
    const user = userEvent.setup();
    let lockWorks = false;
    const api = fakeApi({
      'GET /api/session': () => json(200, session()),
      'POST /api/session/lock': () => (lockWorks ? json(204) : apiError(500, 'internal_error')),
    });
    renderProbe();
    await waitFor(() => {
      expect(status()).toHaveTextContent('signed_in');
    });

    // The lock POST failed, so a re-read saying "not locked" keeps the lock and posts it again.
    await user.click(screen.getByRole('button', { name: 'Probe lock' }));
    await waitFor(() => {
      expect(api.sent('POST /api/session/lock')).toHaveLength(1);
    });
    lockWorks = true;
    await user.click(screen.getByRole('button', { name: 'Probe refresh' }));
    await waitFor(() => {
      expect(api.sent('POST /api/session/lock')).toHaveLength(2);
    });
    expect(status()).toHaveTextContent('locked');

    // Once the api has the lock, "not locked" means another tab unlocked it.
    await user.click(screen.getByRole('button', { name: 'Probe refresh' }));
    await waitFor(() => {
      expect(status()).toHaveTextContent('signed_in');
    });
    expect(api.sent('POST /api/session/lock')).toHaveLength(2);
  });
});

/** One held answer: the test waits for the request, then answers it. */
function held() {
  let arrived: (call: Call) => void = () => undefined;
  let answer: (response: Response) => void = () => undefined;
  const requested = new Promise<Call>((resolve) => (arrived = resolve));
  const response = new Promise<Response>((resolve) => (answer = resolve));
  const handler: Handler = (call) => {
    arrived(call);
    return response;
  };
  return { handler, requested, answer };
}
type Held = ReturnType<typeof held>;

// Test fixture: the public RFC/Google Authenticator base32 example ("Hello!"), not a real secret.
// nosemgrep: generic.secrets.security.detected-generic-secret.detected-generic-secret
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const ENROLLMENT = {
  secret: SECRET,
  otpauthUri: `otpauth://totp/Rampart:ada%40example.com?secret=${SECRET}`,
  qr: { size: 21, path: 'M0 0h7v1h-7zM14 0h7v1h-7z' },
};
const CODES = Array.from({ length: 10 }, (_, index) => `abcde-fghj${String(index)}`);

describe('gate states for MFA', () => {
  it('gate states for MFA', async () => {
    // Enrollment shows in the auth frame, with nothing of the app behind it.
    const enroll = held();
    fakeApi({
      'GET /api/session': () => json(200, session({ mfa: 'enroll' })),
      'POST /api/session/mfa/enroll': enroll.handler,
    });
    const enrolling = renderApp('/poam');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set up two-step sign-in' }),
    ).toBeVisible();
    await enroll.requested;
    enroll.answer(json(200, ENROLLMENT));
    expect(await screen.findByTestId('mfa-manual-key')).toBeVisible();
    expect(screen.queryByRole('navigation', { hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByTestId('gate-app')).not.toBeInTheDocument();
    enrolling.unmount();

    // The challenge for an enrolled user whose session waits for the code.
    fakeApi({ 'GET /api/session': () => json(200, session({ mfa: 'challenge' })) });
    const challenge = renderApp('/poam');
    expect(await screen.findByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
    expect(screen.queryByRole('navigation', { hidden: true })).not.toBeInTheDocument();
    challenge.unmount();

    // Locked wins over both.
    for (const mfa of ['enroll', 'challenge']) {
      fakeApi({ 'GET /api/session': () => json(200, session({ mfa, locked: true })) });
      const locked = renderApp();
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Session locked' }),
      ).toBeVisible();
      expect(screen.queryByRole('heading', { name: /two-step|Enter your code/ })).toBeNull();
      locked.unmount();
    }

    // Both win over a required password change.
    const pendingEnroll = held();
    fakeApi({
      'GET /api/session': () => json(200, session({ mfa: 'enroll', mustChangePassword: true })),
      'POST /api/session/mfa/enroll': pendingEnroll.handler,
    });
    const enrollFirst = renderApp();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set up two-step sign-in' }),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Change password' })).not.toBeInTheDocument();
    await pendingEnroll.requested;
    pendingEnroll.answer(json(200, ENROLLMENT));
    await screen.findByTestId('mfa-manual-key');
    enrollFirst.unmount();
    fakeApi({
      'GET /api/session': () => json(200, session({ mfa: 'challenge', mustChangePassword: true })),
    });
    const challengeFirst = renderApp();
    expect(await screen.findByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Change password' })).not.toBeInTheDocument();
    challengeFirst.unmount();

    // A 403 mfa_required mid-session re-reads the session and shows enrollment.
    let mfa = 'none';
    const users = held();
    const reEnroll = held();
    const api = fakeApi({
      'GET /api/session': () => json(200, session({ mfa })),
      'GET /api/users': users.handler,
      'POST /api/session/mfa/enroll': reEnroll.handler,
    });
    renderApp('/settings');
    await users.requested;
    mfa = 'enroll';
    users.answer(apiError(403, 'mfa_required'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set up two-step sign-in' }),
    ).toBeVisible();
    expect(api.sent('GET /api/session')).toHaveLength(2);
    expect(screen.queryByRole('navigation', { hidden: true })).not.toBeInTheDocument();
    await reEnroll.requested;
    reEnroll.answer(json(200, ENROLLMENT));
    await screen.findByTestId('mfa-manual-key');
  });

  it('a failed re-read, lock() and endSession from the MFA states', async () => {
    const user = userEvent.setup();
    let fail = false;
    const api = fakeApi({
      'GET /api/session': () =>
        fail ? apiError(503, 'db_unavailable') : json(200, session({ mfa: 'challenge' })),
    });
    renderProbe();
    await waitFor(() => {
      expect(status()).toHaveTextContent('mfa_challenge');
    });
    // A failed re-read keeps the challenge rather than showing the session error.
    fail = true;
    await user.click(screen.getByRole('button', { name: 'Probe refresh' }));
    await waitFor(() => {
      expect(api.sent('GET /api/session')).toHaveLength(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(status()).toHaveTextContent('mfa_challenge');
    // lock() applies only to a full session.
    await user.click(screen.getByRole('button', { name: 'Probe lock' }));
    expect(status()).toHaveTextContent('mfa_challenge');
    expect(api.sent('POST /api/session/lock')).toHaveLength(0);
    // endSession ends it, like any held session.
    await user.click(screen.getByRole('button', { name: 'Probe end' }));
    expect(status()).toHaveTextContent('signed_out');
    expect(screen.getByTestId('notice')).toHaveTextContent(SESSION_ENDED);
  });
});

/** Enrolls through the page: answers the enroll POST, types the code, and confirms. */
async function enrollThrough(
  user: ReturnType<typeof userEvent.setup>,
  enroll: Held,
  confirm: Held,
  confirmed: Record<string, unknown>,
) {
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Set up two-step sign-in' }),
  ).toBeVisible();
  await enroll.requested;
  enroll.answer(json(200, ENROLLMENT));
  await user.type(await screen.findByLabelText('6-digit code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  const call = await confirm.requested;
  expect(call.body).toEqual({ code: '123456' });
  confirm.answer(json(200, { ...session(confirmed), recoveryCodes: CODES }));
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Save your recovery codes' }),
  ).toBeVisible();
  expect(within(screen.getByTestId('recovery-codes')).getAllByRole('listitem')).toHaveLength(10);
}

describe('recovery codes survive a re-read', () => {
  it('recovery codes survive a re-read', async () => {
    const user = userEvent.setup();
    let answer: Record<string, unknown> = session({ mfa: 'enroll' });
    const enroll = held();
    const confirm = held();
    const api = fakeApi({
      'GET /api/session': () => json(200, answer),
      'POST /api/session/mfa/enroll': enroll.handler,
      'POST /api/session/mfa/enroll/confirm': confirm.handler,
      'POST /api/poam': () => json(201, {}),
    });
    renderProbe();
    await enrollThrough(user, enroll, confirm, { csrfToken: 'csrf-2' });
    expect(status()).toHaveTextContent('mfa_recovery_codes');

    // A re-read for the same user, now with mfa none, keeps the codes on screen.
    answer = session({ csrfToken: 'csrf-3' });
    await user.click(screen.getByRole('button', { name: 'Probe refresh' }));
    await waitFor(() => {
      expect(api.sent('GET /api/session')).toHaveLength(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(status()).toHaveTextContent('mfa_recovery_codes');
    expect(screen.getByText(CODES[0] ?? '')).toBeVisible();

    // Continue opens the app, with the newest session's token.
    await user.click(screen.getByRole('checkbox', { name: 'I saved my recovery codes' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Draft')).toBeVisible();
    expect(status()).toHaveTextContent('signed_in');
    expect(screen.queryByTestId('recovery-codes')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Probe write' }));
    await waitFor(() => {
      expect(api.sent('POST /api/poam')).toHaveLength(1);
    });
    expect(api.sent('POST /api/poam')[0]?.headers.get('x-csrf-token')).toBe('csrf-3');
  });

  it('Continue opens the forced change when the password is temporary', async () => {
    const user = userEvent.setup();
    const enroll = held();
    const confirm = held();
    fakeApi({
      'GET /api/session': () => json(200, session({ mfa: 'enroll', mustChangePassword: true })),
      'POST /api/session/mfa/enroll': enroll.handler,
      'POST /api/session/mfa/enroll/confirm': confirm.handler,
    });
    renderProbe();
    await enrollThrough(user, enroll, confirm, { mustChangePassword: true });
    await user.click(screen.getByRole('checkbox', { name: 'I saved my recovery codes' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Change password' })).toBeVisible();
    expect(screen.getByTestId('change-password-forced')).toBeInTheDocument();
    expect(status()).toHaveTextContent('password_change');
  });

  it('a signed-out re-read, or a reset, drops the codes', async () => {
    const user = userEvent.setup();
    let answer: Record<string, unknown> = session({ mfa: 'enroll' });
    const enroll = held();
    const confirm = held();
    fakeApi({
      'GET /api/session': () => json(200, answer),
      'POST /api/session/mfa/enroll': enroll.handler,
      'POST /api/session/mfa/enroll/confirm': confirm.handler,
    });
    const first = renderProbe();
    await enrollThrough(user, enroll, confirm, {});
    answer = SIGNED_OUT;
    await user.click(screen.getByRole('button', { name: 'Probe refresh' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(status()).toHaveTextContent('signed_out');
    expect(screen.queryByTestId('recovery-codes')).not.toBeInTheDocument();
    first.unmount();

    // An admin reset in between: the same user must enroll again, so the old codes go.
    answer = session({ mfa: 'enroll' });
    const enrollAgain = held();
    const confirmAgain = held();
    const reEnroll = held();
    let enrolls = 0;
    fakeApi({
      'GET /api/session': () => json(200, answer),
      'POST /api/session/mfa/enroll': (call) => {
        enrolls += 1;
        return (enrolls === 1 ? enrollAgain : reEnroll).handler(call);
      },
      'POST /api/session/mfa/enroll/confirm': confirmAgain.handler,
    });
    renderProbe();
    await enrollThrough(user, enrollAgain, confirmAgain, {});
    await user.click(screen.getByRole('button', { name: 'Probe refresh' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set up two-step sign-in' }),
    ).toBeVisible();
    expect(status()).toHaveTextContent('mfa_enroll');
    expect(screen.queryByTestId('recovery-codes')).not.toBeInTheDocument();
    await reEnroll.requested;
    reEnroll.answer(json(200, ENROLLMENT));
    await screen.findByTestId('mfa-manual-key');
  });
});
