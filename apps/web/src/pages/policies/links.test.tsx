import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

// A page test waits for real requests; keep the timeout above the 5 s waits.
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
function apiError(status: number, code: string, message = code) {
  return json(status, { error: { code, message, requestId: 'r' } });
}

const CREATED = '2026-11-24T10:00:00.000Z';
const ME = { id: 'u-1', displayName: 'Ada Admin' };
const POLICY = {
  id: 'p-1',
  title: 'Access control policy',
  description: null,
  requirementIds: ['SC.L2-3.13.1'],
  versions: [],
  createdAt: CREATED,
  createdBy: ME,
  updatedAt: CREATED,
};

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

function fakeApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const all: Record<string, Handler> = {
    'GET /api/session': () =>
      json(200, {
        setupRequired: false,
        user: { ...ME, email: 'ada@example.com', role: 'contributor' },
        csrfToken: 'csrf-1',
      }),
    'GET /api/assessment': () => json(200, ASSESSMENT_VIEW),
    'GET /api/policies': () => json(200, { items: [POLICY] }),
    ...routes,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? 'GET',
        path: input,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
        headers: new Headers(init.headers),
      };
      calls.push(call);
      const handler =
        all[`${call.method} ${call.path}`] ??
        (call.path === '/api/health'
          ? () => json(200, { status: 'ok', db: 'ok' })
          : () => apiError(404, 'not_found'));
      return Promise.resolve(handler(call));
    }),
  );
  return { sent: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key) };
}

async function renderEditor() {
  render(
    <MemoryRouter initialEntries={['/policies']}>
      <AuthedApp />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('listitem', { name: 'Access control policy' });
  return { row, editor: within(row).getByRole('form', { name: 'Requirement links' }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Policies requirement links', () => {
  it('requirement links', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'PUT /api/policies/p-1/requirements': (call) =>
        json(200, {
          item: {
            ...POLICY,
            requirementIds: (call.body as { requirementIds: string[] }).requirementIds,
            updatedAt: '2026-11-24T11:00:00.000Z',
          },
        }),
    });
    const { row, editor } = await renderEditor();
    expect(within(editor).getByRole('button', { name: 'Save links' })).toBeDisabled();

    // Another family's existing link is counted, and kept when this family's boxes are saved.
    expect(within(row).getByText('1 requirement linked')).toBeInTheDocument();
    await user.selectOptions(within(editor).getByLabelText('Family'), 'AC');
    expect(within(editor).getByLabelText('AC.L2-3.1.1')).not.toBeChecked();
    await user.click(within(editor).getByLabelText('AC.L2-3.1.1'));
    await user.click(within(editor).getByLabelText('AC.L2-3.1.2'));
    await user.click(within(editor).getByRole('button', { name: 'Save links' }));

    expect(await within(row).findByText('3 requirements linked')).toBeInTheDocument();
    const puts = api.sent('PUT /api/policies/p-1/requirements');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toEqual({
      requirementIds: ['AC.L2-3.1.1', 'AC.L2-3.1.2', 'SC.L2-3.13.1'],
    });
    expect(puts[0]?.headers.get('x-csrf-token')).toBe('csrf-1');
    expect(within(editor).getByRole('button', { name: 'Save links' })).toBeDisabled();

    // Unticking in another family sends the set without it, keeping the first family's links.
    await user.selectOptions(within(editor).getByLabelText('Family'), 'SC');
    expect(within(editor).getByLabelText('SC.L2-3.13.1')).toBeChecked();
    await user.click(within(editor).getByLabelText('SC.L2-3.13.1'));
    await user.click(within(editor).getByRole('button', { name: 'Save links' }));
    await vi.waitFor(() => {
      expect(api.sent('PUT /api/policies/p-1/requirements')).toHaveLength(2);
    });
    expect(api.sent('PUT /api/policies/p-1/requirements')[1]?.body).toEqual({
      requirementIds: ['AC.L2-3.1.1', 'AC.L2-3.1.2'],
    });
  });

  it('shows a failed save and keeps the ticks', async () => {
    const user = userEvent.setup();
    fakeApi({
      'PUT /api/policies/p-1/requirements': () =>
        apiError(400, 'validation_failed', 'bad requirement'),
    });
    const { editor } = await renderEditor();
    await user.selectOptions(within(editor).getByLabelText('Family'), 'AC');
    await user.click(within(editor).getByLabelText('AC.L2-3.1.1'));
    await user.click(within(editor).getByRole('button', { name: 'Save links' }));
    expect(await within(editor).findByRole('alert')).toHaveTextContent(
      'The change was not accepted.',
    );
    expect(within(editor).getByLabelText('AC.L2-3.1.1')).toBeChecked();
  });
});
