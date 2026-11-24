# Sprint: Assessment

_From plan: pod-docs/plans/cmmc-l2-grc.md · Slug: assessment · Status: active · Generated: 2026-11-23_

<!-- autopilot-run: started=2026-11-23T22:30:00-08:00 sprints=1 waves=6 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | D1 | DB: users, sessions, audit, objective results, requirement state | assessment-d1 | merged | done | medium | — |
| 1 | K1 | API contract for this sprint, plus client-error mapping | assessment-k1 | merged | done | medium | — |
| 1 | R4 | Rules: evaluateAssessment and what-if helpers | assessment-r4 | merged | done | high | — |
| 1 | L2 | Look: TextArea, Select, RadioGroup, Alert | assessment-l2 | merged | done | medium | — |
| 2 | A2 | Auth API: setup, sign-in, sessions, CSRF, roles, users, audit read | assessment-a2 | merged | done | medium | D1, K1 |
| 2 | W1 | Web auth: session gate, setup, sign-in, user slot, users panel | assessment-w1-auth | merged | done | medium | K1, L2 |
| 2 | S2 | Web score panel and what-if state | assessment-s2 | merged | done | medium | K1, R4, L2 |
| 3 | A3 | Assessment API: view, objective results, requirement state, settings | assessment-a3 | — | pending | — | D1, K1, R4, A2 |
| 3 | W2 | Assessment workspace UI with live and what-if score | assessment-w2 | — | pending | — | K1, R4, L2, W1, S2 |
| 3 | W3 | Settings UI: assessment type, Conditional Status Date, audit log | assessment-w3 | — | pending | — | K1, L2, W1 |

Plan branch `cmmc-l2-grc`; wave heads `assessment-w1`, `assessment-w2`, `assessment-w3`. Merge target `main`.

## Shared contract

Everything in the foundation sprint's Shared contract still holds (tooling, frozen rules and catalog types, error envelope, `respond()`, Look contract), except where this section changes it.

### Queue items folded in
- **R1 (objective status validation):** the API accepts objective status only through `objectiveStatusSchema` = exactly `met | not_met | na | not_assessed` (K1 defines, A3 enforces).
- **A1 (client-error mapping):** K1 adds `unsupported_media_type` (415) and makes unknown routes answer 404 whatever the body.
- **R2 (`poamNotMetOnly` on `Regulation`):** deferred to the poam-evidence sprint, which wires eligibility to POA&M items. This sprint doesn't touch `Regulation` or `packages/rules/src/types.ts`.
- **C1 human PENDINGs:** build on the values in use: the 23 single-statement requirements have objective `[a]` (e.g. `3.4.4[a]`), and 3.3.2 keeps the Rev 2 wording. Nothing in this sprint hard-codes either; the UI shows catalog IDs and text as-is.

### Dependencies (the lockfile opens for A2 only)
A2 adds exactly `@node-rs/argon2` (prebuilt napi binaries, no node-gyp) and `@fastify/cookie` to `apps/api` dependencies, and commits `pnpm-lock.yaml`. Use the corepack workaround in `pod-docs/known-issues/corepack-enable-eperm.md`. If either needs a build script or fails to install on Windows, add a `BLOCKED` queue entry to `orchestrator`. Don't switch packages. No other slice changes dependencies.

### Error codes (K1 adds to `contract/error.ts`; `ERROR_STATUS` maps each one)
| code | status | when |
|---|---|---|
| `unauthenticated` | 401 | there's no valid session on a protected route |
| `invalid_credentials` | 401 | sign-in with a wrong password, an unknown email or an inactive user (one message for all: "Email or password is incorrect.") |
| `forbidden` | 403 | the role isn't allowed |
| `csrf_failed` | 403 | the CSRF header is missing or wrong |
| `setup_complete` | 409 | setup is called after a user exists |
| `email_taken` | 409 | the email is already used (case-insensitive) |
| `last_admin` | 409 | the change would leave no active admin |
| `unsupported_media_type` | 415 | the body is not `application/json` |
| `too_many_attempts` | 429 | the account is locked; `details: { retryAfterSeconds: int ≥ 1 }` plus a `Retry-After` header |

- **Unknown route:** it always answers 404 `not_found`, even with malformed JSON, an oversize body or a non-JSON content type. Check `request.is404` in an `onRequest` hook, before the body is parsed.
- **Body parsing:** only `application/json` is parsed. Fastify's default `text/plain` parser is removed, so a cross-site form post can't reach a handler.

### Contract schemas (K1, under `apps/api/src/contract/`, zod only)
- **`common.ts`:**
  - Enums: `objectiveStatusSchema`; `requirementStatusSchema` (`met | not_met | not_assessed`); `implementationLevelSchema` (`none | partial`); `assessmentTypeSchema` (`self | c3pao`); `roleSchema` (`admin | contributor`).
  - `calendarDateSchema`: `YYYY-MM-DD` and a real calendar date, so `2028-02-29` passes and `2027-02-29`, `2026-02-30`, `2026-2-3` and `11/23/2026` fail.
  - `emailSchema`: trimmed, lowercased, email format, at most 254 characters.
  - `passwordSchema`: 12 to 128 characters, not trimmed.
  - `displayNameSchema`: trimmed, 1 to 80 characters.
  - `noteSchema`: nullable. It trims; empty or whitespace-only becomes `null`; at most 4,000 characters after trimming.
  - `implementationStatementSchema`: the same rules, at most 20,000 characters.
  - `userRefSchema`: `{ id, displayName }`.
  - `SESSION_COOKIE = 'rampart_session'`, `CSRF_HEADER = 'x-csrf-token'`.
