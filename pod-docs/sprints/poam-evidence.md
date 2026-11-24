# Sprint: POA&M, evidence and policies

_From plan: pod-docs/plans/cmmc-l2-grc.md · Slug: poam-evidence · Status: active · Generated: 2026-11-24_

<!-- autopilot-run: started=2026-11-23T22:30:00-08:00 sprints=2 waves=7 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | K2 | Contract for this sprint, plus the upload protocol on both ends | poam-evidence-k2 | — | pending | — | — |
| 1 | E1 | Evidence store, storage config and api wiring | poam-evidence-e1 | — | pending | — | — |
| 1 | D2 | DB: POA&M items, evidence, policies, links | poam-evidence-d2 | — | pending | — | — |
| 1 | R5 | Rules: cited `poamNotMetOnly` on `Regulation` | poam-evidence-r5 | — | pending | — | — |
| 1 | L3 | Look: Checkbox, FileField; mount the three page modules | poam-evidence-l3 | — | pending | — | — |
| 2 | A4 | POA&M API: eligibility, milestones, countdown, closeout | poam-evidence-a4 | — | pending | — | K2, E1, D2 |
| 2 | A5 | Evidence API: items, file versions, CUI references, objective links | poam-evidence-a5 | — | pending | — | K2, E1, D2 |
| 2 | A6 | Policies API: items, file versions, requirement links | poam-evidence-a6 | — | pending | — | K2, E1, D2 |
| 3 | W4 | POA&M page | poam-evidence-w4 | — | pending | — | K2, L3, A4 |
| 3 | W5 | Evidence page with the CUI banner | poam-evidence-w5 | — | pending | — | K2, L3, A5 |
| 3 | W6 | Policies page | poam-evidence-w6 | — | pending | — | K2, L3, A6 |

Plan branch `cmmc-l2-grc`; wave heads `poam-evidence-w1`, `poam-evidence-w2`, `poam-evidence-w3`. Merge target `main`.

## Shared contract

Everything in the foundation and assessment sprints' Shared contracts still holds (tooling, frozen types, error envelope, `respond()`, the auth guard and check order, `recordAudit` in the change's transaction, the Look contract, `createHarness()`), except where this section changes it.

### Run facts
- **No dependency changes.** Uploads are raw `application/octet-stream` bodies, so no multipart package is needed. Nobody touches `pnpm-lock.yaml`. If something is truly missing, add a `BLOCKED` entry to `orchestrator`.
- pnpm: `corepack enable` fails with EPERM here; use `corepack pnpm …` (`pod-docs/known-issues/corepack-enable-eperm.md`).
- **Ports** (3057–3156 are reserved by Windows): web/api per slice — K2 3200/3201, E1 3209/3210, D2 3218/3219, R5 3227/3228, L3 3236/3237, A4 3245/3246, A5 3254/3255, A6 3263/3264, W4 3272/3273, W5 3281/3282, W6 3290/3291.
- **Human PENDINGs, building on the values in use:** objective IDs `[a]` for the 23 single-statement requirements and the Rev 2 wording of 3.3.2 (the UI shows catalog IDs and text as-is); the selected Not met radio stays Ink; no confirm step on self-reset or self-deactivation. Nothing here hard-codes any of them.

### Contract change: `Regulation.poamNotMetOnly` (R5; folds in the R2 PENDING)
`packages/rules/src/types.ts` changes only its `Regulation` interface, to exactly this (the file stays in `.prettierignore`):
```ts
export interface Regulation { id: 'cmmc-32-cfr-170'; version: string; sources: { title: string; url: string }[];
  conditionalMinScore: Cited<number>; poamNotMetOnly: Cited<boolean>; poamMaxItemPoints: Cited<number>;
  poamPointExceptions: { requirementId: RequirementId; implementationLevel: ImplementationLevel; maxPoints: number; citation: string }[];
  poamBarred: Cited<RequirementId[]>; closeoutWindowDays: Cited<number>;
  closeoutConfirmedBy: Cited<Record<AssessmentType, 'organization' | 'c3pao'>> }
```
- `REGULATION.poamNotMetOnly = { value: true, citation: '32 CFR 170.24(c)(2)(i)(B)(6)' }`, and `REGULATION.version` becomes `'1.1.0'`.
- `checkPoamEligibility` takes the `not_not_met` citation from `regulation.poamNotMetOnly.citation`. When `value` is `false`, it never adds `not_not_met`.
- `POAM_NOT_MET_CITATION` is removed from `regulation.ts` and from `@rampart/rules/poam`; nothing outside the rules package uses it.
- **R2's tests and README follow the change:** `regulation.test.ts` and `eligibility.test.ts` read the citation from `REGULATION.poamNotMetOnly`, and the README rules table names `REGULATION.poamNotMetOnly` as the data for "Only Not Met requirements go on a POA&M".
- `evaluateAssessment`, `checkConditional` and the `Blocker` type don't change. The Conditional check still doesn't require a POA&M item per Not Met requirement; the POA&M view lists those requirements as `candidates` for the next sprint's dashboard to use.

### Error codes (K2 adds them to `contract/error.ts` and `ERROR_STATUS`)
| code | status | when |
|---|---|---|
| `poam_ineligible` | 409 | creating an item for a requirement that fails eligibility; `details: { reasons: [{ code, citation }] }` |
| `poam_item_exists` | 409 | an open item already exists for the requirement; `details: { itemId }` |
| `poam_item_closed` | 409 | an edit or closeout of a closed item |
| `closeout_not_ready` | 409 | closeout while the requirement isn't `met`; `details: { requirementStatus }` |
| `cui_file_refused` | 409 | a file upload to an evidence item flagged "contains CUI" |
| `evidence_not_cui` | 409 | a reference version on an item not flagged CUI |
| `unsupported_file_type` | 415 | the file name's extension isn't allowed; `details: { allowed: UPLOAD_EXTENSIONS }` |
| `file_integrity_failed` | 500 | a stored file is missing, or its bytes no longer match the recorded SHA-256. Message: "The stored file is missing or doesn't match its recorded SHA-256." It names no path. |

