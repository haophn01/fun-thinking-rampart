import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthedApp } from '../App';
import { json, stubApi } from '../pages/ssp/kit/testing';
import styles from './Mfa.module.css';

vi.setConfig({ testTimeout: 15_000 });

const ADMIN = { id: 'u-1', email: 'ada@example.com', displayName: 'Ada Admin', role: 'admin' };
const SESSION = {
  setupRequired: false,
  user: ADMIN,
  csrfToken: 'csrf-1',
  locked: false,
  mustChangePassword: false,
  signInNotice: null,
  mfa: 'none',
};
// Test fixture: the public RFC/Google Authenticator base32 example ("Hello!"), not a real secret.
// nosemgrep: generic.secrets.security.detected-generic-secret.detected-generic-secret
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CODES = Array.from({ length: 10 }, (_, index) => `abcde-fghj${String(index)}`);

/** Enrolls through the page and returns once the recovery codes show. */
async function showCodes(user: ReturnType<typeof userEvent.setup>) {
  const api = stubApi({ 'GET /api/session': () => json(200, { ...SESSION, mfa: 'enroll' }) });
  render(
    <MemoryRouter>
      <AuthedApp />
    </MemoryRouter>,
  );
  const start = api.defer('POST /api/session/mfa/enroll');
  await api.waitForCall('POST /api/session/mfa/enroll');
  await start.requested;
  start.answer(
    json(200, {
      secret: SECRET,
      otpauthUri: `otpauth://totp/Rampart:ada%40example.com?secret=${SECRET}`,
      qr: { size: 21, path: 'M0 0h7v1h-7z' },
    }),
  );
  await user.type(await screen.findByLabelText('6-digit code'), '123456');
  const confirm = api.defer('POST /api/session/mfa/enroll/confirm');
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await confirm.requested;
  confirm.answer(json(200, { ...SESSION, csrfToken: 'csrf-2', recoveryCodes: CODES }));
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Save your recovery codes' }),
  ).toBeVisible();
  return api;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('codes must be confirmed', () => {
  it('codes must be confirmed', async () => {
    const user = userEvent.setup();
    await showCodes(user);

    // The codes, once, in an ordered list in the mono font, with what they are for.
    const list = screen.getByTestId('recovery-codes');
    expect(list.tagName).toBe('OL');
    expect(list).toHaveClass(styles.codes ?? 'missing');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(CODES);
    expect(screen.getByText("Each code works once. You won't see them again.")).toBeVisible();

    // Continue is disabled until the box is checked, and again if it is unchecked.
    const proceed = screen.getByRole('button', { name: 'Continue' });
    expect(proceed).toBeDisabled();
    const saved = screen.getByRole('checkbox', { name: 'I saved my recovery codes' });
    await user.click(saved);
    expect(proceed).toBeEnabled();
    await user.click(saved);
    expect(proceed).toBeDisabled();
    await user.click(saved);

    // Continue opens the app.
    await user.click(proceed);
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-codes')).not.toBeInTheDocument();
  });

  it('Copy writes the 10 codes, one per line', async () => {
    const user = userEvent.setup();
    await showCodes(user);
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(write).toHaveBeenCalledTimes(1);
    const text = write.mock.calls[0]?.[0] ?? '';
    expect(text.split('\n')).toEqual(CODES);
    expect(await screen.findByText('Copied.')).toBeVisible();
    expect(screen.queryByText("Couldn't copy. Write them down.")).not.toBeInTheDocument();
  });

  it('a clipboard rejection shows the fallback text', async () => {
    const user = userEvent.setup();
    await showCodes(user);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText("Couldn't copy. Write them down.")).toBeVisible();
    // The codes stay on screen to write down, and Continue still needs the box.
    expect(within(screen.getByTestId('recovery-codes')).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });
});
