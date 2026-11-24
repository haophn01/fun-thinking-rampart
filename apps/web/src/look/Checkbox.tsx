import { useId, type ComponentPropsWithRef } from 'react';
import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<
  ComponentPropsWithRef<'input'>,
  'type' | 'onChange' | 'children'
> {
  label: string;
  /** A line under the label, in Graphite, linked by `aria-describedby`. */
  description?: string | undefined;
  /** Called with the new checked state, once per toggle. */
  onChange?: ((checked: boolean) => void) | undefined;
}

/**
 * A native checkbox, shown as a square box with a 1.5 px Ink border that fills Ink with a Sheet
 * mark when checked. The input is only visually hidden, so Space, Tab, clicks on the label and
 * screen readers work the way the browser makes them work. Pass `checked` to control it, or
 * `defaultChecked` to leave it to the browser.
 */
export function Checkbox({
  label,
  description,
  onChange,
  id,
  className,
  'aria-describedby': describedBy,
  ...rest
}: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-checkbox`;
  const descriptionId = `${inputId}-description`;
  const hasDescription = description !== undefined && description !== '';
  const describers = [describedBy, hasDescription ? descriptionId : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')}>
      <label className={styles.option} htmlFor={inputId}>
        <input
          {...rest}
          id={inputId}
          type="checkbox"
          className={styles.input}
          aria-describedby={describers || undefined}
          onChange={(event) => onChange?.(event.target.checked)}
        />
        <span className={styles.box} aria-hidden="true" />
        <span className={styles.text}>{label}</span>
      </label>
      {hasDescription && (
        <p id={descriptionId} className={styles.description}>
          {description}
        </p>
      )}
    </div>
  );
}
