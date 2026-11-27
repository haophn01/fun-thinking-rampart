import { PRODUCT_NAME } from '@rampart/api/contract';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { App, AuthedApp } from './App';

vi.setConfig({ testTimeout: 15_000 });

function stubSession(session: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(path === '/api/session' ? session : { status: 'ok', db: 'ok' }),
        ),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('mounts the shell with the product name and the Dashboard page when signed in', async () => {
    stubSession({
      setupRequired: false,
      user: { id: 'u-1', email: 'ada@example.com', displayName: 'Ada', role: 'admin' },
      csrfToken: 'csrf-1',
    });
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getAllByText(PRODUCT_NAME).length).toBeGreaterThan(0);
  });

  it('shows Sign in with the product name when signed out', async () => {
    stubSession({ setupRequired: false, user: null, csrfToken: null });
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getAllByText(PRODUCT_NAME).length).toBeGreaterThan(0);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

describe('account password route', () => {
  it('account password route', async () => {
    stubSession({
      setupRequired: false,
      user: { id: 'u-1', email: 'ada@example.com', displayName: 'Ada', role: 'admin' },
      csrfToken: 'csrf-1',
      locked: false,
      mustChangePassword: false,
      signInNotice: null,
    });
    render(
      <MemoryRouter initialEntries={['/account/password']}>
        <AuthedApp />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Change password' }),
    ).toBeInTheDocument();
    // Inside the shell: the masthead and nav are there, and it isn't the forced page.
    expect(screen.getByRole('banner')).toBeInTheDocument();
    const nav = screen.getByRole('navigation');
    expect(screen.queryByTestId('change-password-forced')).not.toBeInTheDocument();
    expect(screen.queryByText('Page not found')).not.toBeInTheDocument();
    // Not a nav tab.
    expect(within(nav).queryByRole('link', { name: /password/i })).not.toBeInTheDocument();
    for (const link of within(nav).getAllByRole('link')) {
      expect(link).not.toHaveAttribute('href', '/account/password');
    }
    expect(document.title).toMatch(/^Change password/);
  });
});
