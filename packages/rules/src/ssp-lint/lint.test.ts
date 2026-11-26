import { describe, expect, it } from 'vitest';
import * as rules from '../index';
import {
  asset,
  catalog,
  cleanSources,
  deepFrozen,
  diagram,
  LIMITS,
  MIB,
  outcome,
  RULE_FIXTURES,
  sourcesWith,
  SSP_ID,
} from './fixtures';
import { FUTURE_TENSE_TERMS } from './future-tense';
import { lintSspFrom } from './lint';
import { SSP_LINT_RULES, SSP_LINT_VERSION } from './rules';
import type { SspLintFinding, SspLintRuleId, SspLintSources } from './types';

const lint = (sources: SspLintSources, limits = LIMITS) => lintSspFrom(catalog, sources, limits);

/** The findings of one rule. */
const of = (rule: SspLintRuleId, sources: SspLintSources, limits = LIMITS) =>
  lint(sources, limits).filter((f) => f.rule === rule);

/** A finding with the rule's severity and hint. */
function finding(
  rule: SspLintRuleId,
  requirementId: string | null,
  subjectId: string | null,
  message: string,
): SspLintFinding {
  const data = SSP_LINT_RULES.find((r) => r.id === rule);
  return {
    rule,
    severity: data?.severity ?? 'error',
    requirementId,
    subjectId,
    message,
    hint: data?.hint ?? '',
  };
}

const BLANKS = [null, '', '   \n\t'];

