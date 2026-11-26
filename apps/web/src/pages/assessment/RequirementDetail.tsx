import {
  NIST_STATUS_LABELS,
  nistImplementationStatus,
  type RequirementState,
} from '@rampart/api/contract';
import type { Requirement } from '@rampart/catalog';
import type { ImplementationLevel, ObjectiveStatus, RequirementOutcome } from '@rampart/rules';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { Button, Select, TextArea } from '../../look';
import { ObjectiveRow } from './ObjectiveRow';
import styles from './assessment.module.css';

/** Only these two have partial credit, so only these get a level control. */
function partialCredit(requirement: Requirement) {
  return requirement.scoring.kind === 'points' ? requirement.scoring.partialCredit : null;
}

function pointsLabel(requirement: Requirement): string {
  if (requirement.scoring.kind === 'prerequisite') return 'Prerequisite — no points';
  const { points } = requirement.scoring;
  return points === 1 ? '1 point' : `${String(points)} points`;
}

export interface OwnerChoice {
  id: string;
  displayName: string;
  active: boolean;
}

export interface RequirementDetailProps {
  requirement: Requirement;
  state: RequirementState | null;
  /** Active users, for the owner Select. */
  users: readonly OwnerChoice[];
  /** What-if mode: status and level go to the what-if; everything else is off. */
  whatIf: boolean;
  /** Objective status as shown (what-if, then unconfirmed click, then stored). */
  statusOf: (objectiveId: string) => ObjectiveStatus;
  noteOf: (objectiveId: string) => string | null;
  isSaving: (objectiveId: string) => boolean;
  /** The level as shown (what-if, then stored). */
  level: ImplementationLevel | null;
  /** The saved outcome (never the what-if's); null when there is none. */
  outcome: Pick<RequirementOutcome, 'status' | 'allNa'> | null;
  patching: boolean;
  backTo: string;
  onStatus: (objectiveId: string, status: ObjectiveStatus) => void;
  onSaveNote: (objectiveId: string, note: string | null) => void;
  onLevel: (level: ImplementationLevel | null) => void;
  onStatement: (statement: string | null) => void;
  onOwner: (ownerId: string | null) => void;
  onPlanned: (text: string | null) => void;
  onNaRationale: (text: string | null) => void;
}

const PLANNED_HINT = 'What will be done, and when. The SSP prints it for Not Met requirements.';
const NA_HINT = "Why the objectives marked N/A don't apply.";

/** A text field that saves on its own button; drafts follow the stored value. */
function SavedText(props: {
  label: string;
  saveLabel: string;
  hint: string;
  hintId: string;
  maxLength: number;
  stored: string;
  disabled: boolean;
  onSave: (text: string | null) => void;
}) {
  const { stored } = props;
  const [draft, setDraft] = useState(stored);
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) {
    setSeen(stored);
    setDraft(stored);
  }
  return (
    <div className={styles.block}>
      <TextArea
        label={props.label}
        value={draft}
        maxLength={props.maxLength}
        rows={5}
        disabled={props.disabled}
        aria-describedby={props.hintId}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
      <p id={props.hintId} className={styles.hint}>
        {props.hint}
      </p>
      <div>
        <Button
          disabled={props.disabled || draft.trim() === stored.trim()}
          onClick={() => {
            props.onSave(draft.trim() === '' ? null : draft);
          }}
        >
          {props.saveLabel}
        </Button>
      </div>
    </div>
  );
}

/** One requirement: facts, objectives, implementation statement, level and owner. */
export function RequirementDetail(props: RequirementDetailProps) {
  const { requirement, state, users, whatIf, patching, outcome } = props;
  const hintBase = useId();
  const credit = partialCredit(requirement);
  const stored = state?.implementationStatement ?? '';
  const [draft, setDraft] = useState(stored);
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) {
    setSeen(stored);
    setDraft(stored);
  }

  const owner = state?.owner ?? null;
  const choices: OwnerChoice[] = users.filter((u) => u.active);
  const ownerMissing = owner !== null && !choices.some((u) => u.id === owner.id);
  const ownerChoices = ownerMissing ? [owner, ...choices] : choices;

  return (
    <section aria-label="Requirement detail" className={styles.detail}>
      <Link to={props.backTo} className={styles.back}>
        Back to requirements
      </Link>
      <h2 className={styles.detailTitle}>{requirement.id}</h2>
      <p className={styles.facts}>
        <span className={styles.code}>NIST {requirement.nistId}</span>
        <span>{requirement.type === 'basic' ? 'Basic' : 'Derived'}</span>
        <span>{pointsLabel(requirement)}</span>
        {credit && <span>{credit.label}</span>}
      </p>
      <p>{requirement.text}</p>

      <ul className={styles.objectives} aria-label="Objectives">
        {requirement.objectives.map((objective) => (
          <ObjectiveRow
            key={objective.id}
            objective={objective}
            status={props.statusOf(objective.id)}
            note={props.noteOf(objective.id)}
            saving={props.isSaving(objective.id)}
            noteDisabled={whatIf}
            onStatus={(status) => {
              props.onStatus(objective.id, status);
            }}
            onSaveNote={(note) => {
              props.onSaveNote(objective.id, note);
            }}
          />
        ))}
      </ul>

      <div className={styles.block}>
        <TextArea
          label="Implementation statement"
          value={draft}
          maxLength={20000}
          rows={6}
          disabled={whatIf || patching}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <div>
          <Button
            disabled={whatIf || patching || draft.trim() === stored.trim()}
            onClick={() => {
              props.onStatement(draft.trim() === '' ? null : draft);
            }}
          >
            Save statement
          </Button>
        </div>
      </div>

      <p className={styles.sspStatus}>
        SSP status:{' '}
        {outcome === null
          ? NIST_STATUS_LABELS.not_assessed
          : NIST_STATUS_LABELS[nistImplementationStatus(outcome)]}
      </p>

      <SavedText
        label="Planned implementation"
        saveLabel="Save planned implementation"
        hint={PLANNED_HINT}
        hintId={`${hintBase}-planned`}
        maxLength={20000}
        stored={state?.plannedImplementation ?? ''}
        disabled={whatIf || patching}
        onSave={props.onPlanned}
      />

      <SavedText
        label="N/A rationale"
        saveLabel="Save N/A rationale"
        hint={NA_HINT}
        hintId={`${hintBase}-na`}
        maxLength={4000}
        stored={state?.naRationale ?? ''}
        disabled={whatIf || patching}
        onSave={props.onNaRationale}
      />

      {credit && (
        <Select
          label="Implementation level"
          value={props.level ?? ''}
          disabled={patching}
          onChange={(event) => {
            const value = event.target.value;
            props.onLevel(value === '' ? null : (value as ImplementationLevel));
          }}
        >
          <option value="">Not set (worst case)</option>
          <option value="none">Not implemented</option>
          <option value="partial">{credit.label}</option>
        </Select>
      )}

      <Select
        label="Owner"
        value={owner?.id ?? ''}
        disabled={whatIf || patching}
        onChange={(event) => {
          props.onOwner(event.target.value === '' ? null : event.target.value);
        }}
      >
        <option value="">Unassigned</option>
        {ownerChoices.map((u) => (
          <option key={u.id} value={u.id}>
            {u.active ? u.displayName : `${u.displayName} (inactive)`}
          </option>
        ))}
      </Select>
    </section>
  );
}
