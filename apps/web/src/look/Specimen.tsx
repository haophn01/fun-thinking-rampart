import { catalogKey, loadCatalog } from '@rampart/catalog';
import { scoreFloor, scoreMax, type ObjectiveStatus } from '@rampart/rules';
import { REGULATION } from '@rampart/rules/poam';
import { useState } from 'react';
import { Alert } from './Alert';
import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { DimensionRuler } from './DimensionRuler';
import { FeatureControlFrame } from './FeatureControlFrame';
import { BODY_TEXT_PAIRS, contrastRatio, LARGE_TEXT_PAIRS, type TextPair } from './contrast';
import { FileField } from './FileField';
import { GraduatedBar } from './GraduatedBar';
import { InspectionStamp, type StampVerdict } from './InspectionStamp';
import { InspectionStrip } from './InspectionStrip';
import { RadioGroup, type RadioOption } from './RadioGroup';
import { SectionLabel } from './SectionLabel';
import { Select } from './Select';
import { StatusChip } from './StatusChip';
import styles from './Specimen.module.css';
import { TextArea } from './TextArea';
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

const STATUS_OPTIONS: readonly RadioOption<ObjectiveStatus>[] = [
  { value: 'met', label: 'Met', status: 'met' },
  { value: 'not_met', label: 'Not Met', status: 'not_met' },
  { value: 'na', label: 'N/A', status: 'na' },
  { value: 'not_assessed', label: 'Not Assessed', status: 'not_assessed' },
];
const TYPE_OPTIONS: readonly RadioOption[] = [
  { value: 'self', label: 'Self-assessment' },
  { value: 'c3pao', label: 'C3PAO certification' },
];

// The ruler's scale comes from the catalog's scoring and the Conditional line from REGULATION.
const catalog = loadCatalog();
const SCALE = {
  floor: scoreFloor(catalog),
  max: scoreMax(catalog),
  threshold: REGULATION.conditionalMinScore.value,
};
const READINGS: readonly {
  title: string;
  value: number | null;
  verdict: StampVerdict;
  detail: string;
}[] = [
  { title: 'HOLD at 72', value: 72, verdict: 'hold', detail: '2 BLOCKERS' },
  { title: 'ACCEPT at 107', value: 107, verdict: 'accept', detail: 'CONDITIONAL' },
  { title: 'Incomplete (no SSP)', value: null, verdict: 'hold', detail: '1 BLOCKER' },
];
const STRIP = [
  { label: 'IR', value: 'IR-3F9A0C21' },
  { label: 'Part', value: 'Engineering enclave' },
  { label: 'Spec', value: catalogKey(catalog) },
  {
    label: 'Characteristics',
    value: String(catalog.requirements.flatMap((r) => r.objectives).length),
  },
  { label: 'Inspector', value: 'Ada Lovelace' },
  { label: 'Date', value: '2026-11-24' },
];

function Inspection() {
  return (
    <div className={styles.stack}>
      {READINGS.map((reading) => (
        // Stretch past the stack's start alignment, so the ruler gets the full width.
        <div
          key={reading.title}
          className={[styles.sheet, styles.stack].filter(Boolean).join(' ')}
          style={{ justifySelf: 'stretch' }}
        >
          <p className={styles.meta}>{reading.title}</p>
          <DimensionRuler value={reading.value} {...SCALE} />
          <div className={styles.row}>
            <FeatureControlFrame measured={reading.value} lsl={SCALE.threshold} usl={SCALE.max} />
            <InspectionStamp verdict={reading.verdict} detail={reading.detail} />
          </div>
        </div>
      ))}
      <InspectionStrip entries={STRIP} />
    </div>
  );
}

const TEXT_CLASS: Record<keyof typeof TEXT_SIZES_PX, string | undefined> = {
  'display-1': styles.display1,
  'display-2': styles.display2,
  'display-3': styles.display3,
  'body-lg': styles.bodyLg,
  body: styles.body,
  label: styles.labelText,
  mono: styles.mono,
};

function pairRows(pairs: readonly TextPair[], sampleClass?: string) {
  return pairs.map((pair) => (
    <tr key={`${pair.fg}-${pair.bg}`}>
      <td>
        <span
          className={[styles.pairSample, sampleClass].filter(Boolean).join(' ')}
          style={{ color: colorVar(pair.fg), background: colorVar(pair.bg) }}
        >
          {pair.fg} on {pair.bg}
        </span>
      </td>
      <td className={styles.num}>{contrastRatio(COLORS[pair.fg], COLORS[pair.bg]).toFixed(2)}</td>
    </tr>
  ));
}

function StatusRadio({
  legend,
  initial,
  disabled,
}: {
  legend: string;
  initial?: ObjectiveStatus;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <RadioGroup
      legend={legend}
      options={STATUS_OPTIONS}
      value={value}
      onChange={setValue}
      disabled={disabled}
    />
  );
}

