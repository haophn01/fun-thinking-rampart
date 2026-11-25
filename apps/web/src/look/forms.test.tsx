import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Alert, RadioGroup, Select, TextArea, type RadioOption } from './index';

describe('TextArea and Select', () => {
  it('associates the TextArea label and is valid without an error', () => {
    render(<TextArea label="Implementation statement" />);
    const area = screen.getByRole('textbox', { name: 'Implementation statement' });
    expect(area.tagName).toBe('TEXTAREA');
    expect(area).not.toHaveAttribute('aria-invalid');
    expect(area).not.toHaveAttribute('aria-describedby');
  });

  it('marks the TextArea invalid and describes it with the error, keeping a caller description', () => {
    render(
      <>
        <p id="hint">Shown in the SSP.</p>
        <TextArea label="Note" error="Enter a note." aria-describedby="hint" />
      </>,
    );
    const area = screen.getByRole('textbox', { name: 'Note' });
    expect(area).toHaveAttribute('aria-invalid', 'true');
    expect(area).toHaveAccessibleDescription('Shown in the SSP. Enter a note.');
  });

  it('shows no counter without maxLength', () => {
    render(<TextArea label="Note" defaultValue="abc" />);
    expect(screen.queryByText(/\d+ \/ \d+/)).not.toBeInTheDocument();
  });

  it('counts the default value, updates as you type, and stops at maxLength', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TextArea label="Note" maxLength={5} defaultValue="ab" onChange={onChange} />);
    const area = screen.getByRole('textbox', { name: 'Note' });
    expect(screen.getByText('2 / 5')).toBeInTheDocument();
    expect(area).toHaveAccessibleDescription('2 / 5');

    await user.type(area, 'c');
    expect(screen.getByText('3 / 5')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);

    await user.type(area, 'defgh');
    expect(area).toHaveValue('abcde');
    expect(screen.getByText('5 / 5')).toBeInTheDocument();
    expect(screen.queryByText('6 / 5')).not.toBeInTheDocument();
  });

  it('counts a controlled value, including one already over the limit', () => {
    function Controlled({ initial }: { initial: string }) {
      const [value, setValue] = useState(initial);
      return (
        <TextArea
          label="Note"
          maxLength={4}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      );
    }
    const { unmount } = render(<Controlled initial="ab" />);
    expect(screen.getByText('2 / 4')).toBeInTheDocument();
    unmount();
    render(<Controlled initial="abcdef" />);
    expect(screen.getByText('6 / 4')).toBeInTheDocument();
  });

  it('associates the Select label and lists its options', () => {
    render(
      <Select label="Owner" defaultValue="b">
        <option value="a">Unassigned</option>
        <option value="b">Ada Lovelace</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Owner' });
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('b');
    expect(select).not.toHaveAttribute('aria-invalid');
    expect(select).not.toHaveAttribute('aria-describedby');
  });

  it('marks the Select invalid and describes it with the error', () => {
    render(
      <Select label="Level" error="Choose a level.">
        <option value="">Not set (worst case)</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Level' });
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Choose a level.');
  });

  it('calls the Select onChange with the chosen value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        label="Owner"
        defaultValue="a"
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        <option value="a">Unassigned</option>
        <option value="b">Ada Lovelace</option>
      </Select>,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Owner' }), 'b');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('gives two fields of each kind distinct ids', () => {
    render(
      <>
        <TextArea label="First" error="Bad first" />
        <TextArea label="Second" error="Bad second" />
        <Select label="Third" error="Bad third">
          <option>x</option>
        </Select>
        <Select label="Fourth" error="Bad fourth">
          <option>y</option>
        </Select>
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'First' })).toHaveAccessibleDescription('Bad first');
    expect(screen.getByRole('textbox', { name: 'Second' })).toHaveAccessibleDescription(
      'Bad second',
    );
    expect(screen.getByRole('combobox', { name: 'Third' })).toHaveAccessibleDescription(
      'Bad third',
    );
    expect(screen.getByRole('combobox', { name: 'Fourth' })).toHaveAccessibleDescription(
      'Bad fourth',
    );
  });
});

