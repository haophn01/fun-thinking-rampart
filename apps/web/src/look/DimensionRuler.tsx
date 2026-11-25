import type { CSSProperties } from 'react';
import styles from './DimensionRuler.module.css';

const MINUS = '−';
const TICK_STEP = 25;
const MAJOR_STEP = 100;
/** Interior scale labels, drawn when they fall strictly inside the scale. */
const INTERIOR_LABELS = [-100, 0];

/** A whole number as the look writes it: negatives with U+2212, never a hyphen. */
export function formatMeasure(value: number): string {
  return value < 0 ? `${MINUS}${String(Math.abs(value))}` : String(value);
}

/**
 * Where `value` sits on a `floor`–`max` scale, as a percent clamped to 0–100. NaN reads as the
 * floor. Throws a RangeError unless `floor < max`.
 */
export function rulerPercent(value: number, floor: number, max: number): number {
  if (!(floor < max)) {
    throw new RangeError(
      `Ruler floor must be below its max, got ${String(floor)} and ${String(max)}`,
    );
  }
  if (Number.isNaN(value)) return 0;
  const percent = ((value - floor) / (max - floor)) * 100;
  return Math.min(100, Math.max(0, percent));
}

/** Multiples of `step` from floor to max, inclusive. */
function multiples(step: number, floor: number, max: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(floor / step) * step; v <= max; v += step) out.push(v === 0 ? 0 : v);
  return out;
}

/** How a label hangs off its point, so it stays inside the ruler at either end. */
type Anchor = 'start' | 'middle' | 'end';

function at(percent: number): CSSProperties {
  return { left: `${String(percent)}%` };
}

function rulerLabel(value: number | null, floor: number, max: number, threshold: number): string {
  const scale = `on a scale from ${formatMeasure(floor)} to ${formatMeasure(max)}. Conditional line at ${formatMeasure(threshold)}.`;
  if (value === null) return `No SPRS score yet ${scale}`;
  const short = threshold - value;
  const verdict =
    short > 0
      ? `${String(short)} ${short === 1 ? 'point' : 'points'} short.`
      : 'At or above the Conditional line.';
  return `SPRS ${formatMeasure(value)} ${scale} ${verdict}`;
}

export interface DimensionRulerProps {
  /** The SPRS score, or null when there is none yet (no marker, no gap). */
  value: number | null;
  /** The scale's low end: the evaluation's `score.floor`. */
  floor: number;
  /** The scale's high end: the evaluation's `score.max`. */
  max: number;
  /** The Conditional line: `REGULATION.conditionalMinScore.value`. */
  threshold: number;
}

/**
 * C's dimension-line ruler: an Ink scale from floor to max, a Red Conditional line, a Blue
 * "YOU" marker, and a dashed Blue dimension for the gap to the line. Every label is HTML text
 * at 16 px or more, so nothing shrinks on a phone.
 */
export function DimensionRuler({ value, floor, max, threshold }: DimensionRulerProps) {
  const place = (v: number) => rulerPercent(v, floor, max);
  const ticks = multiples(TICK_STEP, floor, max);
  const scaleLabels: { value: number; anchor: Anchor }[] = [
    { value: floor, anchor: 'start' },
    ...INTERIOR_LABELS.filter((v) => v > floor && v < max).map((v) => ({
      value: v,
      anchor: 'middle' as const,
    })),
    { value: max, anchor: 'end' },
  ];
  const line = place(threshold);
  const marker = value === null ? null : place(value);
  const gap = value !== null && value < threshold ? threshold - value : null;
  // Labels hang away from the nearer end; the gap label sits left of the marker unless that
  // would run off the ruler, then right of the line.
  const side = (percent: number): Anchor => (percent > 50 ? 'end' : 'start');

  return (
    <div className={styles.ruler} role="img" aria-label={rulerLabel(value, floor, max, threshold)}>
      <div className={styles.row}>
        {scaleLabels.map((label) => (
          <span
            key={label.value}
            className={styles.scaleLabel}
            data-scale-label
            data-anchor={label.anchor}
            style={at(place(label.value))}
          >
            {formatMeasure(label.value)}
          </span>
        ))}
      </div>
      <div className={styles.row}>
        <span className={styles.thresholdLabel} data-anchor={side(line)} style={at(line)}>
          {formatMeasure(threshold)} CONDITIONAL
        </span>
      </div>
      <div className={styles.scale}>
        {ticks.map((tick) => (
          <span
            key={tick}
            className={styles.tick}
            data-tick={tick}
            data-major={tick % MAJOR_STEP === 0}
            style={at(place(tick))}
          />
        ))}
      </div>
      <div className={styles.markerRow}>
        {marker !== null && (
          <span className={styles.marker} data-part="marker" style={at(marker)} />
        )}
      </div>
      <div className={styles.row}>
        {marker !== null && value !== null && (
          <span className={styles.youLabel} data-anchor={side(marker)} style={at(marker)}>
            YOU {formatMeasure(value)}
          </span>
        )}
      </div>
      {gap !== null && marker !== null && (
        <div className={styles.row}>
          <span
            className={styles.gap}
            data-part="gap"
            style={{ ...at(marker), width: `${String(line - marker)}%` }}
          />
          <span
            className={styles.gapLabel}
            data-anchor={marker >= 15 ? 'end' : 'start'}
            style={at(marker >= 15 ? marker : line)}
          >
            +{String(gap)}
          </span>
        </div>
      )}
      <span className={styles.threshold} data-part="threshold" style={at(line)} />
    </div>
  );
}
