# Sprint: SSP export and lint: pre-export check, export v2 in the NIST outline, e2e

_From plan: pod-docs/plans/ssp-export-v2.md · Slug: ssp-export-lint · Status: active · Generated: 2026-11-25_

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | L5 | SSP lint rules package and its contract mirror | ssp-export-lint-l5 | #20 | done | b1bfc2f | — |
| 1 | X2 | Export v2: NIST outline, CMMC sections, appendices, images, signature lines | ssp-export-lint-x2 | #20 | done | b1bfc2f | — |
| 2 | A12 | API: `GET /api/ssp/lint`; the export's record-of-changes entry | ssp-export-lint-a12 | #21 | done | 52bb27a | L5, X2 |
| 2 | W17 | Web: live pre-export check on Lint & export | ssp-export-lint-w17 | #21 | done | 52bb27a | L5, X2 |
| 3 | E4 | E2E smoke and look for lint and export v2; docs | ssp-export-lint-e4 | — | pending | — | L5, X2, A12, W17 |

Plan branch `ssp-export-v2`; wave heads `ssp-export-lint-w1`, `ssp-export-lint-w2`, `ssp-export-lint-w3`. Merge target `main`. This is the plan's last sprint. The human pre-approved the final merge, provided the plan review passes and CI is green.

## Shared contract

Everything in the archived Shared contracts still holds, and every `ssp-data` route, shape, loader and rule is used as written. That covers the error envelope, `respond()`, the guard order, `recordAudit(tx, …)` in the change's transaction, `createHarness()`, the kit, the Look rules, the `ssp-data` loaders and `appendExportRevision`. Contract files stay zod-only: they never import `@rampart/rules`.

