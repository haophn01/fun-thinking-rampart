# Decisions

_Shared: you and the agents both write here, and agents must follow what it says._

> Stub — authoritative architectural decisions for your project. One entry per decision; agents link here from `handoff-queue.md` Resolution lines.

## 2026-11-23 — merge target: default branch
Context: `/pod:ship` for plan `cmmc-l2-grc` asked where autopilot may merge unattended. Staging was offered as the recommended choice.
Decision: autopilot merges the final reviewed plan PR straight into `main` on github.com/haophn01/fun-thinking-rampart, with no `pod-staging` branch.
Consequences: unattended code reaches `main` once the reviewer passes it and CI is green. The policy's other gates still hold: one-way doors, low confidence, migrations in the final PR, and review failures all halt for the human.

<!-- ## YYYY-MM-DD — <title>
Context: <why this came up>
Decision: <what was decided>
Consequences: <trade-offs, follow-ups> -->
