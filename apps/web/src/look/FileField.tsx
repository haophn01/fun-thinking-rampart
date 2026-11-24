import { useId, useState, type ChangeEvent } from 'react';
import styles from './FileField.module.css';

export interface FileFieldProps {
  label: string;
  /** Passed to the native input, e.g. `.pdf,.docx`. The browser's picker filters by it. */
  accept?: string | undefined;
  /** When set, the field is invalid: a red mark, with this message in Ink. */
  error?: string | undefined;
  disabled?: boolean | undefined;
  /** Called once per choice with the chosen file, or `null` when a change brings none. */
  onFileChange: (file: File | null) => void;
  /**
   * Any value; when it changes, the field forgets the chosen name and shows "No file chosen"
   * again, without calling `onFileChange`. Bump it after an upload succeeds.
   */
  reset?: unknown;
  id?: string | undefined;
  name?: string | undefined;
  className?: string | undefined;
}

/**
 * A label, a square "Choose file" face over a visually hidden native file input, and the chosen
 * name in mono. The input clears itself after each choice, so picking the same file again fires
 * again; the name shown is the field's own record of the last choice.
 */
export function FileField({
  label,
  accept,
  error,
  disabled,
  onFileChange,
  reset,
  id,
  name,
  className,
}: FileFieldProps) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-file`;
  const labelId = `${inputId}-label`;
  const chosenId = `${inputId}-chosen`;
  const errorId = `${inputId}-error`;
  const invalid = error !== undefined && error !== '';
  const [chosen, setChosen] = useState<string | null>(null);
  const [seenReset, setSeenReset] = useState(reset);

  // A new `reset` clears the shown name during render, so the stale name never paints.
  if (!Object.is(seenReset, reset)) {
    setSeenReset(reset);
    setChosen(null);
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setChosen(file?.name ?? null);
    event.target.value = '';
    onFileChange(file);
  }

  return (
    <div
      className={[styles.field, className].filter(Boolean).join(' ')}
      data-invalid={invalid || undefined}
      data-disabled={disabled || undefined}
    >
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      <div className={styles.row}>
        <label className={styles.picker}>
          <input
            id={inputId}
            name={name}
            type="file"
            className={styles.input}
            accept={accept}
            disabled={disabled}
            aria-labelledby={labelId}
            aria-describedby={[chosenId, invalid ? errorId : undefined].filter(Boolean).join(' ')}
            aria-invalid={invalid || undefined}
            onChange={handleChange}
          />
          <span className={styles.face} aria-hidden="true">
            Choose file
          </span>
        </label>
        <span id={chosenId} className={styles.chosen} data-empty={chosen === null || undefined}>
          {chosen ?? 'No file chosen'}
        </span>
      </div>
      {invalid && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
