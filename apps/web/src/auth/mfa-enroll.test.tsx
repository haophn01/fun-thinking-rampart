import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../App';
import { apiError, json, stubApi, type Routes } from '../pages/ssp/kit/testing';
import styles from './Mfa.module.css';

vi.setConfig({ testTimeout: 15_000 });

const ENROLL = 'POST /api/session/mfa/enroll';
const CONFIRM = 'POST /api/session/mfa/enroll/confirm';
const WRONG_CODE = "That code didn't work. Enter the newest code from your app.";

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const ENROLLING = {
  setupRequired: false,
  user: ADMIN,
  csrfToken: 'csrf-1',
  locked: false,
  mustChangePassword: false,
  signInNotice: null,
  mfa: 'enroll',
};

// Test fixtures: the public RFC/Google Authenticator base32 example ("Hello!") and a second
// made-up value in the same shape. Neither is a real secret.
// nosemgrep: generic.secrets.security.detected-generic-secret.detected-generic-secret
const SECRET_A = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
// nosemgrep: generic.secrets.security.detected-generic-secret.detected-generic-secret
const SECRET_B = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function enrollment(secret: string, size = 21, path = 'M0 0h7v1h-7zM14 0h7v1h-7zM0 1h1v1h-1z') {
  return {
    secret,
    otpauthUri: `otpauth://totp/Rampart:ada%40example.com?secret=${secret}`,
    qr: { size, path },
  };
}

function renderEnroll(routes: Routes = {}, { strict = false } = {}) {
  const api = stubApi({ 'GET /api/session': () => json(200, ENROLLING), ...routes });
  const app = (
    <MemoryRouter>
      <AuthedApp />
    </MemoryRouter>
  );
  render(strict ? <StrictMode>{app}</StrictMode> : app);
  return api;
}

/** Shows the page with its enrollment answered, and returns the stub. */
async function shown(routes: Routes = {}) {
  const api = renderEnroll(routes);
  const start = api.defer(ENROLL);
  await api.waitForCall(ENROLL);
  await start.requested;
  start.answer(json(200, enrollment(SECRET_A)));
  await screen.findByTestId('mfa-manual-key');
  return api;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('enrollment shows QR and key', () => {
  it('enrollment shows QR and key', async () => {
    const innerHtml = vi.spyOn(Element.prototype, 'innerHTML', 'set');
    const api = renderEnroll();
    const start = api.defer(ENROLL);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set up two-step sign-in' }),
    ).toBeVisible();
    const call = await start.requested;
    expect(call.body).toBeUndefined();
    expect(call.headers.get('x-csrf-token')).toBe('csrf-1');
    start.answer(json(200, enrollment(SECRET_A, 25, 'M0 0h7v1h-7zM18 0h7v1h-7z')));

    // The QR: an inline svg with a 4-module quiet zone and the api's path, nothing else.
    const qr = await screen.findByRole('img', { name: 'QR code for your authenticator app' });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.getAttribute('viewBox')).toBe('-4 -4 33 33');
    const paths = qr.querySelectorAll('path');
    expect(paths).toHaveLength(1);
    expect(paths[0]?.getAttribute('d')).toBe('M0 0h7v1h-7zM18 0h7v1h-7z');
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.innerHTML).not.toContain('data:');
    expect(innerHtml).not.toHaveBeenCalled();

    // The manual key, grouped by 4 in the mono font, with the account it is for.
    const key = screen.getByTestId('mfa-manual-key');
    expect(key).toHaveTextContent(/^JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP$/);
    expect(key).toHaveClass(styles.key ?? 'missing');
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'Mfa.module.css'),
      'utf8',
    );
    expect(css).toMatch(/\.key\s*\{[^}]*font-family:\s*var\(--rp-font-mono\)/);
    expect(screen.getByText('ada@example.com')).toBeVisible();

    // The code field, Confirm and Sign out.
    const field = screen.getByLabelText('6-digit code');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();

    // Once per show: nothing posts again while the page stays.
    await tick();
    expect(api.sent(ENROLL)).toHaveLength(1);
  });

  it('shows only the newer secret when two answers arrive out of order', async () => {
    // StrictMode shows the page twice, so it posts twice; the second post's secret is the one
    // the api keeps.
    const api = renderEnroll({}, { strict: true });
    const first = api.defer(ENROLL);
    const second = api.defer(ENROLL);
    await api.waitForCall(ENROLL, 2);
    await first.requested;
    await second.requested;
    second.answer(json(200, enrollment(SECRET_B)));
    expect(await screen.findByTestId('mfa-manual-key')).toHaveTextContent(
      'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ',
    );
    first.answer(json(200, enrollment(SECRET_A)));
    await tick();
    expect(screen.getByTestId('mfa-manual-key')).toHaveTextContent(
      'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ',
    );
    expect(screen.queryByText(/JBSW/)).not.toBeInTheDocument();
    expect(api.sent(ENROLL)).toHaveLength(2);
  });
});

