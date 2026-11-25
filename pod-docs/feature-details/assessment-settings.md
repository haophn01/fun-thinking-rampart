# Assessment settings

## What it is
**Settings** > Assessment (admin only): the assessment type (self-assessment or C3PAO certification) and the Conditional Status Date.

## How it works
- `PATCH /api/assessment` (`config: { role: 'admin' }`) takes `type` and `conditionalStatusDate`; the date is a real calendar date or null.
- The date starts the 180-day closeout clock (`packages/rules/src/poam/clock.ts`). Settings shows "Deadline" and days remaining.
- The type changes labels and who confirms closeout: `organization` for self, `c3pao` for C3PAO (a C3PAO closeout needs the assessor's name).
- Example: C3PAO with 2026-11-01 shows "Closeout confirmed by: An authorized C3PAO" and "Deadline 2027-04-30". `2026-02-30` shows "Enter a real date as YYYY-MM-DD." and sends nothing.

## Why it's this way
- Both types stay supported although the July 2026 CMMC milestone suspension is real (the human confirmed); self-assessment is the default.

## Watch out
- Days are UTC dates, so near the end of a US day the countdown can be a day off: [decisions.md](../decisions.md#2026-11-25--today-is-the-utc-date-agent-default--override-anytime).
- Contributors can't change these settings.

## History
- 2026-11-25 · plan cmmc-l2-grc · built (assessment sprint, PR #6) · [report](../reports/cmmc-l2-grc.html)
