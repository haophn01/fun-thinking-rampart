import type { ObjectiveStatus } from '@rampart/rules';
import { Button } from './Button';
import { BODY_TEXT_PAIRS, contrastRatio, LARGE_TEXT_PAIRS, type TextPair } from './contrast';
import { GraduatedBar } from './GraduatedBar';
import { SectionLabel } from './SectionLabel';
import { StatusChip } from './StatusChip';
import styles from './Specimen.module.css';
import { TextField } from './TextField';
import { COLORS, colorVar, FONT_FAMILIES, TEXT_SIZES_PX, type ColorToken } from './tokens';

const STATUSES: readonly ObjectiveStatus[] = ['met', 'not_met', 'na', 'not_assessed'];
const BARS = [
  { value: 0, label: '0' },
  { value: 35, label: '35' },
  { value: 72, label: '72' },
  { value: 100, label: '100' },
  { value: 150, label: '150 (clamped)' },
  { value: Number.NaN, label: 'NaN (shown as 0)' },
];

const TEXT_CLASS: Record<keyof typeof TEXT_SIZES_PX, string | undefined> = {
  'display-1': styles.display1,
  'display-2': styles.display2,
  'display-3': styles.display3,
  'body-lg': styles.bodyLg,
  body: styles.body,
  label: styles.labelText,
  mono: styles.mono,
};

function pairRow(pair: TextPair) {
  return (
    <tr key={`${pair.fg}-${pair.bg}`}>
      <td>
        <span
          className={styles.pairSample}
          style={{ color: colorVar(pair.fg), background: colorVar(pair.bg) }}
        >
          {pair.fg} on {pair.bg}
        </span>
      </td>
      <td className={styles.num}>{contrastRatio(COLORS[pair.fg], COLORS[pair.bg]).toFixed(2)}</td>
    </tr>
  );
}

function Controls() {
  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <Button variant="primary">Start assessment</Button>
        <Button>Export SSP</Button>
        <Button variant="primary" disabled>
          Disabled primary
        </Button>
        <Button disabled>Disabled</Button>
      </div>
      <div className={styles.fields}>
        <TextField label="System name" placeholder="e.g. Engineering enclave" />
        <TextField label="Owner" defaultValue="Ada Lovelace" />
        <TextField
          label="Asset count"
          defaultValue="-3"
          error="Enter a whole number of 0 or more."
        />
        <TextField label="Organization ID" defaultValue="ORG-0001" disabled />
      </div>
      <div className={styles.row}>
        {STATUSES.map((status) => (
          <StatusChip key={status} status={status} />
        ))}
      </div>
      <div className={styles.bars}>
        {BARS.map((bar) => (
          <div key={bar.label} className={styles.barRow}>
            <span className={styles.mono}>{bar.label}</span>
            <GraduatedBar value={bar.value} label={`Bar at ${bar.label}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Dev-only specimen of every look token and control state, served at /look.html. */
export function Specimen() {
  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.display2}>Look specimen</h1>
        <p className={styles.muted}>C · Inspection. Dev only, not in the build.</p>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <SectionLabel number={1}>Palette</SectionLabel>
        </h2>
        <div className={styles.swatches}>
          {(Object.keys(COLORS) as ColorToken[]).map((token) => (
            <figure key={token} className={styles.swatch}>
              <div className={styles.chipColour} style={{ background: colorVar(token) }} />
              <figcaption className={styles.mono}>
                --rp-{token}
                <span className={styles.muted}>{COLORS[token]}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <SectionLabel number={2}>Type scale</SectionLabel>
        </h2>
        <div className={styles.types}>
          {(Object.keys(TEXT_SIZES_PX) as (keyof typeof TEXT_SIZES_PX)[]).map((token) => (
            <div key={token} className={styles.typeRow}>
              <span className={TEXT_CLASS[token]}>
                {token.startsWith('display') ? 'SPRS 72' : 'Readiness, measured like a part.'}
              </span>
              <span className={styles.meta}>
                --rp-text-{token} · {TEXT_SIZES_PX[token]} px
              </span>
            </div>
          ))}
          <p className={styles.meta}>Display: {FONT_FAMILIES.display}</p>
          <p className={styles.meta}>Body: {FONT_FAMILIES.body}</p>
          <p className={styles.meta}>Mono: {FONT_FAMILIES.mono}</p>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <SectionLabel number={3}>Controls on Vellum</SectionLabel>
        </h2>
        <Controls />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <SectionLabel number={4}>Controls on Sheet</SectionLabel>
        </h2>
        <div className={styles.sheet}>
          <Controls />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <SectionLabel number={5}>Section labels</SectionLabel>
        </h2>
        <div className={styles.stack}>
          <SectionLabel number={1}>SPRS score</SectionLabel>
          <SectionLabel number={2}>Conditional check</SectionLabel>
          <SectionLabel number={12}>Needs attention</SectionLabel>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <SectionLabel number={6}>Text pairs</SectionLabel>
        </h2>
        <table className={styles.pairs}>
          <caption className={styles.meta}>Body size, 4.5:1 or better</caption>
          <tbody>{BODY_TEXT_PAIRS.map(pairRow)}</tbody>
        </table>
        <table className={styles.pairs}>
          <caption className={styles.meta}>Large text only (24 px+), 3:1 or better</caption>
          <tbody>{LARGE_TEXT_PAIRS.map(pairRow)}</tbody>
        </table>
      </section>
    </main>
  );
}
