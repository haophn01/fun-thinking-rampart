import type { SspProfile, SystemProfile } from '@rampart/api/contract';
import { loadCatalog } from '@rampart/catalog';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

// A page test waits for real requests; keep the timeout above the 5 s waits.
configure({ asyncUtilTimeout: 5000 });
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

const SAVED_AT = '2026-11-24T10:00:00.000Z';
const ME = { id: 'u-1', displayName: 'Ada Admin' };
const TOTAL = loadCatalog().requirements.length;

const EMPTY_PROFILE: SystemProfile = {
  systemName: null,
  systemIdentifier: null,
  organizationName: null,
  cageCode: null,
  description: null,
  authorizationBoundary: null,
  environment: null,
  interconnections: null,
  informationTypes: null,
  systemOwner: null,
  systemOwnerEmail: null,
  securityContact: null,
  securityContactEmail: null,
  updatedAt: null,
  updatedBy: null,
};
type Profile = SystemProfile;
const SAVED_PROFILE: Profile = {
  ...EMPTY_PROFILE,
  systemName: 'Acme Enclave',
  cageCode: '1ABC2',
  updatedAt: SAVED_AT,
  updatedBy: ME,
};

const SSP_PROFILE: SspProfile = {
  categorization: 'Moderate',
  securityOfficer: null,
  securityOfficerEmail: null,
  organizationAddress: null,
  organizationPhone: null,
  cuiCategories: null,
  cuiLocations: null,
  cuiEntryExit: null,
  topologyNarrative: null,
  dataFlowNarrative: null,
  inventoryReference: null,
  maintenanceStatement: null,
  reviewCadenceMonths: 12,
  nextReviewDate: null,
  updatedAt: null,
  updatedBy: null,
};

function assessmentView(status: 'met' | 'not_met' | 'not_assessed', statements: number) {
  return {
    assessment: {
      id: 'a-1',
      type: 'self',
      conditionalStatusDate: null,
      catalogVersion: 'v1',
      updatedAt: SAVED_AT,
    },
    objectiveResults: [],
    requirementStates: Array.from({ length: statements + 2 }, (_, i) => ({
      requirementId: `REQ-${String(i)}`,
      implementationLevel: null,
      // Two rows hold no statement (null, and blank), which don't count.
      implementationStatement: i === 0 ? null : i === 1 ? '   ' : `Statement ${String(i)}`,
      owner: null,
      updatedAt: SAVED_AT,
    })),
    evaluation: {
      outcomes: [
        {
          requirementId: 'CA.L2-3.12.4',
          status,
          allNa: false,
          counts: { met: 0, not_met: 0, na: 0, not_assessed: 0 },
          implementationLevel: null,
          deduction: 0,
        },
      ],
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
}

/** The api over an in-memory profile, faked at the network boundary like the real one. */
function sspApi(
  initial: Profile,
  extra: Record<string, Handler> = {},
  role: 'admin' | 'contributor' = 'admin',
) {
  let profile = initial;
  const calls: Call[] = [];
  const routes: Record<string, Handler> = {
    'GET /api/session': () =>
      json(200, {
        setupRequired: false,
        user: { ...ME, email: 'ada@example.com', role },
        csrfToken: 'csrf-1',
      }),
    'GET /api/assessment': () => json(200, assessmentView('met', 3)),
    // The Identification & roles tab also loads the SSP identification fields and the roles.
    'GET /api/ssp/profile': () => json(200, { profile: SSP_PROFILE }),
    'GET /api/ssp/roles': () => json(200, { roles: [], totals: { users: 0, privilegedUsers: 0 } }),
    'GET /api/system-profile': () => json(200, { profile }),
    'PATCH /api/system-profile': (call) => {
      const patch = call.body as Record<string, string | null>;
      profile = { ...profile, ...patch, updatedAt: SAVED_AT, updatedBy: ME };
      return json(200, { profile });
    },
    ...extra,
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
        routes[`${call.method} ${call.path}`] ??
        (call.path === '/api/health'
          ? () => json(200, { status: 'ok', db: 'ok' })
          : () => apiError(404, 'not_found'));
      return Promise.resolve(handler(call));
    }),
  );
  return { sent: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key) };
}

function renderSsp(tab?: string) {
  render(
    <MemoryRouter initialEntries={[tab === undefined ? '/ssp' : `/ssp?tab=${tab}`]}>
      <AuthedApp />
    </MemoryRouter>,
  );
}