const STATUS_OPTIONS: RadioOption[] = [
  { value: 'met', label: 'Met', status: 'met' },
  { value: 'not_met', label: 'Not Met', status: 'not_met' },
  { value: 'na', label: 'N/A', status: 'na' },
  { value: 'not_assessed', label: 'Not Assessed', status: 'not_assessed' },
];

function Status({
  initial,
  onChange,
  disabled,
}: {
  initial?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <RadioGroup
      legend="AC.L2-3.1.1[a] status"
      options={STATUS_OPTIONS}
      value={value}
      disabled={disabled}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('RadioGroup', () => {
  it('names the group from its legend and renders one radio per option', () => {
    render(<Status onChange={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: 'AC.L2-3.1.1[a] status' });
    expect(group.tagName).toBe('FIELDSET');
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
  });

  it('checks the option matching value, and none for an unknown value', () => {
    const { unmount } = render(<Status initial="na" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'N/A' })).toBeChecked();
    unmount();
    render(<Status initial="bogus" onChange={vi.fn()} />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
  });

  it('selects on click and calls onChange once; clicking the selected option again does not', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Status onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'Not Met' }));
    expect(screen.getByRole('radio', { name: 'Not Met' })).toBeChecked();
    expect(onChange).toHaveBeenCalledExactlyOnceWith('not_met');
    await user.click(screen.getByRole('radio', { name: 'Not Met' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('moves the selection with the arrow keys and calls onChange once per move, wrapping at the ends', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Status initial="met" onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Met' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Not Met' })).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith('not_met');
    expect(onChange).toHaveBeenCalledTimes(1);

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'N/A' })).toBeChecked();
    expect(onChange).toHaveBeenCalledTimes(2);

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Not Met' })).toBeChecked();
    expect(onChange).toHaveBeenCalledTimes(3);

    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByRole('radio', { name: 'Not Assessed' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Not Assessed' })).toHaveFocus();
    expect(onChange).toHaveBeenCalledTimes(5);
    expect(onChange.mock.calls.map(([value]) => value as string)).toEqual([
      'not_met',
      'na',
      'not_met',
      'met',
      'not_assessed',
    ]);
  });

  it('ignores clicks and keys when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Status initial="met" onChange={onChange} disabled />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Not Met' }));
    await user.click(screen.getByText('N/A'));
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Met' })).toBeChecked();
  });

  it('exposes each option status as data-status, and none without one', () => {
    render(
      <>
        <Status onChange={vi.fn()} />
        <RadioGroup
          legend="Assessment type"
          options={[
            { value: 'self', label: 'Self' },
            { value: 'c3pao', label: 'C3PAO' },
          ]}
          value="self"
          onChange={vi.fn()}
        />
      </>,
    );
    for (const option of STATUS_OPTIONS) {
      const label = screen.getByRole('radio', { name: option.label }).closest('label');
      expect(label).toHaveAttribute('data-status', option.status);
    }
    expect(screen.getByRole('radio', { name: 'Self' }).closest('label')).not.toHaveAttribute(
      'data-status',
    );
  });

  it('keeps two groups apart, so selecting in one leaves the other', async () => {
    const user = userEvent.setup();
    render(
      <>
        <RadioGroup
          legend="First"
          options={STATUS_OPTIONS.slice(0, 2)}
          value="met"
          onChange={vi.fn()}
        />
        <Status initial="met" onChange={vi.fn()} />
      </>,
    );
    await user.click(screen.getAllByRole('radio', { name: 'Not Met' })[1] as HTMLElement);
    const [firstMet] = screen.getAllByRole('radio', { name: 'Met' });
    expect(firstMet).toBeChecked();
  });
});

describe('Alert', () => {
  it('uses role alert for the error tone, with its title and message', () => {
    render(
      <Alert tone="error" title="Conditional status not possible">
        Score 72 is below 88.
      </Alert>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-tone', 'error');
    expect(alert).toHaveTextContent('Conditional status not possible');
    expect(alert).toHaveTextContent('Score 72 is below 88.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('uses role status for the info tone, and works without a title', () => {
    render(<Alert tone="info">What-if — not saved</Alert>);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('data-tone', 'info');
    expect(status).toHaveTextContent('What-if — not saved');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