### Upload protocol (K2 defines it in `contract/files.ts`, plus the server and web helpers)
- `FILE_NAME_HEADER = 'x-file-name'`: the value is `encodeURIComponent(fileName)`.
- `UPLOAD_MAX_BYTES = 26_214_400` (25 MiB). Exactly that size is accepted; one byte more gives 413 `payload_too_large`.
- `UPLOAD_EXTENSIONS`: `.csv .doc .docx .gif .jpeg .jpg .json .log .md .pdf .png .ppt .pptx .txt .xls .xlsx .xml .zip`. Matched case-insensitively on the last extension only, so `a.pdf.exe` is refused and `REPORT.PDF` passes.
- `fileNameSchema`: trimmed, 1–255 characters, no `/`, `\` or control characters (U+0000–U+001F, U+007F), and not `.` or `..`.
- `sha256Schema`: `^[0-9a-f]{64}$`.
- `uploadProblem(fileName, size): 'invalid_file_name' | 'unsupported_file_type' | 'empty' | 'too_large' | null`, checked in that order. The web runs it before sending; the server runs the same checks.
- **Server** (`apps/api/src/uploads/`):
  - `registerUploadBodyParser(scope)` adds an `application/octet-stream` parser (`parseAs: 'buffer'`, `bodyLimit: UPLOAD_MAX_BYTES`). A5 and A6 each register their routes inside **their own child plugin** (`api.register(async (scope) => …)`) and call it there, so the guard's hooks still apply and the parser is never registered twice.
  - `readUpload(request)` returns `{ fileName, bytes }`. Failures: not a Buffer body → 415 `unsupported_media_type`, message "The request body must be application/octet-stream"; a missing or malformed header, or a bad name → 400 `validation_failed` with `path: ['x-file-name']`; a bad extension → 415 `unsupported_file_type`; 0 bytes → 400.
  - `sendFile(reply, bytes, fileName)` answers 200 with `content-type: application/octet-stream`, `content-disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<RFC 5987>`, `content-length` and `cache-control: no-store`. Helmet's `nosniff` and CSP still apply.
- **Web** (`apps/web/src/api/client.ts`): `apiUpload(path, file: Blob, fileName, schema)` POSTs the bytes with `content-type: application/octet-stream`, the name header and the CSRF token. It handles errors and 401s like `apiSend`. If `uploadProblem` finds a problem, it throws `ApiError` with status 0 and code `payload_too_large`, `unsupported_file_type` or `validation_failed`, and sends nothing.
- **Upload check order:** 401 → 403 `csrf_failed` (both in `onRequest`, before the body is read) → 413/415 from parsing → name, type and empty checks (400/415) → unknown item (404) → `cui_file_refused` (409). Nothing reaches the store unless every check passes.

### Evidence store (E1, `apps/api/storage/`)
```ts
export interface StoredFile { key: string; sha256: string; size: number }
export interface FileStore {
  put(bytes: Uint8Array): Promise<StoredFile>;              // key === sha256 (lowercase hex)
  get(key: string, sha256: string): Promise<Uint8Array>;    // rehashes and compares before returning
}
export class StorageError extends Error { constructor(readonly kind: 'missing' | 'integrity' | 'invalid_key', message: string) }
export function createLocalStore(root: string): FileStore;
export function createMemoryStore(): FileStore & { keys(): string[]; corrupt(key: string): void };
```
- **Content-addressed:** the key is the SHA-256, and the local file is `<root>/<first 2 hex>/<key>`. A key that doesn't match `^[0-9a-f]{64}$` throws `invalid_key` and touches no file, so a key can never leave the root.
- Writes go to a temp file under `<root>/tmp/` and are renamed into place, so a failed write leaves nothing at the key and no temp file stays behind. If the same bytes are stored twice, there is still one file. If a file already sits at the key but its hash is wrong, it is replaced.
- `get` throws `missing` when there is no file, and `integrity` when the bytes don't hash to `sha256`. The api maps both to 500 `file_integrity_failed`.
- A file written before its DB transaction rolls back is left in place. It's harmless because it's content-addressed, and V1 never deletes files.
- **Config:** `STORAGE_PATH` defaults to `data/files`, resolved against `apps/api` like `DATABASE_PATH`. An empty value means the default; a whitespace-only value is a `ConfigError` naming `STORAGE_PATH`. `Config.storagePath` is absolute, and the folder is created on the first write.
- **Wiring:** `buildApp({ store? })` defaults to `createLocalStore(config.storagePath)`, and `server.ts` passes one in. `ApiDeps` gains a required `store: FileStore`. `createHarness({ store? })` defaults to a memory store and exposes it as `harness.store`. The harness `Client` gains `upload(url, bytes, fileName | null, options?)`, which sends octet-stream with the encoded name header (`null` omits it) and the CSRF token. `RequestOptions` gains `rawBody`, for sending any bytes with any content type.
- E1 creates `registerPoamRoutes`, `registerEvidenceRoutes` and `registerPolicyRoutes` (in `apps/api/src/{poam,evidence,policies}/routes.ts`) with empty bodies and calls them from `registerApiRoutes`. A4, A5 and A6 each own one of these files.

### DB (D2, one migration `0003_poam_evidence`, additive only)
- **`poam_item`:**
  - `id` (UUID), `assessment_id` (FK), `requirement_id`
  - `status`: `'open'` or `'closed'`
  - `plan`, `due` (YYYY-MM-DD)
  - `milestones`: JSON text, not null, default `'[]'`
  - `owner_user_id` (FK, nullable)
  - `closed_on`, `closeout_note`, `confirmed_by` (`'organization'` or `'c3pao'`), `c3pao_name`, `closed_by` (FK)
  - `created_by`, `created_at`, `updated_by`, `updated_at`
  - Checks: `status = 'closed'` exactly when `closed_on`, `confirmed_by` and `closed_by` are set.
  - A partial unique index on (`assessment_id`, `requirement_id`) where `status = 'open'`.
- **`evidence_item`:** `id`, `assessment_id`, `title`, `description`, `contains_cui` (0 or 1, not null), `created_by`, `created_at`, `updated_by`, `updated_at`.
- **`evidence_version`:** primary key (`evidence_id`, `version`), `contains_cui`, `file_name`, `size`, `sha256`, `storage_key`, `reference_location`, `reference_note`, `created_by`, `created_at`.
  - Check: either `contains_cui = 0` with the four file columns set (`length(sha256) = 64`, `size >= 1`) and the reference columns null, or `contains_cui = 1` with the file columns null and `reference_location` set.
- **`evidence_link`:** primary key (`evidence_id`, `objective_id`), with an index on `objective_id`.
- **`policy`:** like `evidence_item`, without `contains_cui`.
- **`policy_version`:** primary key (`policy_id`, `version`), with `file_name`, `size`, `sha256` and `storage_key` all not null, plus `created_by` and `created_at`.
- **`policy_link`:** primary key (`policy_id`, `requirement_id`), with an index on `requirement_id`.
- No row is ever deleted by the api. Existing rows survive the migration.

### Contract schemas (K2, `apps/api/src/contract/`, zod only; all request schemas strict, `patch*` reject `{}`)
- **`evaluation.ts`** adds `ineligibleCodeSchema` (exported) and `eligibilityResultSchema`, which mirrors `EligibilityResult`; `contract-rules-types.test.ts` checks it against the rules type. It also adds `INELIGIBLE_REASON_LABELS`:
  - `not_not_met`: "Only Not Met requirements go on a POA&M"
  - `barred`: "This requirement can never go on a POA&M"
  - `exceeds_point_limit`: "Worth more than 1 point, so it can't go on a POA&M"
- **`poam.ts`:**
  - `milestoneSchema`: `{ title: trimmed 1–200, due: date, doneOn: date | null }`. `milestonesSchema` holds at most 20.
  - `poamItemSchema`:
    - stored fields: `{ id, requirementId, status: 'open' | 'closed', plan, due, milestones, owner: { id, displayName, active } | null, createdAt, createdBy: UserRef, updatedAt }`
    - `closeout: null | { closedOn, note, confirmedBy: 'organization' | 'c3pao', c3paoName: string | null, recordedBy: UserRef, late: boolean }`
    - derived at read time: `requirementStatus`, `eligibility`, `daysToDue: int`, `overdue`, `dueAfterDeadline`, `readyToClose`
  - `poamViewSchema`: `{ items, candidates: { requirementId, eligibility }[], closeout: CloseoutClock | null, confirmer: 'organization' | 'c3pao' }`
  - Requests:
    - `createPoamItemRequestSchema`: `{ requirementId, plan: trimmed 1–20,000, due, ownerId?: uuid | null, milestones? (default []) }`
    - `patchPoamItemRequestSchema`: `{ plan?, due?, ownerId?, milestones? }`
    - `closeoutRequestSchema`: `{ closedOn: date, note: noteSchema, c3paoName?: trimmed 1–200 | null }`
  - Response: `poamItemResponseSchema` = `{ item }`
- **`evidence.ts`:**
  - `evidenceVersionSchema`, discriminated on `kind`:
    - `file`: `{ version ≥ 1, fileName, size ≥ 1, sha256, createdAt, createdBy }`
    - `reference`: `{ version, location, note: string | null, createdAt, createdBy }`
  - `evidenceItemSchema`: `{ id, title, description: string | null, containsCui, objectiveIds (catalog order), versions (newest first), createdAt, createdBy, updatedAt }`
  - Read shapes: `evidenceListSchema` = `{ items }`, and `evidenceQuerySchema` = `{ objectiveId? }`
  - Write requests:
    - `createEvidenceRequestSchema`: `{ title: trimmed 1–200, description: noteSchema, containsCui: boolean, objectiveIds?: string[] ≤ 320 }`
    - `patchEvidenceRequestSchema`: `{ title?, description? }`. A `containsCui` key gives 400: the flag can't change after creation.
    - `putEvidenceObjectivesRequestSchema`: `{ objectiveIds: string[] ≤ 320 }`
    - `addReferenceRequestSchema`: `{ location: trimmed 1–1,000, note: noteSchema }`
  - Response: `evidenceItemResponseSchema` = `{ item }`
- **`policies.ts`:** the same shapes, with `requirementIds` (at most 110) in place of `objectiveIds`, no `containsCui`, and file-only versions: `{ version, fileName, size, sha256, createdAt, createdBy }`.
- **`audit.ts`:**
  - `AUDIT_ACTIONS` adds:
    - `poam_item.created`, `poam_item.updated`, `poam_item.closed`
    - `evidence.created`, `evidence.updated`, `evidence.links_updated`, `evidence.version_added`
    - `policy.created`, `policy.updated`, `policy.links_updated`, `policy.version_added`
  - `AUDIT_ENTITY_TYPES` adds `poam_item`, `evidence_item` and `policy`. The `entityId` is the row's UUID.

### Routes (A4, A5 and A6 build them; check order as before: 401 → 403 csrf → 403 role → 400 → 404 → 409)
| Route | Who | Success | Failures |
|---|---|---|---|
| `GET /api/poam` | signed in | `poamView` | — |
| `POST /api/poam` | signed in | 201 `{ item }` | 400, 404 unknown requirement, 409 `poam_ineligible` / `poam_item_exists` |
| `PATCH /api/poam/:id` | signed in | `{ item }` | 400, 404, 409 `poam_item_closed` |
| `POST /api/poam/:id/closeout` | admin | `{ item }` | 403, 400, 404, 409 `poam_item_closed` / `closeout_not_ready` |
| `GET /api/evidence[?objectiveId=]` | signed in | `{ items }` | 400 for an objective not in the catalog |
| `POST /api/evidence` | signed in | 201 `{ item }` | 400 (including unknown objective IDs) |
| `PATCH /api/evidence/:id` | signed in | `{ item }` | 400, 404 |
| `PUT /api/evidence/:id/objectives` | signed in | `{ item }` | 400, 404 |
| `POST /api/evidence/:id/versions` (octet-stream) | signed in | 201 `{ item }`, or 200 for an identical repeat | 400, 413, 415, 404, 409 `cui_file_refused` |
| `POST /api/evidence/:id/references` | signed in | 201 `{ item }` | 400, 404, 409 `evidence_not_cui` |
| `GET /api/evidence/:id/versions/:version/file` | signed in | the bytes (`sendFile`) | 404 (also for a reference version), 500 `file_integrity_failed` |
| `GET /api/policies[?requirementId=]`, `POST /api/policies`, `PATCH /api/policies/:id`, `PUT /api/policies/:id/requirements`, `POST /api/policies/:id/versions`, `GET /api/policies/:id/versions/:version/file` | signed in | as evidence | as evidence, without the CUI codes |

### POA&M rules and their edges (A4)
- **Today** is the UTC date of `deps.now()`. Eligibility always comes from `checkPoamEligibility(loadCatalog(), { requirementId, status, implementationLevel }, REGULATION)`, using the requirement's current status from `evaluateStored` and its stored level.
- **Create:** the requirement must exist in the catalog (404 otherwise) and be eligible (409 `poam_ineligible`, with every reason and its citation).
  - Only one **open** item per requirement (409 `poam_item_exists`). Once it's closed, a new item may be created if the requirement is Not Met again.
  - A past `due` is accepted, and the item is then overdue.
- **Milestones:** every milestone `due` must be on or before the item's `due`, checked against the merged result on create and patch (so moving the item's `due` earlier than a milestone gives 400). A `doneOn` after today gives 400. 21 milestones give 400. Order is kept as sent.
- **Owner:** the same rule as requirement owners. Must be an active user, or 400; `null` unassigns.
- **Edits** are allowed on open items even after the requirement turns Met or becomes ineligible. Closed items refuse every write with 409 `poam_item_closed`, including a second closeout.
- **Derived fields:**
  - `daysToDue` is `due − today`.
  - `overdue` is true only for an open item when today is after `due`. On the due day itself, `daysToDue` is 0 and the item isn't overdue.
  - `dueAfterDeadline` is true when a closeout deadline exists and `due` is after it. A `due` equal to the deadline gives false.
  - `readyToClose` is true when the item is open and the requirement is `met`.
  - `closeout.late` is true when a deadline exists and `closedOn` is after it.
- **Closeout** (admin only; a contributor gets 403):
  - The requirement must be `met` (409 `closeout_not_ready`).
  - `closedOn` must be no later than today and no earlier than the UTC date the item was created (400 otherwise).
  - `confirmedBy` is `closeoutConfirmer(assessment.type)`. A C3PAO assessment requires `c3paoName`; a self-assessment refuses one (400 either way).
  - A later change to the assessment type doesn't rewrite a recorded closeout.
- **View order:** open items by `due`, then catalog order; then closed items by `closedOn`, newest first. `candidates` lists every `not_met` requirement with no open item, in catalog order, each with its eligibility.
- **Audit `before` and `after`:**
  - `created`: after = `{requirementId, plan, due, ownerId, milestones}`
  - `updated`: the changed fields only
  - `closed`: before `{status: 'open'}`, after `{status: 'closed', closedOn, note, confirmedBy, c3paoName}`
  - A no-op patch writes nothing.

### Evidence and policy rules and their edges (A5 and A6)
- **Links:** every ID must be in the catalog (400 with the bad IDs in `details`). Duplicates collapse, and lists come back in catalog order. A `PUT` replaces the whole set, and the same set again writes nothing.
- **Versions:**
  - Numbered 1, 2, 3… per item.
  - Uploading bytes and a name identical to the newest version answers 200 with no new version and no audit event.
  - The same bytes under a new name make a new version, but the store still holds one file.
- **CUI:**
  - `containsCui` is fixed at creation.
  - A flagged item never holds a file. An upload gets 409 `cui_file_refused`, and the store and the DB are unchanged. The item records reference versions instead (where the file really lives, plus a note).
  - An item that isn't flagged refuses references with 409 `evidence_not_cui`.
- **Lists:** sorted by title (case-insensitive), then `createdAt`, then `id`.
- **Audit:**
  - `created`: after = all fields, including the link list.
  - `updated`: the changed fields only.
  - `links_updated`: `{objectiveIds}` or `{requirementIds}`, before and after.
  - `version_added`: before null; after is `{version, kind, fileName, size, sha256}` for a file, or `{version, kind, location, note}` for a reference.
  - File bytes are never logged or audited.

### Web contract
- **Pages:** L3 mounts `pages/poam/PoamPage.tsx`, `pages/evidence/EvidencePage.tsx` and `pages/policies/PoliciesPage.tsx` in `App.tsx` (W4, W5 and W6 fill them).
  - Each page renders its h1 at once, whatever the API answers.
  - While loading, it shows a muted "Loading…" line. On an error, it shows an error `Alert` with a Retry button.
- **Controls:** use only L1–L3 controls and tokens. Dates are `TextField` inputs validated with `calendarDateSchema` (as in Settings).
- **Manual checks:** each UI slice has `[manual]` checks at 1280 px and 375 px, with no horizontal scroll at 375 px. Every manual check runs against the real API, following the brief's Smoke recipe.
- **Downloads** are plain links to the `…/file` routes; the browser sends the session cookie.

## Per-slice detail

### K2: Contract for this sprint, plus the upload protocol on both ends
- **Scope:**
  - The error codes, upload protocol, schemas, audit actions and labels in the Shared contract.
  - `apps/api/src/uploads/` (`registerUploadBodyParser`, `readUpload`, `sendFile`).
  - The web's `apiUpload`.
  - Labels for every new audit action and entity type, so the audit log compiles.
  - Not: routes, the DB, or storage.
- **Files owned:**
  - api contract: `apps/api/src/contract/{error,files (new),evaluation,poam (new),evidence (new),policies (new),audit,index}.ts`, `apps/api/src/contract/{contract,schemas}.test.ts`, `apps/api/src/contract-rules-types.test.ts`
  - api uploads: `apps/api/src/uploads/upload.ts (new)`, `apps/api/src/uploads/upload.test.ts (new)`
  - web: `apps/web/src/api/client.ts`, `apps/web/src/api/client.test.ts`, `apps/web/src/pages/settings/auditLabels.ts`, `apps/web/src/pages/settings/AuditLog.test.tsx`
- **Success criteria:**
  - `[test] every new code maps to its status and the full code list matches — apps/api/src/contract/schemas.test.ts › error codes and statuses`
  - `[test] uploadProblem: valid, a/b.pdf, ".", "..", a control character, 256 chars, a.pdf.exe, REPORT.PDF, no extension, 0 bytes, max, max+1 — apps/api/src/contract/schemas.test.ts › uploadProblem edges`
  - `[test] POA&M schemas: 20 milestones pass and 21 fail, a whitespace-only plan fails, a patch of {} fails, an unknown key fails, c3paoName null passes — apps/api/src/contract/schemas.test.ts › poam requests`
  - `[test] evidence and policy schemas: a containsCui key in a patch fails, 321 objective IDs fail, an oversize title fails, and a version kind outside the union fails — apps/api/src/contract/schemas.test.ts › evidence and policy requests`
  - `[test] eligibilityResultSchema infers exactly EligibilityResult — apps/api/src/contract-rules-types.test.ts › eligibility mirror`
  - `[test] readUpload accepts a Buffer with a good name, and gives 415 for a JSON body, 400 for a missing or malformed header, 415 unsupported_file_type with allowed for .exe, and 400 for 0 bytes; exactly 25 MiB passes and 25 MiB + 1 gives 413 — apps/api/src/uploads/upload.test.ts › readUpload`
  - `[test] sendFile sets an attachment with an RFC 5987 name for "Política 1.pdf", plus octet-stream, content-length and no-store — apps/api/src/uploads/upload.test.ts › sendFile headers`
  - `[test] apiUpload sends octet-stream, the encoded name and CSRF; parses the response; maps the error envelope; calls onUnauthenticated on 401 — apps/web/src/api/client.test.ts › apiUpload`
  - `[test] apiUpload refuses a too-large, empty or .exe file without calling fetch — apps/web/src/api/client.test.ts › apiUpload pre-checks`
  - `[test] every audit action and entity type has a non-empty label — apps/web/src/pages/settings/AuditLog.test.tsx › labels cover the contract`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### E1: Evidence store, storage config and api wiring
- **Scope:**
  - `apps/api/storage/` as the Shared contract states: interface, local store and memory store.
  - `STORAGE_PATH` config; the `buildApp` and `server` wiring and `ApiDeps.store`; harness `store`, `upload()` and `rawBody`.
  - The three empty route-registration files.
  - The root README's environment section.
  - Not: any route behaviour.
- **Files owned:**
  - storage: `apps/api/storage/{index,local,memory}.ts (new)`, `apps/api/storage/store.test.ts (new)`
  - config and wiring: `apps/api/src/config.ts`, `apps/api/src/config.test.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/src/routes/index.ts`, `apps/api/tsconfig.json`
  - test harness: `apps/api/src/testing/harness.ts`, `apps/api/src/testing/harness.test.ts (new)`
  - route stubs: `apps/api/src/{poam,evidence,policies}/routes.ts (new)`
  - docs: `README.md`
- **Success criteria:**
  - `[test] put("abc") gives key and sha256 ba7816bf…15ad (the full NIST vector), size 3, and get returns the same bytes, for both stores — apps/api/storage/store.test.ts › round trip`
  - `[test] the same bytes put twice give one key, and the local root holds one file and no temp files — apps/api/storage/store.test.ts › content-addressed and atomic`
  - `[test] a tampered file gives integrity; a deleted file gives missing; a wrong expected sha256 gives integrity — apps/api/storage/store.test.ts › integrity`
  - `[test] keys like ../x, an upper-case hex key and 63 characters give invalid_key and touch nothing outside the root — apps/api/storage/store.test.ts › key validation`
  - `[test] the local store creates a missing root, including a path with spaces — apps/api/storage/store.test.ts › creates its root`
  - `[test] STORAGE_PATH defaults to apps/api/data/files; a relative value resolves against apps/api; an empty value gives the default; a whitespace-only value throws ConfigError naming STORAGE_PATH — apps/api/src/config.test.ts › storage path`
  - `[test] client.upload sends the bytes as octet-stream with the encoded name and CSRF, and null omits the header — apps/api/src/testing/harness.test.ts › upload`
  - `[test] the harness exposes a memory store that starts empty — apps/api/src/testing/harness.test.ts › store`
  - `[manual] the built api starts with STORAGE_PATH set to a scratch folder, and /api/health answers ok — curl on 127.0.0.1:3210`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### D2: DB: POA&M items, evidence, policies, links
- **Scope:** add the seven tables, checks and indexes from the Shared contract to `schema.ts`, and generate `0003_poam_evidence` with drizzle-kit. Additive only; no existing table changes. Not: repositories.
- **Files owned:** `apps/api/db/schema.ts`, `apps/api/db/migrations/0003_poam_evidence.sql (new)`, `apps/api/db/migrations/meta/0003_snapshot.json (new)`, `apps/api/db/migrations/meta/_journal.json`, `apps/api/db/db.test.ts`
- **Success criteria:**
  - `[test] the table list now includes the seven new tables, and a second migrate run is a no-op — apps/api/db/db.test.ts › migrations and constraints`
  - `[test] a DB at 0002 with users, results and audit rows upgrades to 0003 and keeps every row — apps/api/db/db.test.ts › upgrade keeps assessment data`
  - `[test] a second open item for the same requirement fails; an open and a closed one coexist — apps/api/db/db.test.ts › one open POA&M item per requirement`
  - `[test] a closed item without closed_on, confirmed_by or closed_by fails, and an open item with closed_on fails — apps/api/db/db.test.ts › poam closeout columns`
  - `[test] a CUI version with a sha256 fails; a file version without one fails; a 63-character sha256 fails; size 0 fails — apps/api/db/db.test.ts › evidence version kinds`
  - `[test] a version or link for a missing evidence item or policy fails its foreign key — apps/api/db/db.test.ts › foreign keys`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### R5: Rules: cited `poamNotMetOnly` on `Regulation`
- **Scope:** the contract change above. Eligibility reads the citation from the data, `POAM_NOT_MET_CITATION` is removed, the version becomes 1.1.0, and R2's tests and the README follow. Not: conditional or score changes.
- **Files owned:** `packages/rules/src/types.ts`, `packages/rules/src/poam/{regulation,eligibility,index}.ts`, `packages/rules/src/poam/{regulation,eligibility}.test.ts`, `packages/rules/README.md`
- **Success criteria:**
  - `[test] REGULATION.poamNotMetOnly is { value: true, citation: '32 CFR 170.24(c)(2)(i)(B)(6)' }, the version is 1.1.0, and the field is frozen — packages/rules/src/poam/regulation.test.ts › values are cited data`
  - `[test] a met or not_assessed candidate gets not_not_met with the citation from REGULATION.poamNotMetOnly — packages/rules/src/poam/eligibility.test.ts › not met only`
  - `[test] with poamNotMetOnly.value false, a met candidate gets no not_not_met reason, and the other reasons still apply — packages/rules/src/poam/eligibility.test.ts › not-met-only rule switched off`
  - `[test] @rampart/rules/poam no longer exports POAM_NOT_MET_CITATION — packages/rules/src/poam/regulation.test.ts › exports`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### L3: Look: Checkbox, FileField; mount the three page modules
- **Scope:**
  - `Checkbox`: a square box with a 1.5 px Ink border; when checked, it fills Ink with a Sheet mark. The native input is visually hidden. It takes a `description`.
  - `FileField`: a label, a hidden native file input, a square "Choose file" button, and the chosen name in mono (or "No file chosen"). Props: `accept`, `error`, `disabled`, `onFileChange(file | null)`, `reset`. It clears after a choice, so the same file can be picked again.
  - Add both to the specimen.
  - Mount the three page modules (each renders `PlaceholderPage` for now).
  - Change `Shell.test.tsx` so it expects the empty-state text only on `/` and `/ssp`.
- **Files owned:**
  - look: `apps/web/src/look/{Checkbox,FileField}.tsx (new)`, `apps/web/src/look/{Checkbox,FileField}.module.css (new)`, `apps/web/src/look/files.test.tsx (new)`, `apps/web/src/look/{index,Specimen}.tsx`
  - pages: `apps/web/src/App.tsx`, `apps/web/src/pages/poam/PoamPage.tsx (new)`, `apps/web/src/pages/evidence/EvidencePage.tsx (new)`, `apps/web/src/pages/policies/PoliciesPage.tsx (new)`
  - shell tests: `apps/web/src/shell/Shell.test.tsx`
  - look guard: `apps/web/src/look/guards.test.ts` (it already scans new files; no edit is expected)
- **Success criteria:**
  - `[test] Checkbox is labelled and described; a click and Space each toggle and call onChange once; disabled ignores both — apps/web/src/look/files.test.tsx › Checkbox`
  - `[test] FileField shows "No file chosen", then the chosen name; calls onFileChange with the file; passes accept through; the error sets aria-invalid and the message; choosing the same file twice fires twice — apps/web/src/look/files.test.tsx › FileField`
  - `[test] the new CSS uses only tokens and the font-size variables — apps/web/src/look/guards.test.ts › only tokens and self-hosted fonts`
  - `[test] every nav route renders its h1 and title; only / and /ssp show the empty-state text — apps/web/src/shell/Shell.test.tsx › routes and titles`
  - `[manual] /look.html at 1280 and 375 px: Checkbox (unchecked, checked, focus, disabled) and FileField (empty, chosen, error) match C · Inspection, with no horizontal scroll`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### A4: POA&M API: eligibility, milestones, countdown, closeout
- **Scope:** the four POA&M routes and every rule under "POA&M rules and their edges", with a repository in the assessment pattern: routes are glue, and each write and its audit event share one transaction. It reuses `actorOf`-style actors, `findActiveAssessment` and `evaluateStored`. Not: the Conditional check.
- **Files owned:** `apps/api/src/poam/routes.ts`, `apps/api/src/poam/repository.ts (new)`, `apps/api/src/poam/{view,create,update,closeout}.test.ts (new)`
- **Success criteria:**
  - `[test] candidates list each Not Met requirement with no open item, in catalog order; 3.1.20 shows barred with 32 CFR 170.21(a)(2)(iii); closeout is null without a CSD; confirmer follows the type — apps/api/src/poam/view.test.ts › candidates and clock`
  - `[test] create gives 201 and a poam_item.created event; a met requirement gives 409 not_not_met citing 170.24(c)(2)(i)(B)(6); a barred one, and a 3-point one, give 409; an unknown requirement gives 404 — apps/api/src/poam/create.test.ts › eligibility enforced`
  - `[test] 3.13.11 Not Met at partial is accepted; at none or unset, it gives 409 exceeds_point_limit — apps/api/src/poam/create.test.ts › 3.13.11 exception`
  - `[test] a second open item gives 409 poam_item_exists with itemId; after closeout and a return to Not Met, a new item is accepted — apps/api/src/poam/create.test.ts › one open item`
  - `[test] a milestone due after the item's due, a doneOn after today, an inactive owner, and a patch moving due before a milestone each give 400 and write nothing — apps/api/src/poam/update.test.ts › milestone and owner edges`
  - `[test] a patch audits only the changed fields; an identical patch writes no event; a closed item gives 409 poam_item_closed — apps/api/src/poam/update.test.ts › edits`
  - `[test] daysToDue and overdue at due − 1, due and due + 1; dueAfterDeadline at the deadline (false) and the deadline + 1 (true); eligibility recomputed after a 3.13.11 level change — apps/api/src/poam/view.test.ts › derived fields`
  - `[test] closeout: a contributor gets 403; a not-met requirement gets 409 closeout_not_ready; a future or pre-creation closedOn gets 400; self with a c3paoName and c3pao without one get 400 — apps/api/src/poam/closeout.test.ts › refusals`
  - `[test] closeout succeeds with confirmedBy per type and a poam_item.closed event; a repeat gets 409; closedOn after the deadline sets late — apps/api/src/poam/closeout.test.ts › records closeout`
  - `[test] no session gives 401 and a write without CSRF gives 403, both with nothing written — apps/api/src/poam/create.test.ts › guarded`
