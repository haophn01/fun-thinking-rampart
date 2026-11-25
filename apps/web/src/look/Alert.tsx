import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Alert.module.css';

export type AlertTone = 'error' | 'info';

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'role'> {
  /** `error` is announced at once (`role="alert"`, red border); `info` politely (`role="status"`, Ink border). */
  tone: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
}

/** A bordered message on Sheet. The text is Ink in both tones; only the border carries red. */
export function Alert({ tone, title, children, className, ...rest }: AlertProps) {
  return (
    <div
      {...rest}
      role={tone === 'error' ? 'alert' : 'status'}
      data-tone={tone}
      className={[styles.alert, styles[tone], className].filter(Boolean).join(' ')}
    >
      {title !== undefined && <p className={styles.title}>{title}</p>}
      {children !== undefined && <div className={styles.body}>{children}</div>}
    </div>
  );
}
