import { DEFAULT_CATEGORIZATION, type SystemProfile } from '@rampart/api/contract';
import { act, configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, renderSsp, stubApi } from './kit/testing';
import { SSP_TABS } from './tabs';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const LABELS = [
  'Identification & roles',
  'Environment',
  'Assets',
  'Service providers & matrix',
  'Document control',
  'Lint & export',
];

const PROFILE: SystemProfile = {
  systemName: 'Acme Enclave',
  systemIdentifier: null,
  organizationName: null,
  cageCode: null,
  description: null,
  authorizationBoundary: null,
  environment: null,
  interconnections: null,
  informationTypes: null,
  systemOwner: null,
  systemOwnerEmail: null,
  securityContact: null,
  securityContactEmail: null,
  updatedAt: null,
  updatedBy: null,
};

/** Every call the default and export tabs make; the stub tabs make none. */
function api() {
  return stubApi({
    'GET /api/system-profile': () => json(200, { profile: PROFILE }),
    'GET /api/ssp/profile': () =>
      json(200, {
        profile: {
          categorization: DEFAULT_CATEGORIZATION,
          reviewCadenceMonths: 12,
          nextReviewDate: null,
          updatedAt: null,
          updatedBy: null,
        },
      }),
    'GET /api/assessment': () => json(500, { error: { code: 'internal', message: 'x' } }),
    'GET /api/ssp/roles': () => json(200, { roles: [], totals: { users: 0, privilegedUsers: 0 } }),
    'GET /api/ssp/assets': () => json(200, { assets: [] }),
  });
}

