import { PRODUCT_NAME } from '@rampart/api/contract';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../App';

const TABS = [
  ['Dashboard', '/'],
  ['Assessment', '/assessment'],
  ['POA&M', '/poam'],
  ['Evidence', '/evidence'],
  ['Policies', '/policies'],
  ['SSP', '/ssp'],
  ['Settings', '/settings'],
] as const;

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada', role: 'admin' };

/** Renders the signed-in app at a path and waits for the shell. */
async function renderAt(path: string) {
  const result = render(
    <MemoryRouter initialEntries={[path]}>
      <AuthedApp />
    </MemoryRouter>,
  );
  await screen.findByRole('navigation', { name: 'Primary' });
  return result;
}

beforeEach(() => {
  const answers: Record<string, unknown> = {
    '/api/session': { setupRequired: false, user: ADMIN, csrfToken: 'csrf-1' },
    '/api/users': {
      users: [{ ...ADMIN, active: true, createdAt: '2026-11-24T10:00:00.000Z' }],
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      Promise.resolve(new Response(JSON.stringify(answers[path] ?? { status: 'ok', db: 'ok' }))),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Shell', () => {
  it('nav marks the current tab', async () => {
    const poam = await renderAt('/poam');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(7);
    for (const [label, path] of TABS) {
      expect(within(nav).getByRole('link', { name: label })).toHaveAttribute('href', path);
    }
    const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('POA&M');
    poam.unmount();

    // /assessment and /settings render their page modules.
    const assessment = await renderAt('/assessment');
    expect(screen.getByRole('heading', { level: 1, name: 'Assessment' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Assessment' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    assessment.unmount();
    await renderAt('/settings');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: /Users/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks Dashboard only at the root, not on every path', async () => {
    await renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      within(nav)
        .getAllByRole('link')
        .filter((link) => link.hasAttribute('aria-current')),
    ).toHaveLength(1);
  });

  it('shows the brand, the user slot and decorative registration marks', async () => {
    const { container } = await renderAt('/');
    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('Ada')).toBeInTheDocument();
    expect(within(banner).getByText('Admin')).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByText(PRODUCT_NAME)).toBeInTheDocument();
    const marks = container.querySelectorAll('header svg[aria-hidden="true"]');
    expect(marks.length).toBeGreaterThanOrEqual(2);
  });

  it('routes and titles', async () => {
    for (const [label, path] of TABS) {
      const { unmount } = await renderAt(path);
      expect(screen.getByRole('heading', { level: 1, name: label })).toBeInTheDocument();
      // Only / and /ssp still lack a page module; every other route mounts its own page.
      if (path === '/' || path === '/ssp') {
        expect(screen.getByText("This section isn't built yet.")).toBeInTheDocument();
      }
      expect(document.title).toBe(`${label} · ${PRODUCT_NAME}`);
      unmount();
    }
  });

  it('sets the title in the same commit that shows the page', async () => {
    // Records the title at each DOM change, before anything else can run, so a title that
    // lands in a later task (after the next route has rendered) shows up here.
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const heading = document.querySelector('h1');
      if (heading) seen.push(`${heading.textContent} | ${document.title}`);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.title = 'stale';
    try {
      await renderAt('/poam');
    } finally {
      observer.disconnect();
    }
    const shown = seen.filter((entry) => entry.startsWith('POA&M |'));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[0]).toBe(`POA&M | POA&M · ${PRODUCT_NAME}`);
  });

  it('not found', async () => {
    await renderAt('/nope/deeper');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(document.title).toBe(`Page not found · ${PRODUCT_NAME}`);
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: /Dashboard/ })).toHaveAttribute('href', '/');
  });

  it('phone menu', async () => {
    const user = userEvent.setup();
    await renderAt('/');
    const button = screen.getByRole('button', { name: 'Menu' });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');

    // Choosing a link closes it.
    await user.click(button);
    await user.click(screen.getByRole('link', { name: 'Evidence' }));
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('heading', { level: 1, name: 'Evidence' })).toBeInTheDocument();

    // Escape closes it and returns focus to the button.
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    screen.getByRole('link', { name: 'SSP' }).focus();
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
  });

  it('Escape with the menu closed leaves focus alone', async () => {
    const user = userEvent.setup();
    await renderAt('/');
    screen.getByRole('link', { name: 'SSP' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('link', { name: 'SSP' })).toHaveFocus();
  });
});
