import styles from './InspectionStamp.module.css';

export type StampVerdict = 'accept' | 'hold';

const WORD: Record<StampVerdict, string> = { accept: 'ACCEPT', hold: 'HOLD' };

export interface InspectionStampProps {
  verdict: StampVerdict;
  /** The line under the verdict, such as `2 BLOCKERS` or `CONDITIONAL`. */
  detail: string;
}

/** A rotated Red-ink inspector's stamp on Sheet: HOLD or ACCEPT, with a detail line. */
export function InspectionStamp({ verdict, detail }: InspectionStampProps) {
  const word = WORD[verdict];
  return (
    <div
      className={styles.stamp}
      role="img"
      aria-label={`Inspector's stamp: ${word}`}
      data-variant={verdict}
    >
      <span className={styles.word}>{word}</span>
      <span className={styles.detail}>{detail}</span>
    </div>
  );
}
