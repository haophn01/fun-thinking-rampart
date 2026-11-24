import styles from './GraduatedBar.module.css';

/** Clamps to 0–100; NaN reads as 0. */
export function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

const TICKS = Array.from({ length: 11 }, (_, i) => i * 10);

export interface GraduatedBarProps {
  /** Percent, 0–100. Out-of-range values are clamped; NaN shows as 0. */
  value: number;
  /** Accessible name of the progressbar. */
  label: string;
}

/** A graduated scale: a Sheet track with an Ink baseline, a tick every 10%, and an Ink travel bar. */
export function GraduatedBar({ value, label }: GraduatedBarProps) {
  const percent = clampPercent(value);
  return (
    <div
      className={styles.bar}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      {TICKS.map((tick) => (
        <span
          key={tick}
          className={styles.tick}
          data-tick={tick}
          style={{ left: `${String(tick)}%` }}
        />
      ))}
      <span className={styles.travel} style={{ width: `${String(percent)}%` }} />
    </div>
  );
}
