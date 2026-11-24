import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './index';

describe('Checkbox', () => {
  it('is labelled by its text and described by its description', () => {
    render(
      <Checkbox
        label="Contains CUI"
        description="Files are refused; store a reference to where it lives instead."
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'Contains CUI' });
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription(
      'Files are refused; store a reference to where it lives instead.',
    );
  });

  it('has no description without one, and keeps a caller description', () => {
    const { unmount } = render(<Checkbox label="Plain" />);
    expect(screen.getByRole('checkbox', { name: 'Plain' })).not.toHaveAttribute('aria-describedby');
    unmount();
    render(
      <>
        <p id="hint">Shown on the export.</p>
        <Checkbox label="Flagged" description="Marked for review." aria-describedby="hint" />
      </>,
    );
    expect(screen.getByRole('checkbox', { name: 'Flagged' })).toHaveAccessibleDescription(
      'Shown on the export. Marked for review.',
    );
  });

  it('toggles on a click and calls onChange once each time', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Contains CUI" onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Contains CUI' });

    await user.click(box);
    expect(box).toBeChecked();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);

    await user.click(box);
    expect(box).not.toBeChecked();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('toggles on a click of its label text', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Contains CUI" onChange={onChange} />);
    await user.click(screen.getByText('Contains CUI'));
    expect(screen.getByRole('checkbox', { name: 'Contains CUI' })).toBeChecked();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('toggles on Space and calls onChange once', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Contains CUI" onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Contains CUI' });

    await user.tab();
    expect(box).toHaveFocus();
    await user.keyboard(' ');
    expect(box).toBeChecked();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('follows a controlled value', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [checked, setChecked] = useState(true);
      return <Checkbox label="Contains CUI" checked={checked} onChange={setChecked} />;
    }
    render(<Controlled />);
    const box = screen.getByRole('checkbox', { name: 'Contains CUI' });
    expect(box).toBeChecked();
    await user.click(box);
    expect(box).not.toBeChecked();
  });

  it('ignores a click and Space when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Contains CUI" disabled defaultChecked onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Contains CUI' });
    expect(box).toBeDisabled();

    await user.click(box);
    await user.click(screen.getByText('Contains CUI'));
    box.focus();
    await user.keyboard(' ');
    expect(box).toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('gives two checkboxes distinct ids', () => {
    render(
      <>
        <Checkbox label="First" description="One" />
        <Checkbox label="Second" description="Two" />
      </>,
    );
    expect(screen.getByRole('checkbox', { name: 'First' })).toHaveAccessibleDescription('One');
    expect(screen.getByRole('checkbox', { name: 'Second' })).toHaveAccessibleDescription('Two');
  });
});