- **Depends on:** K2, E1, D2
- **One-way door:** none
- **Model:** opus

### A5: Evidence API: items, file versions, CUI references, objective links
- **Scope:** the evidence routes and every evidence rule and edge. Routes live in their own child plugin with `registerUploadBodyParser`. Files go to `deps.store`, and downloads use `store.get` plus `sendFile`; `StorageError` maps to `file_integrity_failed`. Not: policies.
- **Files owned:** `apps/api/src/evidence/routes.ts`, `apps/api/src/evidence/repository.ts (new)`, `apps/api/src/evidence/{items,versions,download}.test.ts (new)`
- **Success criteria:**
  - `[test] create, list sorted by title, filter by objectiveId, and an unknown filter ID gives 400 — apps/api/src/evidence/items.test.ts › create and list`
  - `[test] unknown objective IDs give 400 with them in details; duplicates collapse; the order is catalog order; a PUT of the same set writes no event — apps/api/src/evidence/items.test.ts › objective links`
  - `[test] a patch with containsCui gives 400; a title change audits only that field — apps/api/src/evidence/items.test.ts › patch`
  - `[test] uploads give versions 1 and 2, newest first, with sha256 matching the bytes; the same bytes and name give 200 and no event; the same bytes under a new name give a new version but one stored file — apps/api/src/evidence/versions.test.ts › file versions`
  - `[test] an upload to a CUI item gives 409 cui_file_refused, the memory store stays empty, and no version row exists — apps/api/src/evidence/versions.test.ts › CUI refuses a file`
  - `[test] a reference on a CUI item makes a reference version; on a plain item, it gives 409 evidence_not_cui — apps/api/src/evidence/versions.test.ts › references`
  - `[test] exactly 25 MiB gives 201; 25 MiB + 1 gives 413; empty gives 400; .exe gives 415 unsupported_file_type; a JSON body gives 415; a missing name gives 400; and an upload without CSRF gives 403 with nothing stored — apps/api/src/evidence/versions.test.ts › upload limits`
  - `[test] version_added carries {version, kind, fileName, size, sha256}, and no event holds file bytes — apps/api/src/evidence/versions.test.ts › audit`
  - `[test] download returns the exact bytes with attachment headers; a reference or unknown version gives 404; a corrupted stored file gives 500 file_integrity_failed — apps/api/src/evidence/download.test.ts › download`