async function tablist() {
  return screen.findByRole('tablist', { name: 'SSP sections' });
}
const tab = (name: string) => screen.getByRole('tab', { name });
const selectedTab = () => screen.getByRole('tab', { selected: true });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SSP tabs', () => {
  it('tab order and selection', async () => {
    expect(SSP_TABS.map((t) => t.id)).toEqual([
      'identification',
      'environment',
      'assets',
      'providers',
      'document-control',
      'export',
    ]);
    expect(SSP_TABS.map((t) => t.label)).toEqual(LABELS);

    api();
    const page = renderSsp();
    const list = await tablist();
    expect(
      within(list)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(LABELS);
    expect(selectedTab()).toHaveTextContent('Identification & roles');
    expect(page.location().search).toBe('');
    expect(await screen.findByRole('form', { name: 'System profile' })).toBeInTheDocument();
  });

  it('an unknown tab selects Identification and leaves the URL alone', async () => {
    api();
    const page = renderSsp('nope');
    await tablist();
    expect(selectedTab()).toHaveTextContent('Identification & roles');
    expect(page.location().search).toBe('?tab=nope');
  });

  it('?tab=assets selects Assets', async () => {
    const stub = api();
    renderSsp('assets');
    await tablist();
    expect(selectedTab()).toHaveTextContent('Assets');
    const panel = screen.getByRole('tabpanel', { name: 'Assets' });
    expect(
      await within(panel).findByRole('heading', { name: /Asset inventory/ }),
    ).toBeInTheDocument();
    // The Identification tab was never visited, so it sent nothing.
    expect(stub.sent('GET /api/system-profile')).toHaveLength(0);
  });

  it('tab history', async () => {
    api();
    const user = userEvent.setup();
    const page = renderSsp();
    await tablist();

    await user.click(tab('Assets'));
    expect(page.location().search).toBe('?tab=assets');
    expect(selectedTab()).toHaveTextContent('Assets');
    await user.click(tab('Lint & export'));
    expect(page.location().search).toBe('?tab=export');
    // Clicking the selected tab adds no history entry.
    await user.click(tab('Lint & export'));

    await page.back();
    expect(page.location().search).toBe('?tab=assets');
    expect(selectedTab()).toHaveTextContent('Assets');
    await page.back();
    expect(page.location().search).toBe('');
    expect(selectedTab()).toHaveTextContent('Identification & roles');
  });

  it('keyboard', async () => {
    api();
    const user = userEvent.setup();
    const page = renderSsp();
    await tablist();
    const tabIndexes = () => screen.getAllByRole('tab').map((t) => t.tabIndex);
    expect(tabIndexes()).toEqual([0, -1, -1, -1, -1, -1]);

    // From the selected tab, Tab leaves the list: the other tabs aren't stops.
    await screen.findByRole('form', { name: 'System profile' });
    act(() => {
      tab('Identification & roles').focus();
    });
    await user.tab();
    expect(screen.getByLabelText('System name')).toHaveFocus();
    await user.tab({ shift: true });
    expect(tab('Identification & roles')).toHaveFocus();

    // ArrowLeft from the first wraps to the last, and selects it.
    await user.keyboard('{ArrowLeft}');
    expect(tab('Lint & export')).toHaveFocus();
    expect(selectedTab()).toHaveTextContent('Lint & export');
    expect(tabIndexes()).toEqual([-1, -1, -1, -1, -1, 0]);
    expect(page.location().search).toBe('?tab=export');

    // ArrowRight from the last wraps to the first.
    await user.keyboard('{ArrowRight}');
    expect(tab('Identification & roles')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(selectedTab()).toHaveTextContent('Environment');
    expect(tab('Environment')).toHaveFocus();
    expect(tabIndexes()).toEqual([-1, 0, -1, -1, -1, -1]);

    await user.keyboard('{End}');
    expect(selectedTab()).toHaveTextContent('Lint & export');
    expect(tab('Lint & export')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(selectedTab()).toHaveTextContent('Identification & roles');
    expect(tab('Identification & roles')).toHaveFocus();
  });

  it('arrow keys replace the history entry instead of adding one per key', async () => {
    api();
    const user = userEvent.setup();
    const page = renderSsp();
    await tablist();
    await user.click(tab('Assets'));
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(page.location().search).toBe('?tab=document-control');
    await page.back();
    expect(page.location().search).toBe('');
  });

  it('panels mount once', async () => {
    const stub = api();
    const user = userEvent.setup();
    renderSsp();
    const form = await screen.findByRole('form', { name: 'System profile' });
    const name = within(form).getByLabelText('System name');
    await user.type(name, ' draft');

    // An unvisited tab sends no request.
    expect(stub.sent('GET /api/assessment')).toHaveLength(0);

    await user.click(tab('Lint & export'));
    await stub.waitForCall('GET /api/assessment');
    const exportPanel = screen.getByRole('tabpanel', { name: 'Lint & export' });
    expect(exportPanel).toBeVisible();
    // The Identification panel stays mounted, hidden.
    expect(form).toBeInTheDocument();
    expect(form).not.toBeVisible();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);

    await user.click(tab('Identification & roles'));
    expect(name).toBeVisible();
    expect(name).toHaveValue('Acme Enclave draft');
    expect(exportPanel).not.toBeVisible();
    // Selected again, the panel re-reads its data; the reload keeps the draft.
    await stub.waitForCall('GET /api/system-profile', 2);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('form', { name: 'System profile' })).toBe(form);
    expect(name).toHaveValue('Acme Enclave draft');
    // A hidden panel reads nothing.
    expect(stub.sent('GET /api/assessment')).toHaveLength(1);

    await user.click(tab('Lint & export'));
    await stub.waitForCall('GET /api/assessment', 2);
    expect(stub.sent('GET /api/system-profile')).toHaveLength(2);
    // Each panel is labelled by its tab, and the tab controls it.
    expect(tab('Lint & export')).toHaveAttribute('aria-controls', exportPanel.id);
  });

  it('a panel re-reads only when shown again, never on its first visit or a re-click', async () => {
    const stub = api();
    const user = userEvent.setup();
    const page = renderSsp();
    await screen.findByRole('form', { name: 'System profile' });
    expect(stub.sent('GET /api/system-profile')).toHaveLength(1);

    // Clicking the selected tab is not a visit.
    await user.click(tab('Identification & roles'));
    await user.click(tab('Lint & export'));
    await stub.waitForCall('GET /api/assessment');
    expect(stub.sent('GET /api/system-profile')).toHaveLength(1);
    await user.click(tab('Lint & export'));
    expect(stub.sent('GET /api/assessment')).toHaveLength(1);

    // Back to a visited tab is a visit too.
    await page.back();
    await stub.waitForCall('GET /api/system-profile', 2);
    expect(stub.sent('GET /api/assessment')).toHaveLength(1);
  });

  it('the browser tab coming back re-reads the selected panel only', async () => {
    const stub = api();
    const user = userEvent.setup();
    renderSsp();
    await screen.findByRole('form', { name: 'System profile' });
    await user.click(tab('Lint & export'));
    await stub.waitForCall('GET /api/assessment');

    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(stub.sent('GET /api/assessment')).toHaveLength(1);
    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await stub.waitForCall('GET /api/assessment', 2);
    expect(stub.sent('GET /api/system-profile')).toHaveLength(1);
    visibility.mockRestore();
  });

  it('title', async () => {
    const stub = api();
    const profile = stub.defer('GET /api/system-profile');
    renderSsp();
    expect(await screen.findByRole('heading', { level: 1, name: 'SSP' })).toBeInTheDocument();
    await profile.requested;
    // The frame is up while the tab's own load is still out.
    expect(screen.getByRole('tablist', { name: 'SSP sections' })).toBeInTheDocument();
    expect(screen.getAllByText(/^Loading/).length).toBeGreaterThan(0);
    expect(document.title).toMatch(/^SSP · /);
    profile.answer(json(200, { profile: PROFILE }));
    expect(await screen.findByRole('form', { name: 'System profile' })).toBeInTheDocument();
  });
});
