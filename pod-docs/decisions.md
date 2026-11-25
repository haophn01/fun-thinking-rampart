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