- **`auth.ts`:**
  - `sessionUserSchema`: `{ id, email, displayName, role }`.
  - `sessionResponseSchema`: `{ setupRequired: boolean, user: SessionUser | null, csrfToken: string | null }`.
  - `setupRequestSchema`: `{ email, displayName, password }`.
  - `signInRequestSchema`: `{ email: trimmed and lowercased string, 1–254, with no format check; password: 1–128 }`.
- **`users.ts`:**
  - `userSchema`: `{ id, email, displayName, role, active: boolean, createdAt }`.
  - `usersResponseSchema`: `{ users }`, and `userResponseSchema`: `{ user }`.
  - `createUserRequestSchema`: `{ email, displayName, role, password }`.
  - `updateUserRequestSchema`: `{ displayName?, role?, active?, password? }`, with at least one key.
- **`audit.ts`:**
  - `AUDIT_ACTIONS`: `user.created`, `user.updated`, `user.password_reset`, `auth.signed_in`, `auth.signed_out`, `auth.locked_out`, `assessment.created`, `assessment.updated`, `objective_result.updated`, `requirement_state.updated`.
  - `AUDIT_ENTITY_TYPES`: `user`, `assessment`, `objective_result`, `requirement_state`.
  - `auditEventSchema`: `{ id: int, at: ISO timestamp, actor: UserRef | null, action, entityType, entityId, before: unknown | null, after: unknown | null, requestId: string | null }`.
  - `auditQuerySchema` (query strings are coerced): `limit` is an integer from 1 to 200, default 50; `before` is an integer ≥ 1 and optional; `entityType` is optional; `entityId` is 1–64 characters and optional.
  - `auditPageSchema`: `{ events, nextBefore: int | null }`.
- **`evaluation.ts`:** zod mirrors of the frozen rules types `RequirementOutcome`, `ScoreResult`, `Blocker`, `ConditionalResult` and `CloseoutClock`. Also `evaluationSchema` = `{ outcomes, score, conditional }`.
- **`assessment.ts`:**
  - `assessmentSchema`: `{ id, type, conditionalStatusDate: date | null, catalogVersion, updatedAt }`.
  - `objectiveResultSchema`: `{ objectiveId, status, note: string | null, updatedAt, updatedBy: UserRef }`.
  - `requirementStateSchema`: `{ requirementId, implementationLevel: level | null, implementationStatement: string | null, owner: { id, displayName, active } | null, updatedAt }`.
  - `assessmentViewSchema`: `{ assessment, objectiveResults, requirementStates, evaluation, closeout: CloseoutClock | null }`. The two lists are in catalog order and hold only the rows that exist; a missing row means not assessed, or empty.
  - `updateAssessmentRequestSchema`: `{ type?, conditionalStatusDate?: date | null }`.
  - `putObjectiveResultRequestSchema`: `{ status, note }`. Both keys are required, and `note` may be `null`.
  - `objectiveWriteResponseSchema`: `{ objectiveResult, evaluation }`.
  - `patchRequirementRequestSchema`: `{ implementationStatement?, implementationLevel?: level | null, ownerId?: uuid | null }`.
  - `requirementWriteResponseSchema`: `{ requirementState, evaluation }`.
  - `ASSESSMENT_TYPE_LABELS = { self: 'Self-assessment', c3pao: 'C3PAO certification assessment' }`.
  - `CLOSEOUT_CONFIRMER_LABELS = { organization: 'Your organization', c3pao: 'An authorized C3PAO' }`.
- **Request schemas are all strict:** an unknown key gives 400. The `update*` and `patch*` schemas reject `{}`.

### Routes (A2 builds auth, users and audit; A3 builds assessment)
| Route | Who | CSRF | Success | Failures |
|---|---|---|---|---|
| `GET /api/session` | public | — | 200 `sessionResponse` | — |
| `POST /api/setup` | public, JSON | — | 201 `sessionResponse` and the cookie | 409 `setup_complete` |
| `POST /api/session` (sign in) | public, JSON | — | 200 `sessionResponse` and the cookie | 401 `invalid_credentials`, 429 |
| `DELETE /api/session` (sign out) | any | yes if there's a session | 204, clears the cookie | — |
| `GET /api/users` | signed in | — | `usersResponse`, sorted by displayName then email | — |
| `POST /api/users` | admin | yes | 201 `userResponse` | 409 `email_taken` |
| `PATCH /api/users/:id` | admin | yes | `userResponse` | 404, 409 `last_admin` |
| `GET /api/audit` | signed in | — | `auditPage`, newest first (id desc) | 400 |
| `GET /api/assessment` | signed in | — | `assessmentView` | 404 when there's no assessment row |
| `PATCH /api/assessment` | admin | yes | `assessmentView` | 403 for a contributor |
| `PUT /api/assessment/objectives/:objectiveId` | signed in | yes | `objectiveWriteResponse` | 404 for an unknown objective. The ID arrives URL-encoded (`3.1.1%5Ba%5D`) |
| `PATCH /api/assessment/requirements/:requirementId` | signed in | yes | `requirementWriteResponse` | 404 for an unknown requirement |

- **Check order:** session (401) → CSRF (403 `csrf_failed`) → role (403 `forbidden`) → body (400) → existence (404).
- **The guard is deny-by-default:** A2's `registerApiRoutes(app, deps)` (`apps/api/src/routes/index.ts`) registers an encapsulated plugin. Its `onRequest` hook requires a session for every route inside it unless the route sets `config: { public: true }`. Health and test-only routes registered on the root stay unguarded.
- **The active assessment** is the `assessment` row with the earliest `created_at`.
- **`buildApp` options** gain `now?: () => Date`, with a default of the real clock (A2). Every expiry, lockout, audit `at` and "today" value comes from it. "Today" is the UTC date of `now()`.

