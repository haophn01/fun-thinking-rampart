import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '@rampart/api/contract';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';
import { ACTION_LABELS, ENTITY_LABELS } from './auditLabels';

interface Call {
  method: string;
  path: string;
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
      const call: Call = { method: init.method ?? 'GET', path: input };
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
  return {
    audit: () =>
      calls
        .filter((c) => c.path.startsWith('/api/audit'))
        .map((c) => new URLSearchParams(c.path.split('?')[1] ?? '')),
  };
}

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const CONTRIBUTOR = {
  id: 'u-2',
  email: 'kim@example.com',
  displayName: 'Kim',
  role: 'contributor',
};
const sessionFor = (user: typeof ADMIN | typeof CONTRIBUTOR) => () =>
  json(200, { setupRequired: false, user, csrfToken: 'csrf-1' });

const VIEW = {
  assessment: {
    id: 'a-1',
    type: 'self',
    conditionalStatusDate: null,
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
  closeout: null,
};

function event(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    at: `2026-11-24T10:0${String(id)}:00.000Z`,
    actor: { id: 'u-1', displayName: 'Ada Admin' },
    action: 'objective_result.updated',
    entityType: 'objective_result',
    entityId: `3.1.${String(id)}[a]`,
    before: { status: 'not_assessed' },
    after: { status: 'met' },
    requestId: null,
    ...over,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE: Record<string, Handler> = {
  'GET /api/session': sessionFor(ADMIN),
  'GET /api/assessment': () => json(200, VIEW),
  'GET /api/users': () => json(200, { users: [] }),
};

const EVENT_ROW = { name: /audit event/i };

describe('AuditLog', () => {
  it('audit log', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      ...BASE,
      'GET /api/audit': (call) => {
        const q = new URLSearchParams(call.path.split('?')[1] ?? '');
        if (q.get('entityType') === 'user') {
          return json(200, {
            events: [
              event(9, {
                action: 'user.created',
                entityType: 'user',
                entityId: 'u-9',
                before: null,
                after: { role: 'contributor' },
              }),
            ],
            nextBefore: null,
          });
        }
        if (q.get('before') === '2') {
          return json(200, { events: [event(1)], nextBefore: null });
        }
        return json(200, {
          events: [
            event(3),
            event(2, {
              actor: null,
              action: 'auth.locked_out',
              entityType: 'user',
              entityId: 'u-2',
            }),
          ],
          nextBefore: 2,
        });
      },
    });
    await renderSettings();

    // Newest first, with labels, the actor, the entity and before → after.
    const rows = await screen.findAllByRole('listitem', EVENT_ROW);
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(within(first).getByText('Objective result updated')).toBeInTheDocument();
    expect(within(first).getByText(/Ada Admin/)).toBeInTheDocument();
    expect(within(first).getByText(/3\.1\.3\[a\]/)).toBeInTheDocument();
    expect(
      within(first).getByText('{"status":"not_assessed"} → {"status":"met"}'),
    ).toBeInTheDocument();
    expect(within(second).getByText('Account locked after failed sign-ins')).toBeInTheDocument();
    expect(within(second).getByText(/System/)).toBeInTheDocument();
    expect(within(first).getByTitle('2026-11-24T10:03:00.000Z')).toBeInTheDocument();
    expect(api.audit()[0]?.get('before')).toBeNull();

    // Load more pages with before=nextBefore, appends, and hides at the end.
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText(/3\.1\.1\[a\]/);
    expect(screen.getAllByRole('listitem', EVENT_ROW)).toHaveLength(3);
    expect(api.audit()[1]?.get('before')).toBe('2');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    // The filter re-queries from the start, with no cursor.
    await user.selectOptions(screen.getByLabelText('Entity type'), 'user');
    await screen.findByText('User created');
    const last = api.audit().at(-1);
    expect(last?.get('entityType')).toBe('user');
    expect(last?.get('before')).toBeNull();
    expect(screen.getAllByRole('listitem', EVENT_ROW)).toHaveLength(1);
  });

  it('shows an empty state', async () => {
    fakeApi({ ...BASE, 'GET /api/audit': () => json(200, { events: [], nextBefore: null }) });
    await renderSettings();
    expect(await screen.findByText('No audit events yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows an error and retries', async () => {
    const user = userEvent.setup();
    let fail = true;
    fakeApi({
      ...BASE,
      'GET /api/audit': () =>
        fail
          ? json(500, { error: { code: 'internal', message: 'boom', requestId: 'r' } })
          : json(200, { events: [event(1)], nextBefore: null }),
    });
    await renderSettings();
    expect(await screen.findByText(/Couldn.t load the audit log/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findAllByRole('listitem', EVENT_ROW)).toHaveLength(1);
    expect(screen.queryByText(/Couldn.t load the audit log/)).not.toBeInTheDocument();
  });

  it('labels cover the contract', async () => {
    const labelled = (label: string | undefined) =>
      typeof label === 'string' && label.trim() !== '';
    const actions: Record<string, string | undefined> = ACTION_LABELS;
    const entities: Record<string, string | undefined> = ENTITY_LABELS;
    for (const action of AUDIT_ACTIONS) expect(labelled(actions[action]), action).toBe(true);
    for (const type of AUDIT_ENTITY_TYPES) expect(labelled(entities[type]), type).toBe(true);
    expect(Object.keys(ACTION_LABELS).sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(Object.keys(ENTITY_LABELS).sort()).toEqual([...AUDIT_ENTITY_TYPES].sort());
    // The ssp-data actions and entities are among them, each with its own label.
    const added = {
      'ssp_profile.updated': 'SSP details changed',
      'system_role.created': 'System role created',
      'system_role.updated': 'System role changed',
      'system_role.removed': 'System role removed',
      'asset.created': 'Asset created',
      'asset.updated': 'Asset changed',
      'asset.removed': 'Asset removed',
      'service_provider.created': 'Service provider created',
      'service_provider.updated': 'Service provider changed',
      'service_provider.removed': 'Service provider removed',
      'responsibility.updated': 'Responsibility changed',
      'diagram_link.created': 'Diagram link created',
      'diagram_link.updated': 'Diagram link changed',
      'diagram_link.removed': 'Diagram link removed',
      'ssp_revision.created': 'SSP revision recorded',
      'ssp_approval.created': 'SSP approval created',
      'ssp_approval.updated': 'SSP approval changed',
      'ssp_approval.removed': 'SSP approval removed',
    };
    const addedEntities = {
      ssp_profile: 'SSP details',
      system_role: 'System role',
      asset: 'Asset',
      service_provider: 'Service provider',
      responsibility: 'Responsibility',
      diagram_link: 'Diagram link',
      ssp_revision: 'SSP revision',
      ssp_approval: 'SSP approval',
    };
    const ordered = (list: readonly string[], keys: string[]) => {
      const start = list.indexOf(keys[0] ?? '');
      return list.slice(start, start + keys.length);
    };
    // sec-auth appends its actions and entity after them, each with its own label.
    const secAuth = {
      'auth.password_changed': 'Password changed',
      'auth.session_locked': 'Session locked',
      'auth.session_unlocked': 'Session unlocked',
      'auth.notice_acknowledged': 'Sign-in notice acknowledged',
      'settings.updated': 'Settings changed',
    };
    const secAuthEntities = { settings: 'Settings' };
    // sec-mfa appends three actions after those, each with its own label, and no entity.
    const secMfa = {
      'auth.mfa_enrolled': 'Two-step sign-in set up',
      'auth.mfa_verified': 'Two-step sign-in verified',
      'user.mfa_reset': 'Two-step sign-in reset',
    };
    expect(AUDIT_ACTIONS.slice(-Object.keys(secMfa).length)).toEqual(Object.keys(secMfa));
    expect(ordered(AUDIT_ACTIONS, Object.keys(secAuth))).toEqual(Object.keys(secAuth));
    expect(AUDIT_ACTIONS.indexOf('settings.updated') + 1).toBe(
      AUDIT_ACTIONS.indexOf('auth.mfa_enrolled'),
    );
    expect(AUDIT_ENTITY_TYPES.slice(-Object.keys(secAuthEntities).length)).toEqual(
      Object.keys(secAuthEntities),
    );
    expect(ordered(AUDIT_ACTIONS, Object.keys(added))).toEqual(Object.keys(added));
    expect(ordered(AUDIT_ENTITY_TYPES, Object.keys(addedEntities))).toEqual(
      Object.keys(addedEntities),
    );
    for (const [action, label] of Object.entries({ ...added, ...secAuth, ...secMfa }))
      expect(actions[action], action).toBe(label);
    for (const [type, label] of Object.entries({ ...addedEntities, ...secAuthEntities })) {
      expect(entities[type], type).toBe(label);
    }
    expect(actions['system_profile.updated']).toBe('System profile changed');
    expect(entities.system_profile).toBe('System profile');
    // Labels are told apart in the log and the filter.
    expect(new Set(Object.values(ACTION_LABELS)).size).toBe(AUDIT_ACTIONS.length);
    expect(new Set(Object.values(ENTITY_LABELS)).size).toBe(AUDIT_ENTITY_TYPES.length);

    // The entity filter offers every type by its label.
    fakeApi({ ...BASE, 'GET /api/audit': () => json(200, { events: [], nextBefore: null }) });
    await renderSettings();
    await screen.findByText('No audit events yet.');
    const options = within(screen.getByLabelText('Entity type')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'All',
      ...AUDIT_ENTITY_TYPES.map((type) => entities[type]),
    ]);
    for (const label of Object.values({ ...addedEntities, ...secAuthEntities })) {
      expect(options.map((option) => option.textContent)).toContain(label);
    }
  });

  it('section order', async () => {
    fakeApi({ ...BASE, 'GET /api/audit': () => json(200, { events: [], nextBefore: null }) });
    await renderSettings();
    await screen.findByText('No audit events yet.');
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(4);
    expect(headings[0]).toHaveTextContent(/Assessment/);
    expect(headings[1]).toHaveTextContent(/Users/);
    expect(headings[2]).toHaveTextContent(/Sign-in notice/);
    expect(headings[3]).toHaveTextContent(/Audit log/);
    expect(headings.map((h) => h.querySelector('[data-balloon]')?.textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('gives a contributor Assessment then Audit log', async () => {
    fakeApi({
      ...BASE,
      'GET /api/session': sessionFor(CONTRIBUTOR),
      'GET /api/audit': () => json(200, { events: [], nextBefore: null }),
    });
    await renderSettings();
    await screen.findByText('No audit events yet.');
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(2);
    expect(headings[0]).toHaveTextContent(/Assessment/);
    expect(headings[1]).toHaveTextContent(/Audit log/);
  });
});