### Run facts
- **No dependency changes.** Nobody touches `pnpm-lock.yaml`. `docx` already has `ImageRun`, and image sizes are parsed by hand. If something is missing, add a `BLOCKED` entry to `orchestrator`.
- **pnpm:** use `corepack pnpm …`. Scripts that call `pnpm` need both a `pnpm.cmd` shim and an sh `pnpm` shim on PATH.
- **Ports:** Windows reserves 3057–3156. Never use 3000/3001 (the human's app) or 3290/3291/3293 (e2e). Web/api ports: L5 3200/3201, X2 3210/3211, A12 3220/3221, W17 3230/3231, E4 3240/3241. Use a scratch `DATABASE_PATH` and `STORAGE_PATH`.
- **`pnpm e2e` uses fixed ports**, so only one slice per wave runs it: X2 in wave 1, W17 in wave 2, E4 in wave 3.
- **Queue:** there is no `BLOCKED` entry. One item is folded in: A12 exports `actorOf` from `ssp-data/common.ts` and removes the seven copies in `ssp-data/*/routes.ts`. The other copies outside `ssp-data` stay, and the other PENDINGs stay open on the values in use.
- **Pinned lists:** pinned-list tests go to the slice that changes the list. `contract-rules-types.test.ts` goes to L5. `ssp.test.tsx` (export tab) goes to W17. `e2e/smoke.spec.ts` goes to X2 in wave 1 (status labels) and to E4 in wave 3. A slice that breaks a pinned test it doesn't own adds a `BLOCKED` entry to `orchestrator`.
- **UI tests:** mock every call, and wait for the request before answering it. Use `vi.setConfig({ testTimeout: 15_000 })` and `configure({ asyncUtilTimeout: 5000 })`. Tests order same-moment rows by id.
- **Request keys:** `assetType`, `providerType`, and the responsibility PUT `{ party, providerId, note }`.
- **Source files:** no control bytes and no U+FFFD. Tests write `\u0007`-style escapes.
- **No screenshots:** no slice saves or views images for look checks. Check the look by measurement only (`scrollWidth`, font size, palette and contrast through `e2e/look.spec.ts`).

### Shared constants (X2, `apps/api/src/contract/ssp.ts`)
`SSP_MAX_EMBEDDED_IMAGES = 10` and `SSP_LARGE_IMAGE_BYTES = 5 * 1024 * 1024`. `contract/index.ts` already re-exports `ssp.ts`, so X2 doesn't edit `index.ts`. The lint receives both numbers as `limits`, so the rules package never imports the contract.

### SSP lint (L5, `packages/rules/src/ssp-lint/`, re-exported from `packages/rules/src/index.ts`)
- **Version and terms:**
  - `SSP_LINT_VERSION = '1.0.0'`.
  - `FUTURE_TENSE_TERMS = ['will', 'plan to', 'planned', 'intend', 'going to', 'to be implemented', 'TBD']` is data.
  - Matching is case-insensitive on word boundaries (`\b…\b`), and a space in a term matches any run of whitespace, newlines included.
  - Matched terms are reported once each, in list order, spelled as in the list.
  - Examples: "WILL", "TBD." and "plan&nbsp;&nbsp;to" match. "Willow", "unplanned", "skill" and "TBDs" don't. "will-power" matches (a hyphen is a boundary).
- **The function:** `lintSspFrom(catalog, sources, limits): SspLintFinding[]` is pure and never mutates its input.
  - `sources` is structural, so the contract's own types fit without an import:
    - `view`: `requirementStates` (`requirementId`, `implementationStatement`, `naRationale?`), `openPoamRequirementIds?`, and `evaluation.outcomes` (`requirementId`, `status`, `allNa`, `counts`)
    - `assets`: `id`, `name`, `category`, `outOfScopeJustification`
    - `diagrams`: `id`, `caption`, `kind`, `embeddable`, `resolved: { size } | null`
    - `review`: `reviewOverdue`, `nextReviewDue`, `daysToReview`
  - `limits` is `{ maxEmbeddedImages, largeImageBytes }`.
  - A requirement with no outcome is `not_assessed` with 0 N/A objectives. A blank text (null, empty or whitespace) counts as missing.
- **Finding:** `{ rule, severity: 'error' | 'warning', requirementId: string | null, subjectId: string | null, message, hint }`. `subjectId` is the asset or diagram link id. `hint` is the rule's hint.
- **Order:** findings come in rule order (below), then subject order: catalog order for requirements, and input order for assets and diagrams. `SSP_LINT_RULES: readonly { id, severity, label, hint }[]` lists the rules in that order.

| # | `id` | sev | label | fires when | message |
|---|---|---|---|---|---|
| 1 | `ssp_requirement_not_met` | error | The SSP requirement isn't Met | the catalog's prerequisite (3.12.4) is `not_met` or `not_assessed` | `<id> (the SSP requirement) is Not Met, so the assessment can't be completed.` (or `is not yet assessed, so…`) |
| 2 | `no_assets` | error | No assets | zero assets | `No assets are recorded.` |
| 3 | `out_of_scope_unjustified` | error | Out-of-scope asset without a justification | `out_of_scope` with a blank justification (the api refuses this, so a fixture proves it) | `"<name>" is out of scope with no justification.` |
| 4 | `no_network_diagram` | error | No network diagram | no link of kind `network` (any network link clears it, including a CUI reference or a link with no version) | `No network diagram is linked.` |
| 5 | `review_overdue` | error | Review overdue | `reviewOverdue` | `The SSP review was due <nextReviewDue>, <n> day(s) ago.` (n = −`daysToReview`; "1 day", "3 days") |
| 6 | `empty_statement` | error | Empty implementation statements | the statement is blank and the requirement isn't all N/A | `<id> has no implementation statement.` |
| 7 | `not_met_without_poam` | error | Not Met without an open POA&M item | `not_met`, not the prerequisite, and not in `openPoamRequirementIds` | `<id> is Not Met and has no open POA&M item.` |
| 8 | `na_without_rationale` | warning | N/A without a rationale | `counts.na ≥ 1` and the rationale is blank | `<id> has objectives marked N/A and no N/A rationale.` |
| 9 | `future_tense` | warning | Future-tense statements | the statement matches a term (`plannedImplementation` is never checked) | `<id> says "will", "TBD" (future tense).` |
| 10 | `ssp_poam_mismatch` | warning | SSP and POA&M disagree | the requirement is in `openPoamRequirementIds` but is not `not_met` | `<id> has an open POA&M item but is Met.` (or `not applicable` when all N/A, or `not yet assessed`) |
| 11 | `large_image` | warning | Large images | `embeddable` and `resolved.size > largeImageBytes` (exactly equal doesn't fire) | `"<caption>" is <x.y> MiB; images over <limit> MiB make the .docx large.` |
| 12 | `image_limit` | warning | Images over the embed limit | the embeddable links after the first `maxEmbeddedImages` | `"<caption>" is referenced, not embedded: the SSP embeds at most <max> images.` |

- **Hints:**
  1. "Finish the SSP and mark CA.L2-3.12.4's objectives. It can't go on a POA&M."
  2. "Record each asset on SSP › Assets by its CMMC category (32 CFR 170.19)."
  3. "Say why the asset can't process, store or transmit CUI."
  4. "Link a network diagram on SSP › Environment."
  5. "Review the SSP, then set the next review date or record an approval on SSP › Document control."
  6. "Describe how the requirement is met today, in the present tense."
  7. "Add an open POA&M item, or meet the requirement if it can't go on one."
  8. "Say why the N/A objectives don't apply, in the requirement's N/A rationale."
  9. "Describe what is in place now. Put what is still to come in Planned implementation and the POA&M."
  10. "Close the POA&M item, or correct the objective status, so the SSP, POA&M and score agree."
  11. "Export a smaller image, or link a PDF instead."
  12. "Remove diagrams you don't need, or accept that the rest are referenced."
- **When `openPoamRequirementIds` is absent,** rules 7 and 10 are skipped, as the Conditional check does.
- **The contract mirror** (`apps/api/src/contract/ssp-lint.ts`) defines `sspLintFindingSchema` and `sspLintResponseSchema = { version, findings, counts: { errors, warnings } }`.

### Export v2 (X2: `apps/api/ssp`)
- **`SspSource`** gains these fields beyond V1:
  - `sspProfile`, `roles` + `roleTotals`, `assets`, `providers`, `responsibilities` (the matrix rows), `diagrams`, `documentControl`
  - `images: ReadonlyMap<linkId, Uint8Array>`
  - `maxEmbeddedImages`
  - `exportEntry: { date, description, madeBy } | null`: this export's own record-of-changes entry
- **Exports from `index.ts`:** `exportRevisionDescription(fileName)` returns `Exported as <fileName>`.
- **Document order.** The headings are exact text, and section 3 is the V1 requirements structure:
  0. Title block: "System Security Plan", then the system name (or "System not named"), then the "Generated by …" line.
  1. **"1. System identification"**
     - A `Field | Value` table:
       - the V1 `SYSTEM_PROFILE_FIELDS` rows, except `authorizationBoundary`, `environment`, `interconnections` and `informationTypes`
       - then every `identification`-group `SSP_PROFILE_FIELDS` row
       - null reads "Not provided"; categorization reads the effective value
     - **"1.1 Roles and users"**: a table `Role | Person | Responsibilities | Users | Privileged` (Yes/No), or "No roles recorded."
     - Then "Number of users: <totals.users>" and "Privileged and administrative users: <totals.privilegedUsers>".
  2. **"2. System environment"**
     - A table with Authorization boundary, Operating environment, then the `environment`-group SSP fields in contract order, with Interconnections after Network topology and CUI data flow.
     - **"2.1 Diagrams"**: the links in api order, or "No diagrams linked." (lines below).
  3. **"CMMC: CUI description"**: a table of the three `cui`-group fields, then "Information types handled".
  4. **"CMMC: Asset inventory"**
     - "Total assets: <n>".
     - Per category in `ASSET_CATEGORIES` order: a level-2 heading "<label> · <count>", then a table `Name | Type | Owner | Location | Treatment`, plus `Out-of-scope justification` for the out-of-scope group only. An empty category reads "None recorded."
  5. **"CMMC: External service providers and responsibilities"**
     - **"Service providers"**: a table `Name | Type | FedRAMP or equivalent | Services | Agreement`, or "No external service providers recorded."
     - **"Customer responsibility matrix"**: a table `Requirement | Party | Provider | Note` with only the rows that have a party, in catalog order. Then "<n> of 110 requirements have a responsibility recorded."
  6. **"3. Requirements"**: family headings, then each requirement in this order:
     - its ID and text
     - `Status: <NIST_STATUS_LABELS[nistImplementationStatus]>` ("Not yet assessed" with no outcome)
     - Points, the level (3.5.3 and 3.13.11 only) and Owner
     - three labelled texts: "Current implementation" (or "No implementation statement recorded."), "Planned implementation" and "Rationale if not applicable" (each "None recorded." when blank)
     - Policies and Evidence
     - the open POA&M item, if there is one
     - The objectives table moves to Appendix B.
  7. **"4. Record of changes"**
     - "Review cadence: every <n> months" and "Next review due: <nextReviewDue | Not set>".
     - A table `Date | Description | Made by` of the stored revisions in api order, then `exportEntry` last when it isn't null. With neither, it reads "No changes recorded."
  8. **"Approvals"**: one signature block per approval, in api order, or "No approvals recorded."
  9. **"Appendix A — Assessment status"**, in this order:
     - catalog version, regulation version, assessment type
     - the V1 SPRS line and Conditional status
     - the Conditional Status Date and closeout deadline, only when set
     - a table of counts by NIST status (four rows summing to 110)
     - "Open POA&M items: n"
     - the V1 POA&M table, or "No POA&M items recorded."
  10. **"Appendix B — Assessment objectives"**: one table per family, `ID | Objective | Status | Note`, covering all 320 objectives. The note is empty when there is none.
- **Diagram lines.** `<kind>` is `DIAGRAM_KIND_LABELS`, and dates are `resolved.createdAt`'s UTC date.
  - **Embedded:** an image block, then `Figure <n>. <caption> — <kind>, <evidence title> v<version>, <fileName>, SHA-256 <sha256>, <date>`, with n counting embedded images from 1.
  - **File reference:** `<caption> — <kind>: <evidence title> v<version>, <fileName>, SHA-256 <sha256>, <date>`. When the link was embeddable but not embedded, add ` (referenced: the SSP embeds at most <N> images)` or ` (referenced: the image couldn't be read)`.
  - **Location reference:** `<caption> — <kind>: <evidence title> v<version>, kept at <location>, <date>`. A CUI item adds `contains CUI, ` before "kept".
  - **No version:** `<caption> — <kind>: <evidence title>, no version recorded yet`.
- **The embed rule.** An image is embedded only when all of these hold:
  - `embeddable`, **and** not `evidence.containsCui`, **and** `resolved.kind === 'file'`
  - it is among the first `maxEmbeddedImages` embeddable links, in order
  - its bytes are in `images`
  - `imageInfo(bytes)` reads it

  A CUI-flagged link is never embedded, even if it arrives marked embeddable with bytes present.
- **`image-info.ts`:**
  - `imageInfo(bytes)` reads `{ type: 'png' | 'jpg', width, height }` from the PNG IHDR or a JPEG SOFn marker (baseline or progressive). The type comes from the bytes, not the name. Truncated data, a zero size, or any other format gives `null`.
  - `fitImage` scales the image to 624 px wide (6.5 in at 96 dpi), keeping the aspect ratio. Height is capped at 864 px, and the width shrinks to match. It returns integers.
- **New blocks:**
  - `{ kind: 'image'; data; type; width; height; altText }` renders an `ImageRun`.
  - `{ kind: 'signature'; name; title; date: string | null }` renders three paragraphs:
    - `<name>, <title>`
    - `Signature: ` plus 32 underscores
    - `Date: <date>`, or `Date: ` plus 12 underscores when there is no date
  - A model without images renders an identical `document.xml` every time. With images, only the media and relationship IDs may differ.
- **Route reads (X2's part of `apps/api/src/ssp/routes.ts`):** the V1 reads, plus the `ssp-data` loaders and `loadDocumentControl(db, now)`.
  - Bytes are read only for the first `SSP_MAX_EMBEDDED_IMAGES` embeddable links, through `readFileVersion` (hash-checked).
  - An `AppError` from a read leaves that link out of `images`, logs a warning with the link id (no path), and the export still answers 200.
  - In wave 1, `exportEntry` is `null` and the export still writes nothing.

### Routes and the export's revision (A12)
- **`GET /api/ssp/lint`:** any signed-in user gets 200 with `sspLintResponseSchema`.
  - It returns `lintSspFrom(loadCatalog(), { view: readView, assets: loadAssets, diagrams: loadDiagramLinks, review: loadDocumentControl }, { SSP_MAX_EMBEDDED_IMAGES, SSP_LARGE_IMAGE_BYTES })`.
  - It writes nothing. Signed out gives 401; with no assessment, 404.
- **Export record of changes:**
  1. Read the sources and the images.
  2. Set `exportEntry = { date: UTC today, description: exportRevisionDescription(fileName), madeBy: the exporter's display name }`.
  3. Render.
  4. **Only after the render succeeds,** call `appendExportRevision` in one transaction, which adds one `ssp_revision.created` event.
  5. Send.

  A render failure gives 500 and no revision. Signed out (401) and no assessment (404) write nothing. Each export appends one entry, and two exports make two. A contributor's export is made by the contributor. The session cookie is `SameSite=Strict`, so a cross-site GET can't trigger an export.
- **`actorOf(request, deps)`** moves to `ssp-data/common.ts`. It throws `unauthenticated` without `request.auth`.

### Lint panel (W17, `/ssp?tab=export`)
- **Sections:**
  1. "Readiness" (unchanged)
  2. "Pre-export check" (new)
  3. "Export": the "Export SSP (.docx)" link, always enabled, and the note "The check only warns. You can export at any time." The placeholder Alert goes.
- **Data:** the panel loads `/api/assessment`, `/api/ssp/assets`, `/api/ssp/diagrams` and `/api/ssp/document-control` when the tab is first visited. It computes `lintSspFrom(loadCatalog(), …, { SSP_MAX_EMBEDDED_IMAGES, SSP_LARGE_IMAGE_BYTES })`: the same function and inputs as the api.
  - While loading, it shows "Loading the pre-export check…".
  - When any read fails, it shows `LoadError` "Can't run the pre-export check" with Retry.
  - "Check again" re-requests all four reads.
- **Summary** (`role="status"`): "<e> error(s) · <w> warning(s)" ("1 error", "2 errors"), or "No findings. Every check passes."
- **One group per rule that fired,** in rule order:
  - An Alert: `error` tone for errors, `info` for warnings.
  - Its title is "<label> · <count>", then the messages as a list, then the hint.
  - A requirement finding links its ID to `/assessment?family=<family>&req=<id>`. Asset rules link to `/ssp?tab=assets`, diagram and image rules to `/ssp?tab=environment`, and the review rule to `/ssp?tab=document-control`.
  - After 10 messages, a "Show all <n>" button reveals the rest.
- **Look:** existing controls only, tokens only, text at 16 px or more, and no sideways scroll at 375 px.

### Orchestrator tasks (not slice work)
- After wave 3, update `pod-docs/features.md`:
  - **SSP export row:** drive the export, then check the v2 headings in order, one embedded image, the record-of-changes entry, and the export revision in `/api/ssp/document-control`.
  - **New "Pre-export check" row:** add a future-tense statement, open `/ssp?tab=export`, and see it listed. The summary equals `GET /api/ssp/lint`'s counts.
- After each merge, re-install and restart the human's app in the parent checkout.

## Per-slice detail

### L5: SSP lint rules package and its contract mirror
- **Scope:** build **SSP lint** as specified: types, rule data, the future-tense matcher and `lintSspFrom`, with one fixture per rule in `fixtures.ts`. Re-export it from `packages/rules/src/index.ts`, and add the rule table to `packages/rules/README.md`. Write the contract mirror and export it from `contract/index.ts`. Out of scope: no route, no UI, and no change to `types.ts` (it's frozen).
- **Files owned:** `packages/rules/src/ssp-lint/{index.ts,types.ts,rules.ts,future-tense.ts,lint.ts,fixtures.ts,lint.test.ts,future-tense.test.ts}` (new), `packages/rules/src/index.ts`, `packages/rules/README.md`, `apps/api/src/contract/ssp-lint.ts` (new), `apps/api/src/contract/index.ts`, `apps/api/src/contract-rules-types.test.ts`
- **Success criteria:**
  - `[test] SSP_LINT_RULES ids, order, severities, labels and hints, SSP_LINT_VERSION and FUTURE_TENSE_TERMS equal the contract — packages/rules/src/ssp-lint/lint.test.ts › rule data`
  - `[test] Terms match case-insensitively on word boundaries, across whitespace runs and newlines; "Willow", "unplanned", "skill", "TBDs" don't; each matched term is listed once in list order — packages/rules/src/ssp-lint/future-tense.test.ts › word boundaries`
  - `[test] future_tense: one finding per matching statement in catalog order with the exact message; blank statements and plannedImplementation never fire — lint.test.ts › future tense`
  - `[test] empty_statement: null, "" and whitespace fire for met, not_met and not_assessed; all-N/A doesn't — lint.test.ts › empty statement`
  - `[test] na_without_rationale: partial and all N/A without a rationale fire; a rationale clears; zero N/A never fires — lint.test.ts › N/A rationale`
  - `[test] not_met_without_poam: Not Met and not listed fires; listed clears; 3.12.4 Not Met gives only ssp_requirement_not_met; an absent list skips — lint.test.ts › Not Met without POA&M`
  - `[test] no_assets fires on zero and not on one asset of any category — lint.test.ts › no assets`
  - `[test] no_network_diagram: none, or only data_flow/other links, fire; a network CUI reference or a link with no version clears — lint.test.ts › no diagram`
  - `[test] out_of_scope_unjustified: blank or whitespace justification fires per asset in input order; another category's justification is ignored — lint.test.ts › out-of-scope justification`
  - `[test] review_overdue: overdue gives the due date and "1 day" / "3 days"; due today (0) and no due date give nothing — lint.test.ts › review overdue`
  - `[test] ssp_poam_mismatch: an open item on Met, all-N/A or not-assessed fires with its word; on Not Met doesn't; an absent list skips — lint.test.ts › SSP POA&M mismatch`
  - `[test] ssp_requirement_not_met: not_met and not_assessed fire with their wording; met doesn't — lint.test.ts › SSP requirement`
  - `[test] large_image: size equal to the limit gives nothing, limit + 1 fires, non-embeddable never; image_limit with max 2 fires for the 3rd and later embeddable links in order — lint.test.ts › images`
  - `[test] Findings follow rule then subject order; a clean fixture gives []; the input is unchanged (deep-frozen) — lint.test.ts › order and purity`
  - `[test] The zod mirrors infer the rules types; AssessmentView, Asset[], DiagramLink[] and DocumentControl fit SspLintSources; real output parses; a bad rule or severity fails — apps/api/src/contract-rules-types.test.ts › ssp lint mirror`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### X2: Export v2: NIST outline, CMMC sections, appendices, images, signature lines
- **Scope:** build **Export v2**: the `SspSource` fields, the document order, diagram lines, the embed rule, `image-info.ts`, the image and signature blocks, `exportRevisionDescription`, and the route reads with hash-checked image bytes (`exportEntry: null`, no writes). Add the shared constants to `contract/ssp.ts`. Add `docxPart`-based `docxMedia(bytes)` (the `word/media/*` names) to `ssp/testing/docx-text.ts`, and re-export it from `e2e/helpers/docx.ts`. In `e2e/smoke.spec.ts`, change `expectEveryRequirement`/`sectionOf` to read NIST status labels and "Current implementation" between "3. Requirements" and "4. Record of changes". Leave the rest of the smoke alone. You may split `model.ts` into `apps/api/ssp/model/` files. Out of scope: no revision write and no lint.
- **Files owned:** `apps/api/ssp/{index.ts,model.ts,render.ts,model.test.ts,render.test.ts}`, `apps/api/ssp/model/*` (new, optional), `apps/api/ssp/{image-info.ts,image-info.test.ts}` (new), `apps/api/ssp/testing/docx-text.ts`, `apps/api/src/contract/ssp.ts`, `apps/api/src/ssp/routes.ts`, `apps/api/src/ssp/export.test.ts`, `e2e/smoke.spec.ts`, `e2e/helpers/docx.ts`
- **Success criteria:**
  - `[test] Level-1 headings come in the contract order, from "1. System identification" to "Appendix B — Assessment objectives" — apps/api/ssp/model.test.ts › v2 outline order`
  - `[test] Section 1 rows (V1 identification fields, then the SSP identification fields, "Not provided", the default categorization), the roles table or "No roles recorded.", and both totals — model.test.ts › identification and roles`
  - `[test] Section 2 and CUI rows carry their labels and values, with Interconnections and Information types in place — model.test.ts › environment and CUI rows`
  - `[test] Five asset groups in category order with counts and "None recorded."; the justification column only for out of scope — model.test.ts › asset inventory`
  - `[test] ESP table or its empty line; the matrix lists only rows with a party in catalog order with provider names, plus the "<n> of 110" line — model.test.ts › providers and matrix`
  - `[test] Requirement status reads Implemented (met, partial N/A), Not applicable (all N/A), Planned to be implemented, Not yet assessed; the three texts and their fallbacks; no objectives table in section 3 — model.test.ts › requirement blocks`
  - `[test] Diagrams: a PNG with bytes gives an image block at 624 px wide plus its Figure line; a PDF gives a reference with name, version, SHA-256 and date; a CUI link marked embeddable with bytes is still a "contains CUI" reference; no version; the limit reason and the unreadable reason — model.test.ts › diagrams`
  - `[test] Record of changes: revisions in order, then exportEntry last; null adds none; the cadence and next-review lines; "No changes recorded." — model.test.ts › record of changes`
  - `[test] A signature block per approval, a blank date for null, "No approvals recorded." with none — model.test.ts › approvals`
  - `[test] Appendix A: versions, SPRS, Conditional, CSD and deadline only when set, NIST counts summing to 110, the POA&M table; Appendix B: 14 tables, 320 objectives with status and note — model.test.ts › appendices`
  - `[test] imageInfo reads PNG and baseline/progressive JPEG sizes from the bytes, whatever the name; truncated, zero-size and GIF give null — apps/api/ssp/image-info.test.ts › reads sizes`
  - `[test] fitImage gives 624 px wide with the aspect kept, caps the height at 864, and returns integers — image-info.test.ts › fits the page`
  - `[test] An image block gives one word/media part, one <w:drawing>, a png Default content type and an image relationship whose target exists — apps/api/ssp/render.test.ts › embeds images`
  - `[test] Signature lines render name and title, "Signature: " plus 32 underscores, and "Date: <date>" or 12 underscores — render.test.ts › signature lines`
  - `[test] A model without images renders an identical document.xml twice; text safety still holds — render.test.ts › deterministic`
  - `[test] On a seeded harness, the export has the v2 headings, embeds the PNG link (1 media part), references the PDF and the CUI item, and never asks the store for a non-embeddable link — apps/api/src/ssp/export.test.ts › exports the v2 docx`
  - `[test] An embeddable link whose stored file fails its hash check is referenced with the unreadable reason, and the export answers 200 — export.test.ts › unreadable image is referenced`
  - `[test] The export still writes no row and no event this wave; 401 and 404 as before — export.test.ts › access and no side effects`
  - `[test] Every requirement's NIST status and statement are found inside section 3 — e2e/smoke.spec.ts › SSP export contents`
  - `[manual] The exported file opens in Word or LibreOffice with no repair prompt — export once on a scratch api; no screenshot`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### A12: API: `GET /api/ssp/lint`; the export's record-of-changes entry
- **Scope:** build **Routes and the export's revision**: the lint route and the after-render append. Move `actorOf` into `ssp-data/common.ts` and swap the seven `ssp-data` copies for the import, with no other change in those files. Out of scope: the model, the rules and the web.
- **Files owned:** `apps/api/src/ssp/routes.ts`, `apps/api/src/ssp/export.test.ts`, `apps/api/src/ssp/lint.test.ts` (new), `apps/api/src/ssp-data/{common.ts,common.test.ts}`, `apps/api/src/ssp-data/{profile,roles,assets,diagrams,providers,responsibilities,document-control}/routes.ts`
- **Success criteria:**
  - `[test] GET /api/ssp/lint answers the response schema to admin and contributor; 401 signed out; 404 with no assessment; no row or event written — apps/api/src/ssp/lint.test.ts › lint route`
  - `[test] In a world that fires most rules, the route's findings deep-equal lintSspFrom over the parsed responses of GET /api/assessment, /api/ssp/assets, /api/ssp/diagrams and /api/ssp/document-control — lint.test.ts › web and api agree`
  - `[test] Adding an open POA&M item clears that not_met_without_poam; linking a network diagram clears no_network_diagram — lint.test.ts › lint follows the data`
  - `[test] An export near UTC midnight appends one export revision (UTC date, "Exported as <fileName>", the exporter) and one ssp_revision.created event; the docx's record of changes ends with that entry — apps/api/src/ssp/export.test.ts › export records a revision`
  - `[test] Two exports make two entries in order; a contributor's entry is made by them — export.test.ts › repeats and roles`
  - `[test] 401 and 404 write nothing; a render that throws gives 500 and no revision or event — export.test.ts › failures write nothing`
  - `[test] actorOf returns userId, deps.now() and the request id, and throws unauthenticated without auth — apps/api/src/ssp-data/common.test.ts › actorOf`
- **Depends on:** L5, X2
- **One-way door:** none. Each export permanently adds one append-only record-of-changes entry, as the plan asks.
- **Model:** opus

### W17: Web: live pre-export check on Lint & export
- **Scope:** build the **Lint panel** in `LintPanel.tsx` and mount it as section 2 of `ExportTab`. The Export section gets its note and loses the placeholder. Update the export-tab tests in `ssp.test.tsx`. Out of scope: other tabs and the api.
- **Files owned:** `apps/web/src/pages/ssp/tabs/ExportTab.tsx`, `apps/web/src/pages/ssp/tabs/{LintPanel.tsx,lint.module.css,lint.test.tsx}` (new), `apps/web/src/pages/ssp/ssp.test.tsx`
- **Success criteria:**
  - `[test] After the four reads answer, the groups, messages and summary equal lintSspFrom over the same mocked bodies, in rule order — apps/web/src/pages/ssp/tabs/lint.test.tsx › findings match the rules`
  - `[test] Error rules use the error Alert and warnings the info Alert; each group shows "<label> · <count>", its messages and its hint — lint.test.tsx › severity tones`
  - `[test] Requirement IDs link to their assessment detail; asset, diagram and review groups link to their tab — lint.test.tsx › links`
  - `[test] 12 messages show 10 plus "Show all 12", which reveals the rest — lint.test.tsx › long groups`
  - `[test] No findings shows "No findings. Every check passes."; "1 error · 2 warnings" pluralizes — lint.test.tsx › summary`
  - `[test] Check again re-requests all four reads and shows the new result — lint.test.tsx › check again`
  - `[test] One failing read shows "Can't run the pre-export check" with Retry, while readiness and the export link still show — lint.test.tsx › load failure`
  - `[test] The export link is present with the warns-only note whatever the findings, and the placeholder text is gone; an unvisited export tab sends no request — apps/web/src/pages/ssp/ssp.test.tsx › export tab`
  - `[manual] At 1280 and 375 px with findings, document.documentElement.scrollWidth ≤ the viewport width and the Alerts follow the Inspection style — scratch api, measured in devtools; no screenshot`
- **Depends on:** L5, X2
- **One-way door:** none
- **Model:** sonnet

### E4: E2E smoke and look for lint and export v2; docs
- **Scope:**
  - **`e2e/smoke.spec.ts`:** extend the run. Add one role through the Identification UI. Through the api add the SSP profile fields, an asset per category, a provider with an ESP matrix row, a PNG and a PDF evidence file linked as network and other diagrams, the CUI item linked as data flow, and an approval with a date.
    - On `/ssp?tab=export`, the panel matches `GET /api/ssp/lint`.
    - Export through the link and assert the v2 document.
    - Upload helpers go in `e2e/helpers/api.ts`.
  - **`e2e/look.spec.ts`:** seed a future-tense statement. The export tab shows its finding and passes the look.
  - **Docs:**
    - `README.md`: Parts and endpoints.
    - The brief: Parts (`ssp-lint` in rules, export v2) and Key URLs (`GET /api/ssp/lint`; the export appends a revision).
    - `feature-details/ssp-export.md`: rewrite it for v2.
    - `feature-details/ssp-lint.md`: new.
    - `feature-details/ssp-workspace.md`: the export tab row.
- **Files owned:** `e2e/smoke.spec.ts`, `e2e/look.spec.ts`, `e2e/helpers/api.ts`, `README.md`, `pod-docs/codebase-structure.md`, `pod-docs/feature-details/{ssp-export.md,ssp-workspace.md}`, `pod-docs/feature-details/ssp-lint.md` (new)
- **Success criteria:**
  - `[test] The panel's summary equals GET /api/ssp/lint's counts, and each finding message of the first 10 per rule is visible — e2e/smoke.spec.ts › lint panel matches the api`
  - `[test] The downloaded .docx has the ten level-1 headings in order, the UI-added role in 1.1, exactly one media part (the PNG) and one <w:drawing>, the PDF reference line with its SHA-256, the CUI link as a "contains CUI" reference, a final record-of-changes row "<today> | Exported as <file> | <admin>" that also ends GET /api/ssp/document-control's revisions as kind export, the approval's signature lines, Appendix A's SPRS line and an Appendix B objective — e2e/smoke.spec.ts › SSP v2 export`
  - `[test] Every requirement's NIST status and statement are inside section 3 — e2e/smoke.spec.ts › SSP export contents`
  - `[test] Every route, the assessment detail and all six tabs, the export tab included with findings, pass the size, palette, contrast and 375 px scroll checks — e2e/look.spec.ts › look holds on every route`
  - `[test] The seeded export tab lists the future-tense finding for its requirement — e2e/look.spec.ts › seeded workspace shows its data`
  - `[manual] pnpm e2e is green locally on Windows, and git status shows no screenshot or stray files — run output`
- **Depends on:** L5, X2, A12, W17
- **One-way door:** none
- **Model:** opus
