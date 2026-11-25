import { loadCatalog } from '@rampart/catalog';
import {
  compareEvaluations,
  evaluateAssessment,
  type AssessmentInput,
  type Blocker,
  type IneligibleCode,
} from '@rampart/rules';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { blockerText } from './blockerText';
import { ScorePanel, formatDelta } from './ScorePanel';

const catalog = loadCatalog();
type Status = 'met' | 'not_met' | 'not_assessed';

function evalOf(statusFor: (requirementId: string) => Status) {
  const input: AssessmentInput = {
    objectiveResults: catalog.requirements.flatMap((r) =>
      r.objectives.map((o) => ({ objectiveId: o.id, status: statusFor(r.id) })),
    ),
    implementationLevels: {},
  };
  return evaluateAssessment(catalog, input);
}

describe('saved score', () => {
  it('final shows 110, / 110 and its label', () => {
    render(<ScorePanel saved={evalOf(() => 'met')} />);
    expect(screen.getByTestId('score-value')).toHaveTextContent('110');
    expect(screen.getByText('/ 110')).toBeInTheDocument();
    expect(screen.getByText('Final status reachable')).toBeInTheDocument();
  });

  it('conditional shows its label', () => {
    const saved = evalOf((id) => (id === 'AC.L2-3.1.3' ? 'not_met' : 'met'));
    expect(saved.conditional.status).toBe('conditional');
    render(<ScorePanel saved={saved} />);
    expect(screen.getByText('Conditional status reachable')).toBeInTheDocument();
    expect(screen.getByTestId('score-value')).toHaveTextContent('109');
  });

  it('not eligible shows its label and blockers in order with citations', () => {
    const saved = evalOf((id) => (id === 'AC.L2-3.1.20' ? 'not_met' : 'met'));
    expect(saved.conditional.status).toBe('not_eligible');
    expect(saved.conditional.blockers.length).toBeGreaterThan(0);
    render(<ScorePanel saved={saved} />);
    expect(screen.getByText('Not eligible')).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Blockers' })).getAllByRole('listitem');
    expect(items).toHaveLength(saved.conditional.blockers.length);
    saved.conditional.blockers.forEach((blocker, i) => {
      const item = items[i] as HTMLElement;
      expect(item).toHaveTextContent(blockerText(blocker, catalog));
      if ('citation' in blocker) {
        expect(within(item).getByText(blocker.citation)).toHaveAttribute('data-cite');
      }
    });
  });

  it('incomplete shows the dash and the prerequisite message', () => {
    const saved = evalOf((id) => (id === 'CA.L2-3.12.4' ? 'not_assessed' : 'met'));
    expect(saved.conditional.status).toBe('incomplete');
    render(<ScorePanel saved={saved} />);
    expect(screen.getByText('Assessment incomplete')).toBeInTheDocument();
    expect(screen.getByTestId('score-value')).toHaveTextContent('—');
    expect(
      screen.getByText('CA.L2-3.12.4 System Security Plan must be Met before a score exists'),
    ).toBeInTheDocument();
  });

  it('shows no what-if notice without a what-if', () => {
    render(<ScorePanel saved={evalOf(() => 'met')} />);
    expect(screen.queryByText('What-if — not saved')).not.toBeInTheDocument();
  });
});

describe('what-if display', () => {
  it('formats deltas', () => {
    expect(formatDelta(5)).toBe('+5');
    expect(formatDelta(-3)).toBe('−3');
    expect(formatDelta(0)).toBe('±0');
    expect(formatDelta(null)).toBe('—');
  });

  it('shows the notice, the what-if score, the delta and the changed count', () => {
    const saved = evalOf(() => 'met');
    const whatIf = evalOf((id) =>
      id === 'AC.L2-3.1.1' || id === 'AC.L2-3.1.2' ? 'not_met' : 'met',
    );
    const diff = compareEvaluations(saved, whatIf);
    render(<ScorePanel saved={saved} whatIf={whatIf} diff={diff} />);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('What-if — not saved');
    expect(notice).toHaveTextContent('−10');
    expect(notice).toHaveTextContent('2 requirements changed');
    expect(screen.getByTestId('score-value')).toHaveTextContent('100');
  });

  it('uses the singular for one change, and a null delta shows a dash', () => {
    const saved = evalOf(() => 'met');
    const whatIf = evalOf((id) => (id === 'CA.L2-3.12.4' ? 'not_met' : 'met'));
    const diff = compareEvaluations(saved, whatIf);
    expect(diff.scoreDelta).toBeNull();
    render(<ScorePanel saved={saved} whatIf={whatIf} diff={diff} />);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('1 requirement changed');
    expect(notice).toHaveTextContent('Change —');
  });
});

describe('blocker text', () => {
  const reasons: IneligibleCode[] = ['not_not_met', 'barred', 'exceeds_point_limit'];
  const blockers: Blocker[] = [
    { code: 'prerequisite_not_met', requirementId: 'CA.L2-3.12.4', citation: 'c' },
    { code: 'not_assessed', requirementIds: ['AC.L2-3.1.1', 'AC.L2-3.1.2'] },
    { code: 'below_threshold', score: 80, threshold: 88, citation: 'c' },
    { code: 'poam_ineligible', requirementId: 'AC.L2-3.1.20', reasons, citation: 'c' },
  ];

  it('covers every Blocker code', () => {
    for (const blocker of blockers) {
      expect(blockerText(blocker, catalog).length).toBeGreaterThan(10);
    }
    const below = blockerText(blockers[2] as Blocker, catalog);
    expect(below).toContain('80');
    expect(below).toContain('88');
    expect(blockerText(blockers[1] as Blocker, catalog)).toContain('2 requirements');
  });

  it('covers every IneligibleCode with a different phrase', () => {
    const texts = reasons.map((reason) =>
      blockerText(
        {
          code: 'poam_ineligible',
          requirementId: 'AC.L2-3.1.20',
          reasons: [reason],
          citation: 'c',
        },
        catalog,
      ),
    );
    expect(new Set(texts).size).toBe(3);
    for (const text of texts) expect(text).toContain('AC.L2-3.1.20');
  });

  it('survives an unknown requirement id', () => {
    expect(
      blockerText(
        { code: 'prerequisite_not_met', requirementId: 'ZZ.L2-9', citation: 'c' },
        catalog,
      ),
    ).toContain('ZZ.L2-9');
  });
});
