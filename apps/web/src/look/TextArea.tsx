import { useId, useState, type ChangeEvent, type ComponentPropsWithRef } from 'react';
import styles from './TextArea.module.css';

export interface TextAreaProps extends Omit<ComponentPropsWithRef<'textarea'>, 'children'> {
  label: string;
  /** When set, the field is invalid: a red underline mark, with this message in Ink. */
  error?: string | undefined;
}

function lengthOf(value: TextAreaProps['value']): number {
  if (value === undefined) return 0;
  return Array.isArray(value) ? value.join(',').length : String(value).length;
}

/**
 * Labelled, underline-only multi-line input. With `maxLength`, a mono `n / max` counter sits
 * under it; the browser stops input at the limit, and a longer value passed in is counted as is.
 */
export function TextArea({
  label,
  error,
  id,
  className,
  maxLength,
  value,
  defaultValue,
  onChange,
  rows = 4,
  'aria-describedby': describedBy,
  ...rest
}: TextAreaProps) {
  const autoId = useId();
  const areaId = id ?? `${autoId}-textarea`;
  const errorId = `${areaId}-error`;
  const counterId = `${areaId}-counter`;
  const invalid = error !== undefined && error !== '';
  const max = maxLength !== undefined && maxLength >= 0 ? maxLength : undefined;
  const [typedLength, setTypedLength] = useState(() => lengthOf(defaultValue));
  const length = value === undefined ? typedLength : lengthOf(value);
  const describers = [
    describedBy,
    max !== undefined ? counterId : undefined,
    invalid ? errorId : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setTypedLength(event.target.value.length);
    onChange?.(event);
  }

  return (
    <div
      className={[styles.field, className].filter(Boolean).join(' ')}
      data-invalid={invalid || undefined}
    >
      <label className={styles.label} htmlFor={areaId}>
        {label}
      </label>
      <textarea
        {...rest}
        {...(value === undefined ? { defaultValue } : { value })}
        id={areaId}
        rows={rows}
        maxLength={max}
        onChange={handleChange}
        className={styles.input}
        aria-invalid={invalid || undefined}
        aria-describedby={describers || undefined}
      />
      {max !== undefined && (
        <p id={counterId} className={styles.counter} data-full={length >= max || undefined}>
          {length} / {max}
        </p>
      )}
      {invalid && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