describe('lintSspFrom', () => {
  it('rule data', () => {
    expect(SSP_LINT_VERSION).toBe('1.0.0');
    expect(FUTURE_TENSE_TERMS).toEqual([
      'will',
      'plan to',
      'planned',
      'intend',
      'going to',
      'to be implemented',
      'TBD',
    ]);
    expect(SSP_LINT_RULES).toEqual([
      {
        id: 'ssp_requirement_not_met',
        severity: 'error',
        label: "The SSP requirement isn't Met",
        hint: "Finish the SSP and mark CA.L2-3.12.4's objectives. It can't go on a POA&M.",
      },
      {
        id: 'no_assets',
        severity: 'error',
        label: 'No assets',
        hint: 'Record each asset on SSP \u203a Assets by its CMMC category (32 CFR 170.19).',
      },
      {
        id: 'out_of_scope_unjustified',
        severity: 'error',
        label: 'Out-of-scope asset without a justification',
        hint: "Say why the asset can't process, store or transmit CUI.",
      },
      {
        id: 'no_network_diagram',
        severity: 'error',
        label: 'No network diagram',
        hint: 'Link a network diagram on SSP \u203a Environment.',
      },
      {
        id: 'review_overdue',
        severity: 'error',
        label: 'Review overdue',
        hint: 'Review the SSP, then set the next review date or record an approval on SSP \u203a Document control.',
      },
      {
        id: 'empty_statement',
        severity: 'error',
        label: 'Empty implementation statements',
        hint: 'Describe how the requirement is met today, in the present tense.',
      },
      {
        id: 'not_met_without_poam',
        severity: 'error',
        label: 'Not Met without an open POA&M item',
        hint: "Add an open POA&M item, or meet the requirement if it can't go on one.",
      },
      {
        id: 'na_without_rationale',
        severity: 'warning',
        label: 'N/A without a rationale',
        hint: "Say why the N/A objectives don't apply, in the requirement's N/A rationale.",
      },
      {
        id: 'future_tense',
        severity: 'warning',
        label: 'Future-tense statements',
        hint: 'Describe what is in place now. Put what is still to come in Planned implementation and the POA&M.',
      },
      {
        id: 'ssp_poam_mismatch',
        severity: 'warning',
        label: 'SSP and POA&M disagree',
        hint: 'Close the POA&M item, or correct the objective status, so the SSP, POA&M and score agree.',
      },
      {
        id: 'large_image',
        severity: 'warning',
        label: 'Large images',
        hint: 'Export a smaller image, or link a PDF instead.',
      },
      {
        id: 'image_limit',
        severity: 'warning',
        label: 'Images over the embed limit',
        hint: "Remove diagrams you don't need, or accept that the rest are referenced.",
      },
    ]);
    // The package entry point re-exports the lint.
    expect(rules.SSP_LINT_RULES).toBe(SSP_LINT_RULES);
    expect(rules.SSP_LINT_VERSION).toBe(SSP_LINT_VERSION);
    expect(rules.FUTURE_TENSE_TERMS).toBe(FUTURE_TENSE_TERMS);
    expect(rules.lintSspFrom).toBe(lintSspFrom);
  });

  it('one fixture per rule fires its rule', () => {
    for (const data of SSP_LINT_RULES) {
      expect(of(data.id, RULE_FIXTURES[data.id]).length, data.id).toBeGreaterThan(0);
    }
    expect(SSP_LINT_RULES.map((r) => r.id).sort()).toEqual(Object.keys(RULE_FIXTURES).sort());
  });

  it('future tense', () => {
    const sources = sourcesWith({
      states: [
        // Catalog order is 3.1.1, 3.1.5, 3.1.9; the states are given out of order.
        { requirementId: 'AC.L2-3.1.9', implementationStatement: 'Logs are TBD.' },
        {
          requirementId: 'AC.L2-3.1.1',
          implementationStatement: 'TBD: we will, and WILL again, add\nMFA.',
        },
        // Blank statements never fire this rule; plannedImplementation is never checked.
        { requirementId: 'AC.L2-3.1.5', implementationStatement: '  ' },
        {
          requirementId: 'AC.L2-3.1.10',
          implementationStatement: 'Sessions lock after 15 minutes.',
          plannedImplementation: 'We will add a banner. TBD.',
        },
      ],
    });
    expect(of('future_tense', sources)).toEqual([
      finding(
        'future_tense',
        'AC.L2-3.1.1',
        null,
        'AC.L2-3.1.1 says "will", "TBD" (future tense).',
      ),
      finding('future_tense', 'AC.L2-3.1.9', null, 'AC.L2-3.1.9 says "TBD" (future tense).'),
    ]);
    // A requirement with no state has no statement to check.
    const noStates = cleanSources();
    expect(
      of('future_tense', { ...noStates, view: { ...noStates.view, requirementStates: [] } }),
    ).toEqual([]);
  });

  it('empty statement', () => {
    for (const blank of BLANKS) {
      const sources = sourcesWith({
        outcomes: [outcome('AC.L2-3.1.5', 'not_met'), outcome('AC.L2-3.1.9', 'not_assessed')],
        openPoamRequirementIds: ['AC.L2-3.1.5'],
        states: [
          { requirementId: 'AC.L2-3.1.1', implementationStatement: blank },
          { requirementId: 'AC.L2-3.1.5', implementationStatement: blank },
          { requirementId: 'AC.L2-3.1.9', implementationStatement: blank },
          // All N/A: no statement is needed. Partly N/A still needs one.
          { requirementId: 'AC.L2-3.1.10', implementationStatement: blank, naRationale: 'x' },
          { requirementId: 'IA.L2-3.5.3', implementationStatement: blank, naRationale: 'x' },
        ],
      });
      const allNa = {
        ...sources,
        view: {
          ...sources.view,
          evaluation: {
            outcomes: sources.view.evaluation.outcomes.map((o) =>
              o.requirementId === 'AC.L2-3.1.10'
                ? outcome('AC.L2-3.1.10', 'met', 2)
                : o.requirementId === 'IA.L2-3.5.3'
                  ? outcome('IA.L2-3.5.3', 'met', 1)
                  : o,
            ),
          },
        },
      };
      expect(of('empty_statement', allNa), JSON.stringify(blank)).toEqual(
        ['AC.L2-3.1.1', 'AC.L2-3.1.5', 'AC.L2-3.1.9', 'IA.L2-3.5.3'].map((id) =>
          finding('empty_statement', id, null, `${id} has no implementation statement.`),
        ),
      );
    }
    // No state and no outcome: not assessed with no statement, so it fires.
    const base = cleanSources();
    const bare: SspLintSources = {
      ...base,
      view: {
        ...base.view,
        requirementStates: base.view.requirementStates.filter(
          (s) => s.requirementId !== 'AC.L2-3.1.9',
        ),
        evaluation: {
          outcomes: base.view.evaluation.outcomes.filter((o) => o.requirementId !== 'AC.L2-3.1.9'),
        },
      },
    };
    expect(of('empty_statement', bare)).toEqual([
      finding(
        'empty_statement',
        'AC.L2-3.1.9',
        null,
        'AC.L2-3.1.9 has no implementation statement.',
      ),
    ]);
  });

  it('N/A rationale', () => {
    const message = (id: string) => `${id} has objectives marked N/A and no N/A rationale.`;
    const sources = sourcesWith({
      outcomes: [
        outcome('AC.L2-3.1.1', 'met', 1), // partial N/A
        outcome('AC.L2-3.1.5', 'met', 2), // all N/A
        outcome('AC.L2-3.1.9', 'met', 1), // has a rationale
        outcome('AC.L2-3.1.10', 'not_met'), // zero N/A
        outcome('IA.L2-3.5.3', 'not_met', 1), // partial N/A on a Not Met requirement
      ],
      openPoamRequirementIds: ['AC.L2-3.1.10', 'IA.L2-3.5.3'],
      states: [
        { requirementId: 'AC.L2-3.1.1', naRationale: null },
        { requirementId: 'AC.L2-3.1.5', naRationale: ' \n ' },
        { requirementId: 'AC.L2-3.1.9', naRationale: 'No wireless access exists.' },
        { requirementId: 'AC.L2-3.1.10', naRationale: null },
        { requirementId: 'IA.L2-3.5.3', naRationale: '' },
      ],
    });
    expect(of('na_without_rationale', sources)).toEqual(
      ['AC.L2-3.1.1', 'AC.L2-3.1.5', 'IA.L2-3.5.3'].map((id) =>
        finding('na_without_rationale', id, null, message(id)),
      ),
    );
    // An absent rationale (an older payload) counts as blank.
    const absent = sourcesWith({ outcomes: [outcome('AC.L2-3.1.1', 'met', 1)] });
    const states = absent.view.requirementStates.map(
      ({ requirementId, implementationStatement }) => ({
        requirementId,
        implementationStatement,
      }),
    );
    expect(
      of('na_without_rationale', {
        ...absent,
        view: { ...absent.view, requirementStates: states },
      }),
    ).toEqual([finding('na_without_rationale', 'AC.L2-3.1.1', null, message('AC.L2-3.1.1'))]);
  });

  it('Not Met without POA&M', () => {
    const message = (id: string) => `${id} is Not Met and has no open POA&M item.`;
    const notMet = [
      outcome('AC.L2-3.1.1', 'not_met'),
      outcome('AC.L2-3.1.10', 'not_met'),
      outcome('IA.L2-3.5.3', 'not_met'),
      outcome(SSP_ID, 'not_met'),
    ];
    const sources = sourcesWith({ outcomes: notMet, openPoamRequirementIds: ['AC.L2-3.1.10'] });
    expect(of('not_met_without_poam', sources)).toEqual(
      ['AC.L2-3.1.1', 'IA.L2-3.5.3'].map((id) =>
        finding('not_met_without_poam', id, null, message(id)),
      ),
    );

    // 3.12.4 Not Met with no POA&M item gives only ssp_requirement_not_met.
    expect(lint(sourcesWith({ outcomes: [outcome(SSP_ID, 'not_met')] }))).toEqual([
      finding(
        'ssp_requirement_not_met',
        SSP_ID,
        null,
        `${SSP_ID} (the SSP requirement) is Not Met, so the assessment can't be completed.`,
      ),
    ]);

    // No POA&M data: the rule is skipped.
    expect(
      of('not_met_without_poam', sourcesWith({ outcomes: notMet, openPoamRequirementIds: null })),
    ).toEqual([]);
  });

  it('no assets', () => {
    expect(of('no_assets', sourcesWith({ assets: [] }))).toEqual([
      finding('no_assets', null, null, 'No assets are recorded.'),
    ]);
    for (const category of ['cui', 'spa', 'crma', 'specialized', 'out_of_scope']) {
      const one = sourcesWith({ assets: [asset('a1', category, 'Not networked.')] });
      expect(of('no_assets', one), category).toEqual([]);
    }
  });

  it('no diagram', () => {
    const fires = [finding('no_network_diagram', null, null, 'No network diagram is linked.')];
    expect(of('no_network_diagram', sourcesWith({ diagrams: [] }))).toEqual(fires);
    expect(
      of(
        'no_network_diagram',
        sourcesWith({ diagrams: [diagram('d1', 'data_flow'), diagram('d2', 'other')] }),
      ),
    ).toEqual(fires);
    // Any network link clears it: a CUI reference (not embeddable), or one with no version.
    const cuiReference = diagram('d1', 'network', { embeddable: false, resolved: { size: null } });
    const noVersion = diagram('d2', 'network', { embeddable: false, resolved: null });
    for (const link of [cuiReference, noVersion]) {
      expect(of('no_network_diagram', sourcesWith({ diagrams: [link] }))).toEqual([]);
    }
  });

  it('out-of-scope justification', () => {
    const sources = sourcesWith({
      assets: [
        asset('a1', 'out_of_scope', null, 'Lobby kiosk'),
        asset('a2', 'cui', null, 'File server'),
        asset('a3', 'out_of_scope', 'Air-gapped; holds no CUI.', 'Test bench'),
        asset('a4', 'out_of_scope', ' \t\n', 'Guest Wi-Fi'),
        asset('a5', 'out_of_scope', '', 'Break-room TV'),
        // Another category's justification is ignored, blank or not.
        asset('a6', 'spa', '   ', 'Firewall'),
      ],
    });
    expect(of('out_of_scope_unjustified', sources)).toEqual(
      [
        ['a1', 'Lobby kiosk'],
        ['a4', 'Guest Wi-Fi'],
        ['a5', 'Break-room TV'],
      ].map(([id, name]) =>
        finding(
          'out_of_scope_unjustified',
          null,
          id ?? null,
          `"${name ?? ''}" is out of scope with no justification.`,
        ),
      ),
    );
  });

  it('review overdue', () => {
    const review = (daysToReview: number | null, nextReviewDue: string | null) =>
      sourcesWith({
        review: {
          reviewOverdue: daysToReview !== null && daysToReview < 0,
          nextReviewDue,
          daysToReview,
        },
      });
    expect(of('review_overdue', review(-1, '2026-11-24'))).toEqual([
      finding('review_overdue', null, null, 'The SSP review was due 2026-11-24, 1 day ago.'),
    ]);
    expect(of('review_overdue', review(-3, '2026-11-22'))).toEqual([
      finding('review_overdue', null, null, 'The SSP review was due 2026-11-22, 3 days ago.'),
    ]);
    expect(of('review_overdue', review(0, '2026-11-25'))).toEqual([]);
    expect(of('review_overdue', review(null, null))).toEqual([]);
  });

  it('SSP POA&M mismatch', () => {
    const sources = sourcesWith({
      outcomes: [
        outcome('AC.L2-3.1.1', 'met'),
        outcome('AC.L2-3.1.5', 'met', 2),
        outcome('AC.L2-3.1.9', 'not_assessed'),
        outcome('AC.L2-3.1.10', 'not_met'),
      ],
      // Listed out of catalog order, with a duplicate: findings are in catalog order, once each.
      openPoamRequirementIds: [
        'AC.L2-3.1.10',
        'AC.L2-3.1.9',
        'AC.L2-3.1.5',
        'AC.L2-3.1.1',
        'AC.L2-3.1.1',
      ],
      states: [{ requirementId: 'AC.L2-3.1.5', naRationale: 'No wireless.' }],
    });
    expect(of('ssp_poam_mismatch', sources)).toEqual([
      finding(
        'ssp_poam_mismatch',
        'AC.L2-3.1.1',
        null,
        'AC.L2-3.1.1 has an open POA&M item but is Met.',
      ),
      finding(
        'ssp_poam_mismatch',
        'AC.L2-3.1.5',
        null,
        'AC.L2-3.1.5 has an open POA&M item but is not applicable.',
      ),
      finding(
        'ssp_poam_mismatch',
        'AC.L2-3.1.9',
        null,
        'AC.L2-3.1.9 has an open POA&M item but is not yet assessed.',
      ),
    ]);
    // A listed requirement with no outcome is not yet assessed.
    const base = sourcesWith({ openPoamRequirementIds: ['AC.L2-3.1.9'] });
    const noOutcome: SspLintSources = {
      ...base,
      view: {
        ...base.view,
        evaluation: {
          outcomes: base.view.evaluation.outcomes.filter((o) => o.requirementId !== 'AC.L2-3.1.9'),
        },
      },
    };
    expect(of('ssp_poam_mismatch', noOutcome).map((f) => f.message)).toEqual([
      'AC.L2-3.1.9 has an open POA&M item but is not yet assessed.',
    ]);
    // No POA&M data: skipped.
    expect(
      of('ssp_poam_mismatch', {
        ...sources,
        view: { ...sources.view, openPoamRequirementIds: undefined },
      }),
    ).toEqual([]);
  });

  it('SSP requirement', () => {
    expect(
      of('ssp_requirement_not_met', sourcesWith({ outcomes: [outcome(SSP_ID, 'not_met')] })),
    ).toEqual([
      finding(
        'ssp_requirement_not_met',
        SSP_ID,
        null,
        `${SSP_ID} (the SSP requirement) is Not Met, so the assessment can't be completed.`,
      ),
    ]);
    const notAssessed = finding(
      'ssp_requirement_not_met',
      SSP_ID,
      null,
      `${SSP_ID} (the SSP requirement) is not yet assessed, so the assessment can't be completed.`,
    );
    expect(
      of('ssp_requirement_not_met', sourcesWith({ outcomes: [outcome(SSP_ID, 'not_assessed')] })),
    ).toEqual([notAssessed]);
    // No outcome at all counts as not assessed.
    const base = cleanSources();
    const missing: SspLintSources = {
      ...base,
      view: {
        ...base.view,
        evaluation: {
          outcomes: base.view.evaluation.outcomes.filter((o) => o.requirementId !== SSP_ID),
        },
      },
    };
    expect(of('ssp_requirement_not_met', missing)).toEqual([notAssessed]);
    expect(
      of('ssp_requirement_not_met', sourcesWith({ outcomes: [outcome(SSP_ID, 'met')] })),
    ).toEqual([]);
  });

  it('images', () => {
    const limit = LIMITS.largeImageBytes;
    const large = sourcesWith({
      diagrams: [
        diagram('d1', 'network', { caption: 'Exact', embeddable: true, resolved: { size: limit } }),
        diagram('d2', 'network', {
          caption: 'Over',
          embeddable: true,
          resolved: { size: limit + 1 },
        }),
        diagram('d3', 'data_flow', {
          caption: 'CUI',
          embeddable: false,
          resolved: { size: 9 * MIB },
        }),
        diagram('d4', 'other', {
          caption: 'Big',
          embeddable: true,
          resolved: { size: 12.34 * MIB },
        }),
        diagram('d5', 'other', { caption: 'Pending', embeddable: false, resolved: null }),
      ],
    });
    expect(of('large_image', large)).toEqual([
      finding(
        'large_image',
        null,
        'd2',
        '"Over" is 5.0 MiB; images over 5 MiB make the .docx large.',
      ),
      finding(
        'large_image',
        null,
        'd4',
        '"Big" is 12.3 MiB; images over 5 MiB make the .docx large.',
      ),
    ]);
    // The limit is shown in MiB, to one decimal when it isn't whole.
    expect(
      of('large_image', large, { maxEmbeddedImages: 10, largeImageBytes: 2.5 * MIB }).map(
        (f) => f.message,
      ),
    ).toEqual([
      '"Exact" is 5.0 MiB; images over 2.5 MiB make the .docx large.',
      '"Over" is 5.0 MiB; images over 2.5 MiB make the .docx large.',
      '"Big" is 12.3 MiB; images over 2.5 MiB make the .docx large.',
    ]);

    // Max 2: the 3rd and later embeddable links, in input order; non-embeddable ones don't count.
    const many = sourcesWith({
      diagrams: [
        diagram('d1', 'network', { embeddable: true }),
        diagram('d2', 'other', { embeddable: false }),
        diagram('d3', 'data_flow', { embeddable: true }),
        diagram('d4', 'other', { embeddable: true, caption: 'Rack' }),
        diagram('d5', 'other', { embeddable: false }),
        diagram('d6', 'network', { embeddable: true, caption: 'Floor' }),
      ],
    });
    expect(of('image_limit', many, { maxEmbeddedImages: 2, largeImageBytes: limit })).toEqual([
      finding(
        'image_limit',
        null,
        'd4',
        '"Rack" is referenced, not embedded: the SSP embeds at most 2 images.',
      ),
      finding(
        'image_limit',
        null,
        'd6',
        '"Floor" is referenced, not embedded: the SSP embeds at most 2 images.',
      ),
    ]);
    expect(of('image_limit', many, { maxEmbeddedImages: 3, largeImageBytes: limit })).toHaveLength(
      1,
    );
    expect(of('image_limit', many, { maxEmbeddedImages: 4, largeImageBytes: limit })).toEqual([]);
  });

  it('order and purity', () => {
    expect(lint(cleanSources())).toEqual([]);
    expect(lint(deepFrozen(cleanSources()))).toEqual([]);

    // A world that fires every rule, given as deep-frozen input.
    const world = deepFrozen(
      sourcesWith({
        outcomes: [
          outcome(SSP_ID, 'not_assessed'),
          outcome('AC.L2-3.1.1', 'not_met'),
          outcome('AC.L2-3.1.5', 'met', 1),
          outcome('AC.L2-3.1.10', 'not_met'),
        ],
        openPoamRequirementIds: ['AC.L2-3.1.9'],
        states: [
          { requirementId: 'AC.L2-3.1.1', implementationStatement: 'We plan to add MFA.' },
          { requirementId: 'AC.L2-3.1.9', implementationStatement: null },
          { requirementId: 'AC.L2-3.1.10', implementationStatement: 'TBD' },
        ],
        assets: [asset('a2', 'out_of_scope', null, 'B'), asset('a1', 'out_of_scope', null, 'A')],
        diagrams: [
          diagram('d2', 'data_flow', {
            caption: 'Two',
            embeddable: true,
            resolved: { size: 6 * MIB },
          }),
          diagram('d1', 'other', { caption: 'One', embeddable: true, resolved: { size: 7 * MIB } }),
        ],
        review: { reviewOverdue: true, nextReviewDue: '2026-11-24', daysToReview: -1 },
      }),
    );
    const before = structuredClone(world);
    const findings = lintSspFrom(catalog, world, {
      maxEmbeddedImages: 1,
      largeImageBytes: 5 * MIB,
    });
    expect(world).toEqual(before);
    expect(findings.map((f) => [f.rule, f.requirementId ?? f.subjectId])).toEqual([
      ['ssp_requirement_not_met', SSP_ID],
      ['out_of_scope_unjustified', 'a2'],
      ['out_of_scope_unjustified', 'a1'],
      ['no_network_diagram', null],
      ['review_overdue', null],
      ['empty_statement', 'AC.L2-3.1.9'],
      ['not_met_without_poam', 'AC.L2-3.1.1'],
      ['not_met_without_poam', 'AC.L2-3.1.10'],
      ['na_without_rationale', 'AC.L2-3.1.5'],
      ['future_tense', 'AC.L2-3.1.1'],
      ['future_tense', 'AC.L2-3.1.10'],
      ['ssp_poam_mismatch', 'AC.L2-3.1.9'],
      ['large_image', 'd2'],
      ['large_image', 'd1'],
      ['image_limit', 'd1'],
    ]);
    // Every finding carries its rule's severity and hint.
    for (const f of findings) {
      const data = SSP_LINT_RULES.find((r) => r.id === f.rule);
      expect([f.severity, f.hint]).toEqual([data?.severity, data?.hint]);
    }
    // no_assets is the only rule the world above can't fire alongside out_of_scope_unjustified.
    expect(lint(deepFrozen(RULE_FIXTURES.no_assets)).map((f) => f.rule)).toEqual(['no_assets']);
  });
});
