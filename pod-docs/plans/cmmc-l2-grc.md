# Plan: CMMC L2 readiness platform (V1, workflow first)

_Generated: 2026-11-23 · Status: archived · Grilled-with: pod_

Port base: 3200
<!-- autopilot-run: started=2026-11-23T22:30:00-08:00 sprints=4 waves=12 -->

## Goal
Build "Rampart" (a placeholder name), a self-hosted CMMC Level 2 readiness platform that one defense contractor runs locally to prepare for a self-assessment or a C3PAO assessment. You assess each of the 320 NIST SP 800-171A (Rev 2) objectives. The platform derives requirement status from them, a live SPRS score, a Conditional-status check and a rules-checked POA&M, and it manages evidence and policies and generates the SSP as a Word document.

## Why
- The research ([cmmc-l2-grc](../research/cmmc-l2-grc.md)) found no tool that tracks the 320 objectives as first-class records:
  - The SOC 2-origin platforms add CMMC on top and need configuration to show SPRS.
  - The MSP tools are built for the wrong customer.
  - SaaS vendors avoid storing CUI.
  - The only open-source tracker (clucraft/cmmc) is a small project that tracks controls only.
- **Success:** a compliance lead can go from an empty install to an assessed baseline with:
  - a correct SPRS score
  - a POA&M that the 32 CFR 170.21 rules accept or reject
  - evidence and policies linked to objectives
  - an exported SSP .docx
  
  All of it runs on a Windows dev machine with no external services.
- **Constraints:**
  - Correctness of the scoring and POA&M rules matters more than breadth. Every rule cites its source and has table-driven tests.
  - No real CUI in V1 (see Key decisions).

## Scope
**In scope:**
- Monorepo bootstrap with GitHub Actions CI: clean install, typecheck, tests, secret scan.
- Versioned NIST 800-171 Rev 2 / 800-171A catalog (14 families, 110 requirements, 320 objectives, point values) as a data file with count tests.
- A shared rules package that derives:
  - requirement status from objective results
  - the SPRS score, including partial credit for 3.5.3 and 3.13.11
  - POA&M eligibility
  - Conditional-status checks
  - the 180-day closeout clock
- Local accounts (admin and contributor), owner assignment, and an audit log of every status and content change.
- Assessment workspace: browse families and requirements, set Met / Not Met / N/A per objective with notes, and write implementation statements.
- Live SPRS score plus what-if mode, which tries status changes without saving them.
- Assessment settings: self-assessment or C3PAO certification, and the Conditional Status Date.
- POA&M: items only for Not Met requirements, eligibility enforced by the rules, plan, milestones, owner, due dates, 180-day countdown, and closeout.
- Evidence: upload with versions and SHA-256, link to objectives, and a "contains CUI" flag. A flagged item can't hold a file; it stores a reference instead.
- Policies: upload documents, keep versions, and link them to requirements.
- System profile (SSP system characteristics) and SSP export as .docx.
- Readiness dashboard (score, QC stamp, Conditional check, objective status, families, needs-attention list).

**Out of scope (next plans, in order):**
- OSCAL export of the SSP and POA&M, validated with compliance-trestle.
- Integrations that pull evidence (M365 GCC High / Entra, AWS GovCloud, endpoint tools), plus SSO.
- Encrypted CUI evidence storage, hosting, and backups.
- NIST 800-171 Rev 3 catalog, CMMC Level 1 and Level 3, multi-tenant or MSP use.
- SPRS submission and affirmation workflows, policy template authoring, and AI help.

## How it fits together

**Parts:**

