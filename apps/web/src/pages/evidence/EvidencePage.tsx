import { Alert, Button } from '../../look';
import { usePageTitle } from '../usePageTitle';
import { EvidenceForm } from './EvidenceForm';
import { EvidenceItemCard } from './EvidenceItem';
import styles from './evidence.module.css';
import { useEvidence } from './useEvidence';

/** Shown on every state of the page: Rampart V1 never stores CUI. */
const CUI_BANNER =
  "Don't upload CUI. Rampart V1 isn't approved to store CUI. Mark CUI evidence as Contains CUI and record where the file lives.";

/** The Evidence page: items, file versions, CUI references and links to objectives. */
export function EvidencePage() {
  usePageTitle('Evidence');
  const state = useEvidence();
  const { load } = state;

  return (
    <section className={styles.page}>
      <h1>Evidence</h1>
      <Alert tone="info">{CUI_BANNER}</Alert>
      {load.status === 'loading' && <p className={styles.muted}>Loading…</p>}
      {load.status === 'error' && (
        <Alert tone="error" title="The evidence could not be loaded">
          <p>{load.problem.message}</p>
          {load.problem.requestId !== undefined && (
            <p className={styles.mono}>Request ID: {load.problem.requestId}</p>
          )}
          <div className={styles.retry}>
            <Button onClick={state.retry}>Retry</Button>
          </div>
        </Alert>
      )}
      {load.status === 'ready' && (
        <>
          <section className={styles.section} aria-labelledby="evidence-new">
            <h2 id="evidence-new" className={styles.sectionHead}>
              New evidence item
            </h2>
            <EvidenceForm onCreate={state.create} />
          </section>
          {load.items.length === 0 ? (
            <p className={styles.muted}>No evidence yet.</p>
          ) : (
            <ul className={styles.list}>
              {load.items.map((item) => (
                <EvidenceItemCard key={item.id} item={item} state={state} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
