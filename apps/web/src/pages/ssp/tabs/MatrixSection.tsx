import {
  RESPONSIBILITY_PARTIES,
  RESPONSIBILITY_PARTY_LABELS,
  responsibilityRowResponseSchema,
  type ResponsibilityMatrix,
  type ResponsibilityParty,
  type ResponsibilityRow,
  type ServiceProvider,
} from '@rampart/api/contract';
import { loadCatalog } from '@rampart/catalog';
import { memo, useCallback, useMemo, useState } from 'react';
import { apiSend } from '../../../api/client';
import { Button, Select, TextField } from '../../../look';
import { SspTable, errorText, fieldErrors, type SspColumn } from '../kit';
import styles from './providers.module.css';

const CATALOG = loadCatalog();
const TOTAL = CATALOG.requirements.length;
const NEEDS_PROVIDER_TEXT = 'Choose the provider for this requirement.';
const NO_PROVIDERS_TEXT = 'Add a service provider first.';

type Party = ResponsibilityParty | null;
interface ProviderOption {
  id: string;
  name: string;
}

/** One row's unsaved edit and its save state. A row with no entry shows what is stored. */
interface RowEdit {
  party: Party;
  providerId: string | null;
  note: string;
  pending: boolean;
  justSaved: boolean;
  /** Shown on the Provider field. */
  providerError: string | null;
  /** Shown under the row's Save. */
  failure: string | null;
}

const needsProvider = (party: Party) => party === 'esp' || party === 'shared';
const cleanNote = (note: string) => (note.trim() === '' ? null : note.trim());

function fromRow(row: ResponsibilityRow): RowEdit {
  return {
    party: row.party,
    providerId: row.provider?.id ?? null,
    note: row.note ?? '',
    pending: false,
    justSaved: false,
    providerError: null,
    failure: null,
  };
}

function isChanged(edit: RowEdit, row: ResponsibilityRow): boolean {
  return (
    edit.party !== row.party ||
    edit.providerId !== (row.provider?.id ?? null) ||
    cleanNote(edit.note) !== row.note
  );
}

type Change = Partial<Pick<RowEdit, 'party' | 'providerId' | 'note'>>;

interface CellProps {
  row: ResponsibilityRow;
  edit: RowEdit | undefined;
}

const PartyCell = memo(function PartyCell({
  row,
  edit,
  onChange,
}: CellProps & { onChange: (row: ResponsibilityRow, change: Change) => void }) {
  const party = edit?.party ?? row.party;
  return (
    <Select
      label={`Party for ${row.requirementId}`}
      className={styles.cellControl}
      value={party ?? ''}
      onChange={(e) => {
        const next = (e.target.value === '' ? null : e.target.value) as Party;
        onChange(row, needsProvider(next) ? { party: next } : { party: next, providerId: null });
      }}
    >
      <option value="">Not set</option>
      {RESPONSIBILITY_PARTIES.map((p) => (
        <option key={p} value={p}>
          {RESPONSIBILITY_PARTY_LABELS[p]}
        </option>
      ))}
    </Select>
  );
});

