import {
  DIAGRAM_KINDS,
  DIAGRAM_KIND_LABELS,
  diagramResponseSchema,
  diagramsResponseSchema,
  evidenceListSchema,
  type DiagramLink,
  type EvidenceItem,
} from '@rampart/api/contract';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { Link } from 'react-router';
import { ApiError, apiSend } from '../../../api/client';
import { Alert, Button, Select, TextField } from '../../../look';
import { formatSize } from '../../evidence/EvidenceItem';
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
import styles from './environment.module.css';

const CUI_NOTE = 'This item contains CUI. The SSP will reference it and never embed it.';
type Kind = (typeof DIAGRAM_KINDS)[number];

function inSsp(link: DiagramLink): string {
  if (link.embeddable) return 'Embedded image';
  return link.evidence.containsCui ? 'Referenced — contains CUI' : 'Referenced';
}

function versionText(link: DiagramLink): string {
  if (link.version !== null) return `v${String(link.version)}`;
  return link.resolved === null ? 'Newest' : `Newest (v${String(link.resolved.version)})`;
}

function fileText(link: DiagramLink): string {
  const { resolved } = link;
  if (resolved === null) return 'No version yet';
  if (resolved.kind === 'reference') return `Reference: ${resolved.location ?? ''}`;
  const size = resolved.size === null ? '' : ` · ${formatSize(resolved.size)}`;
  return `${resolved.fileName ?? ''}${size}`;
}

/** The versions a link can pin: the item's own, plus a pinned one the item no longer lists. */
function versionOptions(item: EvidenceItem | undefined, pinned: number | null): number[] {
  const numbers = (item?.versions ?? []).map((v) => v.version);
  if (pinned !== null && !numbers.includes(pinned)) numbers.push(pinned);
  return numbers;
}

interface FormProps {
  evidence: readonly EvidenceItem[];
  /** The link being edited, or `null` to make a new one. */
  editing: DiagramLink | null;
  onDone: () => void;
  onCancel: () => void;
  /** The link was already removed: reload. */
  onGone: () => void;
}

