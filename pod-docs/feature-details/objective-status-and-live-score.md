# Objective status and live score

## What it is
The assessment workspace. You mark each of the 320 NIST SP 800-171A objectives Met, Not Met, N/A or Not Assessed, with a note, and write implementation statements per requirement. The SPRS score and Conditional check update on every save.

## How it works
- Requirement status comes from its objectives (`packages/rules/src/status.ts`): Met when every objective is Met or N/A; Not Met when any is Not Met; otherwise Not Assessed. An all-N/A requirement counts as Met.
- Score (`score.ts`) starts at 110 and subtracts each Not Met requirement's points. 44 requirements are 5 points, 14 are 3, 51 are 1, and CA.L2-3.12.4 (the SSP) has none: with no SSP the result is "assessment incomplete".
- IA.L2-3.5.3 and SC.L2-3.13.11 deduct 3 or 5 by their implementation level.
- The API computes `evaluateAssessment(catalog, stored rows, REGULATION)` on every read and write; the web app runs the same function for its what-if score.
- Example: all Met, then 3.1.20[a] Not Met gives 109, "Not eligible", blocker "cannot go on a POA&M ... 32 CFR 170.21(a)(2)(iii)".
- Files: `apps/api/src/assessment/{repository,routes}.ts`, `apps/web/src/pages/assessment/`.

## Why it's this way
- Objectives are first-class records, the gap the research found in every other tool.
- Point values come from 32 CFR 170.24(c)(2), not the research's 42/14/54 split: [decisions.md](../decisions.md#2026-11-23--sprs-point-values-from-32-cfr-17024c2).
- Single-statement requirements get one objective `[a]` so the total stays 320: [decisions.md](../decisions.md#2026-11-25--objective-ids-for-single-statement-requirements-agent-default--override-anytime).

## Watch out
- Status values are validated to exactly `met | not_met | na | not_assessed`; the rules don't check at runtime.
- The selected Not Met radio is filled Ink, not red (agent default).
- The score floor of -203 is derived from catalog data and pinned by a test.

## History
- 2026-11-25 · plan cmmc-l2-grc · built (assessment sprint, PRs #4 to #6) · [report](../reports/cmmc-l2-grc.html)
