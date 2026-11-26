# Sprint: SSP workspace — tabs for the v2 SSP sections, requirement fields, review overdue

_From plan: pod-docs/plans/ssp-export-v2.md · Slug: ssp-workspace · Status: active · Generated: 2026-11-25_

<!-- autopilot-run: started=2026-11-25T10:00:00-08:00 sprints=1 waves=4 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | W9 | SSP workspace frame: tabs, shared kit, Lint & export tab | ssp-workspace-w9 | #17 | done | af68e15 | — |
| 1 | W10 | Assessment: planned implementation, N/A rationale, SSP status | ssp-workspace-w10 | #17 | done | af68e15 | — |
| 1 | W11 | Dashboard: "SSP review overdue" in Needs attention | ssp-workspace-w11 | #17 | done | af68e15 | — |
| 2 | W12 | Tab: Identification & roles | ssp-workspace-w12 | #18 | done | b7985c4 | W9 |
| 2 | W13 | Tab: Environment (CUI description, narratives, diagrams) | ssp-workspace-w13 | #18 | done | b7985c4 | W9 |
| 2 | W14 | Tab: Assets | ssp-workspace-w14 | #18 | done | b7985c4 | W9 |
| 2 | W15 | Tab: Service providers & matrix | ssp-workspace-w15 | #18 | done | b7985c4 | W9 |
| 2 | W16 | Tab: Document control | ssp-workspace-w16 | #18 | done | b7985c4 | W9 |
| 3 | E3 | Look spec on every tab, demo screenshots, docs | ssp-workspace-e3 | — | pending | — | W9, W10, W11, W12, W13, W14, W15, W16 |

Plan branch `ssp-export-v2`; wave heads `ssp-workspace-w1`, `ssp-workspace-w2`, `ssp-workspace-w3`. Merge target `main`. Web only: no api, contract, DB or dependency change. Out of this sprint: the lint package, `GET /api/ssp/lint`, the live lint panel and export v2 (sprint `ssp-export-lint`).

## Shared contract

Everything in the archived Shared contracts still holds (the error envelope, `apiGet`/`apiSend`, the Look rules, the guard order), and every route, shape and rule in the `ssp-data` Shared contract is used as written. Web code imports schemas, enums, labels and `SSP_PROFILE_FIELDS` from `@rampart/api/contract`; it never re-declares them.

