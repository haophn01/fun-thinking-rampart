import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

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
function apiError(status: number, code: string) {
  return json(status, { error: { code, message: code, requestId: 'r' } });
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

const CREATED = '2026-11-24T10:00:00.000Z';
const ADA = {
  id: 'u-1',
  email: 'ada@example.com',
  displayName: 'Ada Admin',
  role: 'admin',
  active: true,
  createdAt: CREATED,
} as const;
const KIM = {
  id: 'u-2',
  email: 'kim@example.com',
  displayName: 'Kim',
  role: 'contributor',
  active: true,
  createdAt: CREATED,
} as const;
type User = { id: string; email: string; displayName: string; role: string; active: boolean };

function session(user: User) {
  const { id, email, displayName, role } = user;
  return { setupRequired: false, user: { id, email, displayName, role }, csrfToken: 'csrf-1' };
}

const ASSESSMENT_VIEW = {
  assessment: {
    id: 'a-1',
    type: 'self',
    conditionalStatusDate: null,
    catalogVersion: 'v1',
    updatedAt: CREATED,
  },
  objectiveResults: [],
  requirementStates: [],
  evaluation: {
    outcomes: [],
    score: {
      kind: 'incomplete',
      reason: 'prerequisite_not_met',
      prerequisites: [],
      max: 110,
      floor: -203,
      notAssessed: [],
    },
    conditional: { status: 'incomplete', blockers: [] },
  },
  closeout: null,
};

/** A small users api: the list, create and patch, over an in-memory table. */
function usersApi(signedInAs: User = ADA, extra: Record<string, Handler> = {}) {
  let users: User[] = [ADA, KIM];
  let me: User | null = signedInAs;
  const patch: Handler = (call) => {
    const id = call.path.split('/').pop();
    const target = users.find((u) => u.id === id);
    if (!target) return apiError(404, 'not_found');
    const next = { ...target, ...(call.body as Partial<User>) };
    delete (next as { password?: string }).password;
    users = users.map((u) => (u.id === id ? next : u));
    return json(200, { user: next });
  };
  const api = fakeApi({
    'GET /api/session': () =>
      me === null
        ? json(200, { setupRequired: false, user: null, csrfToken: null })
        : json(200, session(me)),
    'GET /api/users': () => json(200, { users }),
    'POST /api/users': (call) => {
      const body = call.body as User;
      if (users.some((u) => u.email === body.email)) return apiError(409, 'email_taken');
      const user = { ...body, id: 'u-3', active: true, createdAt: CREATED };
      delete (user as { password?: string }).password;
      users = [...users, user];
      return json(201, { user });
    },
    'GET /api/audit?limit=50': () => json(200, { events: [], nextBefore: null }),
    'GET /api/assessment': () => json(200, ASSESSMENT_VIEW),
    'PATCH /api/users/u-1': patch,
    'PATCH /api/users/u-2': patch,
    ...extra,
  });
  return {
    ...api,
    signOut: () => {
      me = null;
    },
    setMe: (user: User) => {
      me = user;
    },
  };
}

async function renderSettings() {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <AuthedApp />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Settings' });
}

function form() {
  return screen.getByRole('form', { name: 'Add a user' });
}

function row(name: string) {
  return screen.getByRole('listitem', { name });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UsersPanel', () => {
  it('users panel', async () => {
    const user = userEvent.setup();
    const api = usersApi();
    await renderSettings();

    // The list, with the signed-in admin marked.
    expect(await screen.findByRole('heading', { level: 2, name: /Users/ })).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: 'Kim' })).toBeInTheDocument();
    expect(within(row('Kim')).getByText('kim@example.com')).toBeInTheDocument();
    expect(within(row('Ada Admin')).getByText('You')).toBeInTheDocument();

    // Create.
    await user.type(within(form()).getByLabelText('Email'), 'Lee@Example.com');
    await user.type(within(form()).getByLabelText('Display name'), 'Lee');
    await user.selectOptions(within(form()).getByLabelText('Role'), 'admin');
    await user.type(within(form()).getByLabelText('Temporary password'), 'a long password');
    await user.click(within(form()).getByRole('button', { name: 'Add user' }));
    expect(await screen.findByRole('listitem', { name: 'Lee' })).toBeInTheDocument();
    const [create] = api.sent('POST /api/users');
    expect(create?.body).toEqual({
      email: 'lee@example.com',
      displayName: 'Lee',
      role: 'admin',
      password: 'a long password',
    });
    expect(create?.headers.get('x-csrf-token')).toBe('csrf-1');
    expect(within(form()).getByLabelText('Email')).toHaveValue('');
    expect(within(form()).getByLabelText('Temporary password')).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('Added Lee.');

    // A second add clears the old notice before it shows its own error.
    await user.type(within(form()).getByLabelText('Email'), 'lee@example.com');
    await user.type(within(form()).getByLabelText('Display name'), 'Lee Again');
    await user.type(within(form()).getByLabelText('Temporary password'), 'a long password');
    await user.click(within(form()).getByRole('button', { name: 'Add user' }));
    expect(await within(form()).findByText('That email is already in use.')).toBeInTheDocument();
    expect(screen.queryByText('Added Lee.')).not.toBeInTheDocument();

    // Change role.
    await user.selectOptions(within(row('Kim')).getByLabelText('Role'), 'admin');
    expect(api.sent('PATCH /api/users/u-2').at(-1)?.body).toEqual({ role: 'admin' });
    expect(await within(row('Kim')).findByDisplayValue('Admin')).toBeInTheDocument();

    // Deactivate, then reactivate.
    await user.click(within(row('Kim')).getByRole('button', { name: 'Deactivate' }));
    expect(api.sent('PATCH /api/users/u-2').at(-1)?.body).toEqual({ active: false });
    expect(await within(row('Kim')).findByText('Inactive')).toBeInTheDocument();
    await user.click(within(row('Kim')).getByRole('button', { name: 'Reactivate' }));
    expect(api.sent('PATCH /api/users/u-2').at(-1)?.body).toEqual({ active: true });
    expect(await within(row('Kim')).findByText('Active')).toBeInTheDocument();

    // Reset password: checked before sending.
    await user.click(within(row('Kim')).getByRole('button', { name: 'Reset password' }));
    const newPassword = within(row('Kim')).getByLabelText('New password');
    await user.type(newPassword, 'too short');
    await user.click(within(row('Kim')).getByRole('button', { name: 'Save password' }));
    expect(newPassword).toHaveAccessibleDescription('Use 12 to 128 characters.');
    const patches = api.sent('PATCH /api/users/u-2').length;
    expect(patches).toBe(3);
    await user.clear(newPassword);
    await user.type(newPassword, 'another long one');
    await user.click(within(row('Kim')).getByRole('button', { name: 'Save password' }));
    expect(api.sent('PATCH /api/users/u-2').at(-1)?.body).toEqual({
      password: 'another long one',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Password reset for Kim');
    expect(within(row('Kim')).queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('shows email_taken on the email field and blocks a short password', async () => {
    const user = userEvent.setup();
    const api = usersApi(ADA, { 'POST /api/users': () => apiError(409, 'email_taken') });
    await renderSettings();
    await screen.findByRole('listitem', { name: 'Kim' });

    await user.type(within(form()).getByLabelText('Email'), 'kim@example.com');
    await user.type(within(form()).getByLabelText('Display name'), 'Kim Two');
    await user.type(within(form()).getByLabelText('Temporary password'), 'short');
    await user.click(within(form()).getByRole('button', { name: 'Add user' }));
    expect(within(form()).getByLabelText('Temporary password')).toHaveAccessibleDescription(
      'Use 12 to 128 characters.',
    );
    expect(api.sent('POST /api/users')).toHaveLength(0);

    await user.clear(within(form()).getByLabelText('Temporary password'));
    await user.type(within(form()).getByLabelText('Temporary password'), 'a long password');
    await user.click(within(form()).getByRole('button', { name: 'Add user' }));
    expect(api.sent('POST /api/users')).toHaveLength(1);
    expect(await screen.findByText('That email is already in use.')).toBeInTheDocument();
    expect(within(form()).getByLabelText('Email')).toHaveAccessibleDescription(
      'That email is already in use.',
    );
    // The form keeps what was typed.
    expect(within(form()).getByLabelText('Display name')).toHaveValue('Kim Two');
  });

  it('shows last_admin as an Alert and keeps the old role', async () => {
    const user = userEvent.setup();
    usersApi(ADA, {
      'PATCH /api/users/u-1': () => apiError(409, 'last_admin'),
    });
    await renderSettings();
    await screen.findByRole('listitem', { name: 'Ada Admin' });

    await user.selectOptions(within(row('Ada Admin')).getByLabelText('Role'), 'contributor');
    expect(await screen.findByRole('alert')).toHaveTextContent('at least one active admin');
    expect(within(row('Ada Admin')).getByLabelText('Role')).toHaveValue('admin');

    await user.click(within(row('Ada Admin')).getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at least one active admin');
    expect(within(row('Ada Admin')).getByText('Active')).toBeInTheDocument();
  });

  it('is shown to an admin but not to a contributor', async () => {
    const api = usersApi(KIM);
    await renderSettings();
    expect(screen.queryByRole('heading', { name: /Users/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add user' })).not.toBeInTheDocument();
    expect(api.sent('GET /api/users')).toHaveLength(0);
  });

  it('resetting your own password ends your session', async () => {
    const user = userEvent.setup();
    const api = usersApi(ADA);
    await renderSettings();
    await screen.findByRole('listitem', { name: 'Ada Admin' });
    await user.click(within(row('Ada Admin')).getByRole('button', { name: 'Reset password' }));
    await user.type(within(row('Ada Admin')).getByLabelText('New password'), 'my new password');
    api.signOut();
    await user.click(within(row('Ada Admin')).getByRole('button', { name: 'Save password' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Your session ended. Sign in again.')).toBeInTheDocument();
  });

  it('temporary passwords and role change', async () => {
    const user = userEvent.setup();
    const api = usersApi(ADA, {
      'POST /api/users': () => apiError(400, 'password_too_common'),
      'PATCH /api/users/u-2': () => apiError(400, 'password_too_common'),
    });
    await renderSettings();
    await screen.findByRole('listitem', { name: 'Kim' });

    // The create form says Temporary password, with its hint.
    expect(within(form()).getByLabelText('Temporary password')).toBeInTheDocument();
    expect(within(form()).queryByLabelText('Password')).not.toBeInTheDocument();
    expect(within(form()).getByText('They choose their own at first sign-in.')).toBeInTheDocument();

    // A too-common error lands on the field.
    await user.type(within(form()).getByLabelText('Email'), 'lee@example.com');
    await user.type(within(form()).getByLabelText('Display name'), 'Lee');
    await user.type(within(form()).getByLabelText('Temporary password'), 'password1234');
    await user.click(within(form()).getByRole('button', { name: 'Add user' }));
    await vi.waitFor(() => {
      expect(within(form()).getByLabelText('Temporary password')).toHaveAccessibleDescription(
        'This password is too common. Choose another.',
      );
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // The same for a reset.
    await user.click(within(row('Kim')).getByRole('button', { name: 'Reset password' }));
    await user.type(within(row('Kim')).getByLabelText('New password'), 'password1234');
    await user.click(within(row('Kim')).getByRole('button', { name: 'Save password' }));
    await vi.waitFor(() => {
      expect(within(row('Kim')).getByLabelText('New password')).toHaveAccessibleDescription(
        'This password is too common. Choose another.',
      );
    });
    expect(api.sent('PATCH /api/users/u-2')).toHaveLength(1);
  });

  it('a reset notice mentions the forced change', async () => {
    const user = userEvent.setup();
    usersApi(ADA);
    await renderSettings();
    await screen.findByRole('listitem', { name: 'Kim' });
    await user.click(within(row('Kim')).getByRole('button', { name: 'Reset password' }));
    await user.type(within(row('Kim')).getByLabelText('New password'), 'another long one');
    await user.click(within(row('Kim')).getByRole('button', { name: 'Save password' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Password reset for Kim. Their sessions have ended, and they must choose a new password at next sign-in.',
    );
  });

  it('changing your own role ends your session', async () => {
    const user = userEvent.setup();
    const api = usersApi(ADA);
    await renderSettings();
    await screen.findByRole('listitem', { name: 'Ada Admin' });
    api.signOut();
    await user.selectOptions(within(row('Ada Admin')).getByLabelText('Role'), 'contributor');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Your session ended. Sign in again.')).toBeInTheDocument();
  });

  it('shows a load failure with Retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    usersApi(ADA, {
      'GET /api/users': () =>
        fail ? apiError(503, 'db_unavailable') : json(200, { users: [ADA] }),
    });
    await renderSettings();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Can't load users");
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('listitem', { name: 'Ada Admin' })).toBeInTheDocument();
  });
});
