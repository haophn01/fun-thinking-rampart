import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` is solid Signal Red for the one main action; `secondary` (default) is Ink-bordered. */
  variant?: ButtonVariant;
}

/** Square button, at least 44 px tall. `type="button"` unless told otherwise, so it never submits a form by accident. */
export function Button({
  variant = 'secondary',
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      data-variant={variant}
      className={[styles.button, styles[variant], className].filter(Boolean).join(' ')}
    />
  );
}