### Auth rules and their edges (A2)
- **Passwords:** Argon2id through `@node-rs/argon2` with its defaults, so hashes start with `$argon2id$`. A sign-in with an unknown email still verifies against a fixed dummy hash, so the timing doesn't reveal which emails exist. Passwords and hashes never appear in a response, a log line or an audit event.
- **Session token:**
  - 32 random bytes, base64url, sent as cookie `rampart_session`: `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`.
  - No `Secure` flag, because V1 serves plain http on 127.0.0.1; the hosting plan adds it.
  - The DB stores only the token's SHA-256 hex, as `session.id`.
  - Sign-in and setup always make a new session, and the old cookie's session is deleted (no fixation).
- **Expiry:**
  - Idle limit: 2 h after `last_seen_at`, which every authenticated request updates.
  - Absolute limit: 12 h after `created_at`.
  - A session expires at exactly the limit: 1:59:59 idle passes, 2:00:00 fails.
  - An expired session is deleted and gives 401.
  - A user deactivated or given a new password loses all their sessions at once. A role change applies on their next request.
- **CSRF:**
  - Each session has its own random token, returned as `csrfToken`.
  - `POST`, `PUT`, `PATCH` and `DELETE` on a session route need `x-csrf-token` equal to it, compared with `timingSafeEqual`.
  - Setup and sign-in have no session. They rely on JSON-only bodies plus SameSite=Strict.
- **Lockout:**
  - Failures 1–4 on an existing account give 401.
  - The 5th consecutive failure gives 401 and sets `locked_until = now + 15 min`, with audit `auth.locked_out`.
  - While `now < locked_until`, every attempt gives 429, even with the right password, and isn't counted. At `now == locked_until` the account is unlocked.
  - The first attempt after the lock ends starts the count at 0. A successful sign-in resets it.
  - Unknown emails are never counted.
- **Setup:** it runs in one transaction. It creates the admin and, if no assessment exists, an assessment with `type 'self'` and `catalog_version = catalogKey(loadCatalog())`. It writes `user.created` and `assessment.created`, with the new admin as the actor. A second call gives 409.
- **Users:**
  - The email is unique case-insensitively.
  - The last active admin can't be demoted or deactivated (409 `last_admin`). With two active admins, either change is allowed, on yourself too.
  - A password reset writes `user.password_reset` with `before` and `after` null.
  - Users are never deleted.

### Audit rules and their edges (D1 writes; A2 reads; A2 and A3 call)
- **Every** status or content change writes one `audit_event` in the same transaction as the change. If the audit insert fails, the change rolls back and the request gives a 500.
- **`before` and `after`** hold only the changed fields. `before` is null on create.
  - A write that changes nothing gives 200 and no event, so repeats are free.
  - `objective_result` events carry `{status, note}`. `requirement_state` events carry the changed fields of `{implementationStatement, implementationLevel, ownerId}`. `assessment.updated` events carry the changed fields of `{type, conditionalStatusDate}`.
  - `entityId` is the objective ID, the requirement ID, the user ID or the assessment ID.
- **`recordAudit` strips secrets:** any key named `password`, `passwordHash`, `token` or `csrfToken`, at any depth.
- **The table is append-only:** SQL triggers abort any `UPDATE` or `DELETE` on `audit_event`.
- **Paging:** `nextBefore` is the last returned id when older events exist, and `null` otherwise.

### Assessment rules and their edges (A3)
- **One evaluation, used everywhere:** every response's `evaluation` is `evaluateAssessment(loadCatalog(), input, REGULATION)` (R4). The input is built from the stored rows: objective results, plus the implementation levels from requirement state. The web's live and what-if scores call the same function, so the two can't disagree.
- **Implementation level:** only for requirements with `partialCredit` (3.5.3 and 3.13.11). On any other requirement it gives 400 `validation_failed`. `null` unsets it, which means the worst case.
- **Owner:** `ownerId` must be an active user, or the request gives 400. `null` unassigns. If an owner is deactivated later, they stay assigned and show `active: false`.
- **`closeout`:** `closeoutClock(conditionalStatusDate, today)` when the date is set, otherwise `null`. Setting the date to `null` clears it.
- **Who can write:** contributors and admins can both write objective results and requirement state. Only admins can change assessment settings.

### Rules addition (R4, `packages/rules/src/evaluate.ts`, exported from `@rampart/rules`)
```ts
export interface Evaluation { outcomes: RequirementOutcome[]; score: ScoreResult; conditional: ConditionalResult }
export function evaluateAssessment(catalog: Catalog, input: AssessmentInput, regulation?: Regulation): Evaluation;
export interface WhatIfChanges {
  objectiveStatuses?: Readonly<Record<ObjectiveId, ObjectiveStatus>>;
  implementationLevels?: Readonly<Partial<Record<RequirementId, ImplementationLevel | null>>>; // null removes
}
export function applyWhatIf(catalog: Catalog, input: AssessmentInput, changes: WhatIfChanges): AssessmentInput;
export interface EvaluationDiff { scoreDelta: number | null;   // null when either score is incomplete
  changed: { requirementId: RequirementId; from: RequirementStatus; to: RequirementStatus }[] } // catalog order
export function compareEvaluations(saved: Evaluation, next: Evaluation): EvaluationDiff;
```
- These are pure functions, and they throw the same `RulesInputError`s as the functions underneath.
- `applyWhatIf` rejects an unknown objective (`unknown_objective`). It also rejects a level on a requirement without partial credit (`invalid_implementation_level`).

### Web contract
- **`apiSend(method, path, body, schema?)`** (W1, `apps/web/src/api/client.ts`):
  - It sends JSON with `x-csrf-token` from the session store.
  - A 204 resolves to `undefined`.
  - Errors are thrown as `ApiError`, which gains `details?: unknown`.
  - A 401 on any call other than sign-in or setup calls the registered `onUnauthenticated`, so the gate shows Sign in with "Your session ended. Sign in again."