| Part | New or changed | Where (existing folder or module) | Does |
|------|----------------|-----------------------------------|------|
| catalog | new | `packages/catalog` | Versioned Rev 2 catalog data (families, requirements, objectives, points, citations), a loader and count validation |
| rules | new | `packages/rules` | Pure functions: requirement status from objectives, SPRS score, POA&M eligibility, Conditional-status check, 180-day clock |
| api | new | `apps/api` | Node HTTP API: sessions and roles, assessment, POA&M, evidence, policies, system profile and audit log endpoints |
| db | new | `apps/api/db` | SQLite schema and migrations through an ORM; the only place state lives |
| evidence store | new | `apps/api/storage` | Storage interface with a local-folder implementation: write a file, hash it, read it back. A later plan adds encryption and other backends |
| ssp export | new | `apps/api/ssp` | Builds the SSP .docx from the catalog, the system profile, requirement states and POA&M |
| web | new | `apps/web` | React (Vite) UI in the C · Inspection look: dashboard, assessment, POA&M, evidence, policies, SSP, settings |

**How they connect:**

```mermaid
flowchart LR
  web -->|HTTP JSON| api
  web -->|imports for live what-if score| rules
  api -->|computes status, score, eligibility| rules
  rules -->|reads points and objective lists| catalog
  api -->|reads and writes| db
  api -->|stores and hashes files| evidencestore[evidence store]
  api -->|asks for a document| sspexport[ssp export]
  sspexport -->|reads requirement text| catalog
```

**Main flow:** an assessor marks an objective Not Met and the platform reacts:

```mermaid
sequenceDiagram
  actor Assessor
  participant web
  participant api
  participant rules
  participant db
  Assessor->>web: set AC.L2-3.1.20[b] to Not Met, with a note
  web->>rules: what-if score from the current results (shown at once)
  web->>api: save the objective result
  api->>db: write the result and an audit event
  api->>rules: derive the requirement status, SPRS score and Conditional check
  rules-->>api: 3.1.20 Not Met, score 72, barred from POA&M
  api-->>web: updated requirement, score and blockers
  web-->>Assessor: QC stamp shows HOLD, blocker listed, POA&M add disabled for 3.1.20
```

**Data:** everything is in one SQLite file written only by `api`. The catalog is read-only data shipped in `packages/catalog`, and each assessment records the catalog version it uses. Evidence and policy files sit in a local folder managed by the evidence store, and the database holds only their path, hash and version.

```mermaid
erDiagram
  USER ||--o{ AUDIT_EVENT : makes
  ASSESSMENT ||--o{ OBJECTIVE_RESULT : has
  ASSESSMENT ||--o{ REQUIREMENT_STATE : has
  ASSESSMENT ||--o{ POAM_ITEM : has
  ASSESSMENT ||--|| SYSTEM_PROFILE : describes
  REQUIREMENT_STATE ||--o{ POAM_ITEM : "remediated by"
  USER ||--o{ REQUIREMENT_STATE : owns
  EVIDENCE_ITEM ||--o{ EVIDENCE_VERSION : has
  EVIDENCE_ITEM }o--o{ OBJECTIVE_RESULT : supports
  POLICY ||--o{ POLICY_VERSION : has
  POLICY }o--o{ REQUIREMENT_STATE : covers
  ASSESSMENT {
    string type "self or c3pao"
    date conditional_status_date
    string catalog_version
  }
  OBJECTIVE_RESULT {
    string objective_id "e.g. 3.1.1[a]"
    string status "met, not_met, na, not_assessed"
    string note
  }
  REQUIREMENT_STATE {
    string requirement_id
    string implementation_level "3.5.3 and 3.13.11 only"
    string implementation_statement
  }
  POAM_ITEM {
    string plan
    date due
    string status "open, closed"
  }
  EVIDENCE_VERSION {
    string sha256
    bool contains_cui "true means reference only, no file"
  }
```

## Sprint sequence

