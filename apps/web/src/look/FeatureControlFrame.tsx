import { formatMeasure } from './DimensionRuler';
import styles from './FeatureControlFrame.module.css';

export type ToleranceStatus = 'in_tol' | 'out_of_tol' | 'no_reading';

const RESULT: Record<ToleranceStatus, string> = {
  in_tol: 'IN TOL',
  out_of_tol: 'OUT OF TOL',
  no_reading: 'NO READING',
};

/** IN TOL when `lsl ≤ measured ≤ usl`, OUT OF TOL otherwise, NO READING with no measurement. */
export function toleranceStatus(
  measured: number | null,
  lsl: number,
  usl: number,
): ToleranceStatus {
  if (measured === null) return 'no_reading';
  return measured >= lsl && measured <= usl ? 'in_tol' : 'out_of_tol';
}

export interface FeatureControlFrameProps {
  /** The SPRS score, or null when there is none yet. */
  measured: number | null;
  /** Lower spec limit: the Conditional minimum. */
  lsl: number;
  /** Upper spec limit: the score's max. */
  usl: number;
}

/** A GD&T-style feature control frame: `SPRS | MEAS n | LSL n | USL n | <result>`. */
export function FeatureControlFrame({ measured, lsl, usl }: FeatureControlFrameProps) {
  const status = toleranceStatus(measured, lsl, usl);
  return (
    <div className={styles.frame} data-status={status}>
      <span className={styles.cell}>SPRS</span>
      <span className={styles.cell}>MEAS {measured === null ? '—' : formatMeasure(measured)}</span>
      <span className={styles.cell}>LSL {formatMeasure(lsl)}</span>
      <span className={styles.cell}>USL {formatMeasure(usl)}</span>
      <span className={styles.result}>{RESULT[status]}</span>
    </div>
  );
}
