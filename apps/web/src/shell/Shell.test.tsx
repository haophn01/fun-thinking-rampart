import { PRODUCT_NAME } from '@rampart/api/contract';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';

const TABS = [
  ['Dashboard', '/'],
  ['Assessment', '/assessment'],
  ['POA&M', '/poam'],
  ['Evidence', '/evidence'],
  ['Policies', '/policies'],
  ['SSP', '/ssp'],
  ['Settings', '/settings'],
] as const;

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'ok', db: 'ok' })))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Shell', () => {
  it('nav marks the current tab', () => {
    renderAt('/poam');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(7);
    for (const [label, path] of TABS) {
      expect(within(nav).getByRole('link', { name: label })).toHaveAttribute('href', path);
    }
    const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('POA&M');
  });

  it('marks Dashboard only at the root, not on every path', () => {
    renderAt('/');
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

  it('shows the brand and decorative registration marks', () => {
    const { container } = renderAt('/');
    expect(within(screen.getByRole('banner')).getByText(PRODUCT_NAME)).toBeInTheDocument();
    const marks = container.querySelectorAll('header svg[aria-hidden="true"]');
    expect(marks.length).toBeGreaterThanOrEqual(2);
  });

  it('routes and titles', () => {
    for (const [label, path] of TABS) {
      const { unmount } = renderAt(path);
      expect(screen.getByRole('heading', { level: 1, name: label })).toBeInTheDocument();
      expect(screen.getByText("This section isn't built yet.")).toBeInTheDocument();
      expect(document.title).toBe(`${label} · ${PRODUCT_NAME}`);
      unmount();
    }
  });

  it('not found', () => {
    renderAt('/nope/deeper');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(document.title).toBe(`Page not found · ${PRODUCT_NAME}`);
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: /Dashboard/ })).toHaveAttribute('href', '/');
  });

  it('phone menu', async () => {
    const user = userEvent.setup();
    renderAt('/');
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
    renderAt('/');
    screen.getByRole('link', { name: 'SSP' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('link', { name: 'SSP' })).toHaveFocus();
  });
});
