import type { ObjectiveStatus } from '@rampart/rules';
import styles from './StatusChip.module.css';

const GAUGE: Record<ObjectiveStatus, { gauge: string; word: string }> = {
  met: { gauge: 'GO', word: 'Met' },
  not_met: { gauge: 'NO GO', word: 'Not Met' },
  na: { gauge: '—', word: 'N/A' },
  not_assessed: { gauge: '—', word: 'Not Assessed' },
};

export interface StatusChipProps {
  status: ObjectiveStatus;
}

/** A GO / NO GO gauge: the gauge block, then the status word. The word carries the meaning; the block is decoration. */
export function StatusChip({ status }: StatusChipProps) {
  const { gauge, word } = GAUGE[status];
  return (
    <span className={styles.chip} data-status={status}>
      <span className={styles.gauge} aria-hidden="true">
        {gauge}
      </span>
      <span className={styles.word}>{word}</span>
    </span>
  );
}
