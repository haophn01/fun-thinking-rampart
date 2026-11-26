import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CATEGORIZATION,
  sspProfileResponseSchema,
  type SspProfile,
} from '@rampart/api/contract';
import { configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/client';
import {
  RemoveButton,
  SspProfileForm,
  SspTable,
  errorText,
  fieldErrors,
  useLoad,
  type SspProfileFormProps,
} from '.';
import { ME, apiError, json, stubApi, type Routes } from './testing';

// The test timeout sits above the 5 s wait, so a wait that never succeeds names itself.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const SAVED_AT = '2026-11-24T10:00:00.000Z';

const PROFILE: SspProfile = {
  categorization: DEFAULT_CATEGORIZATION,
  securityOfficer: null,
  securityOfficerEmail: null,
  organizationAddress: '1 Main St',
  organizationPhone: null,
  cuiCategories: null,
  cuiLocations: null,
  cuiEntryExit: null,
  topologyNarrative: null,
  dataFlowNarrative: null,
  inventoryReference: null,
  maintenanceStatement: null,
  reviewCadenceMonths: 12,
  nextReviewDate: null,
  updatedAt: null,
  updatedBy: null,
};

/** The profile route over an in-memory profile, answering like the api (blank → default). */
function profileApi(initial: SspProfile, extra: Routes = {}) {
  let profile = initial;
  return stubApi({
    'PATCH /api/ssp/profile': (call) => {
      const patch = call.body as Record<string, unknown>;
      profile = { ...profile, ...patch, updatedAt: SAVED_AT, updatedBy: ME };
      if (patch.categorization === null) profile.categorization = DEFAULT_CATEGORIZATION;
      return json(200, { profile });
    },
    ...extra,
  });
}

function renderForm(props: Partial<SspProfileFormProps> = {}) {
  const onSaved = vi.fn();
  render(
    <SspProfileForm
      title="Identification"
      groups={['identification']}
      profile={PROFILE}
      onSaved={onSaved}
      {...props}
    />,
  );
  const form = screen.getByRole('form', { name: props.title ?? 'Identification' });
  return { form, onSaved, user: userEvent.setup() };
}

function labelsOf(form: HTMLElement) {
  return [...form.querySelectorAll('input, textarea')].map(
    (el) => form.querySelector(`label[for="${el.id}"]`)?.textContent,
  );
}

const CADENCE_MESSAGE = 'Enter a whole number of months from 1 to 60';
const DATE_MESSAGE = 'Enter a real date as YYYY-MM-DD.';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SSP kit', () => {
  it('profile form fields', async () => {
    const api = profileApi(PROFILE);
    const { form, onSaved, user } = renderForm({ groups: ['identification', 'review'] });

    // Only its groups' fields, in contract order.
    expect(labelsOf(form)).toEqual([
      'Security categorization',
      'System security officer',
      'System security officer email',
      'Organization address',
      'Organization phone',
      'Review every (months)',
      'Next review date',
    ]);
    // Control types per LONG_SSP_FIELDS, and the field hints.
    const get = (label: string) => within(form).getByLabelText(label);
    expect(get('Organization address').tagName).toBe('TEXTAREA');
    expect(get('Security categorization').tagName).toBe('INPUT');
    expect(get('System security officer email')).toHaveAttribute('type', 'email');
    expect(get('Review every (months)')).toHaveAttribute('inputMode', 'numeric');
    expect(get('Next review date')).toHaveAccessibleDescription(/YYYY-MM-DD/);
    expect(get('Security categorization')).toHaveValue(DEFAULT_CATEGORIZATION);
    expect(get('Review every (months)')).toHaveValue('12');
    expect(within(form).getByText('Not saved yet.')).toBeInTheDocument();

    // Nothing changed: Save is disabled.
    const save = within(form).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    // Only the changed keys go; blank text goes as null. Save waits while the patch is pending.
    const held = api.defer('PATCH /api/ssp/profile');
    await user.type(get('System security officer'), 'Grace Hopper');
    await user.clear(get('Organization address'));
    await user.click(save);
    const call = await held.requested;
    expect(call.body).toEqual({ securityOfficer: 'Grace Hopper', organizationAddress: null });
    expect(save).toBeDisabled();
    const stored = { ...PROFILE, securityOfficer: 'Grace Hopper', organizationAddress: null };
    held.answer(json(200, { profile: { ...stored, updatedAt: SAVED_AT, updatedBy: ME } }));

    expect(await within(form).findByRole('status')).toHaveTextContent('Saved');
    expect(within(form).getByText(/^Last saved .* by Ada Admin$/)).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledWith({ ...stored, updatedAt: SAVED_AT, updatedBy: ME });
    expect(save).toBeDisabled();

    // Typing again hides "Saved".
    await user.type(get('Organization phone'), '5');
    expect(within(form).queryByRole('status')).not.toBeInTheDocument();
    expect(save).toBeEnabled();
  });

  it('profile form shows only the cui group', () => {
    stubApi();
    const { form } = renderForm({ title: 'CUI description', groups: ['cui'] });
    expect(labelsOf(form)).toEqual([
      'CUI categories (CUI Registry)',
      'Where CUI is stored, processed or transmitted',
      'How CUI enters and leaves the system',
    ]);
    for (const area of within(form).getAllByRole('textbox')) expect(area.tagName).toBe('TEXTAREA');
  });

  it('profile form validation', async () => {
    const api = profileApi(PROFILE);
    const { form, user } = renderForm({ title: 'Review schedule', groups: ['review'] });
    const cadence = within(form).getByLabelText('Review every (months)');
    const date = within(form).getByLabelText('Next review date');
    const save = within(form).getByRole('button', { name: 'Save' });

    for (const bad of ['', '0', '61', '1.5', 'abc']) {
      await user.clear(cadence);
      if (bad !== '') await user.type(cadence, bad);
      await user.click(save);
      expect(within(form).getByText(CADENCE_MESSAGE)).toBeInTheDocument();
      expect(cadence).toBeInvalid();
    }
    expect(api.sent('PATCH /api/ssp/profile')).toHaveLength(0);

    // An invalid field holds back the valid ones too.
    await user.type(date, '2027-02-29');
    await user.click(save);
    expect(within(form).getByText(DATE_MESSAGE)).toBeInTheDocument();
    expect(api.sent('PATCH /api/ssp/profile')).toHaveLength(0);

    // Fixing a field clears its error. 1 and 60 are sent as numbers.
    await user.clear(date);
    await user.clear(cadence);
    expect(within(form).queryByText(CADENCE_MESSAGE)).not.toBeInTheDocument();
    await user.type(cadence, '1');
    await user.click(save);
    await within(form).findByRole('status');
    expect(api.sent('PATCH /api/ssp/profile')[0]?.body).toEqual({ reviewCadenceMonths: 1 });

    await user.clear(cadence);
    await user.type(cadence, '60');
    await user.type(date, ' 2027-03-01 ');
    await user.click(save);
    await within(form).findByRole('status');
    expect(api.sent('PATCH /api/ssp/profile')[1]?.body).toEqual({
      reviewCadenceMonths: 60,
      nextReviewDate: '2027-03-01',
    });

    // Blanking the date sends null.
    await user.clear(date);
    await user.click(save);
    await within(form).findByRole('status');
    expect(api.sent('PATCH /api/ssp/profile')[2]?.body).toEqual({ nextReviewDate: null });
  });

  it('profile form shows the schema message for other fields', async () => {
    const api = profileApi(PROFILE);
    const { form, user } = renderForm();
    await user.type(within(form).getByLabelText('System security officer email'), 'not-an-email');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByLabelText('System security officer email')).toBeInvalid();
    expect(api.sent('PATCH /api/ssp/profile')).toHaveLength(0);
  });

  it('profile form defaults', async () => {
    const api = profileApi({ ...PROFILE, categorization: 'High impact' });
    const { form, user } = renderForm({
      groups: ['identification', 'review'],
      profile: { ...PROFILE, categorization: 'High impact' },
    });
    const categorization = within(form).getByLabelText('Security categorization');
    const cadence = within(form).getByLabelText('Review every (months)');
    const save = within(form).getByRole('button', { name: 'Save' });

    // Clearing it sends null, and the form then shows the default the api returns.
    await user.clear(categorization);
    await user.click(save);
    await within(form).findByRole('status');
    expect(api.sent('PATCH /api/ssp/profile')[0]?.body).toEqual({ categorization: null });
    expect(categorization).toHaveValue(DEFAULT_CATEGORIZATION);

    // Clearing it now, or typing the default back, changes nothing.
    await user.clear(categorization);
    expect(save).toBeDisabled();
    await user.type(categorization, DEFAULT_CATEGORIZATION);
    expect(save).toBeDisabled();

    // Retyping the stored cadence is not a change.
    await user.clear(cadence);
    await user.type(cadence, '12');
    expect(save).toBeDisabled();
    expect(api.sent('PATCH /api/ssp/profile')).toHaveLength(1);
  });

  it('error mapping', async () => {
    let answer: () => Response | Promise<Response> = () =>
      apiError(400, 'validation_failed', 'The request is not valid', [
        { path: ['securityOfficerEmail'], message: 'Invalid email address' },
      ]);
    stubApi({ 'PATCH /api/ssp/profile': () => answer() });
    const { form, user } = renderForm();
    const name = within(form).getByLabelText('System security officer');
    const save = within(form).getByRole('button', { name: 'Save' });

    // A 400 with a details path shows on that field, not in an Alert.
    await user.type(name, 'Grace');
    await user.click(save);
    expect(await within(form).findByText('Invalid email address')).toBeInTheDocument();
    expect(within(form).getByLabelText('System security officer email')).toBeInvalid();
    expect(within(form).queryByRole('alert')).not.toBeInTheDocument();
    expect(name).toHaveValue('Grace');

    const cases: [() => Response | Promise<Response>, string][] = [
      [
        () => apiError(403, 'csrf_failed'),
        'The security check failed. Reload the page and try again.',
      ],
      [
        () => Promise.reject(new TypeError('Failed to fetch')),
        "Can't reach the API. Check your connection and try again.",
      ],
      [() => apiError(500, 'internal_error'), "Couldn't save. Try again."],
      [() => apiError(400, 'validation_failed', 'Nothing to change'), 'Nothing to change'],
    ];
    for (const [next, text] of cases) {
      answer = next;
      await user.click(save);
      expect(await within(form).findByRole('alert')).toHaveTextContent(text);
    }
  });

  it('errorText and fieldErrors', () => {
    const error = (code: string, message = code, details?: unknown) =>
      new ApiError({ status: 400, code, message, details });
    expect(errorText(error('validation_failed', 'Bad title'), 'F')).toBe('Bad title');
    expect(errorText(error('forbidden'), 'F')).toBe('Only an admin can do this.');
    expect(errorText(error('not_found'), 'F')).toBe(
      'It was already removed. The list has been reloaded.',
    );
    expect(errorText(error('conflict'), 'F')).toBe('F');
    expect(errorText(new Error('boom'), 'F')).toBe('F');

    expect(
      fieldErrors(
        error('validation_failed', 'x', [
          { path: ['title'], message: 'Too long' },
          { path: ['title'], message: 'Second' },
          { path: [], message: 'Whole body' },
          { message: 'No path' },
        ]),
      ),
    ).toEqual({ title: 'Too long' });
    expect(fieldErrors(error('validation_failed', 'x', { issues: [] }))).toEqual({});
    expect(fieldErrors(error('csrf_failed', 'x', [{ path: ['a'], message: 'm' }]))).toEqual({});
    expect(fieldErrors(new Error('boom'))).toEqual({});
  });

  it('table stacks on phones', () => {
    interface Row {
      id: string;
      role: string;
      users: number;
    }
    const columns = [
      { header: 'Role', cell: (row: Row) => row.role },
      { header: 'Users', cell: (row: Row) => String(row.users) },
    ];
    const { rerender } = render(
      <SspTable
        caption="Roles"
        columns={columns}
        rows={[
          { id: 'r-1', role: 'Admin', users: 2 },
          { id: 'r-2', role: 'User', users: 40 },
        ]}
        rowKey={(row) => row.id}
        empty="No roles yet."
      />,
    );
    const table = screen.getByRole('table', { name: 'Roles' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Role', 'Users']);
    const [, ...rows] = within(table).getAllByRole('row');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const cells = within(row).getAllByRole('cell');
      // Each cell starts with its column's label.
      expect(cells.map((cell) => cell.firstElementChild?.textContent)).toEqual(['Role', 'Users']);
    }
    expect(within(rows[1] as HTMLElement).getAllByRole('cell')[1]).toHaveTextContent('Users40');

    // No rows: the empty text instead of a table.
    rerender(
      <SspTable
        caption="Roles"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        empty="No roles yet."
      />,
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No roles yet.')).toBeInTheDocument();

    // The CSS: labels hidden on desktop; at max-width 767px rows become blocks and labels show.
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'kit.module.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const media = /@media \(max-width: 767px\)\s*\{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? '';
    const outside = css.slice(0, css.indexOf('@media (max-width: 767px)'));
    expect(outside).toMatch(/\.cellLabel\s*\{[^}]*display:\s*none/);
    expect(media).toMatch(/\.table[^{]*\{[^}]*display:\s*block/);
    expect(media).toMatch(/\.table tr[^{]*\{[^}]*display:\s*block/);
    expect(media).toMatch(/\.table td[^{]*\{[^}]*display:\s*block/);
    expect(media).toMatch(/\.cellLabel\s*\{[^}]*display:\s*block/);
    expect(media).toMatch(/\.table thead[^{]*\{[^}]*(?:display:\s*none|position:\s*absolute)/);
  });

  it('remove confirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() => Promise.resolve());
    render(<RemoveButton name="Admin" onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Remove Admin?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText('Remove Admin?')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('useLoad replace', async () => {
    const api = stubApi({
      'GET /api/ssp/profile': () => json(200, { profile: PROFILE }),
    });
    function Probe() {
      const loaded = useLoad('/api/ssp/profile', sspProfileResponseSchema);
      return (
        <div>
          <p>{loaded.data?.profile.securityOfficer ?? 'none'}</p>
          <button
            type="button"
            onClick={() => {
              loaded.replace({ profile: { ...PROFILE, securityOfficer: 'Grace' } });
            }}
          >
            replace
          </button>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Probe />);
    expect(await screen.findByText('none')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'replace' }));
    expect(screen.getByText('Grace')).toBeInTheDocument();
    // Replacing sends nothing.
    expect(api.sent('GET /api/ssp/profile')).toHaveLength(1);
  });
});