- **`useSession()`** (W1, `apps/web/src/auth/session.tsx`) gives `{ status: 'loading' | 'setup' | 'signed_out' | 'signed_in' | 'error', user, refresh, signIn, signOut }`.
- **Page modules:** W1 mounts `pages/assessment/AssessmentPage.tsx` (W2 fills it) and `pages/settings/SettingsPage.tsx` (W3 adds sections). Settings sections come in this order: Assessment, Users (admin only), Audit log.
- **Score module** (S2, `apps/web/src/score/`):
  - `toAssessmentInput(view)`.
  - `useWhatIf(savedInput)` gives `{ active, start, exit, reset, setObjective, setLevel, changes, evaluation, diff }`.
  - `<ScorePanel saved whatIf? diff? />`.
  - `blockerText(blocker, catalog)`.
  - Conditional labels: final is "Final status reachable", conditional is "Conditional status reachable", not_eligible is "Not eligible", and incomplete is "Assessment incomplete".
  - Deltas use U+2212 for minus: `+5`, `−3`, `±0`, and `—` when the delta is null.
- **UI rules:** every UI slice uses only L1 and L2 controls and tokens. Each has `[manual]` checks at 1280 px and 375 px, with no horizontal scroll at 375 px.

## Per-slice detail

### D1: DB: users, sessions, audit, objective results, requirement state
- **Scope:**
  - In `schema.ts`, add these tables:
    - `user`: `id` uuid pk; `email` unique `COLLATE NOCASE`; `display_name`; `role` with a check on the two roles; `password_hash`; `active` integer boolean, default 1; `failed_sign_ins` int, default 0; `locked_until` nullable; and the timestamps.
    - `session`: `id` (the SHA-256 hex); `user_id` FK with cascade; `csrf_token`; `created_at`; `last_seen_at`; and an index on `user_id`.
    - `audit_event`: `id` integer autoincrement; `at`; `actor_user_id` FK, nullable; `assessment_id` FK, nullable; `action`; `entity_type`; `entity_id`; `before` and `after` JSON text, nullable; `request_id`, nullable; and an index on (`entity_type`, `entity_id`, `id`).
    - `objective_result`: pk (`assessment_id`, `objective_id`); `status` with a check on the four values; `note`, nullable; `updated_by` FK user; `updated_at`.
    - `requirement_state`: pk (`assessment_id`, `requirement_id`); `implementation_level`, nullable, with a check on `none` and `partial`; `implementation_statement`, nullable; `owner_user_id` FK, nullable; `updated_by`; `updated_at`.
  - Generate the migration with drizzle-kit. Add a custom migration (`drizzle-kit generate --custom`) with the append-only triggers.
  - Write `recordAudit(db, event)` in `apps/api/src/audit/record.ts`. It follows the Audit rules (it strips secret keys and writes nothing when `before` deep-equals `after`), returns the new id or `null`, and works inside a caller's transaction.
  - Does not include routes or validation of catalog IDs.
- **Files owned:** `apps/api/db/schema.ts`, `apps/api/db/migrations/*`, `apps/api/db/db.test.ts`, `apps/api/src/audit/record.ts` (new), `apps/api/src/audit/record.test.ts` (new)
- **Success criteria:**
  - `[test] Migrate creates the five new tables beside assessment; a second run is a no-op — apps/api/db/db.test.ts › migrations and constraints`
  - `[test] A DB migrated to 0000 with an assessment row upgrades with the row intact — db.test.ts › upgrades a foundation database`
  - `[test] Role, status and level checks reject bad values; A@x.com and a@x.com conflict; a duplicate (assessment, objective) is rejected; an unknown updated_by fails its FK — db.test.ts › new table constraints`
  - `[test] UPDATE and DELETE on audit_event abort — db.test.ts › audit is append-only`
  - `[test] recordAudit stores before/after JSON with null before on create, returns null and writes nothing when before equals after, and strips password, passwordHash, token and csrfToken at any depth — apps/api/src/audit/record.test.ts › records changes`
  - `[test] An event recorded inside a transaction that rolls back is not stored — record.test.ts › shares the caller's transaction`
- **Depends on:** —
- **One-way door:** none. The migration only adds new tables and triggers, and the existing assessment row is kept.
- **Model:** opus

### K1: API contract for this sprint, plus client-error mapping
- **Scope:**
  - Write the contract files and error codes exactly as the Shared contract gives them, and re-export them from `contract/index.ts`.
  - In `errors.ts` and `app.ts`: map 415 to `unsupported_media_type`, remove the `text/plain` parser, and answer 404 for unknown routes before the body is parsed.
  - Does not include any route.
