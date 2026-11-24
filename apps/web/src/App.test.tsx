import { PRODUCT_NAME } from '@rampart/api/contract';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

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
