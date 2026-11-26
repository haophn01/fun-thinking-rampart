import {
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  assetsResponseSchema,
  type Asset,
  type AssetCategory,
} from '@rampart/api/contract';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { apiSend } from '../../../api/client';
import { Alert, Button, Select, TextArea, TextField } from '../../../look';
import {
  LoadError,
  RemoveButton,
  Section,
  SspTable,
  errorText,
  fieldErrors,
  useLoad,
  type SspColumn,
} from '../kit';
import styles from './assets.module.css';

const JUSTIFICATION_MESSAGE = 'An out-of-scope asset needs a justification.';
const NAME_MESSAGE = 'Enter an asset name';
const NOT_FOUND_MESSAGE = 'It was already removed. The list has been reloaded.';

type TextKey =
  'name' | 'assetType' | 'owner' | 'location' | 'treatment' | 'outOfScopeJustification';
type Draft = Record<TextKey, string> & { category: AssetCategory };
type Errors = Partial<Record<TextKey | 'category', string>>;
type Body = Partial<Record<TextKey, string | null>> & { category?: AssetCategory };
type Notice = { tone: 'error' | 'info'; text: string };

const TEXT_KEYS: readonly TextKey[] = [
  'name',
  'assetType',
  'owner',
  'location',
  'treatment',
  'outOfScopeJustification',
];
const FIELD_KEYS = [...TEXT_KEYS, 'category'] as const;

function toDraft(asset: Asset | null): Draft {
  return {
    name: asset?.name ?? '',
    category: asset?.category ?? 'cui',
    assetType: asset?.assetType ?? '',
    owner: asset?.owner ?? '',
    location: asset?.location ?? '',
    treatment: asset?.treatment ?? '',
    outOfScopeJustification: asset?.outOfScopeJustification ?? '',
  };
}