- **Depends on:** K2, E1, D2
- **One-way door:** none
- **Model:** opus

### A6: Policies API: items, file versions, requirement links
- **Scope:** the policy routes, mirroring A5 without CUI, with requirement links. Use its own child plugin. Not: evidence.
- **Files owned:** `apps/api/src/policies/routes.ts`, `apps/api/src/policies/repository.ts (new)`, `apps/api/src/policies/{items,versions}.test.ts (new)`
- **Success criteria:**
  - `[test] create, list sorted by title, filter by requirementId, and an unknown filter ID gives 400 — apps/api/src/policies/items.test.ts › create and list`
  - `[test] unknown requirement IDs give 400; duplicates collapse; the order is catalog order; the same set writes no event; a change gives links_updated with before and after — apps/api/src/policies/items.test.ts › requirement links`
  - `[test] uploads make versions newest first with matching sha256; an identical repeat gives 200 with no event; 25 MiB + 1 gives 413; .exe gives 415 — apps/api/src/policies/versions.test.ts › file versions`
  - `[test] download returns the exact bytes; a corrupted stored file gives 500 file_integrity_failed; an unknown version gives 404 — apps/api/src/policies/versions.test.ts › download`
  - `[test] a contributor can create, upload and link, and every change writes its policy.* event — apps/api/src/policies/items.test.ts › contributor writes and audit`
