# Sprint: SSP, dashboard and end-to-end smoke

_From plan: pod-docs/plans/cmmc-l2-grc.md · Slug: ssp-dashboard · Status: active · Generated: 2026-11-24_

<!-- autopilot-run: started=2026-11-23T22:30:00-08:00 sprints=3 waves=11 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | X1 | Dependencies, Playwright harness, e2e CI job, one-command start | ssp-dashboard-x1 | merged | done | medium | — |
| 1 | R6 | Rules: a Not Met requirement needs an open POA&M item (contract change) | ssp-dashboard-r6 | merged | done | medium | — |
| 1 | P1 | System profile: contract, migration, API; redact the CSRF header in logs | ssp-dashboard-p1 | merged | done | high | — |
| 1 | L4 | Look: dimension-line ruler, feature control frame, stamp, IR strip; mount pages | ssp-dashboard-l4 | merged | done | high | — |
| 2 | S3 | SSP export: .docx builder and `GET /api/ssp/export` | ssp-dashboard-s3 | — | pending | — | X1, P1 |
| 2 | W7 | Readiness dashboard | ssp-dashboard-w7 | — | pending | — | R6, P1, L4 |
| 2 | W8 | SSP page: system profile form and export | ssp-dashboard-w8 | — | pending | — | P1, L4 |
| 3 | E2 | End-to-end smoke, Look checks, docs | ssp-dashboard-e2 | — | pending | — | X1, R6, P1, L4, S3, W7, W8 |

Plan branch `cmmc-l2-grc`; wave heads `ssp-dashboard-w1`, `ssp-dashboard-w2`, `ssp-dashboard-w3`. Merge target `main`. This is the plan's last sprint: E2 proves the plan's **Verification** section.

## Shared contract

