import { render, screen, waitFor } from '@testing-library/react';
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
      };
      calls.push(call);
      const key = `${call.method} ${call.path.split('?')[0] ?? ''}`;
      const handler =
        routes[key] ??
        (call.path === '/api/health'
          ? () => json(200, { status: 'ok', db: 'ok' })
          : () => json(404, { error: { code: 'not_found', message: 'nf', requestId: 'r' } }));
      return Promise.resolve(handler(call));
    }),
  );
  return { calls, sent: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key) };
}

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const CONTRIBUTOR = {
  id: 'u-2',
  email: 'kim@example.com',
  displayName: 'Kim',
  role: 'contributor',
};

function sessionFor(user: typeof ADMIN | typeof CONTRIBUTOR) {
  return () => json(200, { setupRequired: false, user, csrfToken: 'csrf-1' });
}

interface Assessment {
  type: 'self' | 'c3pao';
  conditionalStatusDate: string | null;
}
interface Closeout {
  conditionalStatusDate: string;
  deadline: string;
  daysRemaining: number;
  expired: boolean;
}

function view(assessment: Assessment, closeout: Closeout | null) {
  return {
    assessment: {
      id: 'a-1',
      ...assessment,
      catalogVersion: 'v1',
      updatedAt: '2026-11-24T10:00:00.000Z',
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
    closeout,
  };
}

const NO_AUDIT = () => json(200, { events: [], nextBefore: null });
const NO_USERS = () => json(200, { users: [] });

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

describe('AssessmentSettings', () => {
  it('type and roles', async () => {
    const user = userEvent.setup();
    let current: Assessment = { type: 'self', conditionalStatusDate: null };
    const api = fakeApi({
      'GET /api/session': sessionFor(ADMIN),
      'GET /api/audit': NO_AUDIT,
      'GET /api/users': NO_USERS,
      'GET /api/assessment': () => json(200, view(current, null)),
      'PATCH /api/assessment': (call) => {
        current = { ...current, ...(call.body as Partial<Assessment>) };
        return json(200, view(current, null));
      },
    });
    await renderSettings();

    // Self-assessment is the default; the organization confirms closeout.
    const self = await screen.findByRole('radio', { name: 'Self-assessment' });
    expect(self).toBeChecked();
    expect(screen.getByText('Closeout confirmed by:')).toBeInTheDocument();
    expect(screen.getByText('Your organization')).toBeInTheDocument();

    // Picking C3PAO changes the confirmer at once, but nothing is sent until Save.
    await user.click(screen.getByRole('radio', { name: 'C3PAO certification assessment' }));
    expect(screen.getByText('An authorized C3PAO')).toBeInTheDocument();
    expect(api.sent('PATCH /api/assessment')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    const patches = api.sent('PATCH /api/assessment');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ type: 'c3pao' });
    expect(screen.getByRole('radio', { name: 'C3PAO certification assessment' })).toBeChecked();
  });

  it('shows the confirmer for a c3pao assessment on load, and gives a contributor no Save', async () => {
    fakeApi({
      'GET /api/session': sessionFor(CONTRIBUTOR),
      'GET /api/audit': NO_AUDIT,
      'GET /api/assessment': () =>
        json(200, view({ type: 'c3pao', conditionalStatusDate: null }, null)),
    });
    await renderSettings();

    const c3pao = await screen.findByRole('radio', { name: 'C3PAO certification assessment' });
    expect(c3pao).toBeChecked();
    expect(screen.getByText('An authorized C3PAO')).toBeInTheDocument();
    expect(c3pao).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Self-assessment' })).toBeDisabled();
    expect(screen.getByLabelText('Conditional Status Date')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear date' })).not.toBeInTheDocument();
  });

  it('conditional status date', async () => {
    const user = userEvent.setup();
    let current: Assessment = { type: 'self', conditionalStatusDate: null };
    let closeout: Closeout | null = null;
    const api = fakeApi({
      'GET /api/session': sessionFor(ADMIN),
      'GET /api/audit': NO_AUDIT,
      'GET /api/users': NO_USERS,
      'GET /api/assessment': () => json(200, view(current, closeout)),
      'PATCH /api/assessment': (call) => {
        current = { ...current, ...(call.body as Partial<Assessment>) };
        return json(200, view(current, closeout));
      },
    });
    await renderSettings();
    const field = await screen.findByLabelText('Conditional Status Date');
    const save = screen.getByRole('button', { name: 'Save' });

    // A date that is not a real calendar date, or not YYYY-MM-DD, sends nothing.
    for (const bad of ['2026-02-30', '2026-2-3']) {
      await user.clear(field);
      await user.type(field, bad);
      await user.click(save);
      expect(await screen.findByText('Enter a real date as YYYY-MM-DD.')).toBeInTheDocument();
      expect(field).toHaveAccessibleDescription('Enter a real date as YYYY-MM-DD.');
      expect(api.sent('PATCH /api/assessment')).toHaveLength(0);
    }

    // A valid date is sent, and the deadline and days remaining come from the response.
    closeout = {
      conditionalStatusDate: '2026-12-01',
      deadline: '2027-03-01',
      daysRemaining: 97,
      expired: false,
    };
    await user.clear(field);
    await user.type(field, '2026-12-01');
    await user.click(save);
    await screen.findByText('Deadline 2027-03-01');
    expect(screen.getByText('97 days remaining')).toBeInTheDocument();
    expect(api.sent('PATCH /api/assessment')[0]?.body).toEqual({
      conditionalStatusDate: '2026-12-01',
    });
    expect(screen.queryByText('Enter a real date as YYYY-MM-DD.')).not.toBeInTheDocument();

    // Clear sends null, and the deadline goes away.
    closeout = null;
    await user.click(screen.getByRole('button', { name: 'Clear date' }));
    await waitFor(() => {
      expect(api.sent('PATCH /api/assessment')).toHaveLength(2);
    });
    expect(api.sent('PATCH /api/assessment')[1]?.body).toEqual({ conditionalStatusDate: null });
    await waitFor(() => {
      expect(screen.queryByText(/Deadline/)).not.toBeInTheDocument();
    });
    expect(field).toHaveValue('');
  });

  it('shows Expired when the clock has run out', async () => {
    fakeApi({
      'GET /api/session': sessionFor(ADMIN),
      'GET /api/audit': NO_AUDIT,
      'GET /api/users': NO_USERS,
      'GET /api/assessment': () =>
        json(
          200,
          view(
            { type: 'self', conditionalStatusDate: '2026-01-01' },
            {
              conditionalStatusDate: '2026-01-01',
              deadline: '2026-04-01',
              daysRemaining: -3,
              expired: true,
            },
          ),
        ),
    });
    await renderSettings();
    expect(await screen.findByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('Deadline 2026-04-01')).toBeInTheDocument();
    expect(screen.queryByText(/days remaining/)).not.toBeInTheDocument();
  });

  it('says what went wrong when the save fails', async () => {
    const user = userEvent.setup();
    fakeApi({
      'GET /api/session': sessionFor(ADMIN),
      'GET /api/audit': NO_AUDIT,
      'GET /api/users': NO_USERS,
      'GET /api/assessment': () =>
        json(200, view({ type: 'self', conditionalStatusDate: null }, null)),
      'PATCH /api/assessment': () =>
        json(403, { error: { code: 'forbidden', message: 'no', requestId: 'r' } }),
    });
    await renderSettings();
    await user.click(await screen.findByRole('radio', { name: 'C3PAO certification assessment' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Only admins can change these settings.')).toBeInTheDocument();
  });
});
