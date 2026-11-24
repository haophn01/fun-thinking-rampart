import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox, FileField } from './index';

function pdf(name = 'firewall-config.pdf') {
  return new File(['%PDF-1.7'], name, { type: 'application/pdf' });
}

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

describe('FileField', () => {
  it('shows "No file chosen", then the chosen name, and calls onFileChange with the file', async () => {
    const user = userEvent.setup();
    const onFileChange = vi.fn();
    render(<FileField label="Evidence file" onFileChange={onFileChange} />);
    const input = screen.getByLabelText('Evidence file');
    expect(input).toHaveAttribute('type', 'file');
    expect(screen.getByText('No file chosen')).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription('No file chosen');

    const file = pdf();
    await user.upload(input, file);
    expect(onFileChange).toHaveBeenCalledExactlyOnceWith(file);
    expect(screen.getByText('firewall-config.pdf')).toBeInTheDocument();
    expect(screen.queryByText('No file chosen')).not.toBeInTheDocument();
    expect(input).toHaveAccessibleDescription('firewall-config.pdf');
  });

  it('shows a square "Choose file" face', () => {
    render(<FileField label="Evidence file" onFileChange={vi.fn()} />);
    expect(screen.getByText('Choose file')).toBeInTheDocument();
  });

  it('passes accept through to the native input', () => {
    render(<FileField label="Policy file" accept=".pdf,.docx" onFileChange={vi.fn()} />);
    expect(screen.getByLabelText('Policy file')).toHaveAttribute('accept', '.pdf,.docx');
  });

  it('is valid without an error', () => {
    render(<FileField label="Evidence file" onFileChange={vi.fn()} />);
    expect(screen.getByLabelText('Evidence file')).not.toHaveAttribute('aria-invalid');
  });

  it('marks itself invalid and describes itself with the error', () => {
    render(
      <FileField
        label="Evidence file"
        error="Files over 25 MiB are refused."
        onFileChange={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('Evidence file');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Files over 25 MiB are refused.')).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription('No file chosen Files over 25 MiB are refused.');
  });

  it('fires twice when the same file is chosen twice', async () => {
    const user = userEvent.setup();
    const onFileChange = vi.fn();
    render(<FileField label="Evidence file" onFileChange={onFileChange} />);
    const input = screen.getByLabelText('Evidence file');
    const file = pdf();

    await user.upload(input, file);
    expect(input).toHaveValue('');
    await user.upload(input, file);
    expect(onFileChange).toHaveBeenCalledTimes(2);
    expect(onFileChange).toHaveBeenNthCalledWith(2, file);
    expect(screen.getByText('firewall-config.pdf')).toBeInTheDocument();
  });

  it('shows the newest name after a second, different choice', async () => {
    const user = userEvent.setup();
    render(<FileField label="Evidence file" onFileChange={vi.fn()} />);
    const input = screen.getByLabelText('Evidence file');
    await user.upload(input, pdf('first.pdf'));
    await user.upload(input, pdf('second.pdf'));
    expect(screen.getByText('second.pdf')).toBeInTheDocument();
    expect(screen.queryByText('first.pdf')).not.toBeInTheDocument();
  });

  it('calls onFileChange with null and forgets the name when a change brings no file', async () => {
    const user = userEvent.setup();
    const onFileChange = vi.fn();
    render(<FileField label="Evidence file" onFileChange={onFileChange} />);
    const input = screen.getByLabelText('Evidence file');
    await user.upload(input, pdf());

    fireEvent.change(input, { target: { files: [] } });
    expect(onFileChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByText('No file chosen')).toBeInTheDocument();
  });

  it('ignores a choice when disabled', async () => {
    const user = userEvent.setup();
    const onFileChange = vi.fn();
    render(<FileField label="Evidence file" disabled onFileChange={onFileChange} />);
    const input = screen.getByLabelText('Evidence file');
    expect(input).toBeDisabled();
    await user.upload(input, pdf());
    expect(onFileChange).not.toHaveBeenCalled();
    expect(screen.getByText('No file chosen')).toBeInTheDocument();
  });

  it('forgets the chosen name when reset changes, without calling onFileChange', async () => {
    const user = userEvent.setup();
    const onFileChange = vi.fn();
    const { rerender } = render(
      <FileField label="Evidence file" reset={0} onFileChange={onFileChange} />,
    );
    await user.upload(screen.getByLabelText('Evidence file'), pdf());
    expect(screen.getByText('firewall-config.pdf')).toBeInTheDocument();

    rerender(<FileField label="Evidence file" reset={0} onFileChange={onFileChange} />);
    expect(screen.getByText('firewall-config.pdf')).toBeInTheDocument();

    rerender(<FileField label="Evidence file" reset={1} onFileChange={onFileChange} />);
    expect(screen.getByText('No file chosen')).toBeInTheDocument();
    expect(onFileChange).toHaveBeenCalledTimes(1);
  });

  it('gives two fields distinct ids', () => {
    render(
      <>
        <FileField label="First" error="Bad first" onFileChange={vi.fn()} />
        <FileField label="Second" error="Bad second" onFileChange={vi.fn()} />
      </>,
    );
    expect(screen.getByLabelText('First')).toHaveAccessibleDescription('No file chosen Bad first');
    expect(screen.getByLabelText('Second')).toHaveAccessibleDescription(
      'No file chosen Bad second',
    );
  });
});
