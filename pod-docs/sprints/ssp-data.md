# Sprint: SSP data — migration, contract and API for the v2 SSP sections

_From plan: pod-docs/plans/ssp-export-v2.md · Slug: ssp-data · Status: active · Generated: 2026-11-25_

<!-- autopilot-run: started=2026-11-25T10:00:00-08:00 sprints=0 waves=1 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | K3 | Contract: SSP data schemas, requirement fields, audit actions, `provider_in_use` | ssp-data-k3 | — | pending | — | — |
| 1 | D3 | DB: migration 0005, schema, `ssp-data` module scaffold, brief | ssp-data-d3 | — | pending | — | — |
| 1 | T1 | `templates/` reference folder and SOURCES.md | ssp-data-t1 | — | pending | — | — |
| 2 | A7 | API: SSP profile (identification, CUI, environment, review) and roles | ssp-data-a7 | — | pending | — | K3, D3 |
| 2 | A8 | API: assets and diagram links | ssp-data-a8 | — | pending | — | K3, D3 |
| 2 | A9 | API: service providers and the responsibility matrix | ssp-data-a9 | — | pending | — | K3, D3 |
| 2 | A10 | API: document control (revisions, approvals, review status) | ssp-data-a10 | — | pending | — | K3, D3 |
| 2 | A11 | API: planned implementation and N/A rationale on requirements | ssp-data-a11 | — | pending | — | K3, D3 |

Plan branch `ssp-export-v2`; wave heads `ssp-data-w1`, `ssp-data-w2`. Merge target `main`. No UI this sprint (the workspace is sprint `ssp-workspace`), so no Look slice and no `[manual]` look checks.

## Shared contract

