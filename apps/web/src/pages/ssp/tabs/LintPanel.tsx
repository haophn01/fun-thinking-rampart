import {
  SSP_LARGE_IMAGE_BYTES,
  SSP_MAX_EMBEDDED_IMAGES,
  type AssessmentView,
  type AssetsResponse,
  type DiagramsResponse,
  type DocumentControl,
} from '@rampart/api/contract';
import { loadCatalog } from '@rampart/catalog';
import { SSP_LINT_RULES, lintSspFrom, type SspLintFinding, type SspLintRule } from '@rampart/rules';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Alert, Button } from '../../../look';
import { LoadError, Section, type Loaded } from '../kit';
import styles from './lint.module.css';

const catalog = loadCatalog();
const FAMILY_OF = new Map(catalog.requirements.map((r) => [r.id, r.family]));
const LIMITS = {
  maxEmbeddedImages: SSP_MAX_EMBEDDED_IMAGES,
  largeImageBytes: SSP_LARGE_IMAGE_BYTES,
};
/** A group shows this many messages until "Show all". */
const SHOWN = 10;

/** Where a rule's subject lives, for the rules that point at a tab rather than a requirement. */
const TAB_OF: Partial<Record<SspLintRule['id'], { tab: string; name: string }>> = {
  no_assets: { tab: 'assets', name: 'Assets' },
  out_of_scope_unjustified: { tab: 'assets', name: 'Assets' },
  no_network_diagram: { tab: 'environment', name: 'Environment' },
  large_image: { tab: 'environment', name: 'Environment' },
  image_limit: { tab: 'environment', name: 'Environment' },
  review_overdue: { tab: 'document-control', name: 'Document control' },
};

export interface LintLoads {
  view: Loaded<AssessmentView>;
  assets: Loaded<AssetsResponse>;
  diagrams: Loaded<DiagramsResponse>;
  control: Loaded<DocumentControl>;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** "1 error · 2 warnings", counted by severity. */
export function summarize(findings: readonly SspLintFinding[]): string {
  const errors = findings.filter((f) => f.severity === 'error').length;
  return `${plural(errors, 'error')} · ${plural(findings.length - errors, 'warning')}`;
}

function Group({ rule, findings }: { rule: SspLintRule; findings: readonly SspLintFinding[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? findings : findings.slice(0, SHOWN);
  const target = TAB_OF[rule.id];
  return (
    <Alert
      tone={rule.severity === 'error' ? 'error' : 'info'}
      title={`${rule.label} · ${String(findings.length)}`}
    >
      <ul className={styles.list}>
        {shown.map((finding, index) => {
          const family =
            finding.requirementId === null ? undefined : FAMILY_OF.get(finding.requirementId);
          return (
            <li key={`${finding.subjectId ?? finding.requirementId ?? ''}-${String(index)}`}>
              <span data-message>{finding.message}</span>
              {finding.requirementId !== null && family !== undefined && (
                <>
                  {' '}
                  <Link
                    className={styles.link}
                    to={`/assessment?family=${family}&req=${finding.requirementId}`}
                  >
                    {`Open ${finding.requirementId}`}
                  </Link>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {findings.length > SHOWN && !all && (
        <Button
          onClick={() => {
            setAll(true);
          }}
        >
          {`Show all ${String(findings.length)}`}
        </Button>
      )}
      <p className={styles.hint}>{rule.hint}</p>
      {target !== undefined && (
        <p className={styles.hint}>
          <Link className={styles.link} to={`/ssp?tab=${target.tab}`}>
            {`Open ${target.name}`}
          </Link>
        </p>
      )}
    </Alert>
  );
}

function Results({ findings }: { findings: readonly SspLintFinding[] }) {
  return (
    <>
      <p className={styles.summary} aria-live="polite">
        {findings.length === 0 ? 'No findings. Every check passes.' : summarize(findings)}
      </p>
      {SSP_LINT_RULES.map((rule) => {
        const mine = findings.filter((f) => f.rule === rule.id);
        return mine.length === 0 ? null : <Group key={rule.id} rule={rule} findings={mine} />;
      })}
    </>
  );
}

/** Section 2 of Lint & export: the same lint as the api, run live over the SSP's four reads. */
export function LintPanel({ loads }: { loads: LintLoads }) {
  const { view, assets, diagrams, control } = loads;
  const ready =
    view.data !== null && assets.data !== null && diagrams.data !== null && control.data !== null;
  const findings = useMemo(() => {
    if (
      view.data === null ||
      assets.data === null ||
      diagrams.data === null ||
      control.data === null
    )
      return null;
    return lintSspFrom(
      catalog,
      {
        view: view.data,
        assets: assets.data.assets,
        diagrams: diagrams.data.diagrams,
        review: control.data,
      },
      LIMITS,
    );
  }, [view.data, assets.data, diagrams.data, control.data]);

  const checkAgain = () => {
    void Promise.all([view.reload(), assets.reload(), diagrams.reload(), control.reload()]);
  };
  const failed = [view, assets, diagrams, control].some((l) => l.failed && l.data === null);

  let body;
  if (findings !== null) {
    body = (
      <>
        <Results findings={findings} />
        <div>
          <Button onClick={checkAgain}>Check again</Button>
        </div>
      </>
    );
  } else if (failed) {
    body = <LoadError title="Can't run the pre-export check" onRetry={checkAgain} />;
  } else {
    body = <p className={styles.muted}>{ready ? '' : 'Running the pre-export check…'}</p>;
  }

  return (
    <Section number={2} title="Pre-export check">
      <div className={styles.panel}>{body}</div>
    </Section>
  );
}
