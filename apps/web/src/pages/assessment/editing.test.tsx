import { loadCatalog, type Requirement } from '@rampart/catalog';
import { evaluateAssessment, type ImplementationLevel, type ObjectiveStatus } from '@rampart/rules';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

// The first render of the whole app is slow on a loaded machine.
configure({ asyncUtilTimeout: 5000 });

const catalog = loadCatalog();
const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const AT = '2026-11-23T10:00:00.000Z';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}
function user(id: string, displayName: string, active = true) {
  return {
    id,
    email: `${id}@example.com`,
    displayName,
    role: 'contributor',
    active,
    createdAt: AT,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}
interface Row {
  status: ObjectiveStatus;
  note: string | null;
}
interface State {
  results: Map<string, Row>;
  states: Map<string, Record<string, unknown>>;
  users: ReturnType<typeof user>[];
}

const target = catalog.requirements.find((r) => r.id === 'AC.L2-3.1.1') as Requirement;
const mfa = catalog.requirements.find((r) => r.id === 'IA.L2-3.5.3') as Requirement;
const first = target.objectives[0];
if (!first) throw new Error('catalog');

/** A fake api over `state`: everything met, so the score is a real number. `put` can be held. */
function fakeApi(state: State, hooks: { put?: (call: Call) => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const evaluation = () =>
    evaluateAssessment(catalog, {
      objectiveResults: [...state.results].map(([objectiveId, row]) => ({
        objectiveId,
        status: row.status,
      })),
      implementationLevels: Object.fromEntries(
        [...state.states]
          .filter(([, s]) => s.implementationLevel)
          .map(([id, s]) => [id, s.implementationLevel as ImplementationLevel]),
      ),
    });
  const view = () => ({
    assessment: {
      id: 'a-1',
      type: 'self',
      conditionalStatusDate: null,
      catalogVersion: 'v',
      updatedAt: AT,
    },
    objectiveResults: [...state.results].map(([objectiveId, row]) => ({
      objectiveId,
      ...row,
      updatedAt: AT,
      updatedBy: { id: 'u-1', displayName: 'Ada Admin' },
    })),
    requirementStates: [...state.states.values()],
    evaluation: evaluation(),
    closeout: null,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      const call = { method, path: input, body };
      if (input === '/api/session')
        return Promise.resolve(json(200, { setupRequired: false, user: ADMIN, csrfToken: 'tok' }));
      if (input === '/api/health') return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      if (input === '/api/users') return Promise.resolve(json(200, { users: state.users }));
      if (input === '/api/assessment') return Promise.resolve(json(200, view()));
      calls.push(call);
      const objective = /^\/api\/assessment\/objectives\/(.+)$/.exec(input);
      if (method === 'PUT' && objective) {
        const apply = () => {
          const id = decodeURIComponent(objective[1] ?? '');
          const row = body as unknown as Row;
          state.results.set(id, { status: row.status, note: row.note });
          return json(200, {
            objectiveResult: {
              objectiveId: id,
              ...row,
              updatedAt: AT,
              updatedBy: { id: 'u-1', displayName: 'Ada Admin' },
            },
            evaluation: evaluation(),
          });
        };
        return hooks.put
          ? Promise.resolve(hooks.put(call)).then((r) => (r.ok ? apply() : r))
          : Promise.resolve(apply());
      }
      const requirement = /^\/api\/assessment\/requirements\/(.+)$/.exec(input);
      if (method === 'PATCH' && requirement) {
        const id = decodeURIComponent(requirement[1] ?? '');
        const next: Record<string, unknown> = {
          requirementId: id,
          implementationLevel: null,
          implementationStatement: null,
          owner: null,
          updatedAt: AT,
          ...state.states.get(id),
          ...body,
        };
        if (body && 'ownerId' in body) {
          const owner = state.users.find((u) => u.id === body.ownerId);
          next.owner = owner
            ? { id: owner.id, displayName: owner.displayName, active: owner.active }
            : null;
          delete next.ownerId;
        }
        state.states.set(id, next);
        return Promise.resolve(json(200, { requirementState: next, evaluation: evaluation() }));
      }
      return Promise.resolve(json(404, { error: { code: 'not_found', message: 'x' } }));
    }),
  );
  return { calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

function allMet(): State {
  const results = new Map<string, Row>();
  for (const r of catalog.requirements)
    for (const o of r.objectives) results.set(o.id, { status: 'met', note: null });
  return {
    results,
    states: new Map(),
    users: [user('u-1', 'Ada Admin'), user('u-2', 'Bo Builder'), user('u-3', 'Cy Gone', false)],
  };
}

async function open(requirement: Requirement) {
  render(
    <MemoryRouter
      initialEntries={[`/assessment?family=${requirement.family}&req=${requirement.id}`]}
    >
      <AuthedApp />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 2, name: requirement.id });
  return screen.getByRole('region', { name: 'Requirement detail' });
}
const status = (id: string) => screen.getByRole('radiogroup', { name: `Status for ${id}` });
const score = () => screen.getByTestId('score-value');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('live save', () => {
  it('updates the score before the PUT resolves, sends the encoded ID with the note, and adopts the server evaluation', async () => {
    const state = allMet();
    state.results.set(first.id, { status: 'met', note: 'keep me' });
    let release: () => void = () => undefined;
    const api = fakeApi(state, {
      put: () =>
        new Promise<Response>(
          (resolve) =>
            (release = () => {
              resolve(json(200));
            }),
        ),
    });
    await open(target);
    await waitFor(() => {
      expect(score()).toHaveTextContent('110');
    });
    const group = status(first.id);
    await userEvent.click(within(group).getByRole('radio', { name: 'Not Met' }));

    // The score is already local-new while the request is held; the control is disabled.
    const expected = evaluateAssessment(catalog, {
      objectiveResults: [...state.results].map(([objectiveId, row]) => ({
        objectiveId,
        status: objectiveId === first.id ? 'not_met' : row.status,
      })),
      implementationLevels: {},
    });
    const expectedScore = expected.score.kind === 'scored' ? String(expected.score.score) : '—';
    expect(expectedScore).not.toBe('110');
    expect(score()).toHaveTextContent(expectedScore);
    expect(status(first.id)).toBeDisabled();
    expect(api.writes()).toHaveLength(1);
    expect(api.writes()[0]).toMatchObject({
      method: 'PUT',
      path: `/api/assessment/objectives/${encodeURIComponent(first.id)}`,
      body: { status: 'not_met', note: 'keep me' },
    });
    expect(api.writes()[0]?.path).toContain('%5Ba%5D');

    release();
    await waitFor(() => {
      expect(status(first.id)).not.toBeDisabled();
    });
    expect(score()).toHaveTextContent(expectedScore);
    expect(within(status(first.id)).getByRole('radio', { name: 'Not Met' })).toBeChecked();
  });

  it('reverts on failure and shows the request ID', async () => {
    const state = allMet();
    fakeApi(state, {
      put: () =>
        json(500, {
          error: { code: 'internal_error', message: 'Could not save', requestId: 'req-42' },
        }),
    });
    await open(target);
    await waitFor(() => {
      expect(score()).toHaveTextContent('110');
    });
    await userEvent.click(within(status(first.id)).getByRole('radio', { name: 'Not Met' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('req-42');
    expect(score()).toHaveTextContent('110');
    expect(within(status(first.id)).getByRole('radio', { name: 'Met' })).toBeChecked();
    expect(status(first.id)).not.toBeDisabled();
  });
});

describe('content edits', () => {
  it('saves a note with the current status', async () => {
    const state = allMet();
    const api = fakeApi(state);
    await open(target);
    const row = screen.getByRole('listitem', { name: first.id });
    await userEvent.type(
      within(row).getByRole('textbox', { name: `Note for ${first.id}` }),
      'Seen on site',
    );
    await userEvent.click(within(row).getByRole('button', { name: 'Save note' }));
    await waitFor(() => {
      expect(api.writes()).toHaveLength(1);
    });
    expect(api.writes()[0]).toMatchObject({
      method: 'PUT',
      body: { status: 'met', note: 'Seen on site' },
    });
  });

  it('saves the statement, and the level, with PATCH', async () => {
    const state = allMet();
    const api = fakeApi(state);
    await open(target);
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Implementation statement' }),
      'We lock doors',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save statement' }));
    await waitFor(() => {
      expect(api.writes()).toHaveLength(1);
    });
    expect(api.writes()[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/assessment/requirements/AC.L2-3.1.1',
      body: { implementationStatement: 'We lock doors' },
    });
  });

  it('sends the level for 3.5.3, and null for Not set', async () => {
    const state = allMet();
    const api = fakeApi(state);
    await open(mfa);
    const level = screen.getByRole('combobox', { name: 'Implementation level' });
    await userEvent.selectOptions(level, 'partial');
    await waitFor(() => {
      expect(api.writes()).toHaveLength(1);
    });
    expect(api.writes()[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/assessment/requirements/IA.L2-3.5.3',
      body: { implementationLevel: 'partial' },
    });
    await userEvent.selectOptions(level, '');
    await waitFor(() => {
      expect(api.writes()).toHaveLength(2);
    });
    expect(api.writes()[1]?.body).toEqual({ implementationLevel: null });
  });

  it('lists Unassigned plus active users, and sends the owner', async () => {
    const state = allMet();
    const api = fakeApi(state);
    await open(target);
    const owner = screen.getByRole('combobox', { name: 'Owner' });
    await waitFor(() => {
      expect(within(owner).getAllByRole('option')).toHaveLength(3);
    });
    expect(
      within(owner)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Unassigned', 'Ada Admin', 'Bo Builder']);
    await userEvent.selectOptions(owner, 'u-2');
    await waitFor(() => {
      expect(api.writes()).toHaveLength(1);
    });
    expect(api.writes()[0]).toMatchObject({ method: 'PATCH', body: { ownerId: 'u-2' } });
    await userEvent.selectOptions(owner, '');
    await waitFor(() => {
      expect(api.writes()).toHaveLength(2);
    });
    expect(api.writes()[1]?.body).toEqual({ ownerId: null });
  });

  it('shows an inactive current owner with "(inactive)"', async () => {
    const state = allMet();
    state.states.set(target.id, {
      requirementId: target.id,
      implementationLevel: null,
      implementationStatement: null,
      owner: { id: 'u-3', displayName: 'Cy Gone', active: false },
      updatedAt: AT,
    });
    fakeApi(state);
    await open(target);
    const owner = screen.getByRole('combobox', { name: 'Owner' });
    await waitFor(() => {
      expect(
        within(owner)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Unassigned', 'Cy Gone (inactive)', 'Ada Admin', 'Bo Builder']);
    });
    expect(owner).toHaveValue('u-3');
  });
});
