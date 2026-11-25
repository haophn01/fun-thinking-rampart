# Handoff Queue

_Shared: agents leave notes here for you and for each other. You answer the ones addressed to `human`._

**The human is the ultimate arbiter** — `BLOCKED` entries halt the orchestrator until acknowledged. **One line per entry.**

Format: `` - `[YYYY-MM-DD · TYPE · from → to · plan: <slug> · sprint: <slug> · slice: <code>]` <body> **Resolution:** pending `` (or `**Resolution:** <YYYY-MM-DD> — <what changed> [optional link to pod-docs/decisions.md#anchor]`).

Entries are **date-keyed and append-only** (newest at the tail) — reference one by its `[date · from → to]` header plus a few words of its body, never by position (a same-day header can repeat; the body disambiguates). `from`/`to` is a **role**, not an agent name — `engineer` / `reviewer` / `orchestrator` / `sprint-planner` / `human` — so it stays stable when an agent is renamed. Omit `slice:` for sprint-wide entries, `sprint:` too for plan-wide ones, and `plan:` too for project-wide ones.

Types: `BLOCKED` halts · `PENDING` defers — someone has to act on it later · `SOLVED` informational, only emitted alongside a `BLOCKED` or `PENDING` to mark a related thing resolved inline. Pure FYI (`NOTE`) never lands here — it goes in the wave PR body. Reviewer entries start with when they matter: `now`, `before hosting`, or `someday`.

To answer an entry addressed to `human` (Pod Board does this for you), add ` **Answer (human):** <one line>` after `**Resolution:** pending`. pod applies it at the next wave start or resume, fills in the Resolution, and keeps your answer on the line. An answered `BLOCKED` resumes the run once pod checks the problem is gone.

Resolve inline; never delete a pending entry. Decision-worthy → a one-liner in `decisions.md`, linked from the Resolution, as `**Resolution:** <date> — default recorded: <value>; override anytime (<link>)`. At plan end, `/pod:code` resolves what's left; when the next plan starts, it moves each plan's resolved entries to that plan's `## Queue log`.

---
- `[2026-11-25 · PENDING · engineer → sprint-planner · plan: cmmc-l2-grc · sprint: ssp-dashboard · slice: X1]` someday: `packages/catalog/src/load.ts` imports its JSON without `with { type: 'json' }`, and Node's native loader refuses that import. Playwright specs hit it, so `playwright.config.ts` has a `module.registerHooks` resolve hook as a workaround. Adding the import attribute in catalog would let the hook go. **Resolution:** pending
- `[2026-11-25 · PENDING · reviewer → human · plan: cmmc-l2-grc]` before hosting: `pnpm start` serves the web app from the Vite dev server, with no CSP or security headers on the HTML. Helmet only covers `/api` (`apps/api/src/app.ts:57`). Hosting needs a production build behind a static server that sets the headers. This belongs with the parked deployment idea. **Resolution:** pending
- `[2026-11-25 · PENDING · reviewer → human · plan: cmmc-l2-grc]` someday: some code exists in more than one copy:
  - the Conditional-status labels, 3 copies (`contract/ssp.ts:47`, `score/ScorePanel.tsx:7`, `dashboard/DashboardPage.tsx:37`)
  - `SSP_MESSAGE` and `CUI_BANNER`, 2 copies each
  - 2 `formatSize` functions, so the same file reads "KiB" on Evidence but "KB" on Policies
  - repeated `actorOf`, `requireAssessment` and `utcDate`

  `PlaceholderPage` in `apps/web/src/App.tsx:9,39` is unreachable dead code. **Resolution:** pending
- `[2026-11-25 · PENDING · orchestrator → human · plan: ssp-export-v2]` gate 6 (escalation-valve): by policy, the final plan PR `ssp-export-v2` → `main` would be held for the human, because the plan adds migration 0005 (additive only). Undo: revert the final PR's merge commit on `main`. The added tables and columns stay in any local database, unused. **Resolution:** pending **Answer (human):** you merge it
