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
const SHA_1 = 'a'.repeat(63) + '1';
const SHA_2 = 'b'.repeat(63) + '2';
const SHA_3 = 'c'.repeat(64);
const ME = { id: 'u-1', displayName: 'Ada Admin' };

interface Version {
  version: number;
  fileName: string;
  size: number;
  sha256: string;
  createdAt: string;
  createdBy: typeof ME;
}
interface Policy {
  id: string;
  title: string;
  description: string | null;
  requirementIds: string[];
  versions: Version[];
  createdAt: string;
  createdBy: typeof ME;
  updatedAt: string;
}

const V1: Version = {
  version: 1,
  fileName: 'access-control.docx',
  size: 2048,
  sha256: SHA_1,
  createdAt: CREATED,
  createdBy: ME,
};
const V2: Version = {
  ...V1,
  version: 2,
  fileName: 'access-control-v2.docx',
  size: 4096,
  sha256: SHA_2,
};
const ACCESS: Policy = {
  id: 'p-1',
  title: 'Access control policy',
  description: 'Who may get in.',
  requirementIds: [],
  versions: [V2, V1],
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

/** A policies api over an in-memory table, faked at the network boundary like the real one. */
function policiesApi(initial: Policy[], extra: Record<string, Handler> = {}) {
  let policies = initial;
  const calls: Call[] = [];
  const routes: Record<string, Handler> = {
    'GET /api/session': () =>
      json(200, {
        setupRequired: false,
        user: { ...ME, email: 'ada@example.com', role: 'admin' },
        csrfToken: 'csrf-1',
      }),
    'GET /api/assessment': () => json(200, ASSESSMENT_VIEW),
    'GET /api/policies': () => json(200, { items: policies }),
    'POST /api/policies': (call) => {
      const body = call.body as { title: string; description: string; requirementIds: string[] };
      const item: Policy = {
        id: 'p-9',
        title: body.title,
        description: body.description === '' ? null : body.description,
        requirementIds: body.requirementIds,
        versions: [],
        createdAt: CREATED,
        createdBy: ME,
        updatedAt: CREATED,
      };
      policies = [...policies, item];
      return json(201, { item });
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

async function renderPolicies() {
  render(
    <MemoryRouter initialEntries={['/policies']}>
      <AuthedApp />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Policies' });
}

const BANNER =
  "Don't upload CUI. Rampart V1 isn't approved to store CUI. Mark CUI evidence as Contains CUI and record where the file lives.";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Policies page', () => {
  it('list and create', async () => {
    const user = userEvent.setup();
    const api = policiesApi([ACCESS]);
    await renderPolicies();

    // The CUI banner, then the list with the latest version's name, size and full SHA-256.
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    const row = await screen.findByRole('listitem', { name: 'Access control policy' });
    expect(within(row).getByText('Who may get in.')).toBeInTheDocument();
    expect(within(row).getByText('access-control-v2.docx')).toBeInTheDocument();
    expect(within(row).getByText('4 KB')).toBeInTheDocument();
    expect(within(row).getByText(SHA_2)).toBeInTheDocument();
    // A download link per version.
    expect(within(row).getByRole('link', { name: /Download version 1/ })).toHaveAttribute(
      'href',
      '/api/policies/p-1/versions/1/file',
    );
    expect(within(row).getByRole('link', { name: /Download version 2/ })).toHaveAttribute(
      'href',
      '/api/policies/p-1/versions/2/file',
    );

    // An empty (blank) title sends nothing.
    const form = screen.getByRole('form', { name: 'Add a policy' });
    await user.type(within(form).getByLabelText('Title'), '   ');
    await user.click(within(form).getByRole('button', { name: 'Add policy' }));
    expect(within(form).getByText('Enter a title.')).toBeInTheDocument();
    expect(api.sent('POST /api/policies')).toHaveLength(0);

    // A create sends its body once, then the new policy shows and the form clears.
    await user.clear(within(form).getByLabelText('Title'));
    await user.type(within(form).getByLabelText('Title'), 'Incident response plan');
    await user.type(within(form).getByLabelText('Description'), 'Who does what.');
    await user.click(within(form).getByRole('button', { name: 'Add policy' }));
    const created = await screen.findByRole('listitem', { name: 'Incident response plan' });
    const posts = api.sent('POST /api/policies');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      title: 'Incident response plan',
      description: 'Who does what.',
      requirementIds: [],
    });
    expect(posts[0]?.headers.get('x-csrf-token')).toBe('csrf-1');
    expect(within(form).getByLabelText('Title')).toHaveValue('');
    expect(within(created).getByText('No file uploaded yet.')).toBeInTheDocument();
  });

  it('shows the banner when the list fails to load', async () => {
    policiesApi([], { 'GET /api/policies': () => apiError(500, 'internal') });
    await renderPolicies();
    expect(await screen.findByText("Can't load policies")).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
  });

  it('upload', async () => {
    // The picker's accept filter is off here so a refused type reaches our own check.
    const user = userEvent.setup({ applyAccept: false });
    const next: Policy = {
      ...ACCESS,
      versions: [
        { ...V1, version: 3, fileName: 'access-control-v3.pdf', size: 1_500_000, sha256: SHA_3 },
        ...ACCESS.versions,
      ],
    };
    const api = policiesApi([ACCESS], {
      'POST /api/policies/p-1/versions': () => json(201, { item: next }),
    });
    await renderPolicies();
    const row = await screen.findByRole('listitem', { name: 'Access control policy' });
    const input = () => within(row).getByLabelText('Upload a new version');

    // An unsupported type shows the reason and sends nothing.
    await user.upload(input(), new File(['x'], 'tool.exe'));
    expect(await within(row).findByText(/This file type can't be uploaded/)).toBeInTheDocument();
    expect(api.sent('POST /api/policies/p-1/versions')).toHaveLength(0);

    // Over 25 MiB: the same, and the old reason is replaced.
    const big = new File(['x'], 'big.pdf');
    Object.defineProperty(big, 'size', { value: 26_214_401 });
    await user.upload(input(), big);
    expect(await within(row).findByText('The file is larger than 25 MiB.')).toBeInTheDocument();
    expect(within(row).queryByText(/This file type can't/)).not.toBeInTheDocument();
    expect(api.sent('POST /api/policies/p-1/versions')).toHaveLength(0);

    // A good upload adds a version and clears the reason and the chosen name.
    await user.upload(input(), new File(['hello'], 'access-control-v3.pdf'));
    expect(await within(row).findByText(SHA_3)).toBeInTheDocument();
    expect(within(row).getByText('access-control-v3.pdf')).toBeInTheDocument();
    const posts = api.sent('POST /api/policies/p-1/versions');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.headers.get('content-type')).toBe('application/octet-stream');
    expect(posts[0]?.headers.get('x-file-name')).toBe('access-control-v3.pdf');
    expect(posts[0]?.headers.get('x-csrf-token')).toBe('csrf-1');
    expect(within(row).queryByText('The file is larger than 25 MiB.')).not.toBeInTheDocument();
    expect(within(row).getByText('No file chosen')).toBeInTheDocument();
  });

  it('treats an identical repeat (200) as success and shows an api refusal', async () => {
    const user = userEvent.setup();
    let missing = false;
    policiesApi([ACCESS], {
      'POST /api/policies/p-1/versions': () =>
        missing
          ? apiError(404, 'not_found', 'That policy no longer exists.')
          : json(200, { item: ACCESS }),
    });
    await renderPolicies();
    const row = await screen.findByRole('listitem', { name: 'Access control policy' });
    await user.upload(within(row).getByLabelText('Upload a new version'), new File(['x'], 'a.pdf'));
    await vi.waitFor(() => {
      expect(within(row).getByText('No file chosen')).toBeInTheDocument();
    });
    expect(within(row).queryByRole('alert')).not.toBeInTheDocument();

    missing = true;
    await user.upload(within(row).getByLabelText('Upload a new version'), new File(['x'], 'b.pdf'));
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      'That policy no longer exists. Reload the page.',
    );
  });
});