- **Files owned:** `apps/api/src/contract/{index.ts,error.ts}`, `apps/api/src/contract/{common.ts,auth.ts,users.ts,audit.ts,evaluation.ts,assessment.ts}` (new), `apps/api/src/contract/schemas.test.ts` (new), `apps/api/src/contract-rules-types.test.ts` (new), `apps/api/src/errors.ts`, `apps/api/src/app.ts`, `apps/api/src/app.test.ts`
- **Success criteria:**
  - `[test] Every code in the table maps to its status — apps/api/src/contract/schemas.test.ts › error codes and statuses`
  - `[test] objectiveStatusSchema accepts exactly the four values and rejects 'Met', 'NOT_MET', '' and null — schemas.test.ts › objective status is exact`
  - `[test] calendarDateSchema accepts 2028-02-29 and rejects 2027-02-29, 2026-02-30, 2026-2-3 and 11/23/2026 — schemas.test.ts › calendar dates`
  - `[test] Password at 11 and 129 characters fails and at 12 and 128 passes; " Admin@Example.COM " becomes admin@example.com; a blank display name fails — schemas.test.ts › identity fields`
  - `[test] A note is trimmed, whitespace becomes null, 4,000 characters pass and 4,001 fail; a statement passes at 20,000 and fails at 20,001 — schemas.test.ts › text limits`
  - `[test] Request schemas reject unknown keys, and the update and patch schemas reject {} — schemas.test.ts › strict requests`
  - `[test] The audit query defaults limit to 50, accepts 1 and 200, and rejects 0, 201 and before=0 — schemas.test.ts › audit query`
  - `[test] The inferred types of the evaluation mirrors equal the frozen rules types — apps/api/src/contract-rules-types.test.ts › mirrors match rules types`
  - `[test] text/plain and form bodies on a JSON route give 415 unsupported_media_type and never reach the handler — apps/api/src/app.test.ts › only json bodies are parsed`
  - `[test] An unknown route with malformed JSON, a body over 1 MiB, or text/plain gives 404 not_found; malformed JSON on a known route is still 400 validation_failed — app.test.ts › not found wins over body errors`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### R4: Rules: evaluateAssessment and what-if helpers
- **Scope:** write the tests first. Build the Rules addition, and add these functions to `packages/rules/README.md`. No change to existing rule logic or to the frozen types.
- **Files owned:** `packages/rules/src/index.ts`, `packages/rules/src/evaluate.ts` (new), `packages/rules/src/evaluate.test.ts` (new), `packages/rules/README.md`
- **Success criteria:**
  - `[test] evaluateAssessment deep-equals the outcomes, the score and checkConditional called separately, on the fixture and on the real catalog — packages/rules/src/evaluate.test.ts › composes the three rules`
  - `[test] applyWhatIf with no changes gives an equal input, doesn't mutate its argument, replaces existing results, adds missing ones, and null removes a level — evaluate.test.ts › applies changes purely`
  - `[test] An unknown objective, or a level on a requirement without partial credit, throws RulesInputError with its code — evaluate.test.ts › rejects invalid changes`
  - `[test] An identical next gives delta 0 and no changes; one Not Met 5-point requirement gives −5 with one change; making 3.12.4 not met gives a null delta — evaluate.test.ts › compares evaluations`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### L2: Look: TextArea, Select, RadioGroup, Alert
- **Scope:**
  - `TextArea`: underline-only, label and error like `TextField`, and with `maxLength` a counter that reads `n / max` in mono.
  - `Select`: a native `<select>` with `appearance: none`, underline-only, an Ink chevron drawn in CSS, and label and error.
  - `RadioGroup`: a fieldset and legend over visually hidden native radios, shown as square segmented buttons. The selected one is Ink-filled with Sheet text. It takes `options: { value, label, status? }[]`, exposes `data-status`, and handles `disabled`.
  - `Alert`: `tone: 'error'` uses `role="alert"` with a red 1.5 px border and Ink text on Sheet; `tone: 'info'` uses `role="status"` with an Ink border.
  - Add all four to `index.ts` and the specimen. Tokens only.
- **Files owned:** `apps/web/src/look/index.ts`, `apps/web/src/look/{TextArea,Select,RadioGroup,Alert}.tsx` (new), `apps/web/src/look/{TextArea,Select,RadioGroup,Alert}.module.css` (new), `apps/web/src/look/Specimen.tsx`, `apps/web/src/look/forms.test.tsx` (new)
- **Success criteria:**
  - `[test] TextArea and Select associate their labels and set aria-invalid and aria-describedby on error; the TextArea counter updates and stops at maxLength — apps/web/src/look/forms.test.tsx › TextArea and Select`
  - `[test] RadioGroup arrow keys move the selection and call onChange once each; a disabled group ignores input; options expose data-status — forms.test.tsx › RadioGroup`
  - `[test] Alert tones use role alert and role status — forms.test.tsx › Alert`
  - `[test] The existing guards still pass over the new files — apps/web/src/look/guards.test.ts › only tokens and self-hosted fonts`
  - `[manual] At 1280 px and 375 px the specimen shows the four controls in every state: underline-only, square, no rounded corners or shadows, no horizontal scroll — open /look.html`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### A2: Auth API: setup, sign-in, sessions, CSRF, roles, users, audit read
- **Scope:**
  - Build the Dependencies section, the auth, users and audit routes, the guard, and the Auth rules and Audit rules (read side).
  - Add `now` to `buildApp`, and create `registerApiRoutes`.
  - Write a test harness, `apps/api/src/testing/harness.ts`, that A3 reuses. It provides: an app on a migrated in-memory DB with a settable clock, `setupAdmin()`, `signIn()`, and a client that keeps the cookie and sends the CSRF header.
  - Update the README (auth and security defaults). In the brief's Smoke recipe, set **Login credentials**: the first run shows Setup, where you create the admin (any email, a password of 12 or more characters).
  - Does not include assessment routes.
