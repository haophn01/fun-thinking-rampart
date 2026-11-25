import { UPLOAD_EXTENSIONS, type EvidenceItem, type EvidenceVersion } from '@rampart/api/contract';
import { useId, useRef, useState, type SyntheticEvent } from 'react';
import { Alert, Button, FileField, TextArea, TextField } from '../../look';
import { ObjectiveLinks } from './ObjectiveLinks';
import styles from './evidence.module.css';
import type { EvidenceState } from './useEvidence';

const ACCEPT = UPLOAD_EXTENSIONS.join(',');

/** Bytes as B, KiB or MiB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function downloadPath(itemId: string, version: number): string {
  return `/api/evidence/${encodeURIComponent(itemId)}/versions/${String(version)}/file`;
}

/** A version's file details, or where a CUI item's file lives. */
function VersionFacts({ version }: { version: EvidenceVersion }) {
  if (version.kind === 'reference') {
    return (
      <div className={styles.facts}>
        <span className={styles.muted}>Where it lives</span>
        <span className={styles.mono}>{version.location}</span>
        {version.note !== null && <span>{version.note}</span>}
      </div>
    );
  }
  return (
    <div className={styles.facts}>
      <span className={styles.mono}>{version.fileName}</span>
      <span className={styles.muted}>{formatSize(version.size)}</span>
      <span className={styles.hash}>
        <span className={styles.muted}>SHA-256</span>{' '}
        <code className={styles.mono}>{version.sha256}</code>
      </span>
    </div>
  );
}

function UploadPanel({ item, state }: { item: EvidenceItem; state: EvidenceState }) {
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [uploaded, setUploaded] = useState(0);
  const sending = useRef(false);

  async function choose(file: File | null) {
    if (file === null || sending.current) return;
    sending.current = true;
    setPending(true);
    setError(undefined);
    const outcome = await state.upload(item.id, file);
    sending.current = false;
    setPending(false);
    if (outcome.ok) setUploaded((n) => n + 1);
    else setError(outcome.message);
  }

  return (
    <FileField
      label="Upload a file"
      accept={ACCEPT}
      error={error}
      disabled={pending}
      reset={uploaded}
      onFileChange={(file) => void choose(file)}
    />
  );
}

function ReferenceForm({ item, state }: { item: EvidenceItem; state: EvidenceState }) {
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [locationError, setLocationError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    if (location.trim() === '') {
      setLocationError('Enter where the file lives.');
      return;
    }
    setLocationError(undefined);
    setFailure(null);
    sending.current = true;
    setPending(true);
    const outcome = await state.addReference(item.id, {
      location: location.trim(),
      note: note.trim(),
    });
    sending.current = false;
    setPending(false);
    if (outcome.ok) {
      setLocation('');
      setNote('');
    } else {
      setFailure(outcome.message);
    }
  }

  return (
    <form className={styles.form} noValidate onSubmit={(event) => void onSubmit(event)}>
      {failure !== null && <Alert tone="error">{failure}</Alert>}
      <p className={styles.muted}>
        This item contains CUI, so no file is stored here. Record where the file lives.
      </p>
      <TextField
        label="Where the file lives"
        autoComplete="off"
        maxLength={1000}
        value={location}
        error={locationError}
        onChange={(event) => {
          setLocation(event.target.value);
        }}
      />
      <TextArea
        label="Note"
        maxLength={4000}
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
        }}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record where it lives'}
        </Button>
      </div>
    </form>
  );
}

/** One evidence item: a summary card, and on request its versions, upload and objective links. */
export function EvidenceItemCard({ item, state }: { item: EvidenceItem; state: EvidenceState }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const latest = item.versions[0];
  const count = item.objectiveIds.length;

  return (
    <li className={styles.card}>
      <div className={styles.top}>
        <h2 className={styles.title}>{item.title}</h2>
        {item.containsCui && <span className={styles.cuiTag}>Contains CUI</span>}
      </div>
      {item.description !== null && <p>{item.description}</p>}
      {latest ? <VersionFacts version={latest} /> : <p className={styles.muted}>No versions yet</p>}
      <div className={styles.top}>
        <span className={styles.muted}>
          {`${String(count)} ${count === 1 ? 'objective' : 'objectives'} linked`}
        </span>
        <Button
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`Details for ${item.title}`}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          {open ? 'Hide details' : 'Details'}
        </Button>
      </div>
      {open && (
        <section id={panelId} className={styles.detail} aria-label={`Details for ${item.title}`}>
          <h3 className={styles.sectionHead}>Versions</h3>
          {item.versions.length === 0 ? (
            <p className={styles.muted}>Nothing recorded yet.</p>
          ) : (
            <ol className={styles.versions}>
              {item.versions.map((version) => (
                <li key={version.version} className={styles.version}>
                  <span className={styles.versionNo}>{`Version ${String(version.version)}`}</span>
                  <VersionFacts version={version} />
                  {version.kind === 'file' && (
                    <a
                      className={styles.download}
                      href={downloadPath(item.id, version.version)}
                      aria-label={`Download version ${String(version.version)}`}
                    >
                      Download
                    </a>
                  )}
                </li>
              ))}
            </ol>
          )}
          {item.containsCui ? (
            <ReferenceForm item={item} state={state} />
          ) : (
            <UploadPanel item={item} state={state} />
          )}
          <ObjectiveLinks
            saved={item.objectiveIds}
            onSave={(ids) => state.putObjectives(item.id, ids)}
          />
        </section>
      )}
    </li>
  );
}
