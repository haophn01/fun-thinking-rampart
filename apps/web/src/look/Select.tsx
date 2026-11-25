import { useId, type ComponentPropsWithRef } from 'react';
import styles from './Select.module.css';

export interface SelectProps extends ComponentPropsWithRef<'select'> {
  label: string;
  /** When set, the field is invalid: a red underline mark, with this message in Ink. */
  error?: string | undefined;
}

/** Labelled, underline-only native select with an Ink chevron. Pass `<option>`s as children. */
export function Select({
  label,
  error,
  id,
  className,
  children,
  'aria-describedby': describedBy,
  ...rest
}: SelectProps) {
  const autoId = useId();
  const selectId = id ?? `${autoId}-select`;
  const errorId = `${selectId}-error`;
  const invalid = error !== undefined && error !== '';
  const describers = [describedBy, invalid ? errorId : undefined].filter(Boolean).join(' ');

  return (
    <div
      className={[styles.field, className].filter(Boolean).join(' ')}
      data-invalid={invalid || undefined}
    >
      <label className={styles.label} htmlFor={selectId}>
        {label}
      </label>
      <div className={styles.control}>
        <select
          {...rest}
          id={selectId}
          className={styles.select}
          aria-invalid={invalid || undefined}
          aria-describedby={describers || undefined}
        >
          {children}
        </select>
      </div>
      {invalid && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
