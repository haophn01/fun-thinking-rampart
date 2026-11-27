import { UPLOAD_MAX_BYTES } from '@rampart/api/contract';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

// See list.test.tsx: the test timeout sits above the 5 s wait so a failure names its wait.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const AT = '2026-11-23T10:00:00.000Z';
const BY = { id: 'u-1', displayName: 'Ada Admin' };
const HASH = 'c'.repeat(64);

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
    createdBy: BY,
    updatedAt: AT,
    ...over,
  };
}

const fileVersion = (version: number, fileName: string, sha256: string) => ({
  kind: 'file',
  version,
  fileName,
  size: 5,
  sha256,
  createdAt: AT,
  createdBy: BY,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

function fakeApi(items: unknown[], write: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (input === '/api/session')
        return Promise.resolve(json(200, { setupRequired: false, user: ADMIN, csrfToken: 'tok' }));
      if (input === '/api/health') return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      if (input === '/api/evidence' && method === 'GET')
        return Promise.resolve(json(200, { items }));
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body;
      const call = { method, path: input, body, headers: new Headers(init.headers) };
      calls.push(call);
      return Promise.resolve(write(call));
    }),
  );
  return calls;
}

async function openDetails(title: string) {
  render(
    <MemoryRouter initialEntries={['/evidence']}>
      <AuthedApp />
    </MemoryRouter>,
  );
  const user = userEvent.setup({ applyAccept: false });
  await user.click(await screen.findByRole('button', { name: `Details for ${title}` }));
  return { user, detail: screen.getByRole('region', { name: `Details for ${title}` }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upload', () => {
  it('refuses a .exe and a file over 25 MiB with the reason, and sends nothing', async () => {
    const calls = fakeApi([item('e-1', 'Firewall config')], () => json(500));
    const { user, detail } = await openDetails('Firewall config');
    const input = within(detail).getByLabelText('Upload a file');

    await user.upload(input, new File(['MZ'], 'setup.exe'));
    expect(await within(detail).findByText(/can't be uploaded\. Allowed: .*\.pdf/)).toBeVisible();

    const big = new File(['x'], 'big.pdf');
    Object.defineProperty(big, 'size', { value: UPLOAD_MAX_BYTES + 1 });
    await user.upload(input, big);
    expect(await within(detail).findByText('The file is larger than 25 MiB.')).toBeVisible();
    expect(calls).toEqual([]);
  });

  it('uploads a good file as octet-stream and shows the new version', async () => {
    const calls = fakeApi(
      [item('e-1', 'Firewall config', { versions: [fileVersion(1, 'fw-v1.pdf', 'a'.repeat(64))] })],
      () =>
        json(201, {
          item: item('e-1', 'Firewall config', {
            versions: [
              fileVersion(2, 'fw-v2.pdf', HASH),
              fileVersion(1, 'fw-v1.pdf', 'a'.repeat(64)),
            ],
          }),
        }),
    );
    const { user, detail } = await openDetails('Firewall config');
    await user.upload(
      within(detail).getByLabelText('Upload a file'),
      new File(['hello'], 'fw-v2.pdf'),
    );
    expect(await within(detail).findByText('Version 2')).toBeVisible();
    expect(within(detail).getByText(HASH)).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/evidence/e-1/versions');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('content-type')).toBe('application/octet-stream');
    expect(calls[0]?.headers.get('x-file-name')).toBe('fw-v2.pdf');
    expect(calls[0]?.headers.get('x-csrf-token')).toBe('tok');
    const link = within(detail).getByRole('link', { name: 'Download version 2' });
    expect(link).toHaveAttribute('href', '/api/evidence/e-1/versions/2/file');
  });

  it('treats a 200 identical repeat as success', async () => {
    const same = item('e-1', 'Firewall config', { versions: [fileVersion(1, 'fw.pdf', HASH)] });
    fakeApi([same], () => json(200, { item: same }));
    const { user, detail } = await openDetails('Firewall config');
    await user.upload(
      within(detail).getByLabelText('Upload a file'),
      new File(['hello'], 'fw.pdf'),
    );
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([p]) => p === '/api/evidence/e-1/versions')).toBe(
        true,
      );
    });
    expect(within(detail).queryByRole('alert')).toBeNull();
    expect(within(detail).getAllByText('Version 1')).toHaveLength(1);
  });

  it('shows the message of a 409 cui_file_refused', async () => {
    fakeApi([item('e-1', 'Firewall config')], () =>
      json(409, {
        error: {
          code: 'cui_file_refused',
          message: 'This item contains CUI, so no file can be stored.',
          requestId: 'r',
        },
      }),
    );
    const { user, detail } = await openDetails('Firewall config');
    await user.upload(
      within(detail).getByLabelText('Upload a file'),
      new File(['hello'], 'fw.pdf'),
    );
    expect(
      await within(detail).findByText('This item contains CUI, so no file can be stored.'),
    ).toBeVisible();
  });

  it("shows a refused file's reason", async () => {
    const message = 'This file expands to more than 100 times its size.';
    const calls = fakeApi([item('e-1', 'Firewall config')], () =>
      json(415, {
        error: {
          code: 'file_refused',
          message,
          requestId: 'r-415',
          details: { reason: 'zip_ratio', extension: '.docx' },
        },
      }),
    );
    const { user, detail } = await openDetails('Firewall config');
    await user.upload(
      within(detail).getByLabelText('Upload a file'),
      new File(['PK'], 'notes.docx'),
    );
    expect(await within(detail).findByText(message)).toBeVisible();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/evidence/e-1/versions',
    ]);
  });
});

describe('CUI reference', () => {
  it('renders no file input and saves a reference with location and note', async () => {
    const cui = item('e-2', 'Key inventory', { containsCui: true });
    const calls = fakeApi([cui], () =>
      json(201, {
        item: {
          ...cui,
          versions: [
            {
              kind: 'reference',
              version: 1,
              location: 'Enclave share \\vault\\keys',
              note: 'Owner: IT',
              createdAt: AT,
              createdBy: BY,
            },
          ],
        },
      }),
    );
    const { user, detail } = await openDetails('Key inventory');
    expect(detail.querySelector('input[type="file"]')).toBeNull();
    expect(within(detail).queryByText('Choose file')).toBeNull();
    await user.type(
      within(detail).getByLabelText('Where the file lives'),
      'Enclave share \\vault\\keys',
    );
    await user.type(within(detail).getByLabelText('Note'), 'Owner: IT');
    await user.click(within(detail).getByRole('button', { name: 'Record where it lives' }));
    expect(await within(detail).findByText('Version 1')).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/evidence/e-2/references',
      body: { location: 'Enclave share \\vault\\keys', note: 'Owner: IT' },
    });
    expect(within(detail).queryByRole('link', { name: /Download/ })).toBeNull();
  });

  it('sends nothing without a location', async () => {
    const calls = fakeApi([item('e-2', 'Key inventory', { containsCui: true })], () => json(500));
    const { user, detail } = await openDetails('Key inventory');
    await user.click(within(detail).getByRole('button', { name: 'Record where it lives' }));
    expect(await within(detail).findByText('Enter where the file lives.')).toBeVisible();
    expect(calls).toEqual([]);
  });
});