Everything in the four archived `cmmc-l2-grc` Shared contracts still holds (tooling, frozen types, error envelope, `respond()`, the deny-by-default guard and check order, `recordAudit(tx, …)` in the change's transaction, `createHarness()`, the upload protocol and evidence store), except where this section changes it.

### Run facts
- **No dependency changes.** Nobody touches `pnpm-lock.yaml`. If something is truly missing, add a `BLOCKED` entry to `orchestrator`.
- pnpm: `corepack enable` fails with EPERM; use `corepack pnpm …`, and put a pnpm shim on PATH for scripts that call `pnpm` (`pod-docs/known-issues/corepack-enable-eperm.md`).
- **Ports** (Windows reserves 3057–3156; never use 3000/3001, the human's app, nor 3290/3291/3293, the e2e servers): web/api — K3 3200/3201, D3 3210/3211, T1 3220/3221, A7 3230/3231, A8 3240/3241, A9 3250/3251, A10 3260/3261, A11 3270/3271. Use a scratch `DATABASE_PATH` and `STORAGE_PATH`.
- **Human PENDINGs, on the values in use:** `[a]` objective IDs, Rev 2 wording of 3.3.2, the Ink Not met radio, no confirm on self-reset, UTC "today". Nothing here hard-codes them.
- **Queue:** no `BLOCKED`. The three open PENDINGs (catalog JSON import attribute, CSP on the dev server, duplicated helpers) are someday or before-hosting and stay open. To avoid adding more copies of `requireAssessment` / `utcDate` / `changedFields`, new code imports them from `apps/api/src/ssp-data/common.ts` (D3); existing copies are left alone.
- **Pinned-list tests belong to the slice that changes the list:** `contract.test.ts` and `schemas.test.ts` (error codes, `AUDIT_ACTIONS`, `AUDIT_ENTITY_TYPES`) and `AuditLog.test.tsx` + `auditLabels.ts` → K3; `db.test.ts` (`ALL_TABLES`, `requirement_state` columns) and `system-profile.test.ts` (journal tail) → D3.
- Source files hold no raw control bytes (U+0000–U+001F other than tab/LF, U+007F); write `\u0007`-style escapes in tests.

### Write rules (every new route)
- All routes live in `/api/ssp/*`, registered inside `registerApiRoutes` via `registerSspDataRoutes` (D3). They never collide with the existing `GET /api/ssp/export`.
- **Who:** any signed-in user reads and writes, except approvals, which only admins create, change or remove (contributor → 403 `forbidden`).
- **Check order:** 401 → 403 `csrf_failed` → 403 `forbidden` → 400 body → 404 (no assessment, unknown id, or a removed row) → 409.
- Request schemas are strict (unknown key → 400); `patch*` reject `{}`. Text trims; blank or whitespace-only becomes `null`; a required text that ends up blank is a 400.
- **Removal is soft:** `DELETE /api/ssp/<collection>/:id` sets `removed_at` and answers 204. Removed rows never appear in lists, and a second `DELETE`, a `PATCH` or a reference to a removed row is 404 (as a path id) or 400 (as a body id). No api route hard-deletes a row.
- **Audit:** every create, change and removal writes one event in the same transaction. `created`: before `null`, after = every stored field. `updated`: only the changed fields. `removed`: before = every stored field, after `null`. A write that changes nothing gives 200 and writes neither the row nor an event, and leaves `updatedAt` as it was. `entityId` is the row's UUID, the assessment ID for `ssp_profile`, the requirement ID for `responsibility`.
- **Lists** are of the active assessment only. Timestamps come from `deps.now()`; "today" is its UTC date.

### Contract (K3, `apps/api/src/contract/ssp-data.ts`, zod only, exported from `contract/index.ts`)
- **Enums and labels** (order is the export order):
  - `ASSET_CATEGORIES` = `cui | spa | crma | specialized | out_of_scope`; `ASSET_CATEGORY_LABELS` = "CUI Assets", "Security Protection Assets", "Contractor Risk Managed Assets", "Specialized Assets", "Out-of-Scope Assets".
  - `PROVIDER_TYPES` = `cloud | msp | mssp | other`; labels "Cloud service provider", "Managed service provider", "Managed security service provider", "Other".
  - `RESPONSIBILITY_PARTIES` = `organization | esp | shared`; labels "Organization", "ESP", "Shared".
  - `DIAGRAM_KINDS` = `network | data_flow | other`; labels "Network diagram", "CUI data flow", "Other diagram".
  - `REVISION_KINDS` = `export | manual`.
  - `NIST_STATUSES` = `implemented | planned | not_applicable | not_assessed`; labels "Implemented", "Planned to be implemented", "Not applicable", "Not yet assessed".
  - `DEFAULT_CATEGORIZATION = 'Moderate impact for confidentiality'`, `DEFAULT_REVIEW_CADENCE_MONTHS = 12`, `EMBEDDABLE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg']`.
- **`nistImplementationStatus({ status, allNa })`** (pure): `met` + `allNa` → `not_applicable`; `met` → `implemented` (also when only some objectives are N/A); `not_met` → `planned`; `not_assessed` → `not_assessed`.
- **`isEmbeddableImage(fileName)`**: true only for the last extension in the list, case-insensitive (`A.PNG` yes, `a.png.pdf` no, `a.gif` no).
- **SSP profile** — `SSP_PROFILE_FIELDS: { key, label, group }[]` in this order (groups `identification | cui | environment | review`):

  | key | label | rule |
  |---|---|---|
  | `categorization` | Security categorization | ≤ 200; null/blank reads as `DEFAULT_CATEGORIZATION` |
  | `securityOfficer` | System security officer | ≤ 200 |
  | `securityOfficerEmail` | System security officer email | `emailSchema` |
  | `organizationAddress` | Organization address | ≤ 1,000 |
  | `organizationPhone` | Organization phone | 7–50 chars of `0-9 + ( ) . -` and spaces, optional ` x123` / ` ext. 123` suffix |
  | `cuiCategories` | CUI categories (CUI Registry) | ≤ 20,000 |
  | `cuiLocations` | Where CUI is stored, processed or transmitted | ≤ 20,000 |
  | `cuiEntryExit` | How CUI enters and leaves the system | ≤ 20,000 |
  | `topologyNarrative` | Network topology | ≤ 20,000 |
  | `dataFlowNarrative` | CUI data flow | ≤ 20,000 |
  | `inventoryReference` | Hardware and software inventory | ≤ 2,000 (narrative or URL) |
  | `maintenanceStatement` | Maintenance and ownership | ≤ 20,000 |
  | `reviewCadenceMonths` | Review every (months) | integer 1–60, never null; default 12 |
  | `nextReviewDate` | Next review date | `calendarDateSchema` or null |

  `sspProfileSchema` = every field (`categorization: string`, `reviewCadenceMonths: number`, the rest `string | null`) + `updatedAt`, `updatedBy` (null before the first save). `sspProfileResponseSchema = { profile }`; `patchSspProfileRequestSchema` strict, all optional, rejects `{}`; `reviewCadenceMonths: null` is a 400.
- **Roles:** `systemRoleSchema` = `{ id, title, person: string|null, responsibilities: string|null, userCount: int, privileged: boolean, createdAt, updatedAt }`. Create: `title` 1–200, `person` ≤ 200, `responsibilities` ≤ 4,000, `userCount` int 0–1,000,000, `privileged` boolean (all required except the two nullable texts, which default `null`). `rolesResponseSchema = { roles, totals: { users, privilegedUsers } }`; `roleResponseSchema = { role }`.
- **Assets:** `assetSchema` = `{ id, name, category, assetType: string|null, owner, location, treatment, outOfScopeJustification, createdAt, updatedAt }`. Create: `name` 1–200, `category` required, `assetType`/`owner`/`location` ≤ 200, `treatment`/`outOfScopeJustification` ≤ 4,000. `assetsResponseSchema = { assets }`, `assetResponseSchema = { asset }`.
- **Providers:** `serviceProviderSchema` = `{ id, name, providerType, fedrampStatus: string|null, services, agreementReference, createdAt, updatedAt }`. Create: `name` 1–200, `providerType` required, `fedrampStatus` ≤ 200 (free text, e.g. "FedRAMP Moderate"), `services` ≤ 4,000, `agreementReference` ≤ 1,000.
- **Responsibilities:** `responsibilityRowSchema` = `{ requirementId, party: party|null, provider: { id, name }|null, note: string|null, updatedAt: string|null }`. `responsibilityMatrixSchema = { rows }`. `putResponsibilityRequestSchema` = strict `{ party: party|null, providerId: uuid|null, note: noteSchema }`, every key required; it refuses (400) `esp`/`shared` without a `providerId`, and `organization`/`null` with one.
- **Diagram links:** `diagramLinkSchema` = `{ id, kind, caption, evidence: { id, title, containsCui }, version: int|null, resolved: null | { version, kind: 'file'|'reference', fileName: string|null, size: int|null, sha256: string|null, location: string|null, createdAt }, embeddable: boolean, createdAt, updatedAt }`. Create: `evidenceId` uuid, `kind`, `caption` 1–200, `version` int ≥ 1 or `null` (null = always the newest version). Patch: `kind?`, `caption?`, `version?` (the evidence item can't change: remove and re-link).
- **Document control:** `sspRevisionSchema` = `{ id, kind, date, description, madeBy, createdAt }`; `createRevisionRequestSchema` = strict `{ date, description: 1–2,000, madeBy?: 1–200 }`. `sspApprovalSchema` = `{ id, name, title, approvedOn: date|null, createdAt, updatedAt }`; create `{ name 1–200, title 1–200, approvedOn: date|null }`. `documentControlSchema` = `{ reviewCadenceMonths, nextReviewDate, nextReviewDue: date|null, daysToReview: int|null, reviewOverdue: boolean, revisions, approvals }`.
- **Requirement fields** (`contract/assessment.ts`): `requirementStateSchema` gains `plannedImplementation` and `naRationale`, both `z.string().nullable().optional()` (the api **always** sends them; optional only so older mocks parse, as with `openPoamRequirementIds`). `patchRequirementRequestSchema` gains `plannedImplementation?: implementationStatementSchema` (≤ 20,000) and `naRationale?: noteSchema` (≤ 4,000).
- **Error code:** `provider_in_use` (409) — removing a provider that a responsibility row names; `details: { requirementIds }` in catalog order.
- **Audit:** `AUDIT_ACTIONS` appends, in order: `ssp_profile.updated`, `system_role.created`, `system_role.updated`, `system_role.removed`, `asset.created`, `asset.updated`, `asset.removed`, `service_provider.created`, `service_provider.updated`, `service_provider.removed`, `responsibility.updated`, `diagram_link.created`, `diagram_link.updated`, `diagram_link.removed`, `ssp_revision.created`, `ssp_approval.created`, `ssp_approval.updated`, `ssp_approval.removed`. `AUDIT_ENTITY_TYPES` appends `ssp_profile`, `system_role`, `asset`, `service_provider`, `responsibility`, `diagram_link`, `ssp_revision`, `ssp_approval`. Requirement fields reuse `requirement_state.updated`.

### Routes (wave 2)
| Route | Slice | Success | Failures beyond 401/403/400 |
|---|---|---|---|
| `GET`, `PATCH /api/ssp/profile` | A7 | `{ profile }` | 404 no assessment |
| `GET /api/ssp/roles`, `POST`, `PATCH /:id`, `DELETE /:id` | A7 | `{ roles, totals }`, 201 `{ role }`, `{ role }`, 204 | 404 |
| `GET /api/ssp/assets`, `POST`, `PATCH /:id`, `DELETE /:id` | A8 | `{ assets }`, 201 `{ asset }`, `{ asset }`, 204 | 404 |
| `GET /api/ssp/diagrams`, `POST`, `PATCH /:id`, `DELETE /:id` | A8 | `{ diagrams }`, 201 `{ diagram }`, `{ diagram }`, 204 | 404 |
| `GET /api/ssp/providers`, `POST`, `PATCH /:id`, `DELETE /:id` | A9 | `{ providers }`, 201 `{ provider }`, `{ provider }`, 204 | 404, 409 `provider_in_use` |
| `GET /api/ssp/responsibilities`, `PUT /:requirementId` | A9 | `{ rows }` (110), `{ row }` | 404 unknown requirement |
| `GET /api/ssp/document-control` | A10 | `documentControl` | 404 |
| `POST /api/ssp/revisions` | A10 | 201 `{ revision }` | — |
| `POST`, `PATCH /:id`, `DELETE /:id` on `/api/ssp/approvals` | A10 (admin) | 201 `{ approval }`, `{ approval }`, 204 | 404 |
| `PATCH /api/assessment/requirements/:id` (new keys) | A11 | as before | as before |

### Rules and their edges
- **Profile (A7):** no row → every field null except `categorization` = default and `reviewCadenceMonths` = 12; reading creates nothing. The first changing PATCH creates the row. No-op detection compares *effective* values: sending the default categorization text to an empty profile, or `reviewCadenceMonths: 12`, changes nothing. `categorization: null` or blank resets to the default (stored null). Cadence 0, 61, 1.5 → 400; 1 and 60 pass. A past `nextReviewDate` is accepted.
- **Roles (A7):** `totals.users` = sum of `userCount`, `totals.privilegedUsers` = sum over `privileged` roles; removed roles count for neither; no roles → `{0, 0}`. Order: `createdAt`, then `id`.
- **Assets (A8):** `out_of_scope` requires a non-blank `outOfScopeJustification`, checked on the merged result of a PATCH (switching to out of scope without one, or blanking it while out of scope → 400 with `path: ['outOfScopeJustification']`). A justification on another category is kept. Order: category order, then name (case-insensitive), then `createdAt`, then `id`.
- **Diagram links (A8):** `evidenceId` must be an existing evidence item of the active assessment (else 400, `path: ['evidenceId']`); a pinned `version` must exist on it (else 400, `path: ['version']`). `resolved` is the pinned version, or the newest when `version` is null, or `null` while the item has no versions; a later upload changes what a null link resolves to. `embeddable` = resolved is a `file` **and** the item is not `containsCui` **and** `isEmbeddableImage(fileName)`; a CUI-flagged item can be linked but is never embeddable. Linking the same item twice makes two links. Order: kind order, then `createdAt`, then `id`. `loadDiagramLinks(db, assessmentId)` is exported for the export sprint.
- **Providers and matrix (A9):** provider order: name (case-insensitive), `createdAt`, `id`. The matrix always has one row per catalog requirement in catalog order; a requirement with no stored row reads `{ party: null, provider: null, note: null, updatedAt: null }`. `providerId` must name a live provider of the active assessment (else 400). The first PUT that sets anything stores the row (`before: null`); an all-null PUT on a requirement with no row stores nothing. Audit fields are `{ party, providerId, note }`. Removing a named provider → 409 `provider_in_use`, nothing changes; after re-pointing those rows, removal works. Renaming a provider shows in the matrix at once.
- **Document control (A10):**
  - `nextReviewDue` = the profile's `nextReviewDate` if set; else the latest `approvedOn` among live approvals plus `reviewCadenceMonths` calendar months; else `null`. Month addition is UTC with the day clamped to the month's end: 2026-01-31 + 1 → 2026-02-28; 2027-11-30 + 3 → 2028-02-29; 2026-03-15 + 12 → 2027-03-15.
  - `daysToReview` = `nextReviewDue − today` (null when due is null). On the due date: 0 and `reviewOverdue` false; the day after: −1 and true. No due date → false.
  - Manual revision: `date` ≤ today (tomorrow → 400; today passes); `madeBy` defaults to the actor's display name. Revisions are append-only: no PATCH or DELETE route (405/404 by Fastify is fine; nothing changes). Order: `date`, `createdAt`, `id` ascending.
  - `appendExportRevision(tx, { assessmentId, actor, description })` (exported for sprint `ssp-export-lint`): kind `export`, date = UTC today, `madeBy` = actor's display name, plus its `ssp_revision.created` event, inside the caller's transaction. Calling it twice makes two entries.
  - Approvals: `approvedOn` ≤ today or null (null prints a blank signature line later). Order: `createdAt`, `id`.
- **Requirement fields (A11):** both fields are stored on any requirement whatever its status (the lint, not the api, judges them). They follow the existing no-op, audit (`requirement_state.updated` with only changed fields) and empty-row rules; a requirement with no row reads both as `null`. They don't change the evaluation.

### DB (D3: migration `0005_ssp_data`, generated by drizzle-kit, additive only)
- New tables (all timestamps and `*_by` columns not null with no default except `removed_at`; `*_by` FK → `user.id`; `assessment_id` FK → `assessment.id`): `ssp_profile` (PK `assessment_id`; one nullable text column per profile field in snake_case, `review_cadence_months` integer not null check 1–60, `next_review_date`, `updated_by`, `updated_at`); `system_role` (`id`, `assessment_id`, `title`, `person`, `responsibilities`, `user_count` int check ≥ 0, `privileged` int check in (0,1), `created_by`, `created_at`, `updated_by`, `updated_at`, `removed_at`); `asset` (`name`, `category` check in the five, `asset_type`, `owner`, `location`, `treatment`, `out_of_scope_justification`, check `category <> 'out_of_scope' or out_of_scope_justification is not null`, stamps, `removed_at`); `service_provider` (`name`, `provider_type` check in the four, `fedramp_status`, `services`, `agreement_reference`, stamps, `removed_at`); `responsibility` (PK `assessment_id, requirement_id`; `party` nullable check in the three; `provider_id` FK → `service_provider.id`; `note`; `updated_by`, `updated_at`; check (`party in ('esp','shared')` and `provider_id is not null`) or (`party is null or party = 'organization'`) and `provider_id is null`; index on `provider_id`); `diagram_link` (`evidence_id` FK → `evidence_item.id`, `version` nullable check ≥ 1, `kind` check, `caption`, stamps, `removed_at`); `ssp_revision` (`kind` check, `revised_on`, `description`, `made_by`, `created_by`, `created_at`); `ssp_approval` (`name`, `title`, `approved_on`, stamps, `removed_at`).
- `requirement_state` gains `planned_implementation` and `na_rationale` (nullable text) by `ALTER TABLE … ADD`. No other existing table changes; no CHECK is added to an existing table (that would make drizzle-kit rebuild it).
- **Before the human's app picks up 0005** (orchestrator, after the wave 1 merge): stop the parent app, copy `apps/api/data/rampart.sqlite` (and any `-wal`/`-shm`) to `apps/api/data/rampart.pre-0005.sqlite`, then `corepack pnpm install --frozen-lockfile` and restart. Undo = revert D3's merge commit and copy the backup back over `rampart.sqlite`.

## Per-slice detail

### K3: Contract: SSP data schemas, requirement fields, audit actions, `provider_in_use`
- **Scope:** write everything under **Contract** (`contract/ssp-data.ts`, the `assessment.ts` additions, `audit.ts`, `error.ts`, `index.ts`), and add a web label for each new action and entity in `auditLabels.ts` (e.g. "SSP details changed", "Asset removed"). Update the pinned lists in `contract.test.ts`, `schemas.test.ts` and `AuditLog.test.tsx`. No routes, no DB.
- **Files owned:** `apps/api/src/contract/{ssp-data.ts (new),assessment.ts,audit.ts,error.ts,index.ts}`, `apps/api/src/contract/ssp-data.test.ts` (new), `apps/api/src/contract/{contract.test.ts,schemas.test.ts}`, `apps/web/src/pages/settings/{auditLabels.ts,AuditLog.test.tsx}`
- **Success criteria:**
  - `[test] ERROR_CODES ends with provider_in_use at 409 — apps/api/src/contract/schemas.test.ts › error codes and statuses`
  - `[test] AUDIT_ACTIONS and AUDIT_ENTITY_TYPES equal the old lists plus the contract's additions in order — schemas.test.ts › other enums and constants`
  - `[test] Every action and entity type has a non-blank web label, and the filter offers each new entity — apps/web/src/pages/settings/AuditLog.test.tsx › labels cover the contract`
  - `[test] Enum orders and labels match the contract; DEFAULT_CATEGORIZATION and the cadence default are exact — apps/api/src/contract/ssp-data.test.ts › enums labels and defaults`
  - `[test] nistImplementationStatus maps met, met+allNa, not_met and not_assessed; partial N/A stays implemented — ssp-data.test.ts › nist status derivation`
  - `[test] isEmbeddableImage accepts .png/.JPG/.jpeg and refuses .gif, .pdf and a.png.pdf — ssp-data.test.ts › embeddable images`
  - `[test] Profile patch: cadence 1 and 60 pass, 0/61/1.5/null fail; phone edges (7 and 50 chars, ' x12' suffix pass; letters, 6 chars fail); blank text → null; {} and unknown keys fail — ssp-data.test.ts › profile request rules`
  - `[test] Responsibility PUT refuses esp/shared without providerId and organization/null with one, and a missing key — ssp-data.test.ts › responsibility request rules`
  - `[test] Create schemas: required title/name/caption blank → 400-shaped failure; userCount −1 and 1,000,001 fail; diagram version 0 fails, null passes — ssp-data.test.ts › collection request rules`
  - `[test] requirementStateSchema parses rows with and without the two new keys; the patch accepts them, blanks become null, 20,001 / 4,001 chars fail — schemas.test.ts › requirement fields`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### D3: DB: migration 0005, schema, `ssp-data` module scaffold, brief
- **Scope:** add the **DB** tables and columns to `apps/api/db/schema.ts` and generate `0005_ssp_data` with drizzle-kit (never hand-edit), then run `drizzle-kit check`. Scaffold `apps/api/src/ssp-data/`: `routes.ts` with `registerSspDataRoutes(api, deps)` calling empty `register…Routes` in `profile/`, `roles/`, `assets/`, `diagrams/`, `providers/`, `responsibilities/`, `document-control/` (`routes.ts` each), wired from `routes/index.ts`; `common.ts` exporting `requireAssessmentId(db)`, `utcDate(now)`, `changedFields(...)` and `newId()`. Update the pinned tests you break. In the brief, add `ssp-data` and `templates/` to **Parts** and the new routes to **Key URLs**.
- **Files owned:** `apps/api/db/schema.ts`, `apps/api/db/migrations/0005_ssp_data.sql` (new), `apps/api/db/migrations/meta/{_journal.json,0005_snapshot.json (new)}`, `apps/api/db/{db.test.ts,system-profile.test.ts}`, `apps/api/db/ssp-data.test.ts` (new), `apps/api/src/routes/index.ts`, `apps/api/src/ssp-data/{routes.ts,common.ts,common.test.ts}` (new), `apps/api/src/ssp-data/{profile,roles,assets,diagrams,providers,responsibilities,document-control}/routes.ts` (new, empty bodies), `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] 0005's SQL holds only CREATE TABLE, CREATE INDEX and ALTER TABLE … ADD; no DROP, RENAME, INSERT, UPDATE, DELETE or __new_ rebuild — apps/api/db/ssp-data.test.ts › 0005 is additive`
  - `[test] A 0004 database with a row in every table upgrades with every row kept (requirement_state rows gain two null columns) and every old definition unchanged; a second run is a no-op — ssp-data.test.ts › upgrade from 0004 keeps data`
  - `[test] The eight tables have the contract's columns, checks (category, party/provider, out-of-scope justification, cadence 1–60, user_count ≥ 0, kinds) and foreign keys — ssp-data.test.ts › new table constraints`
  - `[test] The journal ends with 0005_ssp_data, and 0005_snapshot.json's tables and columns equal schema.ts — ssp-data.test.ts › schema matches the snapshot`
  - `[test] ALL_TABLES and the requirement_state column list include the additions — apps/api/db/db.test.ts › migrations and constraints`
  - `[test] 0004's own test still proves 0004 additive with 0005 after it in the journal — apps/api/db/system-profile.test.ts › 0004 is additive`
  - `[test] utcDate gives the UTC day near midnight; requireAssessmentId throws not_found with no assessment; changedFields ignores undefined and equal values — apps/api/src/ssp-data/common.test.ts › shared helpers`
- **Depends on:** —
- **One-way door:** changes the database schema of every existing install on its next start (eight new tables, two new empty columns on requirement_state; existing rows kept). There is no down migration. Undo: revert the slice's merge commit and restore the pre-0005 copy of the database file the orchestrator takes before restarting the human's app.
- **Model:** opus

### T1: `templates/` reference folder and SOURCES.md
- **Scope:** download into `templates/official/` the NIST CUI SSP template and CUI Plan of Action template (`https://csrc.nist.gov/files/pubs/sp/800/171/r2/upd1/final/docs/`), the 800-171 Rev 2 requirements spreadsheet (same folder; confirm the name on the CSRC Rev 2 page) and the 800-171A assessment-procedures spreadsheet (CSRC 800-171A page), plus the DoD CMMC Assessment Guide L2 and Scoping Guide L2 (dodcio.defense.gov) where they download. A 403 or other refusal → link only, with the status and date. Write `templates/SOURCES.md`: one table row per source with path (or "link only"), URL, date checked (YYYY-MM-DD), SHA-256 of committed files, terms as found ("not stated" if none), and the link-only vendor templates (Hive Systems, Security Scientist, Secureframe — never downloaded). Add `*.docx`, `*.xlsx` binary lines to `.gitattributes`. Don't commit Rev 3 files (out of scope).
- **Files owned:** `templates/official/*` (new), `templates/SOURCES.md` (new), `.gitattributes`, `tests/repo/templates.test.ts` (new)
- **Success criteria:**
  - `[test] Every file under templates/ except SOURCES.md has a SOURCES.md row with an https URL, a real date checked and non-empty terms — tests/repo/templates.test.ts › every committed file is listed`
  - `[test] Each listed SHA-256 matches the committed bytes, and every row marked committed exists — templates.test.ts › hashes match`
  - `[test] No vendor file exists; the three vendor templates are rows marked link only — templates.test.ts › vendor templates are links only`
  - `[test] The NIST SSP template is committed, and each DoD guide is either committed or marked link only with its HTTP status — templates.test.ts › required sources are covered`
  - `[test] Each committed file is at most 20 MiB — templates.test.ts › files stay small`
- **Depends on:** —
- **One-way door:** none
- **Model:** sonnet

### A7: API: SSP profile (identification, CUI, environment, review) and roles
- **Scope:** `GET`/`PATCH /api/ssp/profile` and the roles routes per **Routes**, **Write rules** and the Profile and Roles edges. Export `loadSspProfile(db, assessmentId)` (the one read path; A10 and the export sprint read through it or the table). Don't touch `/api/system-profile`.
- **Files owned:** `apps/api/src/ssp-data/profile/{routes.ts,repository.ts}`, `apps/api/src/ssp-data/profile/profile.test.ts` (new), `apps/api/src/ssp-data/roles/{routes.ts,repository.ts}`, `apps/api/src/ssp-data/roles/roles.test.ts` (new)
- **Success criteria:**
  - `[test] An empty profile reads defaults (categorization, 12) and creates no row — profile.test.ts › empty profile`
  - `[test] First save audits before null; a change audits only changed fields; an effective no-op (default text, 12, blanks) writes nothing; null categorization resets to the default — profile.test.ts › audit edges`
  - `[test] Contributor writes; signed out 401; missing CSRF 403; bad bodies 400; no assessment 404 — profile.test.ts › access`
  - `[test] Saved fields survive a restart on a file database — profile.test.ts › persists across restart`
  - `[test] Create, patch and remove roles with created/updated/removed events; a second DELETE and a PATCH of a removed role give 404 — roles.test.ts › role lifecycle`
  - `[test] Totals sum userCount and privileged counts, skip removed roles, and are 0/0 with none — roles.test.ts › totals`
  - `[test] Roles survive a restart in creation order — roles.test.ts › persists across restart`
- **Depends on:** K3, D3
- **One-way door:** none
- **Model:** sonnet

### A8: API: assets and diagram links
- **Scope:** the asset and diagram routes per **Routes**, **Write rules** and the Assets and Diagram links edges; export `loadAssets` and `loadDiagramLinks`. Read evidence through the evidence tables; never read or copy file bytes.
- **Files owned:** `apps/api/src/ssp-data/assets/{routes.ts,repository.ts}`, `apps/api/src/ssp-data/assets/assets.test.ts` (new), `apps/api/src/ssp-data/diagrams/{routes.ts,repository.ts}`, `apps/api/src/ssp-data/diagrams/diagrams.test.ts` (new)
- **Success criteria:**
  - `[test] Out of scope without a justification gives 400 on create, on a category switch and on blanking it; with one it saves — assets.test.ts › out-of-scope justification`
  - `[test] Lifecycle audits created/updated/removed; a no-op patch writes nothing; removed assets leave the list and 404 — assets.test.ts › asset lifecycle`
  - `[test] Assets list in category order, then name case-insensitively — assets.test.ts › order`
  - `[test] Assets survive a restart — assets.test.ts › persists across restart`
  - `[test] A PNG file link is embeddable; a PDF link is not; a CUI-flagged item's link is never embeddable and has a reference resolved — diagrams.test.ts › embeddable`
  - `[test] A null version follows a new upload; a pinned version doesn't; an item with no versions resolves null — diagrams.test.ts › version resolution`
  - `[test] Unknown evidence and a missing pinned version give 400 with their paths; linking twice makes two links — diagrams.test.ts › link validation`
  - `[test] Lifecycle audits and removal follow the write rules, and links survive a restart — diagrams.test.ts › diagram lifecycle`
- **Depends on:** K3, D3
- **One-way door:** none
- **Model:** sonnet

### A9: API: service providers and the responsibility matrix
- **Scope:** provider and responsibility routes per **Routes**, **Write rules** and the Providers and matrix edges; export `loadProviders` and `loadResponsibilityMatrix`.
- **Files owned:** `apps/api/src/ssp-data/providers/{routes.ts,repository.ts}`, `apps/api/src/ssp-data/providers/providers.test.ts` (new), `apps/api/src/ssp-data/responsibilities/{routes.ts,repository.ts}`, `apps/api/src/ssp-data/responsibilities/matrix.test.ts` (new)
- **Success criteria:**
  - `[test] Provider lifecycle audits created/updated/removed, lists by name, and survives a restart — providers.test.ts › provider lifecycle`
  - `[test] Removing a provider named by rows gives 409 provider_in_use with requirementIds in catalog order and changes nothing; after re-pointing, removal works — providers.test.ts › provider in use`
  - `[test] The matrix has 110 rows in catalog order, empty rows reading null — matrix.test.ts › full matrix`
  - `[test] PUT stores esp with a provider, audits {party, providerId, note}; a repeat writes nothing; an all-null PUT on an empty row stores nothing — matrix.test.ts › put edges`
  - `[test] Unknown or removed providerId gives 400; unknown requirement gives 404, after a bad body's 400 — matrix.test.ts › validation order`
  - `[test] A provider rename shows in the matrix; rows survive a restart — matrix.test.ts › reads follow providers`
- **Depends on:** K3, D3
- **One-way door:** none
- **Model:** opus

### A10: API: document control (revisions, approvals, review status)
- **Scope:** `GET /api/ssp/document-control`, manual revisions, approvals (admin) and `appendExportRevision` per **Routes** and the Document control edges. Put the month and review math in a pure `review.ts`. Read cadence and next review date from the `ssp_profile` table (defaults when no row).
- **Files owned:** `apps/api/src/ssp-data/document-control/{routes.ts,repository.ts,review.ts}`, `apps/api/src/ssp-data/document-control/review.test.ts` (new), `apps/api/src/ssp-data/document-control/document-control.test.ts` (new)
- **Success criteria:**
  - `[test] addMonths clamps 2026-01-31+1, 2027-11-30+3 and keeps 2026-03-15+12 — review.test.ts › calendar months`
  - `[test] Due date: stored date wins, else latest approval plus cadence, else null; 0 and not overdue on the day, −1 and overdue the next — review.test.ts › review status`
  - `[test] A manual revision dated today saves with madeBy defaulting to the actor; tomorrow gives 400; there is no update or delete — document-control.test.ts › manual revisions`
  - `[test] appendExportRevision inside a transaction adds an export entry dated UTC today with its event; a rolled-back transaction adds neither — document-control.test.ts › export revision`
  - `[test] Approvals: admin creates, patches and removes with events; contributor 403; future approvedOn 400; null allowed — document-control.test.ts › approvals`
  - `[test] Setting nextReviewDate in the past via /api/ssp/profile makes reviewOverdue true; revisions and approvals survive a restart — document-control.test.ts › overdue and persistence`
- **Depends on:** K3, D3
- **One-way door:** none
- **Model:** opus

### A11: API: planned implementation and N/A rationale on requirements
- **Scope:** store, return and audit `plannedImplementation` and `naRationale` through `PATCH /api/assessment/requirements/:id` and the view, per the Requirement fields edge. Every `requirementState` the api sends carries both keys. Nothing else in the assessment api changes.
- **Files owned:** `apps/api/src/assessment/repository.ts`, `apps/api/src/assessment/{requirements.test.ts,view.test.ts}`
- **Success criteria:**
  - `[test] Both fields save on any status, audit only changed fields, and a repeat writes nothing — requirements.test.ts › planned and N/A fields`
  - `[test] A first write of only these fields creates the row with before null; the evaluation is unchanged — requirements.test.ts › fields don't change the score`
  - `[test] Every requirementState in the view and write responses has both keys, null when unset — view.test.ts › requirement fields always sent`
  - `[test] Both fields survive a restart — requirements.test.ts › persists across restart`
- **Depends on:** K3, D3
- **One-way door:** none
- **Model:** sonnet
