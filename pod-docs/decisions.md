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