- **Depends on:** K2, E1, D2
- **One-way door:** none
- **Model:** opus

### W4: POA&M page
- **Scope:** `PoamPage` covers:
  - the closeout clock (the deadline and days left, or "Set the Conditional Status Date in Settings to start the 180-day clock"), with the confirmer label
  - candidates: an enabled "Add to POA&M" for eligible requirements, and a disabled button for the rest, with `INELIGIBLE_REASON_LABELS` and the citation
  - an item form (plan, due, owner, milestones editor)
  - the item list with due text ("Due today", "N days left", "Overdue by N days") and flags ("Due after the closeout deadline", "No longer eligible", "Ready for closeout")
  - an admin-only closeout form, with a required C3PAO name field for C3PAO assessments
- **Files owned:** `apps/web/src/pages/poam/PoamPage.tsx`, `apps/web/src/pages/poam/{PoamItem,PoamForm,MilestonesEditor,CloseoutForm}.tsx (new)`, `apps/web/src/pages/poam/{usePoam.ts,poam.module.css} (new)`, `apps/web/src/pages/poam/{list,form,closeout}.test.tsx (new)`
- **Success criteria:**
  - `[test] the clock text with no CSD, with 180 days left, and when expired ("passed N days ago"); due text at −1, 0 and +3 days — apps/web/src/pages/poam/list.test.tsx › countdowns`
  - `[test] a barred 3.1.20 candidate shows a disabled Add with its reason and citation; an eligible one opens the form preselected — apps/web/src/pages/poam/list.test.tsx › candidates`
  - `[test] an empty plan, a malformed due or a milestone after the due sends nothing; a valid form sends the exact body once on a double click; a 409 poam_ineligible shows the reasons — apps/web/src/pages/poam/form.test.tsx › create`
  - `[test] closeout is hidden for contributors and disabled unless readyToClose; the C3PAO name shows and is required only for c3pao; the confirmer label follows the type — apps/web/src/pages/poam/closeout.test.tsx › closeout`
  - `[manual] at 1280 and 375 px against the real API: mark 3.1.20 Not Met and see Add disabled with the barred reason; add a 1-point item with two milestones; set a CSD and see the countdown; close it as admin`
