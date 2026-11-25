import { UPLOAD_EXTENSIONS, type Policy } from '@rampart/api/contract';
import { useId, useState } from 'react';
import { Alert, FileField } from '../../look';
import styles from './policies.module.css';
import { RequirementLinks } from './RequirementLinks';
import { failureText, formatSize, latestVersion } from './usePolicies';

export interface PolicyItemProps {
  policy: Policy;
  uploadVersion: (policy: Policy, file: File) => Promise<void>;
  saveLinks: (policy: Policy, requirementIds: string[]) => Promise<void>;
}

function downloadPath(policy: Policy, version: number): string {
  return `/api/policies/${encodeURIComponent(policy.id)}/versions/${String(version)}/file`;
}

/** One policy: its latest file, every version with a download link, an upload and its links. */
export function PolicyItem({ policy, uploadVersion, saveLinks }: PolicyItemProps) {
  const titleId = useId();
  const latest = latestVersion(policy);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [uploaded, setUploaded] = useState(0);

  async function upload(file: File | null) {
    if (file === null || pending) return;
    setPending(true);
    setFailure(null);
    try {
      await uploadVersion(policy, file);
      setUploaded((n) => n + 1);
    } catch (caught) {
      setFailure(failureText(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <li className={styles.item} aria-labelledby={titleId}>
      <div className={styles.head}>
        <h3 id={titleId} className={styles.title}>
          {policy.title}
        </h3>
        {policy.description !== null && <p className={styles.description}>{policy.description}</p>}
      </div>

      {latest === undefined ? (
        <p className={styles.muted}>No file uploaded yet.</p>
      ) : (
        <dl className={styles.latest}>
          <dt>Latest file</dt>
          <dd className={styles.mono}>
            <span className={styles.fileName}>{latest.fileName}</span>
            <span> · </span>
            <span>{formatSize(latest.size)}</span>
          </dd>
          <dt>SHA-256</dt>
          <dd className={[styles.mono, styles.hash].join(' ')}>{latest.sha256}</dd>
        </dl>
      )}

      {policy.versions.length > 0 && (
        <ul className={styles.versions} aria-label="Versions">
          {policy.versions.map((v) => (
            <li key={v.version} className={styles.version}>
              <span className={styles.mono}>v{v.version}</span>
              <span className={styles.muted}>
                {v.createdAt.slice(0, 10)} by {v.createdBy.displayName}
              </span>
              <a
                className={styles.download}
                href={downloadPath(policy, v.version)}
                aria-label={`Download version ${String(v.version)}, ${v.fileName}`}
              >
                Download
              </a>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.upload}>
        {failure !== null && <Alert tone="error">{failure}</Alert>}
        <FileField
          label="Upload a new version"
          accept={UPLOAD_EXTENSIONS.join(',')}
          disabled={pending}
          reset={uploaded}
          onFileChange={(file) => void upload(file)}
        />
      </div>

      <RequirementLinks linked={policy.requirementIds} onSave={(ids) => saveLinks(policy, ids)} />
    </li>
  );
}