### Run facts
- **No dependency or contract changes.** Nobody touches `pnpm-lock.yaml` or `apps/api/**`. A missing api behavior → a `BLOCKED` entry to `orchestrator`.
- pnpm: `corepack enable` fails with EPERM; use `corepack pnpm …`. Scripts that call `pnpm` need both a `pnpm.cmd` shim and an sh `pnpm` shim on PATH.
- **Ports** (Windows reserves 3057–3156; never 3000/3001, the human's app; never 3290/3291/3293, e2e): web/api — W9 3200/3201, W10 3210/3211, W11 3220/3221, W12 3230/3231, W13 3240/3241, W14 3250/3251, W15 3260/3261, W16 3270/3271, E3 3280/3281. Use a scratch `DATABASE_PATH` and `STORAGE_PATH`.
- **Queue:** no `BLOCKED`; the open PENDINGs stay open on the values in use. Add no new helper copies: file sizes use `formatSize` from `pages/evidence/EvidenceItem.tsx`; "today" is the UTC date.
- **Pinned lists:** `APP_ROUTES`, the nav, `auditLabels` and the Shell tests don't change (tabs live in `?tab=` on `/ssp`). A slice that breaks a pinned test it doesn't own → `BLOCKED` to `orchestrator`.
- **UI tests:** wait for the request before answering it (deferred responses), `vi.setConfig({ testTimeout: 15_000 })` and `configure({ asyncUtilTimeout: 5000 })`. Any test that renders an api-backed page, even as a throwaway route, mocks every call it makes.
- Page titles use `usePageTitle` (it runs in `useLayoutEffect`). Source files hold no raw control bytes (U+0000–U+001F except tab/LF, U+007F); tests write `\u0007`-style escapes.
- **Look:** inherited C · Inspection, existing controls only (TextField, TextArea, Select, RadioGroup, Checkbox, FileField, Alert, StatusChip, SectionLabel, Button). Only the six tokens and `var(--rp-text-*)` (`look/guards.test.ts` polices every file). Text ≥ 16 px. Every new table stacks into cards at `max-width: 767px`. Each UI slice has `[manual]` checks at 1280 and 375 px against `pod-docs/design-drafts/cmmc-l2-grc-look-3.html` (Inspection column), with no horizontal scroll at 375 px.

### SSP tabs (W9)
`/ssp` keeps its h1 "SSP". Under it, an ARIA tablist labelled "SSP sections", in this order:

| id (`?tab=`) | Label | Module (`pages/ssp/tabs/`) | Filled by |
|---|---|---|---|
| `identification` | Identification & roles | `IdentificationTab.tsx` | W12 |
| `environment` | Environment | `EnvironmentTab.tsx` | W13 |
| `assets` | Assets | `AssetsTab.tsx` | W14 |
| `providers` | Service providers & matrix | `ProvidersTab.tsx` | W15 |
| `document-control` | Document control | `DocumentControlTab.tsx` | W16 |
| `export` | Lint & export | `ExportTab.tsx` | W9 |

- Exported as `SSP_TABS: readonly { id, label }[]` from `pages/ssp/tabs.ts`. Each module exports one prop-less component that fetches its own data.
- **Edges:** no `tab`, or an unknown one → Identification is selected and the URL is left alone. Clicking a tab pushes `?tab=<id>` (Back returns to the previous tab). ArrowRight/ArrowLeft move and select with wrap-around, Home/End go to the first and last; only the selected tab has `tabIndex 0`. A panel mounts on its first visit and stays mounted, hidden, so unsaved drafts survive a tab switch; an unvisited tab sends no request. The tablist wraps at 375 px and never scrolls sideways.
- In wave 1, W9 creates the four middle modules as stubs (a paragraph "This tab isn't built yet.") and moves the V1 "System profile" section (`ProfileForm`) into `IdentificationTab.tsx` unchanged, so `/ssp` still opens on the V1 form.
- **Loading and errors in every tab:** loading text starts with "Loading" (the e2e look spec waits for it to go). A failed load shows `LoadError` with Retry for that section only. Sections in a tab are numbered from 1 with `SectionLabel`.

### Shared kit (W9, `pages/ssp/kit/`, exported from `kit/index.ts`)
- Moved from `SspPage.tsx`: `useLoad(path, schema)` (gains `replace`), `Section` and `LoadError`.
- `SspProfileForm({ title, groups, profile, onSaved })`: a form named `title` with one control per `SSP_PROFILE_FIELDS` entry whose `group` is in `groups`, in contract order, and a "Save" button. It PATCHes `/api/ssp/profile` with only the changed keys and calls `onSaved(profile)` with the answer.
  - TextArea for `LONG_SSP_FIELDS` = `organizationAddress`, `cuiCategories`, `cuiLocations`, `cuiEntryExit`, `topologyNarrative`, `dataFlowNarrative`, `inventoryReference`, `maintenanceStatement`; TextField otherwise (`type="email"` for `securityOfficerEmail`, `inputMode="numeric"` for `reviewCadenceMonths`, hint "YYYY-MM-DD" for `nextReviewDate`).
  - Each key is checked with `patchSspProfileRequestSchema` alone. Messages: cadence that is blank, not a whole number or outside 1–60 → "Enter a whole number of months from 1 to 60"; a bad date → "Enter a real date as YYYY-MM-DD."; anything else → the schema's message. An invalid field sends nothing.
  - Edges: blank text sends `null`; clearing `categorization` sends `null` and the form then shows the default the api returns; typing the default into it, or the stored cadence, isn't a change. Save is disabled while nothing differs or a save is pending. Success shows "Saved" (role status) and "Last saved <time> by <name>"; typing again hides "Saved".
- `SspTable({ caption, columns, rows, rowKey, empty })`: a `<table>` with a caption and a header row. Each `<td>` starts with a label element for its column, hidden on desktop and shown at `max-width: 767px`, where rows become cards (block layout). No rows → the `empty` text instead of a table.
- `RemoveButton({ name, onConfirm })`: "Remove" → "Remove <name>?" with "Confirm remove" and "Cancel". Only Confirm calls `onConfirm`.
- `errorText(error, fallback)`: `validation_failed` → the api's message; `csrf_failed` → "The security check failed. Reload the page and try again."; `network_error` → "Can't reach the API. Check your connection and try again."; `forbidden` → "Only an admin can do this."; `not_found` → "It was already removed. The list has been reloaded."; otherwise `fallback`. `fieldErrors(error)` maps `validation_failed` details `{ path: [key], message }` to `{ [key]: message }`.
- `kit/testing.tsx` (a test helper, not a test): `stubApi(routes, { role })` stubs `fetch` with the session, health and the given `'METHOD /path'` handlers (anything else → 404 `not_found`), logs calls with their bodies and headers, and supports deferred answers; `renderSsp(tab?)` renders `AuthedApp` in a `MemoryRouter` at `/ssp` or `/ssp?tab=<tab>`.

### Collection tabs (W12–W16)
- Lists come from the `ssp-data` GET routes in server order. After every create, change or removal the tab reloads that list (so totals, names and order are the server's).
- Create and edit share one form per collection. Edit opens it in place, prefilled, and PATCHes only the changed keys; an unchanged edit can't be saved. Cancel drops the draft.
- Required texts are checked before sending; a server 400 shows `fieldErrors` on the field, else `errorText` in an Alert. A 404 on edit or remove shows the `not_found` text and reloads.
- Both roles edit everything except approvals, which only admins change (W16).

### Review overdue (W11)
- `needsAttention(view, poam, catalog, review?)` gains an optional `review: Pick<DocumentControl, 'reviewOverdue' | 'nextReviewDue' | 'daysToReview'> | null`. When `review?.reviewOverdue` is true it adds one row right after the prerequisite rows: kind `review_overdue`, href `/ssp?tab=document-control`, message `SSP review overdue: due <nextReviewDue> · <n> day(s) overdue`, where n = −`daysToReview`. With no review, `null`, or not overdue (the due date itself is 0, not overdue), there is no row.
- `DashboardPage` also loads `GET /api/ssp/document-control`. Its failure never fails the dashboard: the page renders without the review row.

### Orchestrator tasks (not slice work)
- After wave 3, add `pod-docs/features.md` rows: SSP workspace sections (save on each tab, reload, values kept); planned implementation and N/A rationale (save, reload); "SSP review overdue" on the dashboard (past next review date → row with link).
- After each merge, re-install and restart the human's app in the parent checkout.

## Per-slice detail

### W9: SSP workspace frame: tabs, shared kit, Lint & export tab
- **Scope:** build **SSP tabs** and the **Shared kit**. `ExportTab`: section 1 "Readiness" (moved as is) and section 2 "Export": an info Alert "The pre-export check comes in a later release." and the existing "Export SSP (.docx)" link. Move the readiness, export and loading tests in `ssp.test.tsx` to the export tab; leave the V1 form tests. Not the tab contents (W12–W16).
- **Files owned:** `apps/web/src/pages/ssp/{SspPage.tsx,ssp.module.css,ssp.test.tsx,tabs.ts (new),tabs.test.tsx (new)}`, `apps/web/src/pages/ssp/tabs/{IdentificationTab,EnvironmentTab,AssetsTab,ProvidersTab,DocumentControlTab,ExportTab}.tsx` (new), `apps/web/src/pages/ssp/kit/{index.ts,useLoad.ts,Section.tsx,SspProfileForm.tsx,SspTable.tsx,RemoveButton.tsx,errors.ts,kit.module.css,testing.tsx,kit.test.tsx}` (new)
- **Success criteria:**
  - `[test] Six tabs in contract order with their labels; /ssp and an unknown tab select Identification; ?tab=assets selects Assets — apps/web/src/pages/ssp/tabs.test.tsx › tab order and selection`
  - `[test] Clicking a tab pushes ?tab=<id> and Back returns to the previous tab — tabs.test.tsx › tab history`
  - `[test] Arrow keys wrap, Home/End jump, only the selected tab has tabIndex 0 — tabs.test.tsx › keyboard`
  - `[test] An unvisited tab sends no request; a visited panel stays mounted and keeps an unsaved draft across a switch — tabs.test.tsx › panels mount once`
  - `[test] The h1 "SSP" shows before any request answers, and document.title names SSP — tabs.test.tsx › title`
  - `[test] The export tab shows readiness, the placeholder Alert and the download link; readiness fails on its own with Retry — apps/web/src/pages/ssp/ssp.test.tsx › export tab`
  - `[test] The V1 system profile form still loads, saves only changed fields and validates on the default tab — ssp.test.tsx › saves only changed fields`
  - `[test] SspProfileForm: only its groups' fields in order, control types per LONG_SSP_FIELDS, only changed keys sent, blank → null — apps/web/src/pages/ssp/kit/kit.test.tsx › profile form fields`
  - `[test] Cadence "", "0", "61", "1.5" show the cadence message and send nothing; "1" and "60" send numbers; a bad date shows the date message — kit.test.tsx › profile form validation`
  - `[test] Clearing categorization sends null and then shows the default; typing the default or the stored cadence leaves Save disabled — kit.test.tsx › profile form defaults`
  - `[test] A 400 with details path shows the field error; csrf, network and other failures show errorText — kit.test.tsx › error mapping`
  - `[test] SspTable labels each cell with its column, shows the empty text with no rows, and its CSS stacks rows into blocks at max-width 767px — kit.test.tsx › table stacks on phones`
  - `[test] RemoveButton calls onConfirm only after Confirm remove; Cancel restores the button — kit.test.tsx › remove confirm`
  - `[manual] At 1280 and 375 px the tablist matches the Inspection column, wraps on the phone with no sideways scroll, and focus is visible — real api, scratch DB`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### W10: Assessment: planned implementation, N/A rationale, SSP status
- **Scope:** in the requirement detail, below the implementation statement: a line "SSP status: <label>" from `nistImplementationStatus` and `NIST_STATUS_LABELS` on the saved outcome (`status`, `allNa`; none → "Not yet assessed"); a "Planned implementation" TextArea (max 20,000, hint "What will be done, and when. The SSP prints it for Not Met requirements.") with "Save planned implementation"; an "N/A rationale" TextArea (max 4,000, hint "Why the objectives marked N/A don't apply.") with "Save N/A rationale". Each save PATCHes `/api/assessment/requirements/:id` with only its own key through `patchRequirement`; blank sends `null`. Shown for every requirement whatever its status. Don't change scoring or what-if.
- **Files owned:** `apps/web/src/pages/assessment/{RequirementDetail.tsx,AssessmentPage.tsx,assessment.module.css,editing.test.tsx}`, `apps/web/src/pages/assessment/fields.test.tsx` (new)
- **Success criteria:**
  - `[test] Each field loads its stored value, saves only its own key, and sends null when blanked — apps/web/src/pages/assessment/fields.test.tsx › planned and N/A save`
  - `[test] Save is disabled when the trimmed draft equals the stored value, in what-if, and while a patch is pending — fields.test.tsx › save gating`
  - `[test] A view row without the two keys reads as empty; switching requirement resets both drafts — fields.test.tsx › older rows and switching`
  - `[test] SSP status reads Implemented for met, Not applicable for all N/A, Planned to be implemented for not met, Not yet assessed with no outcome — fields.test.tsx › SSP status`
  - `[test] A failed save shows the same error the statement save shows and keeps the draft — fields.test.tsx › save failure`
  - `[manual] At 1280 and 375 px the detail shows both fields under the statement in the Inspection style, no sideways scroll — real api`
- **Depends on:** —
- **One-way door:** none
- **Model:** sonnet

### W11: Dashboard: "SSP review overdue" in Needs attention
- **Scope:** build **Review overdue**: extend `needsAttention` and `AttentionRow.href`, load document control in `DashboardPage`, and render the row like the "not yet assessed" summary row, linking to `/ssp?tab=document-control`.
- **Files owned:** `apps/web/src/pages/dashboard/{attention.ts,attention.test.ts,DashboardPage.tsx,dashboard.test.tsx}`
- **Success criteria:**
  - `[test] Overdue review adds one row after the prerequisite rows with the due date and "3 days overdue" / "1 day overdue" — apps/web/src/pages/dashboard/attention.test.ts › review overdue row`
  - `[test] No row when review is absent, null, due today (0) or due later — attention.test.ts › review not overdue`
  - `[test] The dashboard shows the row with its link when the api says overdue — apps/web/src/pages/dashboard/dashboard.test.tsx › review overdue`
  - `[test] A failing document-control call leaves the dashboard rendered, with no error and no review row — dashboard.test.tsx › review call fails quietly`
  - `[manual] At 1280 and 375 px the row sits in Needs attention in the Inspection style — real api with a past next review date`
- **Depends on:** —
- **One-way door:** none
- **Model:** sonnet

### W12: Tab: Identification & roles
- **Scope:** `IdentificationTab`: section 1 "System profile" (the V1 form, unchanged); section 2 "Identification" (`SspProfileForm`, groups `identification`); section 3 "Roles": an `SspTable` (Role, Person, Responsibilities, Users, Privileged Yes/No, actions) with the line "<users> users · <privilegedUsers> privileged" from `totals` and the hint "The SSP's privileged and admin count comes from this table." Add/edit form: Title (required, "Enter a role title"), Person, Responsibilities (TextArea), Number of users (whole number 0–1,000,000, else "Enter a whole number from 0 to 1,000,000"), Privileged (Checkbox). Follow **Collection tabs**. Add mocks for the new calls to `ssp.test.tsx`.
- **Files owned:** `apps/web/src/pages/ssp/tabs/IdentificationTab.tsx`, `apps/web/src/pages/ssp/tabs/{RolesSection.tsx,identification.module.css,identification.test.tsx}` (new), `apps/web/src/pages/ssp/ssp.test.tsx`
- **Success criteria:**
  - `[test] The identification form loads /api/ssp/profile and saves only changed identification keys — apps/web/src/pages/ssp/tabs/identification.test.tsx › identification fields`
  - `[test] Creating a role POSTs the body and reloads; totals show the server's sums — identification.test.tsx › add role`
  - `[test] Blank title, and user counts "-1", "1.5", "abc", "1000001", send nothing; "0" passes — identification.test.tsx › role validation`
  - `[test] Edit sends only changed keys; remove needs Confirm and sends DELETE; a 404 shows the removed text and reloads — identification.test.tsx › edit and remove`
  - `[test] A contributor can add a role — identification.test.tsx › contributor edits`
  - `[test] The V1 form tests still pass with the new calls mocked — apps/web/src/pages/ssp/ssp.test.tsx › saves only changed fields`
  - `[manual] At 1280 and 375 px the roles table becomes cards on the phone, Inspection style, no sideways scroll — real api`
- **Depends on:** W9
- **One-way door:** none
- **Model:** sonnet

### W13: Tab: Environment (CUI description, narratives, diagrams)
- **Scope:** `EnvironmentTab`: section 1 "CUI description" (`SspProfileForm`, groups `cui`); section 2 "System environment" (groups `environment`); section 3 "Diagrams": an `SspTable` (Caption, Kind label, Evidence item, Version "Newest (v<n>)" or "v<n>", File: file name or "Reference: <location>", or "No version yet"; In the SSP: "Embedded image" when `embeddable`, "Referenced — contains CUI" when `evidence.containsCui`, else "Referenced"; actions). Link form: Evidence item (Select over `GET /api/evidence`, CUI items suffixed "(contains CUI)"), Kind (`DIAGRAM_KIND_LABELS`), Caption (required), Version ("Always the newest" = `null`, then each version of the chosen item). Choosing a CUI item shows an info Alert "This item contains CUI. The SSP will reference it and never embed it." No evidence items → "Add the diagram on the Evidence page first." with a link to `/evidence`, and no form. Edit changes kind, caption and version only. Follow **Collection tabs**.
- **Files owned:** `apps/web/src/pages/ssp/tabs/EnvironmentTab.tsx`, `apps/web/src/pages/ssp/tabs/{DiagramsSection.tsx,environment.module.css,environment.test.tsx}` (new)
- **Success criteria:**
  - `[test] The two forms show only their groups and each saves only its own changed keys — apps/web/src/pages/ssp/tabs/environment.test.tsx › narrative forms`
  - `[test] Rows read Embedded image for an embeddable PNG, Referenced for a PDF, Referenced — contains CUI for a CUI item, No version yet with no resolved version — environment.test.tsx › diagram rows`
  - `[test] Linking sends evidenceId, kind, caption and version null for Always the newest, or the chosen number — environment.test.tsx › link diagram`
  - `[test] A CUI item shows the never-embedded Alert; a blank caption sends nothing; a 400 on version shows on the Version field — environment.test.tsx › link validation`
  - `[test] With no evidence, the Evidence-page hint shows and no form — environment.test.tsx › no evidence`
  - `[test] Edit sends only changed keys and never evidenceId; remove needs Confirm — environment.test.tsx › edit and remove`
  - `[manual] At 1280 and 375 px narratives and the diagram cards fit with no sideways scroll, Inspection style — real api with a PNG and a CUI item`
- **Depends on:** W9
- **One-way door:** none
- **Model:** sonnet

### W14: Tab: Assets
- **Scope:** `AssetsTab`: one section "Asset inventory" with a total "<n> assets" and one `SspTable` per category in `ASSET_CATEGORIES` order, captioned "<label> · <count>", empty "None recorded." Columns: Name, Type, Owner, Location, Treatment, plus Out-of-scope justification in the out-of-scope group, actions. Form: Name (required, "Enter an asset name"), Category (Select, default `cui`), Type, Owner, Location, Treatment (TextArea), and Out-of-scope justification (TextArea), shown only while the category is out of scope. Follow **Collection tabs**.
- **Files owned:** `apps/web/src/pages/ssp/tabs/AssetsTab.tsx`, `apps/web/src/pages/ssp/tabs/{assets.module.css,assets.test.tsx}` (new)
- **Success criteria:**
  - `[test] Five groups in category order with counts and "None recorded." for empty ones — apps/web/src/pages/ssp/tabs/assets.test.tsx › grouped inventory`
  - `[test] Out of scope with a blank justification shows "An out-of-scope asset needs a justification." and sends nothing, on create and on switching an existing asset — assets.test.tsx › out-of-scope justification`
  - `[test] A server 400 on outOfScopeJustification shows on that field — assets.test.tsx › server field error`
  - `[test] Create sends the body and reloads; edit sends only changed keys; remove needs Confirm — assets.test.tsx › asset lifecycle`
  - `[manual] At 1280 and 375 px each group's table becomes cards on the phone, Inspection style, no sideways scroll — real api with one asset per category`
- **Depends on:** W9
- **One-way door:** none
- **Model:** sonnet

### W15: Tab: Service providers & matrix
- **Scope:** `ProvidersTab`: section 1 "Service providers": an `SspTable` (Name, Type label, FedRAMP or equivalent, Services, Agreement, actions) and a form (Name required, Type Select, FedRAMP status with hint "e.g. FedRAMP Moderate, or equivalent", Services TextArea, Agreement reference). A remove refused with 409 `provider_in_use` shows "<name> is named on <n> requirement(s): <ids>. Point those rows elsewhere, then remove it." and removes nothing. Section 2 "Responsibility matrix": the line "<n> of 110 assigned" (rows with a party), a Family Select ("All families", then each family as "AC — Access Control"), rows under family headings. Each row: requirement ID, Party Select ("Not set", then `RESPONSIBILITY_PARTY_LABELS`), Provider Select (enabled only for ESP or Shared; live providers), Note TextField, and a Save that is enabled only when the row changed and PUTs all three keys. Choosing Organization or Not set clears the provider. ESP or Shared without a provider → "Choose the provider for this requirement." and nothing sent; with no providers, the hint "Add a service provider first." After any provider write, reload the matrix too.
- **Files owned:** `apps/web/src/pages/ssp/tabs/ProvidersTab.tsx`, `apps/web/src/pages/ssp/tabs/{MatrixSection.tsx,providers.module.css,providers.test.tsx}` (new)
- **Success criteria:**
  - `[test] Provider create, edit (changed keys only) and confirmed remove, each followed by a reload of both lists — apps/web/src/pages/ssp/tabs/providers.test.tsx › provider lifecycle`
  - `[test] A 409 provider_in_use shows the name, count and IDs, and the provider stays listed — providers.test.tsx › provider in use`
  - `[test] 110 rows under family headings; the family filter shows one family; the assigned count follows the rows — providers.test.tsx › matrix rows and filter`
  - `[test] PUT sends {party, providerId, note}; Organization clears the provider; ESP without a provider sends nothing; an unchanged row can't be saved — providers.test.tsx › matrix row edges`
  - `[test] A renamed provider shows its new name in the matrix after the reload — providers.test.tsx › matrix follows providers`
  - `[manual] At 1280 and 375 px matrix rows become cards on the phone, typing in a row stays responsive, Inspection style, no sideways scroll — real api`
- **Depends on:** W9
- **One-way door:** none
- **Model:** opus

### W16: Tab: Document control
- **Scope:** `DocumentControlTab` from `GET /api/ssp/document-control`: section 1 "Review": the status (due null → "No review date yet. Set a next review date or record an approval."; days > 0 → "Next review due <date> · <n> day(s) left"; 0 → "Next review due today (<date>)"; overdue → an error Alert "Review overdue" with "Due <date> · <n> day(s) overdue") and `SspProfileForm` (title "Review schedule", groups `review`); saving reloads the status. Section 2 "Record of changes": an `SspTable` (Date, Description, Made by, Kind "Export"/"Manual") with the note "Entries can't be changed or removed.", and a form: Date (default UTC today; after today → "The date can't be in the future."), Description (required, ≤ 2,000), Made by (optional; blank leaves it out so the api uses you). Section 3 "Approvals": an `SspTable` (Name, Title, Approved on or "Not signed yet") with "Each approval prints as a signature line in the SSP."; admins add, edit and remove (Name, Title required; Approved on optional, not after today); contributors see the list and "Only an admin can change approvals." with no controls.
- **Files owned:** `apps/web/src/pages/ssp/tabs/DocumentControlTab.tsx`, `apps/web/src/pages/ssp/tabs/{document-control.module.css,document-control.test.tsx}` (new)
- **Success criteria:**
  - `[test] The status reads each case: no date, n days left, due today, overdue with an error Alert — apps/web/src/pages/ssp/tabs/document-control.test.tsx › review status`
  - `[test] Saving the review schedule PATCHes only changed review keys and reloads the status — document-control.test.tsx › review schedule`
  - `[test] A manual entry defaults to today, a future date sends nothing, a blank Made by is omitted from the body; there are no edit or remove controls — document-control.test.tsx › record of changes`
  - `[test] An admin creates, edits and removes approvals; a future Approved on sends nothing; blank sends null — document-control.test.tsx › approvals admin`
  - `[test] A contributor sees approvals and the admin-only note, with no form or buttons — document-control.test.tsx › approvals contributor`
  - `[manual] At 1280 and 375 px the three sections and their tables fit, Inspection style, no sideways scroll — real api`
- **Depends on:** W9
- **One-way door:** none
- **Model:** sonnet

### E3: Look spec on every tab, demo screenshots, docs
- **Scope:**
  - **`e2e/look.spec.ts`:** extend `seed`: profile fields in every group, a past `nextReviewDate`, two roles (one privileged), one asset per category, a provider with an ESP matrix row, a PNG evidence file linked as a network diagram plus the CUI item linked as data flow, a manual revision, an approval, and both new fields on 3.1.20. Add a view `/ssp?tab=<id>` per tab. A failure on a page E3 doesn't own → `BLOCKED` to `orchestrator` with the route and element.
  - **Screenshots:** when `DEMO_SCREENSHOTS_DIR` is set, the spec saves full-page PNGs `<view>-<width>.png` for `dashboard`, `assessment-detail` and `ssp-<tab id>` (all six), at 1280 and 375. Unset → nothing written (CI unchanged). Run once with `DEMO_SCREENSHOTS_DIR=D:/Projects/Fun_Thinking/demo-screenshots/v2-ssp-workspace` (the parent checkout's git-excluded folder). The data is the spec's own scratch DB.
  - **Docs:** the brief's Key URLs (`/ssp?tab=<id>`, the six tabs) and Parts line for the web SSP workspace; `feature-details/ssp-workspace.md` (new); `feature-details/system-profile.md` (the form is on SSP › Identification & roles).
- **Files owned:** `e2e/look.spec.ts`, `pod-docs/codebase-structure.md`, `pod-docs/feature-details/ssp-workspace.md` (new), `pod-docs/feature-details/system-profile.md`
- **Success criteria:**
  - `[test] Every nav route, the assessment detail and all six SSP tabs pass the text size, palette, contrast and 375 px scroll checks — e2e/look.spec.ts › look holds on every route`
  - `[test] The seeded SSP tabs show their data (a role, an out-of-scope asset, an ESP row, "Embedded image", "Referenced — contains CUI", a revision, an approval) and the dashboard shows "SSP review overdue" — e2e/look.spec.ts › seeded workspace shows its data`
  - ~~[manual] 16 demo screenshots~~ (dropped 2026-11-25 by the human: "no need for screenshot, to reduce token usage")
  - `[manual] pnpm e2e is green locally on Windows with DEMO_SCREENSHOTS_DIR unset, and git status shows no screenshot files — run output`
- **Depends on:** W9, W10, W11, W12, W13, W14, W15, W16
- **One-way door:** none
- **Model:** opus