- **Files owned:** `apps/api/package.json`, `pnpm-lock.yaml`, `apps/api/src/app.ts`, `apps/api/src/app.test.ts`, `apps/api/src/routes/index.ts` (new), `apps/api/src/auth/{password.ts,sessions.ts,guard.ts,routes.ts}` (new), `apps/api/src/auth/{setup.test.ts,sign-in.test.ts,session.test.ts,csrf.test.ts}` (new), `apps/api/src/users/{routes.ts,users.test.ts}` (new), `apps/api/src/audit/{list.ts,list.test.ts}` (new), `apps/api/src/testing/harness.ts` (new), `README.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] Setup creates the admin and the self assessment with the catalog key, writes two audit events, and sets an HttpOnly SameSite=Strict cookie; setupRequired flips from true to false; a second call gives 409 setup_complete — apps/api/src/auth/setup.test.ts › first run setup`
  - `[test] The stored hash starts with $argon2id$; the DB holds the token's SHA-256 and not the token; no response, log line or audit row contains the password or the token — setup.test.ts › secrets never leave`
  - `[test] A wrong password, an unknown email and an inactive user all give the same 401 body; sign-in rotates the session and deletes the old one — apps/api/src/auth/sign-in.test.ts › credentials`
  - `[test] The 5th failure locks; while locked the right password gives 429 with retryAfterSeconds and Retry-After; at locked_until it is allowed; success resets the count; auth.locked_out is audited — sign-in.test.ts › lockout edges`
  - `[test] Idle 1:59:59 passes and 2:00:00 gives 401; an active session dies at 12 h; an expired session's row is deleted — apps/api/src/auth/session.test.ts › expiry edges`
  - `[test] Sign-out gives 204, deletes the row and clears the cookie; a repeat gives 204 — session.test.ts › sign out is idempotent`
  - `[test] A write without the header, with a wrong token, or with another session's token gives 403 csrf_failed; GETs need no token; check order is 401, then csrf, then forbidden, then 400 — apps/api/src/auth/csrf.test.ts › csrf and check order`
  - `[test] Contributors get 403 on POST and PATCH users; a duplicate email in another case gives 409 email_taken; the list is sorted and has no hash fields — apps/api/src/users/users.test.ts › admin-only user management`
  - `[test] Demoting or deactivating the last active admin gives 409 last_admin; with two admins it works; deactivation and password reset end the target's sessions; a role change applies on the next request — users.test.ts › last admin and revocation`
  - `[test] A no-op PATCH gives 200 with no audit event; events hold only the changed fields; a password reset has null before and after — users.test.ts › audit of user changes`
  - `[test] Audit is newest first; limit and before page through with nextBefore null on the last page; the entity filter narrows; limit=0 gives 400 — apps/api/src/audit/list.test.ts › pages the audit log`
  - `[manual] With the smoke recipe: in a browser, setup, sign-out and sign-in work through the Vite proxy, and DevTools shows the cookie as HttpOnly and SameSite=Strict`
- **Depends on:** D1, K1
- **One-way door:** turns on sign-in. After it merges, every API route except health, session status, setup and sign-in needs a signed-in user, and every write needs the CSRF token. It also adds two packages to the lockfile. Undo: revert the slice's merge commit. The user and session rows stay in the database, but nothing reads them.
- **Model:** opus

### W1: Web auth: session gate, setup, sign-in, user slot, users panel
- **Scope:**
  - Build `apiSend`, the session store and `useSession`, and the gate in `App.tsx`. The gate shows: loading; Setup when `setupRequired`; Sign in when signed out; the Shell when signed in; and on a session fetch failure, an `Alert` with Retry.
  - **Setup form:** email, display name, password and confirm. It checks the length and that the two passwords match before sending.
  - **Sign-in form:** a 401 shows "Email or password is incorrect.", and a 429 shows "Too many attempts. Try again in N minutes." (`retryAfterSeconds`, rounded up). Submit is disabled while a request is pending.
  - **Masthead user slot:** the display name, the role (Admin or Contributor), and Sign out.
  - **Mount the page modules:** `SettingsPage` with a `UsersPanel` (admin only), and `AssessmentPage` rendering the current placeholder until W2.
  - **Users panel:** list, create, change role, deactivate or reactivate, and reset password. `email_taken` shows on the email field, and `last_admin` shows as an Alert.
- **Files owned:** `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/api/client.test.ts`, `apps/web/src/shell/{Masthead.tsx,Masthead.module.css,Shell.test.tsx}`, `apps/web/src/auth/{session.tsx,Gate.tsx,SetupPage.tsx,SignInPage.tsx,UserSlot.tsx,auth.module.css}` (new), `apps/web/src/auth/{gate.test.tsx,forms.test.tsx}` (new), `apps/web/src/pages/assessment/AssessmentPage.tsx` (new), `apps/web/src/pages/settings/{SettingsPage.tsx,UsersPanel.tsx,settings.module.css}` (new), `apps/web/src/pages/settings/UsersPanel.test.tsx` (new)
- **Success criteria:**
  - `[test] apiSend sends JSON with x-csrf-token, resolves a 204 to undefined, and maps the envelope to ApiError with details — apps/web/src/api/client.test.ts › apiSend`
  - `[test] A 401 from a non-auth call shows Sign in with "Your session ended. Sign in again."; a 401 from sign-in does not — client.test.ts › unauthenticated hook`
  - `[test] The gate shows Setup, Sign in, the Shell, or the error Alert with a working Retry for each session state — apps/web/src/auth/gate.test.tsx › gate states`
  - `[test] Setup blocks an 11-character password and a mismatched confirm without a request; success shows the Shell with the user slot — apps/web/src/auth/forms.test.tsx › setup form`
  - `[test] Sign-in shows the 401 and 429 messages, with 61 seconds shown as 2 minutes; a double click sends one request — forms.test.tsx › sign-in form`
  - `[test] Sign out sends DELETE and returns to Sign in; a network failure shows an Alert and stays signed in — forms.test.tsx › sign out`
  - `[test] Settings shows Users to an admin but not to a contributor; create, role change, deactivate and reset send the right requests; email_taken and last_admin show where the scope says — apps/web/src/pages/settings/UsersPanel.test.tsx › users panel`
  - `[test] The nav still marks the current tab, and /assessment and /settings render their page modules — apps/web/src/shell/Shell.test.tsx › nav marks the current tab`
  - `[manual] At 1280 px and 375 px: setup, sign-in, the user slot in the masthead, the menu, and the users panel use only look controls, with no horizontal scroll — pnpm dev on a fresh DATABASE_PATH`