describe('confirm edges', () => {
  it('confirm edges', async () => {
    const user = userEvent.setup();
    const api = await shown();
    const field = () => screen.getByLabelText<HTMLInputElement>('6-digit code');

    // 5 digits sends nothing and shows the field error.
    await user.type(field(), '12345');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Enter the 6-digit code from your app.')).toBeVisible();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    await tick();
    expect(api.sent(CONFIRM)).toHaveLength(0);

    // Spaces are dropped: `12 34 56` sends 123456. A wrong code shows the text and clears.
    const wrong = api.defer(CONFIRM);
    await user.clear(field());
    await user.type(field(), '12 34 56');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect((await wrong.requested).body).toEqual({ code: '123456' });
    wrong.answer(apiError(401, 'invalid_mfa_code', WRONG_CODE));
    expect(await screen.findByText(WRONG_CODE)).toBeVisible();
    expect(field()).toHaveValue('');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Set up two-step sign-in');

    // 429 shows the wait.
    const limited = api.defer(CONFIRM);
    await user.type(field(), '654321');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await limited.requested;
    limited.answer(apiError(429, 'too_many_attempts', 'Too many', { retryAfterSeconds: 30 }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many requests. Try again in 30 seconds.',
    );

    // 409 mfa_wrong_step re-reads the session.
    const reads = api.sent('GET /api/session').length;
    const wrongStep = api.defer(CONFIRM);
    await user.clear(field());
    await user.type(field(), '111111');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await wrongStep.requested;
    wrongStep.answer(apiError(409, 'mfa_wrong_step'));
    await api.waitForCall('GET /api/session', reads + 1);
    expect(api.sent(CONFIRM)).toHaveLength(3);
  });

  it('a failed start shows an Alert with Retry', async () => {
    const user = userEvent.setup();
    const api = renderEnroll();
    const failed = api.defer(ENROLL);
    await api.waitForCall(ENROLL);
    await failed.requested;
    failed.answer(apiError(500, 'internal_error'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't start setting up two-step sign-in.");
    expect(screen.queryByLabelText('6-digit code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();

    const retried = api.defer(ENROLL);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await retried.requested;
    retried.answer(json(200, enrollment(SECRET_A)));
    expect(await screen.findByTestId('mfa-manual-key')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.sent(ENROLL)).toHaveLength(2);
  });

  it('a rate-limited start shows the wait, and a wrong-step start re-reads', async () => {
    const api = renderEnroll();
    const limited = api.defer(ENROLL);
    await api.waitForCall(ENROLL);
    await limited.requested;
    limited.answer(apiError(429, 'too_many_attempts', 'Too many', { retryAfterSeconds: 61 }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many requests. Try again in 2 minutes.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();

    const reads = api.sent('GET /api/session').length;
    const wrongStep = api.defer(ENROLL);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await wrongStep.requested;
    wrongStep.answer(apiError(409, 'mfa_wrong_step'));
    await api.waitForCall('GET /api/session', reads + 1);
  });

  it('Sign out signs out', async () => {
    const user = userEvent.setup();
    const api = await shown({
      'GET /api/session': () => json(200, ENROLLING),
    });
    const out = api.defer('DELETE /api/session');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await out.requested;
    out.answer(json(204));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByTestId('mfa-manual-key')).not.toBeInTheDocument();
    });
  });
});
