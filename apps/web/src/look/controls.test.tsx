import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, GraduatedBar, SectionLabel, StatusChip, TextField } from './index';

describe('Button', () => {
  it('defaults to type=button and the secondary variant', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-variant', 'secondary');
  });

  it('exposes the variant and keeps an explicit type', () => {
    render(
      <Button variant="primary" type="submit">
        Submit
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Submit' });
    expect(button).toHaveAttribute('data-variant', 'primary');
    expect(button).toHaveAttribute('type', 'submit');
  });

  it('calls onClick when enabled and ignores clicks when disabled', async () => {
    const user = userEvent.setup();
    const onEnabled = vi.fn();
    const onDisabled = vi.fn();
    render(
      <>
        <Button onClick={onEnabled}>On</Button>
        <Button onClick={onDisabled} disabled>
          Off
        </Button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'On' }));
    await user.click(screen.getByRole('button', { name: 'Off' }));
    expect(onEnabled).toHaveBeenCalledTimes(1);
    expect(onDisabled).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Off' })).toBeDisabled();
  });
});

describe('TextField', () => {
  it('associates the label with the input and is valid without an error', () => {
    render(<TextField label="System name" />);
    const input = screen.getByRole('textbox', { name: 'System name' });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('marks the input invalid and describes it with the error', () => {
    render(<TextField label="System name" error="Enter a system name." />);
    const input = screen.getByRole('textbox', { name: 'System name' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a system name.');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)).toHaveTextContent('Enter a system name.');
  });

  it('keeps a caller aria-describedby alongside the error', () => {
    render(
      <>
        <p id="hint">Shown on the SSP cover.</p>
        <TextField label="System name" error="Required." aria-describedby="hint" />
      </>,
    );
    const input = screen.getByRole('textbox', { name: 'System name' });
    expect(input).toHaveAccessibleDescription('Shown on the SSP cover. Required.');
  });

  it('gives two fields distinct ids', () => {
    render(
      <>
        <TextField label="First" error="Bad first" />
        <TextField label="Second" error="Bad second" />
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'First' })).toHaveAccessibleDescription('Bad first');
    expect(screen.getByRole('textbox', { name: 'Second' })).toHaveAccessibleDescription(
      'Bad second',
    );
  });

  it('passes typing through to the input', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TextField label="Owner" onChange={onChange} />);
    await user.type(screen.getByRole('textbox', { name: 'Owner' }), 'Ada');
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('textbox', { name: 'Owner' })).toHaveValue('Ada');
  });
});

describe('StatusChip', () => {
  const cases = [
    { status: 'met', gauge: 'GO', word: 'Met' },
    { status: 'not_met', gauge: 'NO GO', word: 'Not Met' },
    { status: 'na', gauge: '—', word: 'N/A' },
    { status: 'not_assessed', gauge: '—', word: 'Not Assessed' },
  ] as const;

  it.each(cases)('renders $gauge and "$word" for $status', ({ status, gauge, word }) => {
    const { container } = render(<StatusChip status={status} />);
    const chip = container.querySelector(`[data-status="${status}"]`);
    expect(chip).not.toBeNull();
    const scope = within(chip as HTMLElement);
    expect(scope.getByText(gauge, { exact: true })).toBeInTheDocument();
    expect(scope.getByText(word, { exact: true })).toBeInTheDocument();
    expect(chip).toHaveTextContent(`${gauge}${word}`);
  });
});

describe('GraduatedBar', () => {
  const now = (label: string) =>
    screen.getByRole('progressbar', { name: label }).getAttribute('aria-valuenow');

  it('exposes the value as a 0–100 progressbar', () => {
    render(<GraduatedBar value={72} label="Objectives assessed" />);
    const bar = screen.getByRole('progressbar', { name: 'Objectives assessed' });
    expect(bar).toHaveAttribute('aria-valuenow', '72');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('clamps out-of-range and non-finite values', () => {
    render(
      <>
        <GraduatedBar value={-5} label="low" />
        <GraduatedBar value={150} label="high" />
        <GraduatedBar value={Number.NaN} label="nan" />
        <GraduatedBar value={Number.POSITIVE_INFINITY} label="inf" />
        <GraduatedBar value={0} label="zero" />
        <GraduatedBar value={100} label="full" />
      </>,
    );
    expect(now('low')).toBe('0');
    expect(now('high')).toBe('100');
    expect(now('nan')).toBe('0');
    expect(now('inf')).toBe('100');
    expect(now('zero')).toBe('0');
    expect(now('full')).toBe('100');
  });

  it('draws a tick every 10%', () => {
    render(<GraduatedBar value={40} label="ticks" />);
    const bar = screen.getByRole('progressbar', { name: 'ticks' });
    expect(bar.querySelectorAll('[data-tick]')).toHaveLength(11);
  });
});

describe('SectionLabel', () => {
  it('renders the balloon number and the text', () => {
    render(<SectionLabel number={2}>Objective status</SectionLabel>);
    const balloon = document.querySelector('[data-balloon]');
    expect(balloon).toHaveTextContent('2');
    expect(screen.getByText('Objective status')).toBeInTheDocument();
  });

  it.each([0, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws RangeError for %s',
    (number) => {
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(() => render(<SectionLabel number={number}>Bad</SectionLabel>)).toThrow(RangeError);
      } finally {
        quiet.mockRestore();
      }
    },
  );
});
