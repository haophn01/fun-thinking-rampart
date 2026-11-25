import {
  CLOSEOUT_CONFIRMER_LABELS,
  INELIGIBLE_REASON_LABELS,
  type PoamView,
} from '@rampart/api/contract';
import { loadCatalog } from '@rampart/catalog';
import { useState } from 'react';
import { useSession } from '../../auth/session';
import { Alert, Button, SectionLabel } from '../../look';
import { usePageTitle } from '../usePageTitle';
import { PoamForm } from './PoamForm';
import { PoamItem, dayCount, type ItemPanel } from './PoamItem';
import styles from './poam.module.css';
import { usePoam } from './usePoam';

const catalog = loadCatalog();
const TEXT = new Map<string, string>(catalog.requirements.map((r) => [r.id, r.text]));
const textOf = (id: string) => TEXT.get(id) ?? '';

function clockText(closeout: PoamView['closeout']): string {
  if (closeout === null) {
    return 'Set the Conditional Status Date in Settings to start the 180-day clock';
  }
  return closeout.expired
    ? `Deadline ${closeout.deadline}, passed ${dayCount(-closeout.daysRemaining)} ago`
    : `Deadline ${closeout.deadline}, ${dayCount(closeout.daysRemaining)} left`;
}

/** The POA&M page: the closeout clock, candidates, items with milestones, and closeout. */
export function PoamPage() {
  usePageTitle('POA&M');
  const { user } = useSession();
  const poam = usePoam();
  const [creating, setCreating] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ id: string; panel: Exclude<ItemPanel, null> } | null>(null);

  if (poam.load.status === 'loading') {
    return (
      <section>
        <h1>POA&amp;M</h1>
        <p role="status" className={styles.muted}>
          Loading…
        </p>
      </section>
    );
  }
  if (poam.load.status === 'error') {
    const { problem } = poam.load;
    return (
      <section>
        <h1>POA&amp;M</h1>
        <Alert tone="error" title="The POA&M could not be loaded">
          <p>{problem.message}</p>
          {problem.requestId !== undefined && (
            <p className={styles.mono}>{`Request ID: ${problem.requestId}`}</p>
          )}
          <div className={styles.retry}>
            <Button onClick={poam.retry}>Retry</Button>
          </div>
        </Alert>
      </section>
    );
  }

  const { view } = poam.load;
  const isAdmin = user?.role === 'admin';
  const open = view.items.filter((i) => i.status === 'open');
  const closed = view.items.filter((i) => i.status === 'closed');
  const creatingCandidate = view.candidates.find((c) => c.requirementId === creating);

  const renderItem = (item: PoamView['items'][number]) => (
    <PoamItem
      key={item.id}
      item={item}
      requirementText={textOf(item.requirementId)}
      confirmer={view.confirmer}
      isAdmin={isAdmin}
      users={poam.users}
      panel={panel?.id === item.id ? panel.panel : null}
      onPanel={(next) => {
        setPanel(next === null ? null : { id: item.id, panel: next });
      }}
      onCreate={poam.create}
      onPatch={poam.patch}
      onCloseout={poam.closeout}
    />
  );

  return (
    <section className={styles.page}>
      <h1>POA&amp;M</h1>

      <section className={styles.section} aria-label="Closeout clock">
        <h2 className={styles.sectionHead}>
          <SectionLabel number={1}>Closeout clock</SectionLabel>
        </h2>
        <p>{clockText(view.closeout)}</p>
        <p className={styles.muted}>
          {`Closeout confirmed by: ${CLOSEOUT_CONFIRMER_LABELS[view.confirmer]}`}
        </p>
      </section>

      {creatingCandidate !== undefined && (
        <PoamForm
          key={creatingCandidate.requirementId}
          mode={{
            kind: 'create',
            requirementId: creatingCandidate.requirementId,
            requirementText: textOf(creatingCandidate.requirementId),
          }}
          users={poam.users}
          onCreate={poam.create}
          onPatch={poam.patch}
          onClose={() => {
            setCreating(null);
          }}
        />
      )}

      <section className={styles.section} aria-label="POA&M items section">
        <h2 className={styles.sectionHead}>
          <SectionLabel number={2}>{`Open items · ${String(open.length)}`}</SectionLabel>
        </h2>
        {open.length === 0 ? (
          <p className={styles.muted}>No open POA&amp;M items.</p>
        ) : (
          <ul className={styles.list} aria-label="POA&M items">
            {open.map(renderItem)}
          </ul>
        )}
        {closed.length > 0 && (
          <>
            <h3 className={styles.subHead}>{`Closed · ${String(closed.length)}`}</h3>
            <ul className={styles.list} aria-label="Closed POA&M items">
              {closed.map(renderItem)}
            </ul>
          </>
        )}
      </section>

      <section className={styles.section} aria-label="Not Met requirements">
        <h2 className={styles.sectionHead}>
          <SectionLabel number={3}>Not Met requirements</SectionLabel>
        </h2>
        {view.candidates.length === 0 ? (
          <p className={styles.muted}>No Not Met requirements without an open item.</p>
        ) : (
          <ul className={styles.list} aria-label="Candidates">
            {view.candidates.map((c) => (
              <li
                key={c.requirementId}
                className={styles.card}
                data-eligible={c.eligibility.eligible}
              >
                <div className={styles.top}>
                  <span className={styles.mono}>{c.requirementId}</span>
                  <Button
                    disabled={!c.eligibility.eligible}
                    onClick={() => {
                      setCreating(c.requirementId);
                    }}
                  >
                    Add to POA&amp;M
                  </Button>
                </div>
                <p>{textOf(c.requirementId)}</p>
                {!c.eligibility.eligible && (
                  <div className={styles.reasons}>
                    {c.eligibility.reasons.map((reason) => (
                      <p key={reason.code}>
                        {INELIGIBLE_REASON_LABELS[reason.code]}{' '}
                        <span className={styles.citation}>{reason.citation}</span>
                      </p>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