- **Depends on:** K1, L2
- **One-way door:** none
- **Model:** opus

### S2: Web score panel and what-if state
- **Scope:**
  - Build the Score module from the Web contract. `ScorePanel` shows the SPRS value in display type, `/ 110`, the Conditional label, and the blockers in contract order, each as `blockerText` with its citation in mono.
  - Incomplete shows `—` and "CA.L2-3.12.4 System Security Plan must be Met before a score exists".
  - With a what-if, it shows an `Alert` (info) reading "What-if — not saved", the what-if score, the delta, and the count of changed requirements.
  - The ruler and the stamp come later (ssp-dashboard).
- **Files owned:** `apps/web/score.html` (new), `apps/web/src/score/ScoreSpecimen.tsx` (new), `apps/web/src/score/{input.ts,useWhatIf.ts,ScorePanel.tsx,ScorePanel.module.css,blockerText.ts,index.ts}` (new), `apps/web/src/score/{input.test.ts,useWhatIf.test.tsx,ScorePanel.test.tsx}` (new)
- **Success criteria:**
  - `[test] toAssessmentInput maps results and levels from a view, and with no changes evaluateAssessment deep-equals the view's evaluation — apps/web/src/score/input.test.ts › view to rules input`
  - `[test] setObjective and setLevel update the evaluation and diff; reset clears the changes; exit leaves what-if; setting a saved value back gives no changes — apps/web/src/score/useWhatIf.test.tsx › what-if state`
  - `[test] Each of the four Conditional statuses shows its label; blockers render in order with their citations; incomplete shows the dash and the prerequisite message — apps/web/src/score/ScorePanel.test.tsx › saved score`
  - `[test] Deltas format as +5, −3 (U+2212), ±0 and — for null; the what-if notice shows the changed count — ScorePanel.test.tsx › what-if display`
  - `[test] blockerText covers every Blocker code and every IneligibleCode — ScorePanel.test.tsx › blocker text`
  - `[manual] At 1280 px and 375 px, on the dev-only page /score.html (saved, incomplete and what-if states; like look.html, it is not in the build), the score reads in Space Grotesk and the citations in Space Mono, red text sits only on Sheet, and nothing scrolls sideways — open http://127.0.0.1:<web>/score.html`
- **Depends on:** K1, R4, L2
- **One-way door:** none
- **Model:** sonnet

### A3: Assessment API: view, objective results, requirement state, settings
- **Scope:**
  - Build the four assessment routes in `apps/api/src/assessment/`, registered in `registerApiRoutes`. Follow the Assessment rules and the Audit rules.
  - Each write is one transaction: the change plus its audit event.
  - Update the README (endpoints) and the brief's Smoke recipe **Key URLs** (`/api/assessment`).
  - Does not include POA&M.
- **Files owned:** `apps/api/src/routes/index.ts`, `apps/api/src/assessment/{repository.ts,routes.ts}` (new), `apps/api/src/assessment/{view.test.ts,objectives.test.ts,requirements.test.ts,settings.test.ts,types.test.ts}` (new), `README.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] A fresh assessment shows every requirement not_assessed and the score incomplete; after writes, evaluation deep-equals evaluateAssessment over the stored rows; with no assessment row it gives 404 — apps/api/src/assessment/view.test.ts › view uses the shared evaluation`
  - `[test] Status 'Met', 'unknown', '', or a missing status gives 400; an unknown objective gives 404; the encoded ID 3.1.1%5Ba%5D works — apps/api/src/assessment/objectives.test.ts › validates objective writes`
  - `[test] A first write audits before null; a change audits before and after; an identical repeat gives 200 with no event; the note is trimmed and blank becomes null — objectives.test.ts › audit and repeats`
  - `[test] Main flow: results giving 72 with 3.1.20 not_met return score 72, not_eligible, below_threshold and poam_ineligible(AC.L2-3.1.20, barred) — objectives.test.ts › main flow 72 with 3.1.20`
  - `[test] With a test trigger making the audit insert fail, the write gives 500 and the stored result is unchanged — objectives.test.ts › change and audit are atomic`
  - `[test] A level on a requirement without partial credit gives 400; 3.13.11 not_met moves from −5 to −3 at partial; null unsets it; an unknown or inactive owner gives 400; a deactivated owner shows active false; an unknown requirement gives 404 — apps/api/src/assessment/requirements.test.ts › requirement state`
  - `[test] A 20,001-character statement gives 400; {} and unknown keys give 400; a contributor can write; with no CSRF header it gives 403 — requirements.test.ts › limits and access`
  - `[test] A contributor PATCH gives 403; type c3pao saves; 2026-02-30 gives 400; 2026-03-01 with today 2026-03-01 gives deadline 2026-08-28 and 180 days; null clears closeout; a no-op writes no event — apps/api/src/assessment/settings.test.ts › assessment settings`
  - `[test] z.infer of evaluationSchema equals the rules Evaluation type — apps/api/src/assessment/types.test.ts › contract matches rules`
  - `[manual] With the smoke recipe, signed in through the browser: PUT one objective and see it in GET /api/assessment and GET /api/audit after an api restart`
- **Depends on:** D1, K1, R4, A2
- **One-way door:** none
- **Model:** opus

