import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../App';

vi.setConfig({ testTimeout: 15_000 });

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}
function apiError(status: number, code: string) {
  return json(status, { error: { code, message: code, requestId: 'r' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setup', () => {
  it('setup refuses a common password', async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init: RequestInit = {}) => {
        const key = `${init.method ?? 'GET'} ${input}`;
        if (key === 'GET /api/session') {
          return Promise.resolve(json(200, { setupRequired: true, user: null, csrfToken: null }));
        }
        if (key === 'POST /api/setup') {
          posts.push(key);
          return Promise.resolve(apiError(400, 'password_too_common'));
        }
        return Promise.resolve(apiError(404, 'not_found'));
      }),
    );
    render(
      <MemoryRouter>
        <AuthedApp />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 1, name: /Set up/ });
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Display name'), 'Ada');
    await user.type(screen.getByLabelText('Password'), 'password1234');
    await user.type(screen.getByLabelText('Confirm password'), 'password1234');
    await user.click(screen.getByRole('button', { name: 'Create admin' }));
    await vi.waitFor(() => {
      expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
        'This password is too common. Choose another.',
      );
    });
    expect(posts).toHaveLength(1);
    expect(
      screen.queryByText('Setup failed. Check the fields and try again.'),
    ).not.toBeInTheDocument();
  });
});