function TypeRadio() {
  const [value, setValue] = useState('self');
  return (
    <RadioGroup legend="Assessment type" options={TYPE_OPTIONS} value={value} onChange={setValue} />
  );
}

/** A FileField that shows what onFileChange last received, with a Reset that bumps `reset`. */
function LiveFileField() {
  const [last, setLast] = useState('nothing yet');
  const [reset, setReset] = useState(0);
  return (
    <div className={styles.stack}>
      <FileField
        label="Evidence file"
        accept=".pdf,.docx,.png,.txt"
        reset={reset}
        onFileChange={(file) => {
          setLast(file ? `${file.name} (${String(file.size)} bytes)` : 'null');
        }}
      />
      <p className={styles.meta}>onFileChange: {last}</p>
      <Button
        onClick={() => {
          setReset((n) => n + 1);
          setLast('reset');
        }}
      >
        Reset
      </Button>
    </div>
  );
}

function FileControls() {
  return (
    <div className={styles.stack}>
      <div className={styles.stack}>
        <Checkbox label="Contains CUI" />
        <Checkbox label="Contains CUI" defaultChecked />
        <Checkbox
          label="Contains CUI"
          description="Files are refused; store a reference to where it lives instead."
        />
        <Checkbox label="Locked, unchecked" disabled />
        <Checkbox label="Locked, checked" defaultChecked disabled />
      </div>
      <div className={styles.fields}>
        <LiveFileField />
        <FileField label="Policy file" accept=".pdf,.docx" onFileChange={() => undefined} />
        <FileField
          label="Policy file"
          error="report.exe isn't an allowed file type."
          onFileChange={() => undefined}
        />
        <FileField label="Locked file" disabled onFileChange={() => undefined} />
      </div>
    </div>
  );
}

function FormControls() {
  return (
    <div className={styles.stack}>
      <div className={styles.fields}>
        <TextArea label="Note" placeholder="What you checked, and where." />
        <TextArea
          label="Implementation statement"
          maxLength={120}
          defaultValue="MFA is enforced for all privileged accounts through the IdP."
        />
        <TextArea
          label="Note at its limit"
          maxLength={24}
          defaultValue="Exactly at the limit now"
        />
        <TextArea
          label="Implementation statement"
          maxLength={120}
          defaultValue=""
          error="Enter an implementation statement."
        />
        <TextArea label="Locked note" defaultValue="Read-only while exported." disabled />
      </div>
      <div className={styles.fields}>
        <Select label="Owner" defaultValue="ada">
          <option value="">Unassigned</option>
          <option value="ada">Ada Lovelace</option>
          <option value="grace">Grace Hopper (inactive)</option>
        </Select>
        <Select label="Assessment type" defaultValue="c3pao">
          <option value="self">Self-assessment</option>
          <option value="c3pao">C3PAO certification, with a long label to show truncation</option>
        </Select>
        <Select label="Level" defaultValue="" error="Choose a level for 3.13.11.">
          <option value="">Not set (worst case)</option>
          <option value="none">Not implemented</option>
        </Select>
        <Select label="Family" defaultValue="AC" disabled>
          <option value="AC">AC · Access Control</option>
        </Select>
      </div>
      <div className={styles.stack}>
        <StatusRadio legend="AC.L2-3.1.1[a] · none selected" />
        <StatusRadio legend="AC.L2-3.1.1[b] · Met" initial="met" />
        <StatusRadio legend="AC.L2-3.1.2[a] · Not Met" initial="not_met" />
        <StatusRadio legend="AC.L2-3.1.3[a] · disabled" initial="na" disabled />
        <TypeRadio />
      </div>
      <FileControls />
      <div className={styles.fields}>
        <Alert tone="error" title="Conditional status not possible">
          Score 72 is below 88.
        </Alert>
        <Alert tone="info" title="SSP exported">
          <span className={styles.mono}>Rampart-SSP-2026-11-23.docx</span>
        </Alert>
        <Alert tone="info">What-if — not saved</Alert>
      </div>
    </div>
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
      <FormControls />
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
        <p className={styles.meta}>Body size, 4.5:1 or better</p>
        <table className={styles.pairs} aria-label="Body text pairs">
          <tbody>{pairRows(BODY_TEXT_PAIRS)}</tbody>
        </table>
        <p className={styles.meta}>Large text only (24 px+), 3:1 or better</p>
        <table className={styles.pairs} aria-label="Large text pairs">
          <tbody>{pairRows(LARGE_TEXT_PAIRS, styles.display3)}</tbody>
        </table>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <SectionLabel number={7}>Inspection</SectionLabel>
        </h2>
        <Inspection />
      </section>
    </main>
  );
}
