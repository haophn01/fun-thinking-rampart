import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../App';
import { apiError, json, stubApi } from '../pages/ssp/kit/testing';

vi.setConfig({ testTimeout: 15_000 });

const VERIFY = 'POST /api/session/mfa/verify';
const WRONG_CODE = "That code didn't work. Enter the newest code from your app.";
const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const SESSION = {
  setupRequired: false,
  user: ADMIN,
  csrfToken: 'csrf-1',
  locked: false,
  mustChangePassword: false,
  signInNotice: null,
  mfa: 'challenge',
};

async function renderChallenge() {
  const api = stubApi({ 'GET /api/session': () => json(200, SESSION) });
  render(
    <MemoryRouter>
      <AuthedApp />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
  return api;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('challenge by code or recovery code', () => {
  it('challenge by code or recovery code', async () => {
    const user = userEvent.setup();
    const api = await renderChallenge();
    const code = () => screen.getByLabelText<HTMLInputElement>('6-digit code');
    expect(code()).toHaveAttribute('inputmode', 'numeric');
    expect(code()).toHaveAttribute('autocomplete', 'one-time-code');

    // A wrong code shows the contract text on the field and clears it.
    const wrong = api.defer(VERIFY);
    await user.type(code(), '123 456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    const first = await wrong.requested;
    expect(first.body).toEqual({ code: '123456' });
    expect(first.headers.get('x-csrf-token')).toBe('csrf-1');
    wrong.answer(apiError(401, 'invalid_mfa_code', WRONG_CODE));
    expect(await screen.findByText(WRONG_CODE)).toBeVisible();
    expect(code()).toHaveValue('');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Enter your code');

    // Switch to a recovery code: a malformed one sends nothing.
    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    expect(screen.queryByLabelText('6-digit code')).not.toBeInTheDocument();
    const recovery = () => screen.getByLabelText<HTMLInputElement>('Recovery code');
    expect(screen.queryByText(WRONG_CODE)).not.toBeInTheDocument();
    await user.type(recovery(), 'abcde-fghji');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Enter a recovery code: 10 letters and digits.')).toBeVisible();
    await tick();
    expect(api.sent(VERIFY)).toHaveLength(1);

    // And back to the 6-digit code, then to the recovery code again.
    await user.click(screen.getByRole('button', { name: 'Use a 6-digit code' }));
    expect(code()).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));

    // A well-formed recovery code is sent normalized, and the session it answers opens the app.
    const right = api.defer(VERIFY);
    await user.clear(recovery());
    await user.type(recovery(), ' ABCDE-FGHJK ');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect((await right.requested).body).toEqual({ recoveryCode: 'abcdefghjk' });
    right.answer(json(200, { ...SESSION, csrfToken: 'csrf-2', mfa: 'none' }));
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
  });

  it('a 6-digit code that is not 6 digits sends nothing', async () => {
    const user = userEvent.setup();
    const api = await renderChallenge();
    await user.type(screen.getByLabelText('6-digit code'), '12a456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Enter the 6-digit code from your app.')).toBeVisible();
    await tick();
    expect(api.sent(VERIFY)).toHaveLength(0);
  });

  it('the 5th wrong code ends the session, and 429 and 409 answer as the contract says', async () => {
    const user = userEvent.setup();
    const api = await renderChallenge();
    const field = () => screen.getByLabelText('6-digit code');

    const limited = api.defer(VERIFY);
    await user.type(field(), '111111');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await limited.requested;
    limited.answer(apiError(429, 'too_many_attempts', 'Too many', { retryAfterSeconds: 5 }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many requests. Try again in 5 seconds.',
    );

    const reads = api.sent('GET /api/session').length;
    const wrongStep = api.defer(VERIFY);
    await user.clear(field());
    await user.type(field(), '222222');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await wrongStep.requested;
    wrongStep.answer(apiError(409, 'mfa_wrong_step'));
    await api.waitForCall('GET /api/session', reads + 1);

    const ended = api.defer(VERIFY);
    await user.clear(field());
    await user.type(field(), '333333');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await ended.requested;
    ended.answer(apiError(401, 'unauthenticated'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(screen.getByText('Your session ended. Sign in again.')).toBeVisible();
  });

  it('Sign out signs out', async () => {
    const user = userEvent.setup();
    const api = await renderChallenge();
    const out = api.defer('DELETE /api/session');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await out.requested;
    out.answer(json(204));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument();
  });
});