- **Depends on:** K2, L3, A4
- **One-way door:** none
- **Model:** sonnet

### W5: Evidence page with the CUI banner
- **Scope:** `EvidencePage` covers:
  - an always-visible info `Alert`: "Don't upload CUI. Rampart V1 isn't approved to store CUI. Mark CUI evidence as Contains CUI and record where the file lives."
  - creating an item, with a Contains CUI `Checkbox` noting it can't be changed later
  - the list: title, CUI flag, linked objective count, and the latest version's name, size and full SHA-256 in mono (or its reference location)
  - item detail: versions with download links; a `FileField` upload for plain items; for CUI items, no file picker but a "Record where it lives" form
  - an objective link editor: pick a requirement, tick its objectives, save the full set
- **Files owned:** `apps/web/src/pages/evidence/EvidencePage.tsx`, `apps/web/src/pages/evidence/{EvidenceItem,EvidenceForm,ObjectiveLinks}.tsx (new)`, `apps/web/src/pages/evidence/{useEvidence.ts,evidence.module.css} (new)`, `apps/web/src/pages/evidence/{list,upload,links}.test.tsx (new)`
- **Success criteria:**
  - `[test] the CUI banner shows on load, on error and with items; the list shows the full SHA-256 of the latest version — apps/web/src/pages/evidence/list.test.tsx › banner and list`
  - `[test] a create sends {title, description, containsCui, objectiveIds} once — apps/web/src/pages/evidence/list.test.tsx › create`
  - `[test] a .exe or a file over 25 MiB shows the reason and sends nothing; a good upload shows the new version; a 409 cui_file_refused shows its message — apps/web/src/pages/evidence/upload.test.tsx › upload`
  - `[test] a CUI item renders no file input and saves a reference with location and note — apps/web/src/pages/evidence/upload.test.tsx › CUI reference`
  - `[test] ticking objectives under a requirement and saving PUTs the full set, keeping links under other requirements — apps/web/src/pages/evidence/links.test.tsx › objective links`
  - `[manual] at 1280 and 375 px against the real API: upload a PDF and compare the shown SHA-256 with the output of certutil -hashfile on the same file; create a CUI item and see that no file can be chosen; the download opens the same file`
