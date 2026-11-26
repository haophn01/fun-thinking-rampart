import {
  PROVIDER_TYPES,
  PROVIDER_TYPE_LABELS,
  providerResponseSchema,
  providersResponseSchema,
  responsibilityMatrixSchema,
  type ProviderType,
  type ServiceProvider,
} from '@rampart/api/contract';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { ApiError, apiSend } from '../../../api/client';
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
import { MatrixSection } from './MatrixSection';
import styles from './providers.module.css';

type TextKey = 'name' | 'fedrampStatus' | 'services' | 'agreementReference';
type Draft = Record<TextKey, string> & { providerType: ProviderType };
type Body = { name: string; providerType: ProviderType } & Record<
  Exclude<TextKey, 'name'>,
  string | null
>;

const EMPTY: Draft = {
  name: '',
  providerType: 'cloud',
  fedrampStatus: '',
  services: '',
  agreementReference: '',
};

function toDraft(provider: ServiceProvider): Draft {
  return {
    name: provider.name,
    providerType: provider.providerType,
    fedrampStatus: provider.fedrampStatus ?? '',
    services: provider.services ?? '',
    agreementReference: provider.agreementReference ?? '',
  };
}

/** What the api would store: trimmed, blank optional text as null. */
function toBody(draft: Draft): Body {
  const text = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    name: draft.name.trim(),
    providerType: draft.providerType,
    fedrampStatus: text(draft.fedrampStatus),
    services: text(draft.services),
    agreementReference: text(draft.agreementReference),
  };
}

/** The keys an edit changes, against the stored provider. */
function changedKeys(draft: Draft, stored: ServiceProvider): Partial<Body> {
  const body = toBody(draft);
  const changed: Partial<Record<keyof Body, unknown>> = {};
  for (const key of Object.keys(body) as (keyof Body)[]) {
    if (body[key] !== stored[key]) changed[key] = body[key];
  }
  return changed as Partial<Body>;
}

const NOT_FOUND_TEXT = errorText(
  new ApiError({ status: 404, code: 'not_found', message: 'not_found' }),
  '',
);

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** The text for a refused removal: which requirements still name the provider. */
function inUseText(name: string, error: ApiError): string {
  const details = error.details as { requirementIds?: unknown } | undefined;
  const ids = Array.isArray(details?.requirementIds)
    ? details.requirementIds.filter((id): id is string => typeof id === 'string')
    : [];
  return `${name} is named on ${plural(ids.length, 'requirement')}: ${ids.join(', ')}. Point those rows elsewhere, then remove it.`;
}

