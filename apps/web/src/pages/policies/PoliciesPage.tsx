import { useId, type ReactNode } from 'react';
import { Alert, Button, SectionLabel } from '../../look';
import { usePageTitle } from '../usePageTitle';
import styles from './policies.module.css';
import { PolicyForm } from './PolicyForm';
import { PolicyItem } from './PolicyItem';
import { usePolicies } from './usePolicies';

/** The same text as the Evidence page's banner. */
const CUI_BANNER =
  "Don't upload CUI. Rampart V1 isn't approved to store CUI. Mark CUI evidence as Contains CUI and record where the file lives.";

function Section({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionHead}>
        <SectionLabel number={number}>{title}</SectionLabel>
      </h2>
      {children}
    </section>
  );
}

/** The Policies page: the CUI banner, each policy with its files and requirement links, and a form to add one. */
export function PoliciesPage() {
  usePageTitle('Policies');
  const state = usePolicies();
  const { policies, loadFailed } = state;

  let list: ReactNode;
  if (loadFailed && policies === null) {
    list = (
      <Alert tone="error" title="Can't load policies">
        <p>Check that the API is running, then retry.</p>
        <Button
          className={styles.retry}
          onClick={() => {
            void state.reload();
          }}
        >
          Retry
        </Button>
      </Alert>
    );
  } else if (policies === null) {
    list = <p className={styles.muted}>Loading policies…</p>;
  } else if (policies.length === 0) {
    list = <p className={styles.muted}>No policies yet. Add the first one below.</p>;
  } else {
    list = (
      <ul className={styles.list}>
        {policies.map((policy) => (
          <PolicyItem
            key={policy.id}
            policy={policy}
            uploadVersion={state.uploadVersion}
            saveLinks={state.saveLinks}
          />
        ))}
      </ul>
    );
  }

  return (
    <section className={styles.page}>
      <h1>Policies</h1>
      <Alert tone="info">{CUI_BANNER}</Alert>
      <Section number={1} title="Policies">
        {list}
      </Section>
      <Section number={2} title="New policy">
        <PolicyForm onCreate={state.create} />
      </Section>
    </section>
  );
}
