import { loadCatalog } from '@rampart/catalog';
import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Select } from '../../look';
import styles from './evidence.module.css';
import type { Outcome } from './useEvidence';

const catalog = loadCatalog();
/** Every objective's place in the catalog, so a saved set goes out in catalog order. */
const ORDER = new Map(
  catalog.requirements
    .flatMap((r) => r.objectives)
    .map((objective, index) => [objective.id, index]),
);
const REQUIREMENT_OF = new Map(
  catalog.requirements.flatMap((r) => r.objectives.map((o) => [o.id, r.id] as const)),
);

export interface ObjectiveLinksProps {
  /** The item's saved links. */
  saved: readonly string[];
  /** Saves the full set. */
  onSave: (objectiveIds: string[]) => Promise<Outcome>;
}

/**
 * Picks a requirement and ticks its objectives. The draft is the item's whole set, so ticks made
 * under one requirement survive switching to another, and Save sends the full set.
 */
export function ObjectiveLinks({ saved, onSave }: ObjectiveLinksProps) {
  const [draft, setDraft] = useState<ReadonlySet<string>>(() => new Set(saved));
  const [requirementId, setRequirementId] = useState(
    () => REQUIREMENT_OF.get(saved[0] ?? '') ?? catalog.requirements[0]?.id ?? '',
  );
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const requirement = catalog.requirements.find((r) => r.id === requirementId);

  const dirty = useMemo(
    () => draft.size !== saved.length || saved.some((id) => !draft.has(id)),
    [draft, saved],
  );

  function toggle(id: string, on: boolean) {
    const next = new Set(draft);
    if (on) next.add(id);
    else next.delete(id);
    setDraft(next);
    setDone(false);
  }

  async function save() {
    if (pending || !dirty) return;
    setPending(true);
    setFailure(null);
    setDone(false);
    const ids = [...draft].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
    const outcome = await onSave(ids);
    setPending(false);
    if (outcome.ok) setDone(true);
    else setFailure(outcome.message);
  }

  return (
    <fieldset className={styles.links}>
      <legend className={styles.legend}>Linked objectives</legend>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <Select
        label="Requirement"
        value={requirementId}
        onChange={(event) => {
          setRequirementId(event.target.value);
        }}
      >
        {catalog.requirements.map((r) => (
          <option key={r.id} value={r.id}>
            {r.id}
          </option>
        ))}
      </Select>
      {requirement && <p className={styles.muted}>{requirement.text}</p>}
      <div className={styles.objectives}>
        {requirement?.objectives.map((objective) => (
          <Checkbox
            key={objective.id}
            label={`${objective.id} ${objective.text}`}
            checked={draft.has(objective.id)}
            onChange={(on) => {
              toggle(objective.id, on);
            }}
          />
        ))}
      </div>
      <p className={styles.muted}>
        {draft.size === 1
          ? '1 objective linked in all'
          : `${String(draft.size)} objectives linked in all`}
      </p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={pending || !dirty}
          onClick={() => {
            void save();
          }}
        >
          {pending ? 'Saving…' : 'Save links'}
        </Button>
        {done && <span role="status">Saved.</span>}
      </div>
    </fieldset>
  );
}