Everything in the foundation, assessment and poam-evidence Shared contracts still holds (tooling, frozen types, error envelope, `respond()`, the guard and check order, `recordAudit` in the change's transaction, the Look contract, `createHarness()`, the upload protocol), except where this section changes it.

### Run facts
- pnpm: `corepack enable` fails with EPERM here; use the scratchpad shims or `corepack pnpm …` (`pod-docs/known-issues/corepack-enable-eperm.md`).
- **Ports** (Windows reserves 3057–3156): X1 3200/3201, R6 3210/3211, P1 3220/3221, L4 3230/3231, S3 3240/3241, W7 3250/3251, W8 3260/3261, E2 3270/3271 (web/api). Playwright defaults to `E2E_WEB_PORT` 3290 and `E2E_API_PORT` 3291.
- **Human PENDINGs, on the values in use:** `[a]` objective IDs, the Rev 2 wording of 3.3.2, the selected Not met radio stays Ink, no confirm step on self-reset. Nothing here hard-codes any of them.
- **Queue item folded in:** the K2 PENDING (`x-csrf-token` in logs) is fixed by P1.
- **UI tests** wait for a request before answering it and keep `testTimeout` above 5 s. A test that renders an API-backed page as a throwaway route mocks its call.

### Dependencies (the lockfile opens for X1 only)
X1 adds exactly these and commits `pnpm-lock.yaml`: `docx` (apps/api dependency); `fflate` (devDependency of the root and of apps/api, to unzip .docx files in tests); `@playwright/test` (root devDependency); `@rampart/catalog` and `@rampart/rules` as `workspace:*` root devDependencies (so e2e specs can plan scores from the data). None of them needs a build script. If one fails to install on Windows, add a `BLOCKED` entry to `orchestrator`; don't switch packages. No other slice changes dependencies.

### Decision: a Not Met requirement with no open POA&M item blocks ACCEPT (R6; contract change, as R5 did)
32 CFR 170.24(c)(2)(i)(B)(6) requires a POA&M for each Not Met requirement, and the plan's Verification reaches ACCEPT only "with eligible POA&M items". So Conditional status needs an **open** POA&M item for every Not Met requirement. The orchestrator records this in `decisions.md`.

`packages/rules/src/types.ts` changes exactly these three declarations (the file stays in `.prettierignore`); everything else in it is unchanged:
```ts
export interface AssessmentInput { objectiveResults: readonly ObjectiveResult[];
  implementationLevels: Readonly<Partial<Record<RequirementId, ImplementationLevel>>>;
  openPoamRequirementIds?: readonly RequirementId[] }   // absent: the caller has no POA&M data
export type Blocker =
  | { code: 'prerequisite_not_met'; requirementId: RequirementId; citation: string }
  | { code: 'not_assessed'; requirementIds: RequirementId[] }
  | { code: 'below_threshold'; score: number; threshold: number; citation: string }
  | { code: 'poam_ineligible'; requirementId: RequirementId; reasons: IneligibleCode[]; citation: string }
  | { code: 'poam_missing'; requirementId: RequirementId; citation: string };
export interface Regulation { id: 'cmmc-32-cfr-170'; version: string; sources: { title: string; url: string }[];
  conditionalMinScore: Cited<number>; poamNotMetOnly: Cited<boolean>; poamRequiredForNotMet: Cited<boolean>;
  poamMaxItemPoints: Cited<number>;
  poamPointExceptions: { requirementId: RequirementId; implementationLevel: ImplementationLevel; maxPoints: number; citation: string }[];
  poamBarred: Cited<RequirementId[]>; closeoutWindowDays: Cited<number>;
  closeoutConfirmedBy: Cited<Record<AssessmentType, 'organization' | 'c3pao'>> }
```
- `REGULATION.poamRequiredForNotMet = { value: true, citation: '32 CFR 170.24(c)(2)(i)(B)(6)' }`; `REGULATION.version` becomes `'1.2.0'`.
- `checkConditional(catalog, outcomes, score, regulation?, openPoamRequirementIds?)`; `evaluateAssessment` passes `input.openPoamRequirementIds`.
- **The rule and its edges:**
  - It applies only when `openPoamRequirementIds` is given and `poamRequiredForNotMet.value` is true. When the key is absent or the value is false, no `poam_missing` is added, so callers without POA&M data keep today's behavior.
  - Each Not Met requirement that is POA&M-eligible and isn't in the list gets one `poam_missing`. An ineligible one gets only its `poam_ineligible`, never both.
  - Blocker order: `prerequisite_not_met`, `not_assessed`, `below_threshold`, every `poam_ineligible` in catalog order, then every `poam_missing` in catalog order.
  - IDs in the list whose requirement is Met or Not Assessed are ignored. Duplicates count once. An ID not in the catalog throws `RulesInputError('unknown_requirement')`.
  - `poam_missing` alone makes the status `not_eligible` (HOLD). With every Not Met requirement covered and no other blocker, the status is `conditional`.
  - 3.13.11 Not Met at `partial` is eligible, so it needs an item. 3.13.11 at `none` is `poam_ineligible` only.
  - `applyWhatIf` keeps `openPoamRequirementIds` as it was (a copy). A what-if that turns a requirement Not Met with no item shows `poam_missing`.
- **Only open items count.** A closed item on a requirement that is Not Met again doesn't cover it.
- **API:** `loadInput` always sets `openPoamRequirementIds` (open `poam_item` rows of the active assessment, catalog order), so every `evaluation` the api returns has the rule applied. `assessmentViewSchema` gains `openPoamRequirementIds: z.array(z.string()).optional()`, which the api always sends. `toAssessmentInput(view)` passes it on only when present, so the workspace's live and what-if scores match the api.
- **Contract mirror:** `blockerSchema` gains `poam_missing`. `blockerText` reads: `<id> is Not Met and has no open POA&M item`.

### System profile (P1)
- **DB:** migration `0004_system_profile` (additive). Table `system_profile`: `assessment_id` (text PK, FK → assessment), one nullable text column per field below, `updated_by` (FK user, not null), `updated_at` (not null). The first PATCH creates the row.
- **Fields**, in this order, exported as `SYSTEM_PROFILE_FIELDS: readonly { key, label }[]` from `contract/system-profile.ts`. All are nullable; text trims, and empty or whitespace-only becomes `null`:

  | key | label | rule |
  |---|---|---|
  | `systemName` | System name | ≤ 200 |
  | `systemIdentifier` | System identifier | ≤ 100 |
  | `organizationName` | Organization | ≤ 200 |
  | `cageCode` | CAGE code | exactly 5 of `[A-Z0-9]` after trimming and uppercasing |
  | `description` | System description | ≤ 20,000 |
  | `authorizationBoundary` | Authorization boundary | ≤ 20,000 |
  | `environment` | Operating environment | ≤ 20,000 |
  | `interconnections` | Interconnections with other systems | ≤ 20,000 |
  | `informationTypes` | Information types handled | ≤ 20,000 |
  | `systemOwner` | System owner | ≤ 200 |
  | `systemOwnerEmail` | System owner email | `emailSchema` |
  | `securityContact` | Security contact | ≤ 200 |
  | `securityContactEmail` | Security contact email | `emailSchema` |
- **Schemas:** `systemProfileSchema` = every field (`string | null`) plus `updatedAt: string | null` and `updatedBy: UserRef | null` (both null before the first save). `systemProfileResponseSchema` = `{ profile }`. `patchSystemProfileRequestSchema` is strict, every field optional, and rejects `{}`.
- **Routes:**

  | Route | Who | Success | Failures |
  |---|---|---|---|
  | `GET /api/system-profile` | signed in | `{ profile }` (all null with no row) | 404 with no assessment |
  | `PATCH /api/system-profile` | signed in (admin or contributor), CSRF | `{ profile }` | 400, 404 with no assessment |
- **Audit:** action `system_profile.updated`, entity type `system_profile`, `entityId` = the assessment ID. `before` is null on the first save; after that, `before` and `after` hold only the changed fields. A patch that changes nothing writes nothing.
- `loadSystemProfile(db, assessmentId): SystemProfile` (`apps/api/src/system-profile/repository.ts`) is the one read path. S3 uses it.

### SSP export (P1 defines `contract/ssp.ts`; S3 builds)
- `SSP_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'`.
- `sspFileName(systemIdentifier: string | null, today: string)` gives `SSP-<id>-<today>.docx`. The ID keeps `[A-Za-z0-9._-]`, turns each other run into one `-`, trims `-` from both ends and caps at 64 characters. `null`, or nothing left after cleaning, gives `system`.
- `REQUIREMENT_STATUS_LABELS`: met `Met`, not_met `Not Met`, not_assessed `Not Assessed`. An `allNa` requirement reads `Not Applicable`. `OBJECTIVE_STATUS_LABELS`: `Met`, `Not Met`, `N/A`, `Not Assessed`. `CONDITIONAL_STATUS_LABELS` holds the four labels ScorePanel uses ("Final status reachable", …).
- `GET /api/ssp/export` (signed in, any role) answers 200 with `content-type: SSP_CONTENT_TYPE`, `attachment` disposition through `attachmentDisposition(sspFileName(...))`, and `cache-control: no-store`. "Today" is the UTC date of `deps.now()`. It writes nothing and records no audit event. 401 when signed out, 404 with no assessment.
- **Document order** (S3 tests it):
  1. Title "System Security Plan", the system name (or "System not named"), and "Generated by `PRODUCT_NAME` on `<today>`". Then the catalog version, the regulation version and the assessment type label.
  2. "1. System characteristics": one row per `SYSTEM_PROFILE_FIELDS` entry, label then value, or "Not provided".
  3. "2. Assessment summary": `SPRS <score> / <max>`, or "SPRS incomplete: CA.L2-3.12.4 must be Met". Then the Conditional status label, the Conditional Status Date and closeout deadline when set, the requirement counts by status, and the open POA&M count.
  4. "3. Security requirements": one heading per family (`3.1 Access Control (AC)`). Under it, each requirement in catalog order gets its ID and text, then:
     - "Status:", plus the points (or "Prerequisite"), the implementation level (3.5.3 and 3.13.11 only) and the owner (or "Unassigned")
     - "Implementation statement:" and the text (one paragraph per line), or "No implementation statement recorded."
     - an objectives table (ID, text, status)
     - "Policies:" and "Evidence:" with linked titles (evidence via its objectives), or "None linked"
     - its open POA&M item (due date and plan), if there is one
  5. "4. Plan of action and milestones": a table of every item (requirement, status, due, plan, milestone count, owner, closeout date).
- Text drops characters XML 1.0 forbids (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F) and keeps everything else, `<` and `&` included.

### E2E harness (X1 sets up; E2 fills)
- `playwright.config.ts` at the root and specs in `e2e/*.spec.ts` (Vitest never collects them). Chromium only, `workers: 1`, `retries: 0`, `reuseExistingServer: false`. A failure keeps its trace and screenshot.
- **Fresh state every run:** the config sets `process.env.E2E_RUN_DIR ??= mkdtempSync(join(tmpdir(), 'rampart-e2e-'))`, so workers inherit the same folder. `webServer` starts the api, without watch, with `API_PORT`, `DATABASE_PATH=<run dir>/e2e.sqlite`, `STORAGE_PATH=<run dir>/files` and `LOG_LEVEL=warn`, waiting on `/api/health`. It starts the web (Vite) with `WEB_PORT` and `API_PORT`. Both bind 127.0.0.1.
- `e2e/helpers/` (E2 adds): `api(page)` signs requests with the CSRF token from `GET /api/session` through `page.request`, which shares the browser's cookie. `docxText(bytes)` unzips with fflate and returns the text of `word/document.xml`.
- Root scripts: `e2e` = `playwright test`; `start` = `node scripts/start.ts`. `verify` is unchanged.
- **CI job `e2e`** in `pod-ci.yml`: matrix `ubuntu-latest` and `windows-latest`, `fail-fast: false`, `timeout-minutes: 20`. Steps: checkout; setup-node 24 with `package-manager-cache: false`; `corepack enable`; `pnpm install --frozen-lockfile`; `pnpm exec playwright install --with-deps chromium`; `pnpm e2e`; and on failure, `actions/upload-artifact` with the report. It's a job of its own, so a browser download never slows `verify` and an e2e failure reads as one. It runs on both OSes because the plan's target is a Windows machine.

### One-command start (X1)
- From a clean clone: **`corepack pnpm start`**. `scripts/start.ts` (Node 24 runs it directly; `node:` imports only) runs `pnpm install --frozen-lockfile`, then `pnpm db:migrate`, then `pnpm dev`, using the pnpm that launched it (`process.execPath` + `npm_execpath`, or `corepack pnpm` when that is unset). It passes the env through, so `API_PORT` and `WEB_PORT` work, and stops at the first failing step with that step's exit code. The script exports a pure `startSteps()` and an injectable runner for tests.

### Look additions (L4, `apps/web/src/look/`, exported from `look/index.ts`)
- `DimensionRuler({ value: number | null, floor, max, threshold })` draws C's ruler:
  - an Ink scale from `floor` to `max`, with ticks every 25 (each multiple of 25 in range) and majors at multiples of 100
  - labels at `floor`, −100, 0 and `max`
  - a Red threshold line labelled `<threshold> CONDITIONAL`, a Blue "YOU `<value>`" marker, and a dashed Blue dimension from the value to the threshold labelled `+<threshold − value>` when the value is below it
  - Values come from the evaluation (`score.floor`, `score.max`) and `REGULATION.conditionalMinScore`, never literals.
  - `rulerPercent(value, floor, max)` clamps to 0–100 and throws `RangeError` when `floor >= max`.
  - Every label is an HTML element at `--rp-text-label` (16 px) or larger. There is no SVG `<text>`, so labels never shrink on phones. The ruler sits on Sheet.
  - `role="img"`, with an `aria-label` such as "SPRS 72 on a scale from −203 to 110. Conditional line at 88. 16 points short." At or above the line, the last sentence is "At or above the Conditional line." With `null`, it starts "No SPRS score yet" and has no marker and no dimension.
- `FeatureControlFrame({ measured, lsl, usl })` shows cells `SPRS | MEAS <n> | LSL <lsl> | USL <usl> | <result>`. Negative numbers use U+2212; `null` shows `MEAS —`.
  - The result is `IN TOL` when `lsl ≤ measured ≤ usl` (Sheet on Blue), `OUT OF TOL` otherwise (Sheet on Red), and `NO READING` when `null` (Graphite).
  - `data-status` is `in_tol | out_of_tol | no_reading`.
- `InspectionStamp({ verdict: 'accept' | 'hold', detail })` is a rotated Red-ink stamp on Sheet: `HOLD` or `ACCEPT` at 28 px display, with `detail` below it at 16 px mono bold. It has `data-variant` set to the verdict and `aria-label="Inspector's stamp: HOLD"` (or ACCEPT).
- `InspectionStrip({ entries: { label, value }[] })`: 6 columns on desktop, 2 on phones, values in 16 px mono bold.
- **Red text** at body size only on Sheet; large Red text (24 px+) may sit on Vellum. Only the six tokens.

### Web contract
- L4 mounts `pages/dashboard/DashboardPage.tsx` at `/` and `pages/ssp/SspPage.tsx` at `/ssp` in `App.tsx`. Each starts as the placeholder (h1 plus "This section isn't built yet."); W7 and W8 fill them.
- Each page renders its h1 at once whatever the API answers, shows "Loading…" while loading, and shows an error `Alert` with Retry when any of its calls fails.
- **Verdict:** ACCEPT exactly when `evaluation.conditional.status` is `final` or `conditional`, otherwise HOLD. The dashboard uses the api's saved `evaluation`, never a local one.
- Manual checks run at 1280 px and 375 px against the real API (brief's Smoke recipe), with no horizontal scroll at 375 px.

### Orchestrator tasks (not slice work)
- After R6 merges: add a `decisions.md` entry, "Conditional status needs an open POA&M item per Not Met requirement" (32 CFR 170.24(c)(2)(i)(B)(6)), and link it from the sprint PR.
- After P1 merges: resolve the K2 `x-csrf-token` PENDING.
- After wave 3: fill `pod-docs/features.md`, one row each. Use the drive and proof from E2's smoke steps:
  - setup and sign-in
  - objective status and the live score
  - what-if
  - dashboard ruler, frame and stamp (HOLD to ACCEPT)
  - POA&M create, and the refusal for 3.1.20
  - evidence upload with its SHA-256, and the CUI refusal
  - policy upload and link
  - system profile save (survives a reload)
  - SSP export
  - audit log
  - assessment settings

## Per-slice detail

### X1: Dependencies, Playwright harness, e2e CI job, one-command start
- **Scope:** Add the dependencies under **Dependencies**. Set up the **E2E harness**: config, one spec, the `e2e` script and the CI job. Ignore `playwright-report/` and `test-results/` in git, ESLint and Prettier, and add `e2e/**/*.ts`, `playwright.config.ts` and `scripts/**/*.ts` to the root tsconfig. Add the **One-command start**. Update the README's Setup (the clean-clone command, then `pnpm e2e` and what it needs: `pnpm exec playwright install chromium` once) and its Scripts table. Update the brief's `## CI` and its Smoke recipe **Install** line. Don't write the smoke path; that's E2.
- **Files owned:** `package.json`, `apps/api/package.json`, `pnpm-lock.yaml`, `playwright.config.ts` (new), `e2e/shell.spec.ts` (new), `scripts/start.ts` (new), `tests/repo/start-script.test.ts` (new), `tests/repo/ci-workflow.test.ts`, `.github/workflows/pod-ci.yml`, `tsconfig.json`, `eslint.config.js`, `.prettierignore`, `.gitignore`, `README.md`, `CONTRIBUTING.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test]` on a fresh DB the web shows Setup with the product name, and `/api/health` answers ok through the web origin — e2e/shell.spec.ts › fresh install shows Setup
  - `[test]` a spec can import `@rampart/catalog` and see 110 requirements and 320 objectives — e2e/shell.spec.ts › workspace data is importable
  - `[test]` the e2e job has the matrix, the fail-fast and timeout settings, and the step order above, with cache off before `corepack enable` — tests/repo/ci-workflow.test.ts › e2e job installs chromium and runs pnpm e2e on both OSes
  - `[test]` the verify and secrets jobs are unchanged — tests/repo/ci-workflow.test.ts › verify job runs frozen install and pnpm verify on both OSes
  - `[test]` the steps are install --frozen-lockfile, then db:migrate, then dev, in that order — tests/repo/start-script.test.ts › runs install, migrate, dev
  - `[test]` a failing step stops the later ones and exits with its code — tests/repo/start-script.test.ts › stops at the first failure
  - `[test]` it uses `npm_execpath` when set and falls back to `corepack pnpm`, and passes `API_PORT` and `WEB_PORT` through — tests/repo/start-script.test.ts › runner and env
  - `[test]` `pnpm verify` doesn't collect `e2e/` specs — tests/repo/start-script.test.ts › vitest ignores e2e specs
  - `[manual]` from a fresh clone in PowerShell, `corepack pnpm start` installs, migrates and serves Setup at http://127.0.0.1:3000 — run it in a scratch clone
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### R6: Rules: a Not Met requirement needs an open POA&M item (contract change)
- **Scope:** Implement **Decision: a Not Met requirement with no open POA&M item blocks ACCEPT** end to end:
  - the three type changes, `REGULATION` 1.2.0 and the README rules table
  - `checkConditional` and `evaluateAssessment`, with validation in `validateInput`
  - `applyWhatIf` keeping the list
  - the contract mirror and the optional view field
  - the api's `loadInput`
  - `toAssessmentInput` and `blockerText`

  Update the existing tests the change breaks. Don't change the score, eligibility or POA&M routes.
- **Files owned:** `packages/rules/src/types.ts`, `packages/rules/src/poam/regulation.ts`, `packages/rules/src/poam/regulation.test.ts`, `packages/rules/src/poam/conditional.ts`, `packages/rules/src/poam/conditional.test.ts`, `packages/rules/src/evaluate.ts`, `packages/rules/src/evaluate.test.ts`, `packages/rules/src/validate.ts`, `packages/rules/src/poam/poam-missing.test.ts` (new), `packages/rules/README.md`, `apps/api/src/contract/evaluation.ts`, `apps/api/src/contract/assessment.ts`, `apps/api/src/contract-rules-types.test.ts`, `apps/api/src/assessment/repository.ts`, `apps/api/src/assessment/view.test.ts`, `apps/api/src/assessment/objectives.test.ts`, `apps/api/src/assessment/requirements.test.ts`, `apps/api/src/assessment/poam-coverage.test.ts` (new), `apps/web/src/score/input.ts`, `apps/web/src/score/input.test.ts`, `apps/web/src/score/blockerText.ts`, `apps/web/src/score/blockerText.test.ts` (new)
- **Success criteria:**
  - `[test]` `REGULATION.poamRequiredForNotMet` is `true` and cites 32 CFR 170.24(c)(2)(i)(B)(6), with version `1.2.0` — packages/rules/src/poam/regulation.test.ts › poamRequiredForNotMet is cited data
  - `[test]` an eligible Not Met requirement missing from the list gives `poam_missing` and `not_eligible`; once listed, the status is `conditional` — packages/rules/src/poam/poam-missing.test.ts › missing item blocks, open item clears
  - `[test]` with the key absent, or the regulation value false, no `poam_missing` is added — packages/rules/src/poam/poam-missing.test.ts › absent list or rule off skips the check
  - `[test]` an ineligible requirement gets only `poam_ineligible`; 3.13.11 at partial needs an item; at none it is ineligible only — packages/rules/src/poam/poam-missing.test.ts › ineligible never doubles; 3.13.11 levels
  - `[test]` blocker order puts `poam_ineligible` then `poam_missing`, each in catalog order — packages/rules/src/poam/poam-missing.test.ts › blocker order
  - `[test]` Met or Not Assessed IDs in the list are ignored, duplicates count once, and an unknown ID throws `unknown_requirement` — packages/rules/src/poam/poam-missing.test.ts › list edges
  - `[test]` `applyWhatIf` keeps the list, and turning a requirement Not Met adds `poam_missing` — packages/rules/src/evaluate.test.ts › what-if keeps open POA&M list
  - `[test]` the zod mirrors still infer exactly the rules types — apps/api/src/contract-rules-types.test.ts › mirrors match rules types
  - `[test]` the view's `openPoamRequirementIds` lists only open items in catalog order; a closed item's requirement turned Not Met again gets `poam_missing` — apps/api/src/assessment/poam-coverage.test.ts › only open items cover
  - `[test]` creating an open item clears that requirement's `poam_missing` in the next `GET /api/assessment` and objective write — apps/api/src/assessment/poam-coverage.test.ts › evaluation follows POA&M items
  - `[test]` `toAssessmentInput` passes the list only when present, and the local evaluation equals the api's — apps/web/src/score/input.test.ts › carries open POA&M list
  - `[test]` `poam_missing` reads "<id> is Not Met and has no open POA&M item" — apps/web/src/score/blockerText.test.ts › poam_missing text
- **Depends on:** —
- **One-way door:** none. Stored data doesn't change; the Conditional check gets stricter.
- **Model:** opus

### P1: System profile: contract, migration, API; redact the CSRF header in logs
- **Scope:**
  - **System profile:** the contract, `contract/ssp.ts` (the S3 constants and `sspFileName`), the migration, `loadSystemProfile`, and the two routes with their audit. Add the new audit action and entity, with web labels.
  - **Route stubs:** create `registerSspRoutes` (empty) in `apps/api/src/ssp/routes.ts` for S3, and wire both new route files into `registerApiRoutes`.
  - **Log redaction:** add `req.headers["x-csrf-token"]` to `REDACT_PATHS`.
  - **Not in this slice:** the SSP document and any UI page.
- **Files owned:** `apps/api/src/contract/system-profile.ts` (new), `apps/api/src/contract/ssp.ts` (new), `apps/api/src/contract/audit.ts`, `apps/api/src/contract/index.ts`, `apps/api/src/contract/schemas.test.ts`, `apps/api/src/contract/system-profile.test.ts` (new), `apps/api/db/schema.ts`, `apps/api/db/migrations/0004_system_profile.sql` (new), `apps/api/db/migrations/meta/0004_snapshot.json` (new), `apps/api/db/migrations/meta/_journal.json`, `apps/api/db/system-profile.test.ts` (new), `apps/api/src/system-profile/repository.ts` (new), `apps/api/src/system-profile/routes.ts` (new), `apps/api/src/system-profile/routes.test.ts` (new), `apps/api/src/ssp/routes.ts` (new), `apps/api/src/routes/index.ts`, `apps/api/src/logger.ts`, `apps/api/src/logger.test.ts` (new), `apps/web/src/pages/settings/auditLabels.ts`, `apps/web/src/pages/settings/AuditLog.test.tsx`
- **Success criteria:**
  - `[test]` text fields trim and turn empty to null; length caps, the CAGE format (lowercase uppercased, 4 or 6 characters refused) and email checks hold; patches are strict and `{}` is refused — apps/api/src/contract/system-profile.test.ts › field rules
  - `[test]` `sspFileName` cleans, caps at 64, and falls back to `system` for null and for all-symbol IDs — apps/api/src/contract/system-profile.test.ts › sspFileName edges
  - `[test]` the migration is additive: a 0003 DB with rows upgrades and keeps every row, and a second run is a no-op — apps/api/db/system-profile.test.ts › 0004 is additive
  - `[test]` GET with no row gives every field null and `updatedBy` null — apps/api/src/system-profile/routes.test.ts › empty profile
  - `[test]` the first PATCH audits with `before` null; a change audits only the changed fields; an identical PATCH writes no event — apps/api/src/system-profile/routes.test.ts › audit edges
  - `[test]` a contributor can PATCH; signed out gives 401; a missing CSRF token gives 403 `csrf_failed`; no assessment gives 404 — apps/api/src/system-profile/routes.test.ts › access
  - `[test]` a saved profile survives a new app on the same file DB — apps/api/src/system-profile/routes.test.ts › persists across restart
  - `[test]` a request with `x-csrf-token` logs `[Redacted]`, and the token value appears in no captured log line — apps/api/src/logger.test.ts › redacts x-csrf-token
  - `[test]` the audit action and entity lists include the new entries, and every one has a label — apps/web/src/pages/settings/AuditLog.test.tsx › labels cover the contract
- **Depends on:** —
- **One-way door:** none. The migration only adds a table.
- **Model:** opus

### L4: Look: dimension-line ruler, feature control frame, stamp, IR strip; mount pages
- **Scope:** Build the four components in **Look additions**, add them to `/look.html`'s specimen (HOLD at 72, ACCEPT at 107, and incomplete), and mount the two placeholder page modules (**Web contract**). No data fetching.
- **Files owned:** `apps/web/src/look/DimensionRuler.tsx` (new), `apps/web/src/look/DimensionRuler.module.css` (new), `apps/web/src/look/FeatureControlFrame.tsx` (new), `apps/web/src/look/FeatureControlFrame.module.css` (new), `apps/web/src/look/InspectionStamp.tsx` (new), `apps/web/src/look/InspectionStamp.module.css` (new), `apps/web/src/look/InspectionStrip.tsx` (new), `apps/web/src/look/InspectionStrip.module.css` (new), `apps/web/src/look/inspection.test.tsx` (new), `apps/web/src/look/index.ts`, `apps/web/src/look/Specimen.tsx`, `apps/web/src/App.tsx`, `apps/web/src/pages/dashboard/DashboardPage.tsx` (new), `apps/web/src/pages/ssp/SspPage.tsx` (new)
- **Success criteria:**
  - `[test]` `rulerPercent` maps floor to 0 and max to 100, clamps outside values, and throws when `floor >= max` — apps/web/src/look/inspection.test.tsx › rulerPercent edges
  - `[test]` ticks every 25 with majors at multiples of 100, labels at floor, −100, 0 and max, and no SVG `<text>` — apps/web/src/look/inspection.test.tsx › ruler scale
  - `[test]` at 72 the gap reads `+16`; at 87, `+1`; at 88 and above, no gap; with `null`, no marker; the aria-label matches each case — apps/web/src/look/inspection.test.tsx › ruler gap and label
  - `[test]` the frame reads OUT OF TOL at 87, IN TOL at 88 and 110, and NO READING for null, with U+2212 for negatives — apps/web/src/look/inspection.test.tsx › feature control frame
  - `[test]` the stamp's text, `data-variant` and aria-label for both verdicts — apps/web/src/look/inspection.test.tsx › inspector's stamp
  - `[test]` the new CSS uses only the six tokens and `var(--rp-text-*)` sizes, and every text pair it sets passes the contrast rule — apps/web/src/look/inspection.test.tsx › tokens and contrast
  - `[test]` `/` and `/ssp` render their page modules with the right h1 — apps/web/src/look/inspection.test.tsx › pages mounted
  - `[manual]` at 1280 and 375 px, `/look.html` shows the ruler with no overlapping labels, every label at 16 px or more, and a rotated stamp — browser at both widths
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### S3: SSP export: .docx builder and `GET /api/ssp/export`
- **Scope:** Build the `apps/api/ssp` part:
  - `buildSspModel(source)` is pure. Its source is the catalog, the profile, the assessment view, the POA&M view, policies and evidence.
  - `renderSspDocx(model, { generatedAt })` uses `docx` and is deterministic for the same input and time.
  - `docxText(bytes)` is the test helper.

  Fill `registerSspRoutes` per **SSP export**, reading through `loadSystemProfile`, `readView`, `readPoamView`, `listPolicies` and `listEvidence`. Add `ssp/**/*.ts` to the api tsconfig. Don't change other routes.
- **Files owned:** `apps/api/ssp/index.ts` (new), `apps/api/ssp/model.ts` (new), `apps/api/ssp/render.ts` (new), `apps/api/ssp/testing/docx-text.ts` (new), `apps/api/ssp/model.test.ts` (new), `apps/api/ssp/render.test.ts` (new), `apps/api/src/ssp/routes.ts`, `apps/api/src/ssp/export.test.ts` (new), `apps/api/tsconfig.json`
- **Success criteria:**
  - `[test]` the sections come in the documented order, each profile field shows its value or "Not provided", and all 14 families and 110 requirements appear in catalog order — apps/api/ssp/model.test.ts › document order and completeness
  - `[test]` status labels, including `Not Applicable` for all-N/A, the points or Prerequisite, the level only on 3.5.3 and 3.13.11, and the owner or Unassigned — apps/api/ssp/model.test.ts › requirement lines
  - `[test]` an empty assessment gives Not Assessed everywhere and "SPRS incomplete"; a scored one gives `SPRS n / 110` and its Conditional label — apps/api/ssp/model.test.ts › summary edges
  - `[test]` linked policies and evidence titles appear, and only an open POA&M item shows under its requirement; every item is in section 4 — apps/api/ssp/model.test.ts › links and POA&M
  - `[test]` statements split into paragraphs on newlines, keep `<` and `&`, and drop forbidden control characters — apps/api/ssp/render.test.ts › text safety
  - `[test]` two renders of the same model at the same time give an identical `document.xml` — apps/api/ssp/render.test.ts › deterministic
  - `[test]` GET answers 200 with the content type, the `SSP-<id>-<today>.docx` disposition and no-store; the bytes start with `PK`; the text holds a saved profile value and a saved statement — apps/api/src/ssp/export.test.ts › exports the docx
  - `[test]` signed out gives 401; a contributor can export; the export writes no audit event — apps/api/src/ssp/export.test.ts › access and no side effects
  - `[manual]` the exported file opens in Word or LibreOffice with headings and tables intact — download it from the running api
- **Depends on:** X1, P1
- **One-way door:** none
- **Model:** opus

### W7: Readiness dashboard
- **Scope:** Fill `DashboardPage` from `GET /api/assessment`, `GET /api/poam`, `GET /api/system-profile` and the session user. It has five ballooned sections in the plan's Look grid and phone order:
  1. **SPRS score:** the big number (or —) over `/ max`, `DimensionRuler`, `FeatureControlFrame` (LSL = threshold, USL = max), and `InspectionStamp`. The stamp detail reads `<n> BLOCKER(S)` on HOLD, or `CONDITIONAL` / `FINAL` on ACCEPT. Under it, a sentence ("Conditional status needs 88. You are 16 points short." / "At or above the Conditional minimum of 88." / the SSP message when incomplete) and a "Continue assessment" link to `/assessment`.
  2. **Conditional check:** the status label, each blocker with `blockerText` and its citation, "POA&M · n open", and the closeout clock ("180-day clock: not started", "Closeout due <deadline> · n days left", or "Closeout deadline passed").
  3. **Objectives · 320:** counts of Met, Not met, N/A and Not assessed over every catalog objective (a missing result counts as not assessed), with StatusChips and a bar.
  4. **Families · 14:** each family's assessed-objective `GraduatedBar` and its Met and Not Met requirement counts.
  5. **Needs attention:** from a pure `needsAttention(view, poam, catalog)`, in this order: the SSP prerequisite, each `poam_ineligible` (link `/assessment`), each `poam_missing` (link `/poam`), overdue open items, items due after the deadline, items ready to close, then "n requirements not yet assessed". Requirement rows show the ID, a chip, the text, points and owner. With nothing to show: "Nothing needs attention."

  Below them sits the `InspectionStrip`: IR (`IR-` + the first 8 characters of the assessment ID, uppercased), Part (system name, or "System not named"), Spec (catalog version), Characteristics (the catalog's objective count), Inspector (the user) and Date (UTC today).
- **Files owned:** `apps/web/src/pages/dashboard/DashboardPage.tsx`, `apps/web/src/pages/dashboard/dashboard.module.css` (new), `apps/web/src/pages/dashboard/summary.ts` (new), `apps/web/src/pages/dashboard/attention.ts` (new), `apps/web/src/pages/dashboard/summary.test.ts` (new), `apps/web/src/pages/dashboard/attention.test.ts` (new), `apps/web/src/pages/dashboard/dashboard.test.tsx` (new)
- **Success criteria:**
  - `[test]` objective counts sum to the catalog total, with missing results counted as not assessed; family counts and percentages are right — apps/web/src/pages/dashboard/summary.test.ts › objective and family counts
  - `[test]` attention rows come in the documented order with the right links; an empty result says nothing needs attention — apps/web/src/pages/dashboard/attention.test.ts › order and empty
  - `[test]` overdue, due-after-deadline and ready-to-close come only from open items; a closed item never appears — apps/web/src/pages/dashboard/attention.test.ts › POA&M edges
  - `[test]` at 72 with a 3.1.20 blocker: 72, OUT OF TOL, HOLD and the 3.1.20 blocker text — apps/web/src/pages/dashboard/dashboard.test.tsx › hold at 72
  - `[test]` with status `conditional`, ACCEPT and IN TOL; at 95 with a `poam_missing` blocker, HOLD while IN TOL — apps/web/src/pages/dashboard/dashboard.test.tsx › stamp follows conditional status
  - `[test]` an incomplete score shows —, NO READING, HOLD and the SSP message — apps/web/src/pages/dashboard/dashboard.test.tsx › incomplete
  - `[test]` the h1 shows at once; a failed call shows the error with Retry, and Retry reloads — apps/web/src/pages/dashboard/dashboard.test.tsx › loading and error
  - `[test]` the strip shows the IR number, the system name or its fallback, 320, the user and today — apps/web/src/pages/dashboard/dashboard.test.tsx › inspection strip
  - `[manual]` at 1280 px the grid matches the Look's rows; at 375 px it's one column in the order score, Conditional, objectives, attention, families, with no horizontal scroll — real API, with some objectives marked
- **Depends on:** R6, P1, L4
- **One-way door:** none
- **Model:** sonnet

### W8: SSP page: system profile form and export
- **Scope:** Fill `SspPage`:
  - **Section 1, "System profile":** one control per `SYSTEM_PROFILE_FIELDS` entry, in order. The short fields are `TextField`s and the 20,000-character fields are `TextArea`s. Each validates with the contract schema. A Save button sends only the changed fields; with no changes, it stays disabled. Show "Saved" and the "Last saved … by …" line.
  - **Section 2, "Readiness":** CA.L2-3.12.4's status and "n of 110 requirements have an implementation statement" (from `GET /api/assessment`), with a link to `/assessment`.
  - **Section 3, "Export":** a download link to `/api/ssp/export` labelled "Export SSP (.docx)".

  Both roles can edit.
- **Files owned:** `apps/web/src/pages/ssp/SspPage.tsx`, `apps/web/src/pages/ssp/ProfileForm.tsx` (new), `apps/web/src/pages/ssp/ssp.module.css` (new), `apps/web/src/pages/ssp/ssp.test.tsx` (new)
- **Success criteria:**
  - `[test]` the form loads the profile, edits one field, and PATCHes only that key; an unchanged form can't be saved — apps/web/src/pages/ssp/ssp.test.tsx › saves only changed fields
  - `[test]` a bad CAGE code or email shows the field error and sends nothing; a server 400 shows its message — apps/web/src/pages/ssp/ssp.test.tsx › validation
  - `[test]` clearing a field sends `null` — apps/web/src/pages/ssp/ssp.test.tsx › clearing sends null
  - `[test]` readiness shows 3.12.4's status and the statement count — apps/web/src/pages/ssp/ssp.test.tsx › readiness
  - `[test]` the export link points to `/api/ssp/export` — apps/web/src/pages/ssp/ssp.test.tsx › export link
  - `[test]` the h1 shows at once, and errors offer Retry — apps/web/src/pages/ssp/ssp.test.tsx › loading and error
  - `[manual]` at 1280 and 375 px, save the profile, reload, and see the values kept, with no horizontal scroll — real API
- **Depends on:** P1, L4
- **One-way door:** none
- **Model:** sonnet

### E2: End-to-end smoke, Look checks, docs
- **Scope:**
  - **`e2e/smoke.spec.ts`:** the plan's Verification path, in the browser. Plan scores from `loadCatalog()` and `REGULATION`; never hard-code points. Bulk writes go through the `api(page)` helper; the named steps go through the UI.
    1. Set up the admin in the UI.
    2. Set every objective Met through the API, then set enough requirements Not Met (including 3.1.20) to reach exactly 72 + 3.1.20's points.
    3. In the Assessment UI, mark a 3.1.20 objective Not met. The dashboard shows 72, HOLD and the 3.1.20 blocker. On the POA&M page, 3.1.20's add is disabled, and `POST /api/poam` answers 409 `poam_ineligible`.
    4. Mark 3.1.20 Met in the UI. Set every Not Met requirement to Met except three eligible 1-point requirements. HOLD now lists `poam_missing`.
    5. Create the three items, one of them through the POA&M UI. The stamp shows ACCEPT.
    6. Upload a file in the Evidence UI and see the SHA-256 computed in the test. A CUI-flagged item refuses a file (409 `cui_file_refused`) and takes a reference.
    7. Upload a policy and link it to a requirement in the UI.
    8. Fill the profile in the SSP UI, set a statement on every requirement through the API, and export through the link. `docxText` holds the profile values and every requirement's ID, status label and statement.
    9. `GET /api/audit` holds objective, POA&M, evidence, policy and system profile events, each with the actor, `at`, and `before`/`after`.
  - **`e2e/look.spec.ts`:** signed in, at 1280 and 375 px, on every nav route:
    - no visible text under 16 px
    - every `color`, `background-color` and drawn border color is one of the six tokens or transparent
    - each text element's color against its nearest opaque background reaches 4.5:1, or 3:1 for large text
    - `scrollWidth` is at most the viewport width at 375 px

    A failure in a page E2 doesn't own goes to the queue as `BLOCKED` → `orchestrator`, with the route and element.
  - **Docs:**
    - README: the Parts row for `apps/api/ssp`, the system profile and SSP export endpoints, the dashboard and the e2e run.
    - Brief: the Smoke recipe's Key URLs and the Parts list.
- **Files owned:** `e2e/smoke.spec.ts` (new), `e2e/look.spec.ts` (new), `e2e/helpers/api.ts` (new), `e2e/helpers/docx.ts` (new), `e2e/helpers/plan.ts` (new), `README.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test]` score 72 with 3.1.20 Not Met shows HOLD and the blocker, and 3.1.20 is refused for a POA&M — e2e/smoke.spec.ts › hold at 72 and 3.1.20 refused
  - `[test]` at 88 or more, `poam_missing` holds until every Not Met requirement has an item, then ACCEPT — e2e/smoke.spec.ts › accept with eligible POA&M items
  - `[test]` the evidence SHA-256 matches, and a CUI item refuses a file — e2e/smoke.spec.ts › evidence hash and CUI refusal
  - `[test]` the policy upload and link show on the page after a reload — e2e/smoke.spec.ts › policy upload and link
  - `[test]` the SSP .docx holds the profile and every requirement's status and statement — e2e/smoke.spec.ts › SSP export contents
  - `[test]` the audit log records each kind of change with actor, time and before/after — e2e/smoke.spec.ts › audit trail
  - `[test]` every route passes the text size, palette, contrast and 375 px scroll checks — e2e/look.spec.ts › look holds on every route
  - `[manual]` `pnpm e2e` is green locally on Windows, and the e2e CI job is green on both OSes — the run output and the PR checks
- **Depends on:** X1, R6, P1, L4, S3, W7, W8
- **One-way door:** none
- **Model:** opus
