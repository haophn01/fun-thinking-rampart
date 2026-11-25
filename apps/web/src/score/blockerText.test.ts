import { loadCatalog } from '@rampart/catalog';
import type { Blocker } from '@rampart/rules';
import { REGULATION } from '@rampart/rules/poam';
import { describe, expect, it } from 'vitest';
import { blockerText } from './blockerText';

const catalog = loadCatalog();

describe('blockerText', () => {
  it('poam_missing text', () => {
    const blocker: Blocker = {
      code: 'poam_missing',
      requirementId: 'AC.L2-3.1.3',
      citation: REGULATION.poamRequiredForNotMet.citation,
    };
    expect(blockerText(blocker, catalog)).toBe('AC.L2-3.1.3 is Not Met and has no open POA&M item');
    // The citation is shown separately, never in the sentence.
    expect(blockerText(blocker, catalog)).not.toContain('CFR');
  });
});