/** Trimmed text; blank means `null`, as the api stores it. */
function clean(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * What to send, or what is wrong. A new asset sends every key; an edit sends only the keys that
 * differ from the stored asset. The justification counts only while the category is out of scope.
 */
export function buildBody(draft: Draft, asset: Asset | null): { body: Body; errors: Errors } {
  const errors: Errors = {};
  const name = clean(draft.name);
  if (name === null) errors.name = NAME_MESSAGE;
  const outOfScope = draft.category === 'out_of_scope';
  const justification = clean(draft.outOfScopeJustification);
  if (outOfScope && justification === null) errors.outOfScopeJustification = JUSTIFICATION_MESSAGE;

  const next: Body = {
    name,
    category: draft.category,
    assetType: clean(draft.assetType),
    owner: clean(draft.owner),
    location: clean(draft.location),
    treatment: clean(draft.treatment),
    outOfScopeJustification: outOfScope ? justification : null,
  };
  if (asset === null) return { body: next, errors };

  const body: Body = {};
  for (const key of FIELD_KEYS) {
    if (key === 'outOfScopeJustification' && !outOfScope) continue;
    if (next[key] !== asset[key]) (body as Record<string, unknown>)[key] = next[key];
  }
  return { body, errors };
}

interface AssetFormProps {
  /** The asset being edited, or `null` for a new one. */
  asset: Asset | null;
  /** After a save: show the notice and reload. */
  onDone: (notice: Notice) => Promise<void>;
  onCancel: () => void;
}

function AssetForm({ asset, onDone, onCancel }: AssetFormProps) {
  const [draft, setDraft] = useState(() => toDraft(asset));
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const editing = asset !== null;
  const title = editing ? `Edit ${asset.name}` : 'Add an asset';

  useEffect(() => {
    if (editing) wrap.current?.querySelector('input')?.focus();
  }, [editing]);

  const outOfScope = draft.category === 'out_of_scope';
  const changed = !editing || Object.keys(buildBody(draft, asset).body).length > 0;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !changed) return;
    const { body, errors: found } = buildBody(draft, asset);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailure(null);
    setPending(true);
    try {
      if (asset === null) await apiSend('POST', '/api/ssp/assets', body);
      else await apiSend('PATCH', `/api/ssp/assets/${asset.id}`, body);
    } catch (caught) {
      setPending(false);
      const fields = fieldErrors(caught);
      const shown: Errors = {};
      for (const key of FIELD_KEYS) {
        if (key === 'outOfScopeJustification' && !outOfScope) continue;
        const message = fields[key];
        if (message !== undefined) shown[key] = message;
      }
      if (Object.keys(shown).length > 0) {
        setErrors(shown);
        return;
      }
      const text = errorText(caught, "Couldn't save the asset. Try again.");
      if (editing && text === NOT_FOUND_MESSAGE) await onDone({ tone: 'error', text });
      else setFailure(text);
      return;
    }
    setPending(false);
    const name = draft.name.trim();
    await onDone({ tone: 'info', text: asset === null ? `Added ${name}.` : `Saved ${name}.` });
  }

  return (
    <div ref={wrap} className={styles.formWrap}>
      <h3 className={styles.formTitle}>{title}</h3>
      <form
        aria-label={title}
        className={styles.form}
        noValidate
        onSubmit={(event) => void onSubmit(event)}
      >
        {failure !== null && (
          <Alert tone="error" title="Not saved">
            {failure}
          </Alert>
        )}
        <TextField
          label="Name"
          value={draft.name}
          error={errors.name}
          maxLength={200}
          onChange={(event) => {
            set('name', event.target.value);
          }}
        />
        <Select
          label="Category"
          value={draft.category}
          error={errors.category}
          onChange={(event) => {
            set('category', event.target.value as AssetCategory);
          }}
        >
          {ASSET_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {ASSET_CATEGORY_LABELS[category]}
            </option>
          ))}
        </Select>
        <TextField
          label="Type"
          value={draft.assetType}
          error={errors.assetType}
          maxLength={200}
          onChange={(event) => {
            set('assetType', event.target.value);
          }}
        />
        <TextField
          label="Owner"
          value={draft.owner}
          error={errors.owner}
          maxLength={200}
          onChange={(event) => {
            set('owner', event.target.value);
          }}
        />
        <TextField
          label="Location"
          value={draft.location}
          error={errors.location}
          maxLength={200}
          onChange={(event) => {
            set('location', event.target.value);
          }}
        />
        <TextArea
          label="Treatment"
          value={draft.treatment}
          error={errors.treatment}
          maxLength={4000}
          onChange={(event) => {
            set('treatment', event.target.value);
          }}
        />
        {outOfScope && (
          <TextArea
            label="Out-of-scope justification"
            value={draft.outOfScopeJustification}
            error={errors.outOfScopeJustification}
            maxLength={4000}
            onChange={(event) => {
              set('outOfScopeJustification', event.target.value);
            }}
          />
        )}
        <div className={styles.formActions}>
          <Button type="submit" variant="primary" disabled={pending || !changed}>
            {editing ? 'Save changes' : 'Add asset'}
          </Button>
          {editing && (
            <Button disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function cell(text: string | null) {
  return text === null || text === '' ? <span className={styles.none}>{'—'}</span> : text;
}

/** The asset inventory: a table per category, and one form to add or edit an asset. */
export function AssetsTab() {
  const list = useLoad('/api/ssp/assets', assetsResponseSchema);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Bumped after each save so the next form starts blank.
  const [round, setRound] = useState(0);

  if (list.data === null) {
    return (
      <Section number={1} title="Asset inventory">
        {list.failed ? (
          <LoadError title="Couldn't load the assets" onRetry={() => void list.reload()} />
        ) : (
          <p>Loading assets…</p>
        )}
      </Section>
    );
  }
  const assets = list.data.assets;
  const total = assets.length;

  async function remove(asset: Asset) {
    setNotice(null);
    try {
      await apiSend('DELETE', `/api/ssp/assets/${asset.id}`);
    } catch (caught) {
      setNotice({
        tone: 'error',
        text: errorText(caught, "Couldn't remove the asset. Try again."),
      });
      if (editing?.id === asset.id) setEditing(null);
      await list.reload();
      throw caught;
    }
    if (editing?.id === asset.id) setEditing(null);
    setNotice({ tone: 'info', text: `Removed ${asset.name}.` });
    await list.reload();
  }

  function columns(category: AssetCategory): SspColumn<Asset>[] {
    const base: SspColumn<Asset>[] = [
      { header: 'Name', cell: (a) => a.name },
      { header: 'Type', cell: (a) => cell(a.assetType) },
      { header: 'Owner', cell: (a) => cell(a.owner) },
      { header: 'Location', cell: (a) => cell(a.location) },
      { header: 'Treatment', cell: (a) => cell(a.treatment) },
    ];
    if (category === 'out_of_scope') {
      base.push({
        header: 'Out-of-scope justification',
        cell: (a) => cell(a.outOfScopeJustification),
      });
    }
    base.push({
      header: 'Actions',
      cell: (a) => (
        <span className={styles.rowActions}>
          <Button
            aria-label={`Edit ${a.name}`}
            onClick={() => {
              setNotice(null);
              setEditing(a);
            }}
          >
            Edit
          </Button>
          <RemoveButton name={a.name} onConfirm={() => remove(a)} />
        </span>
      ),
    });
    return base;
  }

  async function finish(next: Notice) {
    setEditing(null);
    setRound((n) => n + 1);
    setNotice(next);
    await list.reload();
  }

  return (
    <Section number={1} title="Asset inventory">
      <div className={styles.inventory}>
        <p className={styles.total}>{`${String(total)} ${total === 1 ? 'asset' : 'assets'}`}</p>
        {notice !== null && <Alert tone={notice.tone}>{notice.text}</Alert>}
        <div className={styles.groups}>
          {ASSET_CATEGORIES.map((category) => {
            const rows = assets.filter((a) => a.category === category);
            return (
              <SspTable
                key={category}
                caption={`${ASSET_CATEGORY_LABELS[category]} · ${String(rows.length)}`}
                columns={columns(category)}
                rows={rows}
                rowKey={(a) => a.id}
                empty="None recorded."
              />
            );
          })}
        </div>
        <AssetForm
          key={`${editing?.id ?? 'new'}-${String(round)}`}
          asset={editing}
          onDone={finish}
          onCancel={() => {
            setEditing(null);
          }}
        />
      </div>
    </Section>
  );
}
