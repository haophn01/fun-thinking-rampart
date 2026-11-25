import styles from './InspectionStrip.module.css';

export interface InspectionEntry {
  label: string;
  value: string;
}

export interface InspectionStripProps {
  entries: readonly InspectionEntry[];
}

/** The inspection-report strip: label over value, 6 columns on desktop and 2 on phones. */
export function InspectionStrip({ entries }: InspectionStripProps) {
  return (
    <dl className={styles.strip}>
      {entries.map((entry) => (
        <div key={entry.label} className={styles.entry}>
          <dt className={styles.label}>{entry.label}</dt>
          <dd className={styles.value}>{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}
