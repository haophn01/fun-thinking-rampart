# Handoff Queue

_Shared: agents leave notes here for you and for each other. You answer the ones addressed to `human`._

**The human is the ultimate arbiter** — `BLOCKED` entries halt the orchestrator until acknowledged. **One line per entry.**

Format: `` - `[YYYY-MM-DD · TYPE · from → to · plan: <slug> · sprint: <slug> · slice: <code>]` <body> **Resolution:** pending `` (or `**Resolution:** <YYYY-MM-DD> — <what changed> [optional link to pod-docs/decisions.md#anchor]`).

Entries are **date-keyed and append-only** (newest at the tail) — reference one by its `[date · from → to]` header plus a few words of its body, never by position (a same-day header can repeat; the body disambiguates). `from`/`to` is a **role**, not an agent name — `engineer` / `reviewer` / `orchestrator` / `sprint-planner` / `human` — so it stays stable when an agent is renamed. Omit `slice:` for sprint-wide entries, `sprint:` too for plan-wide ones, and `plan:` too for project-wide ones.

Types: `BLOCKED` halts · `PENDING` defers — someone has to act on it later · `SOLVED` informational, only emitted alongside a `BLOCKED` or `PENDING` to mark a related thing resolved inline. Pure FYI (`NOTE`) never lands here — it goes in the wave PR body. Reviewer entries start with when they matter: `now`, `before hosting`, or `someday`.

To answer an entry addressed to `human` (Pod Board does this for you), add ` **Answer (human):** <one line>` after `**Resolution:** pending`. pod applies it at the next wave start or resume, fills in the Resolution, and keeps your answer on the line. An answered `BLOCKED` resumes the run once pod checks the problem is gone.

Resolve inline; never delete a pending entry. Decision-worthy → a one-liner in `decisions.md`, linked from the Resolution, as `**Resolution:** <date> — default recorded: <value>; override anytime (<link>)`. At plan end, `/pod:code` resolves what's left; when the next plan starts, it moves each plan's resolved entries to that plan's `## Queue log`.

---
- `[2026-11-24 · PENDING · engineer → human · plan: cmmc-l2-grc · sprint: foundation · slice: C1]` 23 requirements in NIST SP 800-171A have one unlettered "Determine if…" statement instead of lettered objectives. The catalog gives each one a single objective `[a]` (for example `3.4.4[a]`), as the CMMC assessment guide does, so the total stays 320. You'll see these IDs on the assessment screen. Reply `ok` or give another ID form. **Resolution:** pending
- `[2026-11-24 · PENDING · engineer → human · plan: cmmc-l2-grc · sprint: foundation · slice: C1]` The two NIST PDFs word 3.3.2 slightly differently: SP 800-171 Rev 2 has "…those users, so they can…" and SP 800-171A drops the comma. The catalog keeps the Rev 2 wording through an override, listed in `packages/catalog/README.md` for you to spot-check. Reply `ok` or say which wording to keep. **Resolution:** pending
- `[2026-11-24 · PENDING · engineer → sprint-planner · plan: cmmc-l2-grc · sprint: foundation · slice: R1]` The rules don't check objective status values at runtime. The assessment sprint's API must zod-validate incoming objective results to exactly `met | not_met | na | not_assessed`, or the counts go wrong. **Resolution:** pending
- `[2026-11-24 · PENDING · engineer → sprint-planner · plan: cmmc-l2-grc · sprint: foundation · slice: R2]` Contract friction: the frozen `Regulation` type has no field for the "POA&M only for NOT MET" citation (32 CFR 170.24(c)(2)(i)(B)(6)), so it lives as `POAM_NOT_MET_CITATION` outside `REGULATION`. Consider adding `poamNotMetOnly: Cited<…>` to `Regulation`. **Resolution:** pending
- `[2026-11-24 · PENDING · engineer → sprint-planner · plan: cmmc-l2-grc · sprint: foundation · slice: A1]` Fastify client-error mapping isn't in the contract. Malformed JSON gives 400 `validation_failed`, and 415 also uses code `validation_failed`, so consider adding `unsupported_media_type`. A bad or oversize body sent to an unknown route returns 400 or 413 rather than 404, because Fastify parses the body before routing. **Resolution:** pending
- `[2026-11-24 · PENDING · orchestrator → human · plan: cmmc-l2-grc · sprint: assessment · slice: L2]` On the objective status control, the selected option is always filled Ink (black), as the sprint scope says. The look-3 draft fills a selected "Not met" in Signal Red. Reply `ink` to keep it, or `red` to have a later slice fill Not met in red (each option already exposes `data-status`). **Resolution:** pending