- **Depends on:** K2, L3, A5
- **One-way door:** none
- **Model:** sonnet

### W6: Policies page
- **Scope:** `PoliciesPage` covers:
  - creating a policy
  - a list with the latest version's name, size and SHA-256
  - uploading versions with `FileField`, and download links
  - a requirement link editor: pick a family, tick its requirements, save the full set
  - It shows the same CUI banner text as W5.
- **Files owned:** `apps/web/src/pages/policies/PoliciesPage.tsx`, `apps/web/src/pages/policies/{PolicyItem,PolicyForm,RequirementLinks}.tsx (new)`, `apps/web/src/pages/policies/{usePolicies.ts,policies.module.css} (new)`, `apps/web/src/pages/policies/{list,links}.test.tsx (new)`
- **Success criteria:**
  - `[test] the list shows the latest version and its SHA-256; a create sends its body once; an empty title sends nothing — apps/web/src/pages/policies/list.test.tsx › list and create`
  - `[test] an unsupported or oversize file shows the reason and sends nothing; a good upload adds a version — apps/web/src/pages/policies/list.test.tsx › upload`
  - `[test] ticking requirements in a family and saving PUTs the full set, keeping other families' links — apps/web/src/pages/policies/links.test.tsx › requirement links`
  - `[manual] at 1280 and 375 px against the real API: upload a policy .docx, link it to AC.L2-3.1.1, reload, and see both persist`
- **Depends on:** K2, L3, A6
- **One-way door:** none
- **Model:** sonnet
