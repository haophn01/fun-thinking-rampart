import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiStatus } from './ApiStatus';

vi.setConfig({ testTimeout: 15_000 });

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

describe('api status on 429', () => {
  it('api status on 429', async () => {
    const user = userEvent.setup();
    let limited = true;
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        limited
          ? new Response(
              JSON.stringify({
                error: {
                  code: 'too_many_attempts',
                  message: 'Too many requests.',
                  requestId: 'r',
                  details: { retryAfterSeconds: 45 },
                },
              }),
              { status: 429, headers: { 'retry-after': '45' } },
            )
          : ok(),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ApiStatus />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many requests. Try again in 45 seconds.');
    expect(alert).not.toHaveTextContent("Can't reach the API");

    // Retry after the wait clears it.
    limited = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says "later" for a 429 without a wait, and unreachable again after a network failure', async () => {
    const user = userEvent.setup();
    let down = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        down
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve(
              new Response(
                JSON.stringify({
                  error: { code: 'too_many_attempts', message: 'Too many', requestId: 'r' },
                }),
                { status: 429 },
              ),
            ),
      ),
    );
    render(<ApiStatus />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many requests. Try again later.',
    );
    down = true;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText("Can't reach the API")).toBeInTheDocument();
    expect(screen.queryByText(/Too many requests/)).not.toBeInTheDocument();
  });
});
