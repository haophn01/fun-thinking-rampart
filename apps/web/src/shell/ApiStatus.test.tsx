import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiStatus } from './ApiStatus';

const ok = () => new Response(JSON.stringify({ status: 'ok', db: 'ok' }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api status banner', () => {
  it('shows nothing while health is ok', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(ok()));
    vi.stubGlobal('fetch', fetchMock);
    render(<ApiStatus />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the alert on failure and a successful Retry clears it', async () => {
    const user = userEvent.setup();
    let healthy = false;
    const fetchMock = vi.fn(() =>
      healthy ? Promise.resolve(ok()) : Promise.reject(new TypeError('Failed to fetch')),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ApiStatus />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Can't reach the API");

    // A Retry that still fails keeps the alert.
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    healthy = true;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('treats a 503 envelope as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: 'db_unavailable', message: 'down', requestId: 'r' } }),
            { status: 503 },
          ),
        ),
      ),
    );
    render(<ApiStatus />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the API");
  });
});
