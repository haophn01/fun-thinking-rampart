import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

// Each wait for the app may take up to 5 s, for a full-app render on a loaded CI runner. The
// test timeout sits above that (the 5 s default would equal it), so a wait that never succeeds
// fails with its own message and the DOM instead of a bare "Test timed out".
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const AT = '2026-11-23T10:00:00.000Z';
const HASH = '9f2c41d0b7e3a5c8f61e0d2b94a7c3e41a5b6c7d8e9f00112233445566778899';
const BANNER =
  "Don't upload CUI. Rampart V1 isn't approved to store CUI. Mark CUI evidence as Contains CUI and record where the file lives.";

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

function item(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title,
    description: null,
    containsCui: false,
    objectiveIds: [],
    versions: [],
    createdAt: AT,
    createdBy: { id: 'u-1', displayName: 'Ada Admin' },
    updatedAt: AT,
    ...over,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fake api. `evidence` answers GET /api/evidence; `write` answers every other evidence call. */
function fakeApi(opts: {
  evidence: () => Response | Promise<Response>;
  write?: (call: Call) => Response | Promise<Response>;
}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (input === '/api/session')
        return Promise.resolve(json(200, { setupRequired: false, user: ADMIN, csrfToken: 'tok' }));
      if (input === '/api/health') return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      if (input === '/api/evidence' && method === 'GET') return Promise.resolve(opts.evidence());
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const call = { method, path: input, body };
      calls.push(call);
      return Promise.resolve(opts.write?.(call) ?? json(500));
    }),
  );
  return calls;
}

function open() {
  render(
    <MemoryRouter initialEntries={['/evidence']}>
      <AuthedApp />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('banner and list', () => {
  it('shows the CUI banner while loading, on error and with items', async () => {
    let release: (value: Response) => void = () => undefined;
    fakeApi({ evidence: () => new Promise<Response>((resolve) => (release = resolve)) });
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Evidence' })).toBeVisible();
    expect(screen.getByText(BANNER)).toBeVisible();
    // The held request has been made before it is answered.
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([path]) => path === '/api/evidence')).toBe(true);
    });
    release(json(200, { items: [item('e-1', 'Firewall config')] }));
    expect(await screen.findByText('Firewall config')).toBeVisible();
    expect(screen.getByText(BANNER)).toBeVisible();
  });

  it('keeps the banner and offers Retry when the list fails', async () => {
    let fail = true;
    fakeApi({
      evidence: () =>
        fail
          ? json(500, { error: { code: 'internal_error', message: 'Boom', requestId: 'r-1' } })
          : json(200, { items: [item('e-1', 'Firewall config')] }),
    });
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
    expect(screen.getByText(BANNER)).toBeVisible();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Firewall config')).toBeVisible();
  });

  it('lists title, CUI flag, link count, and the full SHA-256 of the latest version', async () => {
    const by = { id: 'u-1', displayName: 'Ada Admin' };
    fakeApi({
      evidence: () =>
        json(200, {
          items: [
            item('e-1', 'Firewall config', {
              objectiveIds: ['3.1.1[a]', '3.1.1[b]'],
              versions: [
                {
                  kind: 'file',
                  version: 2,
                  fileName: 'fw-2026-11.pdf',
                  size: 2048,
                  sha256: HASH,
                  createdAt: AT,
                  createdBy: by,
                },
                {
                  kind: 'file',
                  version: 1,
                  fileName: 'fw-old.pdf',
                  size: 10,
                  sha256: 'a'.repeat(64),
                  createdAt: AT,
                  createdBy: by,
                },
              ],
            }),
            item('e-2', 'Key inventory', {
              containsCui: true,
              versions: [
                {
                  kind: 'reference',
                  version: 1,
                  location: 'Enclave share vault/keys',
                  note: null,
                  createdAt: AT,
                  createdBy: by,
                },
              ],
            }),
          ],
        }),
    });
    open();
    const plain = (await screen.findByText('Firewall config')).closest('li') as HTMLElement;
    expect(within(plain).getByText(HASH)).toBeVisible();
    expect(within(plain).getByText('fw-2026-11.pdf')).toBeVisible();
    expect(within(plain).getByText('2 objectives linked')).toBeVisible();
    expect(within(plain).queryByText('Contains CUI')).toBeNull();
    expect(within(plain).queryByText('fw-old.pdf')).toBeNull();
    const cui = screen.getByText('Key inventory').closest('li') as HTMLElement;
    expect(within(cui).getByText('Contains CUI')).toBeVisible();
    expect(within(cui).getByText('Enclave share vault/keys')).toBeVisible();
    expect(within(cui).getByText('0 objectives linked')).toBeVisible();
  });
});

describe('create', () => {
  it('sends {title, description, containsCui, objectiveIds} once on a double click', async () => {
    const calls = fakeApi({
      evidence: () => json(200, { items: [] }),
      write: (call) => {
        if (call.method === 'POST' && call.path === '/api/evidence')
          return json(201, {
            item: item('e-9', 'Badge logs', { description: 'Q4 export', containsCui: true }),
          });
        return json(500);
      },
    });
    const user = userEvent.setup();
    open();
    await user.type(await screen.findByLabelText('Title'), 'Badge logs');
    await user.type(screen.getByLabelText('Description'), 'Q4 export');
    await user.click(screen.getByRole('checkbox', { name: 'Contains CUI' }));
    expect(screen.getByText(/can't be changed later/i)).toBeVisible();
    await user.dblClick(screen.getByRole('button', { name: 'Create evidence item' }));
    expect(await screen.findByText('Badge logs')).toBeVisible();
    await waitFor(() => {
      expect(screen.getByLabelText('Title')).toHaveValue('');
    });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toEqual([
      {
        method: 'POST',
        path: '/api/evidence',
        body: {
          title: 'Badge logs',
          description: 'Q4 export',
          containsCui: true,
          objectiveIds: [],
        },
      },
    ]);
  });

  it('sends nothing for an empty title and says why', async () => {
    const calls = fakeApi({ evidence: () => json(200, { items: [] }) });
    const user = userEvent.setup();
    open();
    await user.type(await screen.findByLabelText('Title'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create evidence item' }));
    expect(await screen.findByText('Enter a title.')).toBeVisible();
    expect(calls).toEqual([]);
  });

  it('shows the api message when a create is refused and keeps what was typed', async () => {
    fakeApi({
      evidence: () => json(200, { items: [] }),
      write: () =>
        json(400, {
          error: {
            code: 'validation_failed',
            message: 'The title is not accepted',
            requestId: 'r',
          },
        }),
    });
    const user = userEvent.setup();
    open();
    await user.type(await screen.findByLabelText('Title'), 'X');
    await user.click(screen.getByRole('button', { name: 'Create evidence item' }));
    expect(await screen.findByText('The title is not accepted')).toBeVisible();
    expect(screen.getByLabelText('Title')).toHaveValue('X');
  });
});