| Sprint | Goal | Status | Depends on |
|--------|------|--------|------------|
| foundation | Monorepo and CI bootstrap; Rev 2 catalog with count tests; the rules package (status, score, partial credit, POA&M eligibility, Conditional check, 180-day clock) fully tested against 32 CFR 170.24 and 170.21; API and DB skeleton; web shell with the look's tokens and self-hosted fonts | done | — |
| assessment | Local accounts and roles, audit log, assessment workspace (objective status, notes, implementation statements, owners), live and what-if SPRS score, assessment type and Conditional Status Date | done | foundation |
| poam-evidence | POA&M with rule-enforced eligibility, countdown and closeout; evidence store with versions, hashes, objective links and the CUI flag; policy library linked to requirements | done | assessment |
| ssp-dashboard | System profile, SSP .docx export, readiness dashboard (QC stamp, title block, Conditional check, objective status, families, needs attention), end-to-end smoke | done | poam-evidence |

## Look
The human picked direction **C (Spec Sheet)**. They liked the manufacturing culture but found the Shop Floor variant had too many colors: "lets go back with option C. However you can add in inspection tools style look in it". The result is **C · Inspection**: C's palette and fonts unchanged, plus motifs from inspection tools.
- **Thesis:** the Spec Sheet run through the quality lab. Readiness is measured the way a part is inspected: read off a caliper, checked against spec limits, gauged GO / NO GO, ballooned and stamped. Light, precise, monochrome with two signal colors.
- **Palette** (C's six, nothing added):
  - Vellum `#F2F1EC`: background
  - Sheet `#FFFFFF`: surfaces and inputs
  - Ink `#111111`: text, rules and scales
  - Graphite `#6B6B66`: muted text
  - Signal Red `#E10600`: accent, primary button, NO GO, the LSL line and the inspector's stamp
  - Draft Blue `#1F4BFF`: GO, Met, and the measured value
  - **Contrast rule:** Signal Red text on Vellum is about 4.39:1 and fails 4.5:1. Red text at body sizes goes only on Sheet (about 4.97:1), or appears as white text on a red block. Red on Vellum is allowed only for large text (24 px+, or 18.7 px+ bold) and for non-text marks (lines, the stamp border, chips' blocks).
  - The look-3 draft also uses `#1A1A1A` for rules and `#E4E3DD` for the bar track. The build doesn't: rules are Ink, and the bar track is Sheet with an Ink baseline. Only the six tokens exist.
- **Type:**
  - Fonts (self-hosted through @fontsource):
    - Space Grotesk 700: display (score, titles, brand).
    - Inter 400/500/600: body.
    - Space Mono 400/700: IDs, hashes, numbers and labels.
  - Scale: 64 / 40 / 28 display, 18 / 16 body, 16 labels and mono. The smallest text is 16 px, including the ruler's scale labels and the feature control frame, in the real build. The draft's SVG labels shrink below that on phones; the build renders them at 16 px or more.
- **Layout:**
  - Desktop: a masthead with the brand, a text nav (active tab gets a red underline) and the user, then a 3-column grid:
    - row 1: score (2 columns) and Conditional check (1)
    - row 2: objective status (2 columns), with the Conditional check still beside it
    - row 3: families (1) and needs attention (2)
  - Sections are separated by 1.5 px ink rules.
  - Crosshair registration marks sit at the top corners, and an inspection-report strip runs along the bottom (IR number, part, spec, characteristics 320, inspector, date).
  - Phone: one column in the order score, Conditional check, objectives, needs attention, families. The nav collapses to a menu and the strip becomes 2 columns.
- **Signature detail:** the SPRS score is shown on **C's original dimension-line ruler**, as in the Spec Sheet column of the draft. The human chose it over the caliper: "Replace the caliper score with the old one".
  - The ruler runs −203 to 110, with a red 88 Conditional line, a blue "YOU 72" marker, and a dashed dimension line showing the gap (+16).
  - Beneath it, a GD&T-style **feature control frame** reads `SPRS | MEAS 72 | LSL 88 | USL 110 | OUT OF TOL` (or `IN TOL`).
  - A rotated red-ink inspector's stamp reads **HOLD** while the score is under 88 or a blocker remains, and **ACCEPT** once Conditional status is reachable.
  - The ruler's labels render at 16 px or more.
- **Components:**
  - Section labels carry **ballooned characteristic numbers**: circled 1, 2, 3, as on an inspected drawing.
  - Status chips read as a **GO / NO GO gauge**: a solid blue GO block for Met, a solid red NO GO block for Not Met, and a dashed or graphite "—" for N/A and Not Assessed, each followed by the status word.
  - Progress bars are graduated scales: tick marks every 10% with an ink travel bar.
  - Inputs are underline-only.
  - Buttons are square, with a 1.5 px ink border; the primary is solid Signal Red.
- **Rules out:**
  - Any color beyond the six (no yellow, green, orange or hazard stripes).
  - Dark mode in V1, rounded "SaaS" cards, drop shadows and gradients.
  - Default browser controls.
- **Draft:** `pod-docs/design-drafts/cmmc-l2-grc-look-3.html`, the Inspection column, except that the score uses the left (Spec Sheet) column's ruler, not the caliper. History: A, B and C are in `cmmc-l2-grc-look.html`. The Shop Floor variant the human set aside is in `cmmc-l2-grc-look-2.html`.

## Key decisions
- **Baseline:** NIST SP 800-171 Rev 2 / 800-171A, the standard CMMC L2 baseline. The data model is versioned so a Rev 3 catalog can be added later. No fetched source in the research states the Rev 2 mapping; it is the brief's assumption, taken from 32 CFR 170 practice IDs (AC.L2-3.x.x). [research](../research/cmmc-l2-grc.md)
- **Catalog source: the PDFs** (human's choice). Sprint 1 builds the catalog from the NIST SP 800-171 Rev 2 and SP 800-171A PDFs, which are the normative text:
  - A repeatable conversion script under `packages/catalog` reads the PDFs and writes the JSON.
  - Each PDF's URL and SHA-256 go into the catalog metadata.
  - Tests assert 14 families, 110 requirements, 320 objectives, and the point values from the regulation (see **Scoring**): 44 requirements at 5 points, 14 at 3, 51 at 1, and CA.L2-3.12.4 unscored.
  - Text the script couldn't extract cleanly is fixed by hand and listed in the catalog README for the human to spot-check.
- **Built for continuous updates** (human: "the product will circle back for continuous update"):
  - Regulatory values (the catalog, point weights, barred list, thresholds, the 180-day window) live as versioned data with citations, never as literals scattered through code.
  - Database changes go through migrations only.
  - Each part keeps a stable interface, so later plans (OSCAL, integrations, CUI storage, Rev 3) plug in without rewrites.
- **Professional engineering standards** (human: "lets do it like a professional swe"). Every slice follows them, and the final review checks them:
  - Strict TypeScript, ESLint and Prettier, all enforced in CI.
  - API request and response schemas validated with zod and shared with the web app.
  - Tests written first for `packages/rules`.
  - Structured logging and consistent error responses.
  - Secure defaults: password hashing, httpOnly SameSite session cookies, CSRF protection on writes, security headers, and upload size and type limits.
  - Conventional commits.
  - A root README covering setup, scripts and architecture, plus CONTRIBUTING.md.
  - Decisions recorded in `pod-docs/decisions.md`.
  - No dead code and no TODOs left without a queue entry.
- **Build from scratch.** clucraft/cmmc (MIT) and CISO Assistant (AGPL v3) are references only: no fork, and no AGPL code.
- **Objectives are first-class.** Status is set per objective (Met / Not Met / N/A / Not Assessed). A requirement is Met when every objective is Met or N/A, Not Met when any objective is Not Met, and Not Assessed otherwise. An all-N/A requirement counts as Met for scoring (per DoD methodology practice).
- **Partial credit:** IA.L2-3.5.3 and SC.L2-3.13.11 carry an implementation level that sets their deduction to −3 or −5 (32 CFR 170.24(c)(2)).
- **POA&M rules (32 CFR 170.21), enforced in `packages/rules`, each with a citation and tests:**
  - POA&M items exist only for Not Met requirements.
  - Conditional status needs a score of at least 88.
  - Each item must be worth 1 point or less. The one exception is 3.13.11 at the −3 level.
  - AC.L2-3.1.20, AC.L2-3.1.22, CA.L2-3.12.4, PE.L2-3.10.3, PE.L2-3.10.4 and PE.L2-3.10.5 can never go on a POA&M.
  - Closeout is due within 180 days of the Conditional Status Date.
  - The SSP (3.12.4) must exist.
- **Scoring** (32 CFR 170.24(c)(2), checked against the Cornell LII text on 2026-11-23 after the sprint-planner found the research's 42 / 14 / 54 split inconsistent with −203):
  - The score starts at 110, and each Not Met requirement subtracts its points.
  - **5 points:** the 23 basic and 19 derived requirements the regulation lists, plus IA.L2-3.5.3 and SC.L2-3.13.11 at their worst level. That's 44.
  - **3 points:** the 7 basic and 7 derived requirements the regulation lists. That's 14.
  - **1 point:** every other derived requirement. That's 51.
  - **CA.L2-3.12.4 (SSP) has no point value.** It is a prerequisite: with no up-to-date SSP, the assessment cannot be completed. The rules return "assessment incomplete" rather than a score.
  - IA.L2-3.5.3 and SC.L2-3.13.11 subtract 3 or 5 by implementation level (see Partial credit).
  - The worst case is 110 − (44×5 + 14×3 + 51) = 110 − 313 = **−203**. That floor is derived from the catalog's point data, not hard-coded, and a test asserts it equals −203.
  - The source prints two IDs as "IA-L2-3.5.1" and "IA-L2-3.5.2". The catalog normalizes them to `IA.L2-3.5.1` and `IA.L2-3.5.2`.
  - The score shown in the UI and the score stored by the API come from the same `packages/rules` code, so they can't disagree.
- **Assessment type:** self-assessment or C3PAO certification, chosen in settings. It changes the labels and who confirms closeout. The human confirms the July 13, 2026 CMMC milestone suspension is real and still wants the platform ready for both kinds of assessment. Self-assessment is the default setting, and the C3PAO path stays fully supported.
- **CUI:** no real CUI in V1. An evidence item flagged "contains CUI" can't hold a file and stores only a description plus where the file really lives. A banner says not to upload CUI. Storage sits behind an interface so a later plan can add encryption and an approved host without changing the data model. DFARS 252.204-7012 requires FedRAMP Moderate equivalency for cloud hosts of covered defense information.
- **Users:**
  - Local email and password accounts with an Argon2 password hash and server sessions.
  - Two roles: admin (users, settings, closeout) and contributor (assess, evidence, POA&M edits).
  - An owner can be assigned on requirements and POA&M items.
  - Every change writes an audit event (who, what, before and after, when).
- **Stack:**
  - TypeScript monorepo with pnpm workspaces (default).
  - Fastify API (default) and React + Vite web.
  - SQLite with Drizzle ORM and migrations (default).
  - The `docx` npm library for the SSP (default).
  - Vitest for unit and rule tests, Playwright for one end-to-end smoke (default).
  - Node 24 LTS, which is what this machine has (default). pnpm is enabled through corepack, because it isn't installed globally.
- **CI is required** (human: "CI offer should be keep (make no mistake)"). Sprint 1's bootstrap slice adds `.github/workflows/pod-ci.yml`, which runs on every PR and on pushes to `main`:
  - a clean install from the lockfile
  - lint
  - typecheck
  - unit and rule tests
  - build
  - a gitleaks secret scan

  The brief's `## CI` is updated with it. No later wave merges without these checks passing.
- **Name:** "Rampart" is a placeholder (default). It's set in one config value so it's easy to rename.
- **One active assessment** in the UI. The schema allows several, which leaves room for history later (default).
- **Fonts self-hosted** through @fontsource packages, with no CDN at runtime (default).

## Known risks
- **Catalog accuracy.** 320 objective texts can drift from NIST's if typed from memory. Mitigation: generate the catalog from NIST's files with a conversion script, record their checksums, add count tests, and have the human spot-check any hand-transcribed text.
- **Rules disagreements.** Vendor sources disagree on POA&M details. Mitigation: encode only from 32 CFR 170.21 and 170.24 (Cornell LII text, since the eCFR fetch failed), with a citation on each rule and table tests. Flag anything the regulation leaves unclear in the queue rather than guessing.
- **Regulatory churn.** The July 2026 suspension is real (the human confirmed it), and the rules may keep changing. Mitigation: weights, barred lists and thresholds live as data in `packages/rules`, so a change is a data edit plus tests.
- **CUI on a dev machine.** A user could still paste CUI into notes. Mitigation: the CUI banner, the flag, and Key decisions stating that V1 isn't approved for CUI.
- **The SSP format has no official template.** Mitigation: follow the OSCAL SSP section shape (system characteristics, implementation, per-requirement statements), keep the docx generator isolated, and accept feedback in a later plan.

## Open questions
- The product name. "Rampart" is a placeholder.
- Settled at the go check (2026-11-23):
  - The suspension is real, and both assessment types stay.
  - The catalog is built from the PDFs.
  - CI is required.

## Verification
- `packages/catalog` tests pass with 14 families, 110 requirements and 320 objectives. Point values: 44 at 5 (3.5.3 and 3.13.11 included at their worst level), 14 at 3, 51 at 1, and CA.L2-3.12.4 unscored. The catalog metadata records its source PDFs and their checksums.
- Rule tests in `packages/rules` cite 32 CFR 170.24 or 170.21 and cover at least these cases:
  - All Met scores 110, and all Not Met (worst case) scores −203. With no SSP, the result is "assessment incomplete" rather than a score.
  - 3.5.3 and 3.13.11 subtract 3 or 5 by implementation level.
  - Scores of 88 and 87 sit on each side of the Conditional threshold.
  - Each of the 6 barred requirements is rejected for a POA&M.
  - A 3-point requirement other than 3.13.11 is rejected, and 3.13.11 at −3 is accepted.
  - The 180-day due date is computed from the Conditional Status Date.
- From a clean clone on Windows, one documented command installs, migrates and starts the app. CI is green on the final PR: clean install, lint, typecheck, tests, build, and gitleaks.
- An end-to-end smoke (Playwright) runs this path in the browser:
  1. Create an admin.
  2. Mark objectives so the score is 72 with 3.1.20 Not Met. The dashboard shows 72, HOLD and the 3.1.20 blocker, and adding 3.1.20 to a POA&M is refused.
  3. Fix 3.1.20 and reach 88 or more with eligible POA&M items. The stamp shows ACCEPT.
  4. Upload evidence and see its SHA-256. A CUI-flagged item refuses a file.
  5. Upload a policy and link it.
  6. Export the SSP and get a .docx with the system profile and every requirement's status and implementation statement.
- Every status, POA&M, evidence and policy change appears in the audit log with user, time, and before and after values.
- The UI matches `## Look` (C · Inspection, `cmmc-l2-grc-look-3.html`, with C's ruler for the score):
  - only the six palette tokens and the three fonts
  - no text under 16 px
  - every text pair at 4.5:1 or better, so body-size red text sits only on Sheet
  - the phone layout at 375 px has no horizontal scroll

## Queue log

Resolved handoff-queue entries for this plan, moved here when plan `ssp-export-v2` started.

- `[2026-11-24 · PENDING · engineer → human · plan: cmmc-l2-grc · sprint: foundation · slice: C1]` 23 requirements in NIST SP 800-171A have one unlettered "Determine if…" statement instead of lettered objectives. The catalog gives each one a single objective `[a]` (for example `3.4.4[a]`), as the CMMC assessment guide does, so the total stays 320. You'll see these IDs on the assessment screen. Reply `ok` or give another ID form. **Resolution:** 2026-11-25 — default recorded: `[a]` IDs; override anytime (pod-docs/decisions.md "Objective IDs for single-statement requirements")
- `[2026-11-24 · PENDING · engineer → human · plan: cmmc-l2-grc · sprint: foundation · slice: C1]` The two NIST PDFs word 3.3.2 slightly differently: SP 800-171 Rev 2 has "…those users, so they can…" and SP 800-171A drops the comma. The catalog keeps the Rev 2 wording through an override, listed in `packages/catalog/README.md` for you to spot-check. Reply `ok` or say which wording to keep. **Resolution:** 2026-11-25 — default recorded: Rev 2 wording; override anytime (pod-docs/decisions.md "3.3.2 wording")
- `[2026-11-24 · PENDING · engineer → sprint-planner · plan: cmmc-l2-grc · sprint: foundation · slice: R1]` The rules don't check objective status values at runtime. The assessment sprint's API must zod-validate incoming objective results to exactly `met | not_met | na | not_assessed`, or the counts go wrong. **Resolution:** 2026-11-24 — A3 validates objective status to exactly met | not_met | na | not_assessed (PR #6)
- `[2026-11-24 · PENDING · engineer → sprint-planner · plan: cmmc-l2-grc · sprint: foundation · slice: R2]` Contract friction: the frozen `Regulation` type has no field for the "POA&M only for NOT MET" citation (32 CFR 170.24(c)(2)(i)(B)(6)), so it lives as `POAM_NOT_MET_CITATION` outside `REGULATION`. Consider adding `poamNotMetOnly: Cited<…>` to `Regulation`. **Resolution:** 2026-11-24 — R5 added cited `poamNotMetOnly` to `Regulation` (v1.1.0) and removed POAM_NOT_MET_CITATION (PR #7)
- `[2026-11-24 · PENDING · engineer → sprint-planner · plan: cmmc-l2-grc · sprint: foundation · slice: A1]` Fastify client-error mapping isn't in the contract. Malformed JSON gives 400 `validation_failed`, and 415 also uses code `validation_failed`, so consider adding `unsupported_media_type`. A bad or oversize body sent to an unknown route returns 400 or 413 rather than 404, because Fastify parses the body before routing. **Resolution:** 2026-11-24 — K1 added unsupported_media_type (415) and 404-before-body (PR #4)
- `[2026-11-24 · PENDING · orchestrator → human · plan: cmmc-l2-grc · sprint: assessment · slice: L2]` On the objective status control, the selected option is always filled Ink (black), as the sprint scope says. The look-3 draft fills a selected "Not met" in Signal Red. Reply `ink` to keep it, or `red` to have a later slice fill Not met in red (each option already exposes `data-status`). **Resolution:** 2026-11-25 — default recorded: Ink; override anytime (pod-docs/decisions.md "Selected Not met objective radio fill")
- `[2026-11-24 · PENDING · engineer → human · plan: cmmc-l2-grc · sprint: assessment · slice: A2]` Auth default: when an admin resets a user's password, it also clears that user's lockout (failed count and lock time), so the new password works at once. Reply `ok`, or `keep lock` to make the user wait out the 15 minutes. **Resolution:** 2026-11-24 — accepted as built **Answer (human):** ok
- `[2026-11-24 · PENDING · engineer → human · plan: cmmc-l2-grc · sprint: assessment · slice: A2]` Auth default: when an admin resets their own password or deactivates themself (allowed only while another active admin exists), every one of their sessions ends, including the current one, so they must sign in again. Reply `ok`, or `keep current` to end only their other sessions. **Resolution:** 2026-11-24 — accepted as built **Answer (human):** ok
- `[2026-11-24 · PENDING · engineer → human · plan: cmmc-l2-grc · sprint: assessment · slice: A2]` Auth default: a sign-in to a deactivated account never counts a failure or locks. It always gets the same "Email or password is incorrect" 401, so a 429 can't reveal that the account exists. Reply `ok`, or say otherwise. **Resolution:** 2026-11-24 — accepted as built **Answer (human):** ok
- `[2026-11-24 · PENDING · orchestrator → human · plan: cmmc-l2-grc · sprint: assessment · slice: A2]` one-way door in the assessment wave 2 PR: A2 turns on sign-in (every API route except health, session status, setup and sign-in needs a signed-in user, and every write needs the CSRF token), and adds `@node-rs/argon2` and `@fastify/cookie`. Undo: revert A2's merge commit. The user and session rows stay in the database, unused. **Resolution:** 2026-11-24 — accepted, PR #5 merged **Answer (human):** you merge it
- `[2026-11-24 · PENDING · engineer → human · plan: cmmc-l2-grc · sprint: assessment · slice: W1]` On your own row in Settings › Users, "Reset password" and "Deactivate" act without a warning. Both end your session, and you land on Sign in with "Your session ended. Sign in again." Reply `add confirm` to have a later slice ask "This will sign you out. Continue?" first, or `ok` to keep it as is. **Resolution:** 2026-11-25 — default recorded: no confirm step; override anytime (pod-docs/decisions.md "No confirm step before resetting or deactivating yourself")
- `[2026-11-24 · PENDING · orchestrator → sprint-planner · plan: cmmc-l2-grc · sprint: poam-evidence · slice: K2]` now — the API's request logs record the `x-csrf-token` header value in plain text. The logger in `apps/api/src/logger.ts` redacts cookie, authorization and set-cookie, but not this header. The token is bound to the session, so it isn't a credential on its own, but it doesn't belong in logs. Add `req.headers["x-csrf-token"]` to the pino redact paths, with a test, in the next slice that can own `logger.ts`. **Resolution:** 2026-11-25 — P1 added `x-csrf-token` to the pino redact paths with a test; 0 tokens in the smoke log (PR #10)
- `[2026-11-25 · PENDING · orchestrator → human · plan: cmmc-l2-grc]` gate 6 (escalation-valve): the final plan PR `cmmc-l2-grc` → `main` will be withheld by policy, because the plan adds database migrations (0001–0004, additive). Undo: revert the final PR's merge commit on `main`. The local database keeps its tables, unused. **Resolution:** 2026-11-25 — accepted, PR #13 merged **Answer (human):** You merge it
- `[2026-11-25 · PENDING · human → orchestrator · plan: cmmc-l2-grc]` after plan complete: run `/pod:research` on SSP document templates to use as a reference folder: official NIST SP 800-171 SSP template (CSRC), DoD and CMMC SSP templates and guidance, the OSCAL SSP model, and well-regarded vendor or community CMMC L2 SSP templates. Compare their section structure and fields against Rampart's exported SSP .docx, and list the gaps. Save the findings, and the source links for a `templates/` reference folder, to `pod-docs/research/`. **Resolution:** 2026-11-25 — done: pod-docs/research/ssp-templates.md (+ .html)
- `[2026-11-25 · PENDING · reviewer → human · plan: cmmc-l2-grc]` now: "today" is the UTC date everywhere (`apps/api/src/poam/repository.ts:36`, `apps/api/src/assessment/repository.ts:88`). For a US user after about 4–5 pm local time, an item due today reads "Overdue by 1 day" and every countdown is one day lower. `contract/poam.ts` documents UTC days, so this is a product choice. Fixing it needs the user's time zone, e.g. a setting or the browser's offset sent with requests. **Resolution:** 2026-11-25 — default recorded: UTC days; override anytime (pod-docs/decisions.md "Today is the UTC date")
- `[2026-11-25 · PENDING · orchestrator → human · plan: cmmc-l2-grc]` plan cmmc-l2-grc complete — final PR https://github.com/haophn01/fun-thinking-rampart/pull/13, review pass (round 2). The open entries are sorted in the hand-back: 5 decisions recorded as defaults, 1 before-hosting item, 2 someday items, and 1 post-plan research task. Report: pod-docs/reports/cmmc-l2-grc.html. **Resolution:** 2026-11-25 — final PR merged
