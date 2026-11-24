import type { Objective } from '@rampart/catalog';
import type { ObjectiveStatus } from '@rampart/rules';
import { useState } from 'react';
import { Button, RadioGroup, TextArea, type RadioOption } from '../../look';
import styles from './assessment.module.css';

const OPTIONS: readonly RadioOption<ObjectiveStatus>[] = [
  { value: 'met', label: 'Met', status: 'met' },
  { value: 'not_met', label: 'Not Met', status: 'not_met' },
  { value: 'na', label: 'N/A', status: 'na' },
  { value: 'not_assessed', label: 'Not Assessed', status: 'not_assessed' },
];

export interface ObjectiveRowProps {
  objective: Objective;
  status: ObjectiveStatus;
  /** The stored note. */
  note: string | null;
  /** The status control is off while this objective is being saved. */
  saving: boolean;
  /** The note is off in what-if mode, where nothing is saved. */
  noteDisabled: boolean;
  onStatus: (status: ObjectiveStatus) => void;
  onSaveNote: (note: string | null) => void;
}

/** One objective: its ID and text, the status control and a note with Save. */
export function ObjectiveRow({
  objective,
  status,
  note,
  saving,
  noteDisabled,
  onStatus,
  onSaveNote,
}: ObjectiveRowProps) {
  const stored = note ?? '';
  const [draft, setDraft] = useState(stored);
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) {
    setSeen(stored);
    setDraft(stored);
  }
  const unchanged = draft.trim() === stored.trim();

  return (
    <li className={styles.objective} aria-label={objective.id}>
      <p className={styles.objectiveHead}>
        <span className={styles.code}>{objective.id}</span>
        <span>{objective.text}</span>
      </p>
      <RadioGroup<ObjectiveStatus>
        legend={`Status for ${objective.id}`}
        options={OPTIONS}
        value={status}
        onChange={onStatus}
        disabled={saving}
      />
      <TextArea
        label={`Note for ${objective.id}`}
        value={draft}
        maxLength={4000}
        rows={2}
        disabled={noteDisabled || saving}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
      <div>
        <Button
          disabled={noteDisabled || saving || unchanged}
          onClick={() => {
            onSaveNote(draft.trim() === '' ? null : draft);
          }}
        >
          Save note
        </Button>
      </div>
    </li>
  );
}
