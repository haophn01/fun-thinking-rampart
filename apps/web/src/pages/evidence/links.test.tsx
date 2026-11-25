import { loadCatalog } from '@rampart/catalog';
import { configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../../App';

// See list.test.tsx: the test timeout sits above the 5 s wait so a failure names its wait.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const catalog = loadCatalog();
const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const AT = '2026-11-23T10:00:00.000Z';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

const req = (id: string) => {
  const found = catalog.requirements.find((r) => r.id === id);
  if (!found) throw new Error(id);
  return found;
};
const first = req('AC.L2-3.1.1');
const second = req('AC.L2-3.1.2');
const [a, b] = first.objectives.map((o) => o.id);
const [c] = second.objectives.map((o) => o.id);
if (a === undefined || b === undefined || c === undefined) throw new Error('catalog');

function evidence(objectiveIds: string[]) {
  return {
    id: 'e-1',
    title: 'Firewall config',
    description: null,
    containsCui: false,
    objectiveIds,
    versions: [],
    createdAt: AT,
    createdBy: { id: 'u-1', displayName: 'Ada Admin' },
    updatedAt: AT,
  };
}

function fakeApi(saved: string[], answer: (body: { objectiveIds: string[] }) => Response) {
  const puts: { path: string; body: { objectiveIds: string[] } }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (input === '/api/session')
        return Promise.resolve(json(200, { setupRequired: false, user: ADMIN, csrfToken: 'tok' }));
      if (input === '/api/health') return Promise.resolve(json(200, { status: 'ok', db: 'ok' }));
      if (input === '/api/evidence' && method === 'GET')
        return Promise.resolve(json(200, { items: [evidence(saved)] }));
      const body = JSON.parse(init.body as string) as { objectiveIds: string[] };
      if (method === 'PUT') puts.push({ path: input, body });
      return Promise.resolve(answer(body));
    }),
  );
  return puts;
}

async function openLinks() {
  render(
    <MemoryRouter initialEntries={['/evidence']}>
      <AuthedApp />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Details for Firewall config' }));
  const editor = screen.getByRole('group', { name: 'Linked objectives' });
  return { user, editor };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('objective links', () => {
  it('PUTs the full set, keeping links under other requirements', async () => {
    const puts = fakeApi([a, c], (body) => json(200, { item: evidence(body.objectiveIds) }));
    const { user, editor } = await openLinks();
    // The editor starts on the requirement of the first linked objective, with its link ticked.
    expect(within(editor).getByLabelText('Requirement')).toHaveValue(first.id);
    expect(within(editor).getByRole('checkbox', { name: new RegExp(`^${esc(a)}`) })).toBeChecked();
    await user.click(within(editor).getByRole('checkbox', { name: new RegExp(`^${esc(b)}`) }));
    await user.click(within(editor).getByRole('button', { name: 'Save links' }));
    expect(await within(editor).findByText('Saved.')).toBeVisible();
    expect(puts).toEqual([
      { path: '/api/evidence/e-1/objectives', body: { objectiveIds: [a, b, c] } },
    ]);
  });

  it('keeps a tick made under one requirement when another is picked, and can untick', async () => {
    const puts = fakeApi([a, c], (body) => json(200, { item: evidence(body.objectiveIds) }));
    const { user, editor } = await openLinks();
    await user.click(within(editor).getByRole('checkbox', { name: new RegExp(`^${esc(b)}`) }));
    await user.selectOptions(within(editor).getByLabelText('Requirement'), second.id);
    expect(within(editor).getByRole('checkbox', { name: new RegExp(`^${esc(c)}`) })).toBeChecked();
    await user.click(within(editor).getByRole('checkbox', { name: new RegExp(`^${esc(c)}`) }));
    await user.click(within(editor).getByRole('button', { name: 'Save links' }));
    await within(editor).findByText('Saved.');
    expect(puts[0]?.body).toEqual({ objectiveIds: [a, b] });
  });

  it('has Save disabled until something changes, and shows an unknown-objective failure', async () => {
    const puts = fakeApi([a], () =>
      json(400, {
        error: { code: 'validation_failed', message: 'Unknown objective', requestId: 'r' },
      }),
    );
    const { user, editor } = await openLinks();
    const save = within(editor).getByRole('button', { name: 'Save links' });
    expect(save).toBeDisabled();
    await user.click(within(editor).getByRole('checkbox', { name: new RegExp(`^${esc(b)}`) }));
    await user.click(save);
    expect(await within(editor).findByText('Unknown objective')).toBeVisible();
    expect(puts).toHaveLength(1);
  });
});

function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
