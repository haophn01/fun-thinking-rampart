import type { ReactNode } from 'react';
import styles from './SectionLabel.module.css';

export interface SectionLabelProps {
  /** The ballooned characteristic number: an integer of 1 or more. */
  number: number;
  children: ReactNode;
}

/** A section label with a ballooned characteristic number, as on an inspected drawing. */
export function SectionLabel({ number, children }: SectionLabelProps) {
  if (!Number.isInteger(number) || number < 1) {
    throw new RangeError(
      `SectionLabel number must be an integer of 1 or more, got ${String(number)}`,
    );
  }
  return (
    <span className={styles.label}>
      <span className={styles.balloon} data-balloon={number}>
        {number}
      </span>
      <span>{children}</span>
    </span>
  );
}
