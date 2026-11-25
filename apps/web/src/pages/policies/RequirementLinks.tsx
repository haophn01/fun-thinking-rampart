import { loadCatalog } from '@rampart/catalog';
import type { FamilyCode } from '@rampart/catalog';
import { useState, type SyntheticEvent } from 'react';
import { Alert, Button, Checkbox, Select } from '../../look';
import styles from './policies.module.css';
import { failureText } from './usePolicies';

const catalog = loadCatalog();
const ORDER = new Map(catalog.requirements.map((r, index) => [r.id, index]));

export interface RequirementLinksProps {
  /** The requirements the policy links to now, as stored. */
  linked: string[];
  onSave: (requirementIds: string[]) => Promise<void>;
}

/**
 * Pick a family, tick its requirements and save. The whole set is sent, so the links in other
 * families (saved before or ticked earlier) are kept, and unticking removes one.
 */
export function RequirementLinks({ linked, onSave }: RequirementLinksProps) {
  const [family, setFamily] = useState<FamilyCode>(catalog.families[0]?.code ?? 'AC');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(linked));
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const requirements = catalog.requirements.filter((r) => r.family === family);
  const dirty = selected.size !== linked.length || linked.some((id) => !selected.has(id));

  function toggle(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !dirty) return;
    setPending(true);
    setFailure(null);
    const ids = [...selected].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
    try {
      await onSave(ids);
    } catch (caught) {
      setFailure(failureText(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className={styles.links}
      aria-label="Requirement links"
      noValidate
      onSubmit={(event) => void onSubmit(event)}
    >
      <p className={styles.sub}>
        {linked.length === 1
          ? '1 requirement linked'
          : `${String(linked.length)} requirements linked`}
      </p>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <Select
        label="Family"
        value={family}
        onChange={(event) => {
          const code = catalog.families.find((f) => f.code === event.target.value)?.code;
          if (code !== undefined) setFamily(code);
        }}
      >
        {catalog.families.map((f) => (
          <option key={f.code} value={f.code}>
            {f.code} {f.name}
          </option>
        ))}
      </Select>
      <div className={styles.checks} role="group" aria-label={`${family} requirements`}>
        {requirements.map((r) => (
          <Checkbox
            key={r.id}
            label={r.id}
            description={r.text}
            checked={selected.has(r.id)}
            onChange={(checked) => {
              toggle(r.id, checked);
            }}
          />
        ))}
      </div>
      <div>
        <Button type="submit" disabled={!dirty || pending}>
          {pending ? 'Saving…' : 'Save links'}
        </Button>
      </div>
    </form>
  );
}