const ProviderCell = memo(function ProviderCell({
  row,
  edit,
  options,
  onChange,
}: CellProps & {
  options: readonly ProviderOption[] | null;
  onChange: (row: ResponsibilityRow, change: Change) => void;
}) {
  const party = edit === undefined ? row.party : edit.party;
  const providerId = edit === undefined ? (row.provider?.id ?? null) : edit.providerId;
  const enabled = needsProvider(party);
  // The stored provider stays choosable even before the provider list has loaded.
  const all = options ?? [];
  const shown =
    row.provider !== null && !all.some((o) => o.id === row.provider?.id)
      ? [...all, row.provider]
      : all;
  const none = options !== null && options.length === 0;
  return (
    <>
      <Select
        label={`Provider for ${row.requirementId}`}
        className={styles.cellControl}
        value={enabled ? (providerId ?? '') : ''}
        disabled={!enabled || shown.length === 0}
        error={edit?.providerError ?? undefined}
        onChange={(e) => {
          onChange(row, { providerId: e.target.value === '' ? null : e.target.value });
        }}
      >
        <option value="">{enabled ? 'Choose a provider' : 'None'}</option>
        {enabled &&
          shown.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
      </Select>
      {enabled && none && <p className={styles.hint}>{NO_PROVIDERS_TEXT}</p>}
    </>
  );
});

const NoteCell = memo(function NoteCell({
  row,
  edit,
  onChange,
}: CellProps & { onChange: (row: ResponsibilityRow, change: Change) => void }) {
  return (
    <TextField
      label={`Note for ${row.requirementId}`}
      className={styles.cellControl}
      maxLength={4000}
      value={edit?.note ?? row.note ?? ''}
      onChange={(e) => {
        onChange(row, { note: e.target.value });
      }}
    />
  );
});

const SaveCell = memo(function SaveCell({
  row,
  edit,
  onSave,
}: CellProps & { onSave: (row: ResponsibilityRow, edit: RowEdit) => void }) {
  const changed = edit !== undefined && isChanged(edit, row);
  return (
    <span className={styles.saveCell}>
      <Button
        aria-label={`Save ${row.requirementId}`}
        disabled={!changed || edit.pending}
        onClick={() => {
          if (edit !== undefined) onSave(row, edit);
        }}
      >
        Save
      </Button>
      {edit?.justSaved === true && (
        <span role="status" className={styles.saved}>
          Saved
        </span>
      )}
      {edit?.failure != null && (
        <span role="alert" className={styles.rowError}>
          {edit.failure}
        </span>
      )}
    </span>
  );
});

/**
 * The responsibility matrix: one row per requirement under its family's heading, each saved on
 * its own. Drafts live here, so they survive a reload of the matrix or the providers.
 */
export function MatrixSection({
  matrix,
  providers,
}: {
  matrix: ResponsibilityMatrix;
  /** The live providers, or null while they load or after they failed. */
  providers: readonly ServiceProvider[] | null;
}) {
  // The server's rows, with each save's answer put in place until the next reload.
  const [rows, setRows] = useState(matrix.rows);
  const [loaded, setLoaded] = useState(matrix);
  if (loaded !== matrix) {
    setLoaded(matrix);
    setRows(matrix.rows);
  }
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [family, setFamily] = useState('');

  const options = useMemo(
    () => providers?.map((p) => ({ id: p.id, name: p.name })) ?? null,
    [providers],
  );

  const update = useCallback((row: ResponsibilityRow, change: (edit: RowEdit) => RowEdit) => {
    setEdits((all) => ({
      ...all,
      [row.requirementId]: change(all[row.requirementId] ?? fromRow(row)),
    }));
  }, []);

  const onChange = useCallback(
    (row: ResponsibilityRow, change: Change) => {
      update(row, (edit) => ({
        ...edit,
        ...change,
        justSaved: false,
        failure: null,
        providerError: null,
      }));
    },
    [update],
  );

  const onSave = useCallback(
    (row: ResponsibilityRow, edit: RowEdit) => {
      if (needsProvider(edit.party) && edit.providerId === null) {
        update(row, (e) => ({ ...e, providerError: NEEDS_PROVIDER_TEXT }));
        return;
      }
      const body = { party: edit.party, providerId: edit.providerId, note: cleanNote(edit.note) };
      update(row, (e) => ({ ...e, pending: true, failure: null, providerError: null }));
      apiSend(
        'PUT',
        `/api/ssp/responsibilities/${encodeURIComponent(row.requirementId)}`,
        body,
        responsibilityRowResponseSchema,
      ).then(
        ({ row: stored }) => {
          setRows((all) => all.map((r) => (r.requirementId === stored.requirementId ? stored : r)));
          update(stored, () => ({ ...fromRow(stored), justSaved: true }));
        },
        (error: unknown) => {
          const providerError = fieldErrors(error).providerId ?? null;
          update(row, (e) => ({
            ...e,
            pending: false,
            providerError,
            failure:
              providerError === null ? errorText(error, "Can't save this row. Try again.") : null,
          }));
        },
      );
    },
    [update],
  );

  const byId = useMemo(() => new Map(rows.map((r) => [r.requirementId, r])), [rows]);
  const assigned = rows.filter((r) => r.party !== null).length;
  const families = CATALOG.families.filter((f) => family === '' || f.code === family);

  const columns: SspColumn<ResponsibilityRow>[] = [
    {
      header: 'Requirement',
      cell: (r) => <span className={styles.reqId}>{r.requirementId}</span>,
    },
    {
      header: 'Party',
      cell: (r) => <PartyCell row={r} edit={edits[r.requirementId]} onChange={onChange} />,
    },
    {
      header: 'Provider',
      cell: (r) => (
        <ProviderCell row={r} edit={edits[r.requirementId]} options={options} onChange={onChange} />
      ),
    },
    {
      header: 'Note',
      cell: (r) => <NoteCell row={r} edit={edits[r.requirementId]} onChange={onChange} />,
    },
    {
      header: 'Save',
      cell: (r) => <SaveCell row={r} edit={edits[r.requirementId]} onSave={onSave} />,
    },
  ];

  return (
    <>
      <div className={styles.matrixHead}>
        <p className={styles.count}>{`${String(assigned)} of ${String(TOTAL)} assigned`}</p>
        {options !== null && options.length === 0 && (
          <p className={styles.hint}>{NO_PROVIDERS_TEXT}</p>
        )}
        <Select
          label="Family"
          className={styles.familySelect}
          value={family}
          onChange={(e) => {
            setFamily(e.target.value);
          }}
        >
          <option value="">All families</option>
          {CATALOG.families.map((f) => (
            <option key={f.code} value={f.code}>
              {`${f.code} — ${f.name}`}
            </option>
          ))}
        </Select>
      </div>
      {families.map((f) => (
        <div key={f.code} className={styles.tableWrap}>
          <SspTable
            caption={<h3 className={styles.familyHeading}>{`${f.code} — ${f.name}`}</h3>}
            columns={columns}
            rows={f.requirementIds.flatMap((id) => byId.get(id) ?? [])}
            rowKey={(r) => r.requirementId}
            empty="No requirements."
          />
        </div>
      ))}
    </>
  );
}