function ProviderForm({
  editing,
  onDone,
  onCancel,
}: {
  /** The provider being edited, or null to add one. */
  editing: ServiceProvider | null;
  onDone: (notFound: boolean) => void;
  onCancel: () => void;
}) {
  const hintId = useId();
  const [draft, setDraft] = useState<Draft>(() => (editing === null ? EMPTY : toDraft(editing)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const changes = editing === null ? null : changedKeys(draft, editing);
  const unchanged = changes !== null && Object.keys(changes).length === 0;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== key)));
    setFailure(null);
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (draft.name.trim() === '') {
      setErrors({ name: 'Enter a provider name' });
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      if (editing === null) {
        await apiSend('POST', '/api/ssp/providers', toBody(draft), providerResponseSchema);
      } else {
        await apiSend(
          'PATCH',
          `/api/ssp/providers/${encodeURIComponent(editing.id)}`,
          changes,
          providerResponseSchema,
        );
      }
      setPending(false);
      onDone(false);
    } catch (error) {
      setPending(false);
      if (error instanceof ApiError && error.code === 'not_found') {
        onDone(true);
        return;
      }
      const byField = fieldErrors(error);
      setErrors(byField);
      if (Object.keys(byField).length === 0) {
        setFailure(errorText(error, "Can't save the provider. Try again."));
      }
    }
  }

  const title = editing === null ? 'Add a service provider' : `Edit ${editing.name}`;
  return (
    <form className={styles.form} aria-label={title} noValidate onSubmit={(e) => void submit(e)}>
      <h3 className={styles.formTitle}>{title}</h3>
      <TextField
        label="Name"
        required
        // An edit opens the form in place; focus moves to it (and scrolls it into view).
        autoFocus={editing !== null}
        maxLength={200}
        value={draft.name}
        error={errors.name}
        onChange={(e) => {
          set('name', e.target.value);
        }}
      />
      <Select
        label="Type"
        value={draft.providerType}
        error={errors.providerType}
        onChange={(e) => {
          set('providerType', e.target.value as ProviderType);
        }}
      >
        {PROVIDER_TYPES.map((type) => (
          <option key={type} value={type}>
            {PROVIDER_TYPE_LABELS[type]}
          </option>
        ))}
      </Select>
      <div className={styles.field}>
        <TextField
          label="FedRAMP or equivalent"
          maxLength={200}
          aria-describedby={hintId}
          value={draft.fedrampStatus}
          error={errors.fedrampStatus}
          onChange={(e) => {
            set('fedrampStatus', e.target.value);
          }}
        />
        <p id={hintId} className={styles.hint}>
          e.g. FedRAMP Moderate, or equivalent
        </p>
      </div>
      <TextArea
        label="Services"
        maxLength={4000}
        value={draft.services}
        error={errors.services}
        onChange={(e) => {
          set('services', e.target.value);
        }}
      />
      <TextField
        label="Agreement reference"
        maxLength={1000}
        value={draft.agreementReference}
        error={errors.agreementReference}
        onChange={(e) => {
          set('agreementReference', e.target.value);
        }}
      />
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={pending || unchanged}>
          {editing === null ? 'Add provider' : 'Save changes'}
        </Button>
        {editing !== null && (
          <Button disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** Service providers, and who carries out each of the 110 requirements. */
export function ProvidersTab() {
  const providers = useLoad('/api/ssp/providers', providersResponseSchema);
  const matrix = useLoad('/api/ssp/responsibilities', responsibilityMatrixSchema);
  const [editing, setEditing] = useState<ServiceProvider | null>(null);
  // A new key remounts the form, so a finished or cancelled edit starts from a clean draft.
  const [formKey, setFormKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  function reloadBoth() {
    void providers.reload();
    void matrix.reload();
  }

  function closeForm() {
    setEditing(null);
    setFormKey((k) => k + 1);
  }

  async function remove(provider: ServiceProvider) {
    setNotice(null);
    try {
      await apiSend('DELETE', `/api/ssp/providers/${encodeURIComponent(provider.id)}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'provider_in_use') {
        setNotice(inUseText(provider.name, error));
        return;
      }
      setNotice(errorText(error, `Can't remove ${provider.name}. Try again.`));
      if (!(error instanceof ApiError && error.code === 'not_found')) return;
    }
    if (editing?.id === provider.id) closeForm();
    reloadBoth();
  }

  const columns: SspColumn<ServiceProvider>[] = [
    { header: 'Name', cell: (p) => p.name },
    { header: 'Type', cell: (p) => PROVIDER_TYPE_LABELS[p.providerType] },
    { header: 'FedRAMP or equivalent', cell: (p) => p.fedrampStatus ?? '' },
    { header: 'Services', cell: (p) => <span className={styles.prose}>{p.services ?? ''}</span> },
    { header: 'Agreement', cell: (p) => p.agreementReference ?? '' },
    {
      header: 'Actions',
      cell: (p) => (
        <span className={styles.rowActions}>
          <Button
            aria-label={`Edit ${p.name}`}
            onClick={() => {
              setNotice(null);
              setEditing(p);
              setFormKey((k) => k + 1);
            }}
          >
            Edit
          </Button>
          <RemoveButton name={p.name} onConfirm={() => remove(p)} />
        </span>
      ),
    },
  ];

  let list: ReactNode;
  if (providers.data !== null) {
    list = (
      <div className={styles.tableWrap}>
        <SspTable
          caption={`Service providers · ${String(providers.data.providers.length)}`}
          columns={columns}
          rows={providers.data.providers}
          rowKey={(p) => p.id}
          empty="No service providers yet."
        />
      </div>
    );
  } else if (providers.failed) {
    list = (
      <LoadError
        title="Can't load the service providers"
        onRetry={() => {
          void providers.reload();
        }}
      />
    );
  } else {
    list = <p className={styles.muted}>Loading the service providers…</p>;
  }

  let rows: ReactNode;
  if (matrix.data !== null) {
    rows = <MatrixSection matrix={matrix.data} providers={providers.data?.providers ?? null} />;
  } else if (matrix.failed) {
    rows = (
      <LoadError
        title="Can't load the responsibility matrix"
        onRetry={() => {
          void matrix.reload();
        }}
      />
    );
  } else {
    rows = <p className={styles.muted}>Loading the responsibility matrix…</p>;
  }

  return (
    <>
      <Section number={1} title="Service providers">
        {list}
        {notice !== null && <Alert tone="error">{notice}</Alert>}
        {providers.data !== null && (
          <div className={styles.formWrap}>
            <ProviderForm
              key={formKey}
              editing={editing}
              onCancel={closeForm}
              onDone={(notFound) => {
                if (notFound) setNotice(NOT_FOUND_TEXT);
                closeForm();
                reloadBoth();
              }}
            />
          </div>
        )}
      </Section>
      <Section number={2} title="Responsibility matrix">
        {rows}
      </Section>
    </>
  );
}