### W2: Assessment workspace UI with live and what-if score
- **Scope:**
  - `/assessment` loads the view. It shows loading, and on error an Alert with the message, the requestId, and Retry.
  - **Family list:** code, name, Met / Not Met / Not Assessed requirement counts, and a `GraduatedBar` of % assessed.
  - **Requirement list:** in catalog order, with the ID in mono, a `StatusChip` with the derived status (all-N/A shows Met), and the owner.
  - **Requirement detail:**
    - The ID, the NIST ID, basic or derived, and the points label: "5 points", "3 points", "1 point", or "Prerequisite — no points". A partial-credit requirement adds its label.
    - The text.
    - Each objective with its catalog ID and text, a `RadioGroup` (Met, Not Met, N/A, Not Assessed), and a note `TextArea` with Save.
    - The implementation statement (`TextArea`, max 20,000, Save).
    - The level `Select`, only for 3.5.3 and 3.13.11: "Not set (worst case)", "Not implemented", or the catalog label.
    - The owner `Select`: Unassigned, then active users. An inactive current owner is shown with "(inactive)".
  - **URL state:** `?family=AC&req=AC.L2-3.1.1`. Unknown values fall back to the first family, with no requirement selected. On a phone, it's one column with a Back link.
  - **Live score:**
    - A status click shows the local `evaluateAssessment` result at once.
    - It then PUTs with the current note and the encoded ID, and the control is disabled while pending.
    - On success the panel uses the server's evaluation. On failure it reverts and shows an Alert with the requestId.
  - **What-if:**
    - A "Try changes" toggle starts `useWhatIf`.
    - Status and level changes go to the what-if, not the API. Notes, the statement and the owner are disabled.
    - Lists show what-if statuses marked "what-if".
    - Exit, or leaving the page, discards the changes.
- **Files owned:** `apps/web/src/pages/assessment/AssessmentPage.tsx`, `apps/web/src/pages/assessment/{FamilyList.tsx,RequirementList.tsx,RequirementDetail.tsx,ObjectiveRow.tsx,useAssessment.ts,assessment.module.css}` (new), `apps/web/src/pages/assessment/{browse.test.tsx,editing.test.tsx,whatif.test.tsx}` (new)
- **Success criteria:**
  - `[test] Loading, then 14 families with counts and bars; picking a family lists its requirements in catalog order; the URL deep-links; unknown values fall back; an error shows the requestId and Retry works — apps/web/src/pages/assessment/browse.test.tsx › browse`
  - `[test] The detail shows the points label for 5, 3, 1, prerequisite and partial-credit cases; a single-statement requirement shows its [a] objective; the level Select shows only for 3.5.3 and 3.13.11 — browse.test.tsx › requirement detail`
  - `[test] A status click updates the score before the PUT resolves and sends the encoded ID with the note; success adopts the server evaluation; failure reverts and shows the requestId; the control is disabled while pending — apps/web/src/pages/assessment/editing.test.tsx › live save`
  - `[test] Saving a note, a statement or an owner sends the right PUT or PATCH; the owner list holds Unassigned plus active users, and shows an inactive current owner with "(inactive)" — editing.test.tsx › content edits`
  - `[test] In what-if, status and level changes send no request, the panel shows the what-if score and delta, other edits are disabled, and Exit and unmount discard the changes — apps/web/src/pages/assessment/whatif.test.tsx › what-if mode`
  - `[manual] At 1280 px and 375 px: browse, edit and what-if with look controls only and no horizontal scroll; marking AC.L2-3.1.20[a] Not Met lists the 3.1.20 POA&M blocker — pnpm dev, signed in`
- **Depends on:** K1, R4, L2, W1, S2
- **One-way door:** none
- **Model:** sonnet

### W3: Settings UI: assessment type, Conditional Status Date, audit log
- **Scope:**
  - **Assessment section** (at the top of `SettingsPage`):
    - A type `RadioGroup` with `ASSESSMENT_TYPE_LABELS`, self by default. It shows "Closeout confirmed by:" with the `CLOSEOUT_CONFIRMER_LABELS` value, using `closeoutConfirmer` from the rules.
    - The Conditional Status Date as a `TextField` in YYYY-MM-DD, checked with `calendarDateSchema` before any request. It shows the deadline and days remaining, or "Expired". Clear sets it to null.
    - Admins edit. Contributors see it read-only, with no Save.
  - **Audit log section** (last):
    - Rows newest first: the local time (ISO in `title`), the actor, a label for the action, the entity, and `before → after` as compact JSON in mono.
    - An entity-type filter `Select`, and a Load more button that uses `nextBefore`.
    - An empty state, and an error Alert with Retry.
- **Files owned:** `apps/web/src/pages/settings/SettingsPage.tsx`, `apps/web/src/pages/settings/{AssessmentSettings.tsx,AuditLog.tsx,auditLabels.ts}` (new), `apps/web/src/pages/settings/{AssessmentSettings.test.tsx,AuditLog.test.tsx}` (new)
- **Success criteria:**
  - `[test] The type label and closeout confirmer show for both types; an admin save sends a PATCH and shows the result; a contributor gets no Save and disabled inputs — apps/web/src/pages/settings/AssessmentSettings.test.tsx › type and roles`
  - `[test] 2026-02-30 and 2026-2-3 show an error with no request; a valid date shows the deadline and days remaining from the response; an expired clock shows Expired; Clear sends null — AssessmentSettings.test.tsx › conditional status date`
  - `[test] Rows render newest first with labels; Load more appends with before=nextBefore and hides when it's null; the filter re-queries from the start; the empty and error states work — apps/web/src/pages/settings/AuditLog.test.tsx › audit log`
  - `[test] auditLabels has a label for every AUDIT_ACTIONS value, and the sections render in the order Assessment, Users (admin), Audit log — AuditLog.test.tsx › labels and section order`
  - `[manual] At 1280 px and 375 px, Settings uses look controls only; the audit JSON wraps without horizontal scroll — pnpm dev, signed in as an admin and as a contributor`
- **Depends on:** K1, L2, W1
- **One-way door:** none
- **Model:** sonnet