/** The page once the profile form has loaded. */
async function renderLoaded() {
  renderSsp();
  return screen.findByRole('form', { name: 'System profile' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SSP page', () => {
  it('saves only changed fields', async () => {
    const user = userEvent.setup();
    const api = sspApi(SAVED_PROFILE);
    const form = await renderLoaded();

    // One control per profile field, in order, with the saved values filled in.
    const labels = within(form)
      .getAllByRole('textbox')
      .map((el) => el.getAttribute('id'))
      .map((id) => form.querySelector(`label[for="${String(id)}"]`)?.textContent);
    expect(labels).toEqual([
      'System name',
      'System identifier',
      'Organization',
      'CAGE code',
      'System description',
      'Authorization boundary',
      'Operating environment',
      'Interconnections with other systems',
      'Information types handled',
      'System owner',
      'System owner email',
      'Security contact',
      'Security contact email',
    ]);
    expect(within(form).getByLabelText('System name')).toHaveValue('Acme Enclave');
    expect(within(form).getByLabelText('System description').tagName).toBe('TEXTAREA');
    expect(within(form).getByLabelText('System owner').tagName).toBe('INPUT');
    expect(screen.getByText(/Last saved .* by Ada Admin/)).toBeInTheDocument();

    // Unchanged: the Save button is disabled, and nothing is sent.
    const save = within(form).getByRole('button', { name: 'Save profile' });
    expect(save).toBeDisabled();

    await user.type(within(form).getByLabelText('System identifier'), 'ENC-1');
    expect(save).toBeEnabled();
    await user.click(save);

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    const patches = api.sent('PATCH /api/system-profile');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ systemIdentifier: 'ENC-1' });
    expect(patches[0]?.headers.get('x-csrf-token')).toBe('csrf-1');
    // Saved, so there is nothing left to save; typing again drops the "Saved" mark.
    expect(save).toBeDisabled();
    await user.type(within(form).getByLabelText('System name'), '!');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(save).toBeEnabled();
    // Putting the original text back leaves nothing to save.
    await user.type(within(form).getByLabelText('System name'), '{Backspace}');
    expect(save).toBeDisabled();
  });

  it('lets a contributor edit', async () => {
    const user = userEvent.setup();
    const api = sspApi(EMPTY_PROFILE, {}, 'contributor');
    const form = await renderLoaded();
    await user.type(within(form).getByLabelText('Organization'), 'Acme');
    await user.click(within(form).getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Saved');
    expect(api.sent('PATCH /api/system-profile')[0]?.body).toEqual({ organizationName: 'Acme' });
  });

  it('validation', async () => {
    const user = userEvent.setup();
    const api = sspApi(EMPTY_PROFILE, {
      'PATCH /api/system-profile': () => apiError(400, 'validation_failed', 'Name is not allowed'),
    });
    const form = await renderLoaded();

    // A bad CAGE code and a bad email: each shows its error, and nothing is sent.
    await user.type(within(form).getByLabelText('CAGE code'), 'ab');
    await user.type(within(form).getByLabelText('System owner email'), 'not-an-email');
    await user.click(within(form).getByRole('button', { name: 'Save profile' }));
    expect(
      within(form).getByText('A CAGE code is exactly 5 letters or digits'),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText('CAGE code')).toBeInvalid();
    expect(within(form).getByLabelText('System owner email')).toBeInvalid();
    expect(api.sent('PATCH /api/system-profile')).toHaveLength(0);

    // Fixing a field clears its error; a valid lower-case code is sent upper-cased.
    await user.type(within(form).getByLabelText('CAGE code'), 'cde');
    expect(within(form).getByLabelText('CAGE code')).toBeValid();
    await user.clear(within(form).getByLabelText('System owner email'));
    await user.type(within(form).getByLabelText('System name'), 'X');
    await user.click(within(form).getByRole('button', { name: 'Save profile' }));

    // A server 400 shows its message and keeps what was typed.
    expect(await screen.findByText('Name is not allowed')).toBeInTheDocument();
    expect(api.sent('PATCH /api/system-profile')[0]?.body).toEqual({
      cageCode: 'ABCDE',
      systemName: 'X',
    });
    expect(within(form).getByLabelText('System name')).toHaveValue('X');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('clearing sends null', async () => {
    const user = userEvent.setup();
    const api = sspApi(SAVED_PROFILE);
    const form = await renderLoaded();
    await user.clear(within(form).getByLabelText('System name'));
    await user.click(within(form).getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Saved');
    expect(api.sent('PATCH /api/system-profile')[0]?.body).toEqual({ systemName: null });
    expect(within(form).getByLabelText('System name')).toHaveValue('');
  });

  it('loading and error', async () => {
    const user = userEvent.setup();
    let release: (response: Response) => void = () => undefined;
    let fail = true;
    const api = sspApi(SAVED_PROFILE, {
      'GET /api/system-profile': () => {
        if (fail) return new Promise<Response>((resolve) => (release = resolve));
        return json(200, { profile: SAVED_PROFILE });
      },
    });
    renderSsp();
    // The h1 shows at once, before the profile has answered.
    expect(await screen.findByRole('heading', { level: 1, name: 'SSP' })).toBeInTheDocument();
    expect(screen.getByText('Loading the system profile…')).toBeInTheDocument();

    // A failed profile load offers Retry, and Retry loads it.
    await waitFor(() => {
      expect(api.sent('GET /api/system-profile')).toHaveLength(1);
    });
    release(apiError(500, 'internal'));
    const title = await screen.findByText("Can't load the system profile");
    fail = false;
    const alert = title.closest('[role="alert"]') as HTMLElement;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('form', { name: 'System profile' })).toBeInTheDocument();
    expect(api.sent('GET /api/system-profile')).toHaveLength(2);
    // The default tab never asks for the readiness.
    expect(api.sent('GET /api/assessment')).toHaveLength(0);
  });
});

describe('SSP export tab', () => {
  it('export tab', async () => {
    sspApi(SAVED_PROFILE, {
      'GET /api/assessment': () => json(200, assessmentView('not_met', 3)),
    });
    renderSsp('export');
    const panel = await screen.findByRole('tabpanel', { name: 'Lint & export' });

    // Section 1: the readiness, as before.
    const section = within(panel).getByRole('region', { name: /Readiness/ });
    expect(within(section).getByText('1')).toBeInTheDocument();
    expect(await within(section).findByText('Not Met')).toBeInTheDocument();
    expect(within(section).getByText(/CA\.L2-3\.12\.4/)).toBeInTheDocument();
    expect(
      within(section).getByText(
        `3 of ${String(TOTAL)} requirements have an implementation statement`,
      ),
    ).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: /Assessment/ })).toHaveAttribute(
      'href',
      '/assessment',
    );

    // Section 2: the placeholder and the download link.
    const exportSection = within(panel).getByRole('region', { name: /Export/ });
    expect(within(exportSection).getByText('2')).toBeInTheDocument();
    expect(within(exportSection).getByRole('status')).toHaveTextContent(
      'The pre-export check comes in a later release.',
    );
    const link = within(exportSection).getByRole('link', { name: 'Export SSP (.docx)' });
    expect(link).toHaveAttribute('href', '/api/ssp/export');
    // A plain download, not a route change.
    expect(link).toHaveAttribute('download');
    // The profile form isn't loaded on this tab.
    expect(screen.queryByRole('form', { name: 'System profile' })).not.toBeInTheDocument();
  });

  it('readiness fails on its own with Retry', async () => {
    const user = userEvent.setup();
    let release: (response: Response) => void = () => undefined;
    let answer = (): Response | Promise<Response> =>
      new Promise<Response>((resolve) => (release = resolve));
    const api = sspApi(SAVED_PROFILE, { 'GET /api/assessment': () => answer() });
    renderSsp('export');
    const panel = await screen.findByRole('tabpanel', { name: 'Lint & export' });
    await waitFor(() => {
      expect(api.sent('GET /api/assessment')).toHaveLength(1);
    });
    expect(within(panel).getByText(/^Loading/)).toBeInTheDocument();
    release(apiError(500, 'internal'));

    const readiness = within(panel).getByRole('region', { name: /Readiness/ });
    expect(await within(readiness).findByText("Can't load the readiness")).toBeInTheDocument();
    // The export link doesn't wait on the load.
    expect(within(panel).getByRole('link', { name: 'Export SSP (.docx)' })).toBeInTheDocument();

    answer = () => json(200, assessmentView('met', 3));
    await user.click(within(readiness).getByRole('button', { name: 'Retry' }));
    expect(await within(readiness).findByText('Met')).toBeInTheDocument();
    expect(api.sent('GET /api/assessment')).toHaveLength(2);
  });
});
