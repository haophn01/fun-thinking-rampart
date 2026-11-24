import { useId, type InputHTMLAttributes } from 'react';
import styles from './TextField.module.css';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'children'> {
  label: string;
  /** When set, the field is invalid: a red underline mark, with this message in Ink. */
  error?: string | undefined;
}

/** Labelled, underline-only text input. */
export function TextField({
  label,
  error,
  id,
  className,
  type = 'text',
  'aria-describedby': describedBy,
  ...rest
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const errorId = `${inputId}-error`;
  const invalid = error !== undefined && error !== '';
  const describers = [describedBy, invalid ? errorId : undefined].filter(Boolean).join(' ');

  return (
    <div
      className={[styles.field, className].filter(Boolean).join(' ')}
      data-invalid={invalid || undefined}
    >
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <input
        {...rest}
        id={inputId}
        type={type}
        className={styles.input}
        aria-invalid={invalid || undefined}
        aria-describedby={describers || undefined}
      />
      {invalid && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