function DiagramForm({ evidence, editing, onDone, onCancel, onGone }: FormProps) {
  const [evidenceId, setEvidenceId] = useState('');
  const [kind, setKind] = useState<Kind>(editing?.kind ?? 'network');
  const [caption, setCaption] = useState(editing?.caption ?? '');
  const [version, setVersion] = useState(
    editing?.version === null || editing === null ? '' : String(editing.version),
  );
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const item = evidence.find((e) => e.id === (editing === null ? evidenceId : editing.evidence.id));
  const pinned = version === '' ? null : Number(version);
  const changed =
    editing === null ||
    kind !== editing.kind ||
    caption.trim() !== editing.caption ||
    pinned !== editing.version;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !changed) return;
    const found: Record<string, string> = {};
    if (editing === null && evidenceId === '')
      found.evidenceId = 'Select the evidence item to link';
    if (caption.trim() === '') found.caption = 'Enter a caption';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailure(null);
    setPending(true);
    try {
      if (editing === null) {
        await apiSend(
          'POST',
          '/api/ssp/diagrams',
          { evidenceId, kind, caption: caption.trim(), version: pinned },
          diagramResponseSchema,
        );
      } else {
        const patch: Record<string, unknown> = {};
        if (kind !== editing.kind) patch.kind = kind;
        if (caption.trim() !== editing.caption) patch.caption = caption.trim();
        if (pinned !== editing.version) patch.version = pinned;
        await apiSend(
          'PATCH',
          `/api/ssp/diagrams/${encodeURIComponent(editing.id)}`,
          patch,
          diagramResponseSchema,
        );
      }
      onDone();
    } catch (caught) {
      const byField = fieldErrors(caught);
      if (Object.keys(byField).length > 0) {
        setErrors(byField);
      } else {
        setFailure(errorText(caught, "Couldn't save the diagram."));
        if (editing !== null && caught instanceof ApiError && caught.code === 'not_found') onGone();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className={styles.form}
      aria-label={editing === null ? 'Link a diagram' : 'Edit diagram'}
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      {editing === null ? (
        <Select
          label="Evidence item"
          value={evidenceId}
          error={errors.evidenceId}
          onChange={(event) => {
            setEvidenceId(event.target.value);
            setVersion('');
            setErrors({ ...errors, evidenceId: undefined, version: undefined });
          }}
        >
          <option value="">Choose an evidence item</option>
          {evidence.map((e) => (
            <option key={e.id} value={e.id}>
              {e.containsCui ? `${e.title} (contains CUI)` : e.title}
            </option>
          ))}
        </Select>
      ) : (
        <div className={styles.fixed}>
          <span className={styles.fixedLabel}>Evidence item</span>
          <p className={styles.fixedValue}>{editing.evidence.title}</p>
        </div>
      )}
      {item?.containsCui === true && <Alert tone="info">{CUI_NOTE}</Alert>}
      <Select
        label="Kind"
        value={kind}
        error={errors.kind}
        onChange={(event) => {
          setKind(event.target.value as Kind);
        }}
      >
        {DIAGRAM_KINDS.map((k) => (
          <option key={k} value={k}>
            {DIAGRAM_KIND_LABELS[k]}
          </option>
        ))}
      </Select>
      <TextField
        label="Caption"
        value={caption}
        maxLength={200}
        autoComplete="off"
        error={errors.caption}
        onChange={(event) => {
          setCaption(event.target.value);
          setErrors({ ...errors, caption: undefined });
        }}
      />
      <Select
        label="Version"
        value={version}
        error={errors.version}
        onChange={(event) => {
          setVersion(event.target.value);
          setErrors({ ...errors, version: undefined });
        }}
      >
        <option value="">Always the newest</option>
        {versionOptions(item, editing?.version ?? null).map((n) => (
          <option key={n} value={String(n)}>
            {`v${String(n)}`}
          </option>
        ))}
      </Select>
      <div className={styles.actions}>
        <Button
          type="submit"
          variant="primary"
          disabled={pending || (editing !== null && !changed)}
        >
          {editing === null ? 'Link diagram' : 'Save'}
        </Button>
        {editing !== null && <Button onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

/** Section 3: the diagrams linked from the SSP, each pointing at an evidence item. */
export function DiagramsSection() {
  const diagrams = useLoad('/api/ssp/diagrams', diagramsResponseSchema);
  const evidence = useLoad('/api/evidence', evidenceListSchema);
  const [editing, setEditing] = useState<DiagramLink | null>(null);
  const [removeFailure, setRemoveFailure] = useState<string | null>(null);
  // A new key empties the link form after each link is made.
  const [created, setCreated] = useState(0);

  async function remove(link: DiagramLink) {
    setRemoveFailure(null);
    try {
      await apiSend('DELETE', `/api/ssp/diagrams/${encodeURIComponent(link.id)}`);
      if (editing?.id === link.id) setEditing(null);
    } catch (caught) {
      setRemoveFailure(errorText(caught, "Couldn't remove the diagram."));
    } finally {
      await diagrams.reload();
    }
  }

  const columns: SspColumn<DiagramLink>[] = [
    { header: 'Caption', cell: (row) => row.caption },
    { header: 'Kind', cell: (row) => DIAGRAM_KIND_LABELS[row.kind] },
    { header: 'Evidence item', cell: (row) => row.evidence.title },
    { header: 'Version', cell: versionText },
    { header: 'File', cell: fileText },
    { header: 'In the SSP', cell: inSsp },
    {
      header: 'Actions',
      cell: (row) => (
        <span className={styles.rowActions}>
          <Button
            onClick={() => {
              setEditing(row);
            }}
          >
            Edit
          </Button>
          <RemoveButton
            name={row.caption}
            onConfirm={() => {
              return remove(row);
            }}
          />
        </span>
      ),
    },
  ];

  let body: ReactNode;
  if (diagrams.data === null || evidence.data === null) {
    body =
      diagrams.failed || evidence.failed ? (
        <LoadError
          title="Can't load the diagrams"
          onRetry={() => {
            void diagrams.reload();
            void evidence.reload();
          }}
        />
      ) : (
        <p className={styles.muted}>Loading the diagrams…</p>
      );
  } else {
    const items = evidence.data.items;
    body = (
      <div className={styles.diagrams}>
        {removeFailure !== null && <Alert tone="error">{removeFailure}</Alert>}
        <SspTable
          caption={
            <span className={styles.captionText}>
              {`Linked diagrams · ${String(diagrams.data.diagrams.length)}`}
            </span>
          }
          columns={columns}
          rows={diagrams.data.diagrams}
          rowKey={(row) => row.id}
          empty="No diagrams linked yet."
        />
        {items.length === 0 ? (
          <p className={styles.muted}>
            Add the diagram on the Evidence page first.{' '}
            <Link className={styles.link} to="/evidence">
              Open the Evidence page
            </Link>
          </p>
        ) : (
          <DiagramForm
            key={editing?.id ?? `new-${String(created)}`}
            evidence={items}
            editing={editing}
            onDone={() => {
              setEditing(null);
              setCreated((n) => n + 1);
              void diagrams.reload();
            }}
            onCancel={() => {
              setEditing(null);
            }}
            onGone={() => {
              setEditing(null);
              void diagrams.reload();
            }}
          />
        )}
      </div>
    );
  }
  return (
    <Section number={3} title="Diagrams">
      {body}
    </Section>
  );
}
