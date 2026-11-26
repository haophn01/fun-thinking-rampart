import { useId, type ReactNode } from 'react';
import { Alert, Button, SectionLabel } from '../../../look';
import styles from './kit.module.css';

/** One numbered section of a tab: a ruled region named by its ballooned label. */
export function Section({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionHead}>
        <SectionLabel number={number}>{title}</SectionLabel>
      </h2>
      {children}
    </section>
  );
}

/** A section's failed load, with a Retry for that section only. */
export function LoadError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <Alert tone="error" title={title}>
      <p>Check that the API is running, then retry.</p>
      <Button className={styles.retry} onClick={onRetry}>
        Retry
      </Button>
    </Alert>
  );
}
