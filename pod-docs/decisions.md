# Decisions

_Shared: you and the agents both write here, and agents must follow what it says._

> Stub — authoritative architectural decisions for your project. One entry per decision; agents link here from `handoff-queue.md` Resolution lines.

## 2026-11-23 — merge target: default branch
Context: `/pod:ship` for plan `cmmc-l2-grc` asked where autopilot may merge unattended. Staging was offered as the recommended choice.
Decision: autopilot merges the final reviewed plan PR straight into `main` on github.com/haophn01/fun-thinking-rampart, with no `pod-staging` branch.
Consequences: unattended code reaches `main` once the reviewer passes it and CI is green. The policy's other gates still hold: one-way doors, low confidence, migrations in the final PR, and review failures all halt for the human.

## 2026-11-23 — SPRS point values from 32 CFR 170.24(c)(2)
Context: the sprint-planner found that the plan's 42 / 14 / 54 split (from the research) gives a floor of −196, not −203. It showed that no all-scored 1/3/5 split of 110 requirements can reach −203.
Decision: the orchestrator checked the regulation text (Cornell LII). It gives 44 requirements at 5 points (the 42 listed, plus IA.L2-3.5.3 and SC.L2-3.13.11 at their worst level), 14 at 3 and 51 at 1. CA.L2-3.12.4 (SSP) has no point value: it is a prerequisite, and without it the assessment can't be completed. The floor is 110 − 313 = −203, derived from the catalog data.
Consequences: the catalog count tests and the rules floor test use these values. A missing SSP returns "assessment incomplete" rather than a score. The IDs the source prints as "IA-L2-3.5.1" and "IA-L2-3.5.2" are normalized to dots.

<!-- ## YYYY-MM-DD — <title>
Context: <why this came up>
Decision: <what was decided>
Consequences: <trade-offs, follow-ups> -->

## 2026-11-25 — A Not Met requirement needs an open POA&M item before ACCEPT
Context: 32 CFR 170.24(c)(2)(i)(B)(6) says each Not Met requirement must have a POA&M. The plan's Verification has the stamp read ACCEPT only after reaching 88+ "with eligible POA&M items". The sprint-planner settled this for sprint `ssp-dashboard`.
Decision: the rules add a `poam_missing` blocker, citing 32 CFR 170.24(c)(2)(i)(B)(6), for each POA&M-eligible Not Met requirement with no **open** POA&M item. A closed item doesn't count. A requirement that is ineligible for a POA&M gets only `poam_ineligible`, never both. `Regulation` gains `poamRequiredForNotMet` (REGULATION v1.2.0). `AssessmentInput.openPoamRequirementIds` is optional: when it's absent the check is skipped, and the API always fills it. The blocker is still listed while the score is incomplete; the stamp reads HOLD either way. Built in R6 (PR #10).
Consequences: the dashboard's ACCEPT now matches the regulation. The workspace's live and what-if scores apply the same rule, because the view carries the open list. Switching `poamRequiredForNotMet` off in the regulation data turns the rule off.

## 2026-11-25 — Objective IDs for single-statement requirements (agent default — override anytime)
Context: 23 NIST SP 800-171A requirements have one unlettered "Determine if…" statement.
Decision: each gets a single objective `[a]` (e.g. `3.4.4[a]`), matching the CMMC assessment guide, so the total stays 320.
Consequences: users see these IDs on the assessment screen and in the SSP. Changing it means a catalog version bump plus a data migration for stored results.

## 2026-11-25 — 3.3.2 wording (agent default — override anytime)
Context: SP 800-171 Rev 2 and SP 800-171A word 3.3.2 slightly differently (a comma).
Decision: keep the Rev 2 wording ("…those users, so they can…"), through the catalog override listed in `packages/catalog/README.md`.
Consequences: it's cosmetic. Changing it is a one-line override plus a catalog version bump.

## 2026-11-25 — Selected "Not met" objective radio fill (agent default — override anytime)
Context: the look-3 draft fills a selected Not Met option in Signal Red, but the sprint scope said Ink.
Decision: the selected option is always filled Ink. Each option exposes `data-status`, so a red Not Met fill is a small CSS change.
Consequences: none for behavior.

## 2026-11-25 — No confirm step before resetting or deactivating yourself (agent default — override anytime)
Context: on your own row in Settings › Users, Reset password and Deactivate act immediately and end your session.
Decision: no confirm step. You land on Sign in with "Your session ended. Sign in again."
Consequences: an admin can sign themself out with one click. Adding a confirm dialog is a small UI change.

## 2026-11-25 — "Today" is the UTC date (agent default — override anytime)
Context: the plan review found that POA&M due dates, the 180-day clock and the closeout checks use the UTC calendar date. For a US user after about 4–5 pm local time, they read one day ahead.
Decision: keep UTC days, as `contract/poam.ts` documents.
Consequences: near the end of the US day, countdowns and "due today" can be off by one. Fixing it needs the user's time zone (a setting, or the browser's offset sent with requests).

## 2026-11-25 — SSP workspace tab keys and categorization reset (agent default)

- **Tab history:** clicking an SSP tab pushes a history entry, and clicking the selected tab adds none. Arrow, Home and End keys **replace** the `?tab=` entry, so Back doesn't step through every tab the keys passed.
- **Categorization reset:** clearing the categorization when it already holds the default counts as no change, so Save stays disabled. This follows the API's effective-value rule; the default is stored as null.
- **Why:** these match the WAI-ARIA tabs pattern and the API's rules. Raised as PENDING by W9 (plan `ssp-export-v2`, sprint `ssp-workspace`) and taken as defaults by the orchestrator. The human can change them.

## 2026-11-25 — SSP export v2 wording (agent default)

- **Cadence wording:** the record of changes says "every 1 month" when the cadence is 1, and "every <n> months" otherwise.
- **CUI file version line:** a file version on a CUI-flagged item prints `<caption> — <kind>: <title> v<n>, contains CUI, <fileName>, SHA-256 <sha>, <date>`, with no "(referenced: …)" suffix. The api never produces this case.
- **Why:** these were raised as PENDING by X2 (plan `ssp-export-v2`, sprint `ssp-export-lint`) and taken as defaults by the orchestrator. The human can change them.

## 2026-11-26 — Pre-export check wording (agent default)

- **Wording kept as built (W17):** the panel shows "Running the pre-export check…" while it loads, not "Loading…". The Export note reads "Findings don't block the export. Fix them first, or export as is.", not the contract's "The check only warns. You can export at any time." Both say the same thing.
- **Fixed in the wave merge:** the summary line was not announced to screen readers. It now has `aria-live="polite"`. `role="status"` would have collided with the info Alerts, which already use that role.
- **Why:** E4 raised these as PENDING (plan `ssp-export-v2`, sprint `ssp-export-lint`). The orchestrator took the wording as a default and fixed the accessibility gap.

## 2026-11-26 — SSP panels re-read when shown again (review fix)

- **What:** SSP workspace panels still mount once and stay mounted, so drafts survive. They now **re-read their data each time their tab is shown again** (re-select, Back, or the browser tab regaining focus). There's no separate reload on the export click, because a plain download link would race the write; Document control reloads when you return to it.
- **Embeddable:** a diagram is embeddable only if its stored bytes read as PNG or JPEG, not just its file name.
- **Why:** these came from the round-1 plan review of #23 (FIX 1 and FIX 2), fixed by F2.
