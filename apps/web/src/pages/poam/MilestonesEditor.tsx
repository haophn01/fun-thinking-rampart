import { MAX_MILESTONES, calendarDateSchema, type Milestone } from '@rampart/api/contract';
import { Button, TextField } from '../../look';
import styles from './poam.module.css';

export const DATE_ERROR = 'Enter a real date as YYYY-MM-DD.';

/** One milestone as typed: text fields, and a key that stays with the row when others move. */
export interface MilestoneDraft {
  key: string;
  title: string;
  due: string;
  doneOn: string;
}

export interface MilestoneErrors {
  title?: string;
  due?: string;
  doneOn?: string;
}

let keyCounter = 0;
/** A fresh row key. */
export function nextKey(): string {
  keyCounter += 1;
  return `m${String(keyCounter)}`;
}

const isDate = (text: string) => calendarDateSchema.safeParse(text).success;

/** Checks each row; `itemDue` is the item's due date as typed (skipped while it isn't a date). */
export function checkMilestones(
  rows: readonly MilestoneDraft[],
  itemDue: string,
): MilestoneErrors[] {
  return rows.map((row) => {
    const errors: MilestoneErrors = {};
    if (row.title.trim() === '') errors.title = 'Enter a title.';
    const due = row.due.trim();
    if (!isDate(due)) errors.due = DATE_ERROR;
    else if (isDate(itemDue.trim()) && due > itemDue.trim()) {
      errors.due = "This milestone is due after the item's due date.";
    }
    const doneOn = row.doneOn.trim();
    if (doneOn !== '' && !isDate(doneOn)) errors.doneOn = DATE_ERROR;
    return errors;
  });
}

/** The rows as the api takes them. Call only after `checkMilestones` found no errors. */
export function toMilestones(rows: readonly MilestoneDraft[]): Milestone[] {
  return rows.map((row) => ({
    title: row.title.trim(),
    due: row.due.trim(),
    doneOn: row.doneOn.trim() === '' ? null : row.doneOn.trim(),
  }));
}

export interface MilestonesEditorProps {
  rows: readonly MilestoneDraft[];
  errors: readonly MilestoneErrors[];
  disabled: boolean;
  onChange: (rows: MilestoneDraft[]) => void;
}

/** The milestones of an item: add, edit and remove rows, in the order they will be sent. */
export function MilestonesEditor({ rows, errors, disabled, onChange }: MilestonesEditorProps) {
  const set = (index: number, field: 'title' | 'due' | 'doneOn', value: string) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };
  return (
    <fieldset className={styles.milestones} disabled={disabled}>
      <legend className={styles.legend}>Milestones</legend>
      {rows.map((row, index) => (
        <div key={row.key} className={styles.milestoneRow}>
          <TextField
            label={`Milestone ${String(index + 1)} title`}
            value={row.title}
            maxLength={200}
            autoComplete="off"
            error={errors[index]?.title}
            onChange={(event) => {
              set(index, 'title', event.target.value);
            }}
          />
          <TextField
            label={`Milestone ${String(index + 1)} due`}
            placeholder="YYYY-MM-DD"
            value={row.due}
            autoComplete="off"
            error={errors[index]?.due}
            onChange={(event) => {
              set(index, 'due', event.target.value);
            }}
          />
          <TextField
            label={`Milestone ${String(index + 1)} done on (optional)`}
            placeholder="YYYY-MM-DD"
            value={row.doneOn}
            autoComplete="off"
            error={errors[index]?.doneOn}
            onChange={(event) => {
              set(index, 'doneOn', event.target.value);
            }}
          />
          <Button
            onClick={() => {
              onChange(rows.filter((_, i) => i !== index));
            }}
          >
            {`Remove milestone ${String(index + 1)}`}
          </Button>
        </div>
      ))}
      <div>
        <Button
          disabled={rows.length >= MAX_MILESTONES}
          onClick={() => {
            onChange([...rows, { key: nextKey(), title: '', due: '', doneOn: '' }]);
          }}
        >
          Add milestone
        </Button>
        {rows.length >= MAX_MILESTONES && (
          <p className={styles.muted}>{`At most ${String(MAX_MILESTONES)} milestones.`}</p>
        )}
      </div>
    </fieldset>
  );
}
