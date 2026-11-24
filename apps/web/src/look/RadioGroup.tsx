import { useId } from 'react';
import styles from './RadioGroup.module.css';

export interface RadioOption<V extends string = string> {
  value: V;
  label: string;
  /** Exposed as `data-status` on the option, for callers that style or test by status. */
  status?: string | undefined;
}

export interface RadioGroupProps<V extends string = string> {
  legend: string;
  options: readonly RadioOption<V>[];
  /** The selected value; undefined, or anything not in `options`, selects none. */
  value: V | undefined;
  onChange: (value: V) => void;
  disabled?: boolean | undefined;
  /** The radios' shared name; unique by default, so two groups never interfere. */
  name?: string | undefined;
  className?: string | undefined;
}

/**
 * A fieldset of native radios, shown as square segmented buttons. The radios are only visually
 * hidden, so arrow keys, Tab and screen readers work the way the browser makes them work.
 */
export function RadioGroup<V extends string = string>({
  legend,
  options,
  value,
  onChange,
  disabled,
  name,
  className,
}: RadioGroupProps<V>) {
  const autoName = useId();
  const groupName = name ?? autoName;

  return (
    <fieldset
      role="radiogroup"
      className={[styles.group, className].filter(Boolean).join(' ')}
      disabled={disabled}
    >
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.options}>
        {options.map((option) => (
          <label key={option.value} className={styles.option} data-status={option.status}>
            <input
              type="radio"
              className={styles.radio}
              name={groupName}
              value={option.value}
              checked={option.value === value}
              onChange={() => {
                onChange(option.value);
              }}
            />
            <span className={styles.face}>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
