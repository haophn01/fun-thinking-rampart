import type { SspLintRule } from './types';

/** Bumped when a rule, message or hint changes. */
export const SSP_LINT_VERSION = '1.0.0';

/** The rules in the order findings come in. */
export const SSP_LINT_RULES: readonly SspLintRule[] = Object.freeze(
  (
    [
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
    ] satisfies SspLintRule[]
  ).map((rule) => Object.freeze(rule)),
);
