import { loadCatalog } from '@rampart/catalog';
import type { AssessmentInput, Evaluation } from '@rampart/rules';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useWhatIf } from './useWhatIf';

const catalog = loadCatalog();
const allMet: AssessmentInput = {
  objectiveResults: catalog.requirements.flatMap((r) =>
    r.objectives.map((o) => ({ objectiveId: o.id, status: 'met' as const })),
  ),
  implementationLevels: {},
};
const empty: AssessmentInput = { objectiveResults: [], implementationLevels: {} };

function scoreOf(evaluation: Evaluation): number | null {
  return evaluation.score.kind === 'scored' ? evaluation.score.score : null;
}

describe('what-if state', () => {
  it('is inactive at first and evaluates the saved input', () => {
    const { result } = renderHook(() => useWhatIf(allMet));
    expect(result.current.active).toBe(false);
    expect(scoreOf(result.current.evaluation)).toBe(110);
    expect(result.current.diff).toEqual({ scoreDelta: 0, changed: [] });
    expect(result.current.changes).toEqual({});
  });

  it('setObjective updates the evaluation and diff', () => {
    const { result } = renderHook(() => useWhatIf(allMet));
    act(() => {
      result.current.start();
    });
    expect(result.current.active).toBe(true);
    act(() => {
      result.current.setObjective('3.1.1[a]', 'not_met');
    });
    expect(scoreOf(result.current.evaluation)).toBe(105);
    expect(result.current.diff.scoreDelta).toBe(-5);
    expect(result.current.diff.changed).toEqual([
      { requirementId: 'AC.L2-3.1.1', from: 'met', to: 'not_met' },
    ]);
    expect(result.current.changes.objectiveStatuses).toEqual({ '3.1.1[a]': 'not_met' });
  });

  it('setLevel updates the evaluation, and null is a change back to saved', () => {
    const { result } = renderHook(() => useWhatIf(allMet));
    act(() => {
      result.current.start();
    });
    act(() => {
      result.current.setObjective('3.13.11[a]', 'not_met');
    });
    expect(scoreOf(result.current.evaluation)).toBe(105);
    act(() => {
      result.current.setLevel('SC.L2-3.13.11', 'partial');
    });
    expect(scoreOf(result.current.evaluation)).toBe(107);
    expect(result.current.changes.implementationLevels).toEqual({ 'SC.L2-3.13.11': 'partial' });
    act(() => {
      result.current.setLevel('SC.L2-3.13.11', null);
    });
    expect(result.current.changes.implementationLevels).toBeUndefined();
    expect(scoreOf(result.current.evaluation)).toBe(105);
  });

  it('setting a saved value back gives no changes', () => {
    const { result } = renderHook(() => useWhatIf(allMet));
    act(() => {
      result.current.start();
    });
    act(() => {
      result.current.setObjective('3.1.1[a]', 'not_met');
    });
    act(() => {
      result.current.setObjective('3.1.1[a]', 'met');
    });
    expect(result.current.changes).toEqual({});
    expect(result.current.diff).toEqual({ scoreDelta: 0, changed: [] });
  });

  it('an objective with no saved result counts as not_assessed', () => {
    const { result } = renderHook(() => useWhatIf(empty));
    act(() => {
      result.current.start();
    });
    act(() => {
      result.current.setObjective('3.1.1[a]', 'met');
    });
    expect(result.current.changes.objectiveStatuses).toEqual({ '3.1.1[a]': 'met' });
    act(() => {
      result.current.setObjective('3.1.1[a]', 'not_assessed');
    });
    expect(result.current.changes).toEqual({});
  });

  it('reset clears the changes and stays active; exit leaves what-if', () => {
    const { result } = renderHook(() => useWhatIf(allMet));
    act(() => {
      result.current.start();
    });
    act(() => {
      result.current.setObjective('3.1.1[a]', 'not_met');
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.changes).toEqual({});
    expect(result.current.active).toBe(true);
    act(() => {
      result.current.setObjective('3.1.1[a]', 'not_met');
    });
    act(() => {
      result.current.exit();
    });
    expect(result.current.active).toBe(false);
    expect(result.current.changes).toEqual({});
    expect(scoreOf(result.current.evaluation)).toBe(110);
    // Starting again begins from the saved input, not the changes exit discarded.
    act(() => {
      result.current.start();
    });
    expect(result.current.active).toBe(true);
    expect(result.current.changes).toEqual({});
    expect(result.current.diff).toEqual({ scoreDelta: 0, changed: [] });
    expect(scoreOf(result.current.evaluation)).toBe(110);
  });

  it('unmounting drops the changes; a new mount starts from the saved input', () => {
    const first = renderHook(() => useWhatIf(allMet));
    act(() => {
      first.result.current.start();
    });
    act(() => {
      first.result.current.setObjective('3.1.1[a]', 'not_met');
    });
    first.unmount();
    const { result } = renderHook(() => useWhatIf(allMet));
    act(() => {
      result.current.start();
    });
    expect(result.current.changes).toEqual({});
    expect(scoreOf(result.current.evaluation)).toBe(110);
  });

  it('follows a new saved input', () => {
    const { result, rerender } = renderHook(({ saved }) => useWhatIf(saved), {
      initialProps: { saved: allMet },
    });
    act(() => {
      result.current.start();
    });
    act(() => {
      result.current.setObjective('3.1.1[a]', 'not_met');
    });
    rerender({ saved: empty });
    expect(result.current.evaluation.score.kind).toBe('incomplete');
    expect(result.current.diff.scoreDelta).toBeNull();
  });
});
