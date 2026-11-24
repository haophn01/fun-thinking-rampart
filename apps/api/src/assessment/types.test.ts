// The api sends `evaluateAssessment`'s result as the contract's `evaluation`. `tsc` checks the
// type half (it fails on any drift); the runtime half checks a stored evaluation parses unchanged.
import type { Evaluation } from '@rampart/rules';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { assessmentViewSchema, evaluationSchema, type AssessmentView } from '../contract';
import { createHarness, type Harness } from '../testing/harness';
import { evaluateStored, findActiveAssessment, readView } from './repository';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

describe('contract matches rules', () => {
  it('z.infer of evaluationSchema equals the rules Evaluation type', async () => {
    expectTypeOf<z.infer<typeof evaluationSchema>>().toEqualTypeOf<Evaluation>();
    expectTypeOf<ReturnType<typeof evaluateStored>>().toEqualTypeOf<
      z.infer<typeof evaluationSchema>
    >();
    expectTypeOf<ReturnType<typeof readView>>().toEqualTypeOf<AssessmentView>();

    const h = createHarness();
    harnesses.push(h);
    const admin = await h.setupAdmin();
    await admin.put('/api/assessment/objectives/3.1.1%5Ba%5D', { status: 'not_met', note: null });

    const active = findActiveAssessment(h.db);
    expect(active).toBeDefined();
    const evaluation = evaluateStored(h.db, active?.id ?? '');
    expect(evaluationSchema.parse(evaluation)).toEqual(evaluation);
    const view = readView(h.db, h.clock.now());
    expect(assessmentViewSchema.parse(view)).toEqual(view);
    expect(view.evaluation).toEqual(evaluation);
  });
});
