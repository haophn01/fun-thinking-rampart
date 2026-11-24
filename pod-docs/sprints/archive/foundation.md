# Sprint: Foundation

_From plan: pod-docs/plans/cmmc-l2-grc.md · Slug: foundation · Status: archived · Generated: 2026-11-23_


## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | B1 | Bootstrap: pnpm monorepo, strict TS, lint, Vitest, CI | foundation-b1 | merged | done | medium | — |
| 2 | C1 | Catalog: PDF conversion script, Rev 2 data, loader, count tests | foundation-c1 | merged | done | medium | B1 |
| 2 | R1 | Rules: requirement status and SPRS score | foundation-r1 | merged | done | medium | B1 |
| 2 | R2 | Rules: POA&M eligibility, Conditional check, 180-day clock | foundation-r2 | merged | done | medium | B1 |
| 2 | A1 | API and DB skeleton: config, errors, logging, headers, migrations | foundation-a1 | merged | done | medium | B1 |
| 2 | L1 | Look: tokens, self-hosted fonts, base controls | foundation-l1 | merged | done | medium | B1 |
| 3 | S1 | Web shell: masthead, nav, routes, API client | foundation-s1 | merged | done | medium | L1, A1 |
| 3 | R3 | Rules against the real catalog: the plan's verification table | foundation-r3 | merged | done | high | C1, R1, R2 |

Plan branch `cmmc-l2-grc`; wave heads `foundation-w1`, `foundation-w2`, `foundation-w3`. Merge target is `main` (decisions.md 2026-11-23).

## Shared contract

### Workspace and tooling (B1 sets up; everyone follows)
- **Layout:** pnpm workspace with `packages/catalog` (`@rampart/catalog`), `packages/rules` (`@rampart/rules`), `apps/api` (`@rampart/api`) and `apps/web` (`@rampart/web`). Every package is `"type": "module"`. Node `>=24` in `engines`. pnpm is pinned in the root `packageManager` field and enabled with `corepack enable`. `pnpm-workspace.yaml` allows the build scripts of `better-sqlite3` and `esbuild` (`onlyBuiltDependencies`).
- **Internal packages export TypeScript source** (`exports` → `./src/*.ts`). Only apps build: the api is bundled with tsup (workspace packages inlined), and the web with Vite. Dev runs the api through `tsx watch`. TS uses `moduleResolution: "Bundler"`.
- **Exports:** `@rampart/catalog` → `src/index.ts`. `@rampart/rules` → `src/index.ts`, and `@rampart/rules/poam` → `src/poam/index.ts`. `@rampart/api/contract` → `src/contract/index.ts`. Workspace deps: rules → catalog; api → catalog, rules; web → api (contract only), catalog, rules.
- **Strict TS** (`tsconfig.base.json`): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`. ESLint flat config with typescript-eslint `strictTypeChecked`, react-hooks, and eslint-config-prettier. Prettier uses `endOfLine: "lf"`, and `.gitattributes` sets `* text=auto eol=lf` so Windows checkouts pass `prettier --check`.
- **Root scripts:** `dev` (api and web in parallel), `lint` (`eslint .` then `prettier --check .`), `format`, `typecheck` (`pnpm -r typecheck`), `test` (`vitest run` at the root, with projects `packages/*`, `apps/*` and the `repo` project `tests/**/*.test.ts`), `build` (`pnpm -r build`), and `verify` = lint → typecheck → test → build, stopping at the first failure.
- **The lockfile is frozen after B1.** B1 installs every dependency this sprint needs: zod v4, fastify v5, @fastify/helmet, drizzle-orm, drizzle-kit, better-sqlite3, tsup, tsx, pdfjs-dist (catalog dev only), react 19, react-dom, react-router, vite, @vitejs/plugin-react, @fontsource/space-grotesk, @fontsource/inter, @fontsource/space-mono, vitest, jsdom, @testing-library/react, @testing-library/user-event, @testing-library/jest-dom, yaml (dev, root), and the eslint, prettier, typescript and @types packages. Later slices may edit `scripts` in a package.json they own, but never dependencies. If one is truly missing: add a `BLOCKED` queue entry to `orchestrator`; don't install it.
- **Ports and host:** everything binds `127.0.0.1`. `WEB_PORT` defaults to 3000 and `API_PORT` to 3001 (plan port base 3000). Vite uses `strictPort` and proxies `/api` to `http://127.0.0.1:${API_PORT}`.
- **CI** (`.github/workflows/pod-ci.yml`): runs on `pull_request` and on `push` to `main`, with `permissions: contents: read, pull-requests: read`.
  - Job `verify`: matrix `ubuntu-latest` and `windows-latest`. Steps: checkout, setup-node 24, `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm verify`.
  - Job `secrets`: ubuntu, checkout with `fetch-depth: 0`, then `gitleaks/gitleaks-action@v2` with `GITHUB_TOKEN`. The repo is under a personal account, so no license key is needed.
- **Product name:** `PRODUCT_NAME = "Rampart"` is exported once from `@rampart/api/contract`. Nothing else spells the name.

### Catalog types (`packages/catalog/src/types.ts`, written by B1 exactly like this, frozen in wave 2)
```ts
export type FamilyCode = 'AC'|'AT'|'AU'|'CM'|'IA'|'IR'|'MA'|'MP'|'PS'|'PE'|'RA'|'CA'|'SC'|'SI';
export type RequirementId = string;   // CMMC form "AC.L2-3.1.1"
export type ObjectiveId = string;     // "3.1.1[a]" (nistId + bracketed letter), unique catalog-wide
export interface CatalogSource { title: string; url: string; sha256: string; retrieved: string } // retrieved: YYYY-MM-DD
export interface Objective { id: ObjectiveId; text: string }
export type Scoring =
  | { kind: 'points'; points: 1 | 3 | 5; citation: string;
      partialCredit: null | { deduction: 3; label: string; citation: string } }
  | { kind: 'prerequisite'; citation: string };   // CA.L2-3.12.4 only
export interface Requirement { id: RequirementId; nistId: string; family: FamilyCode;
  type: 'basic' | 'derived'; text: string; scoring: Scoring; objectives: Objective[] }
export interface Family { code: FamilyCode; nistSection: string; name: string; requirementIds: RequirementId[] }
export interface Catalog { id: 'nist-800-171-r2'; version: string; sources: CatalogSource[];
  families: Family[]; requirements: Requirement[] }
```
- The families are 3.1 AC, 3.2 AT, 3.3 AU, 3.4 CM, 3.5 IA, 3.6 IR, 3.7 MA, 3.8 MP, 3.9 PS, 3.10 PE, 3.11 RA, 3.12 CA, 3.13 SC, 3.14 SI. Requirements per family: 22, 3, 9, 9, 11, 3, 6, 9, 2, 6, 3, 4, 16, 7.
- Requirements are in NIST order, sorted numerically (3.1.9 comes before 3.1.10).
- `catalogKey(catalog)` returns `"nist-800-171-r2@<version>"`. That string is what an assessment records as `catalog_version`. The first version is `1.0.0`.
- **Points (decisions.md 2026-11-23, 32 CFR 170.24(c)(2)):**
  - 44 requirements at 5: the 42 the regulation lists (23 basic and 19 derived), plus IA.L2-3.5.3 and SC.L2-3.13.11. Those two have `partialCredit` with a deduction of 3.
  - 14 at 3 (7 basic, 7 derived) and 51 at 1.
  - CA.L2-3.12.4 is `prerequisite`.
  - The source's "IA-L2-3.5.1" and "IA-L2-3.5.2" are normalized to dots.
  - The `partialCredit.label` text: 3.5.3 is "MFA covers remote and privileged users only", and 3.13.11 is "Encryption employed but not FIPS-validated".

### Rules types (`packages/rules/src/types.ts` and `src/errors.ts`, written by B1 exactly like this, frozen in wave 2)
```ts
export type ObjectiveStatus = 'met' | 'not_met' | 'na' | 'not_assessed';
export type RequirementStatus = 'met' | 'not_met' | 'not_assessed';
export type ImplementationLevel = 'none' | 'partial';           // only for requirements with partialCredit
export type AssessmentType = 'self' | 'c3pao';
export interface ObjectiveResult { objectiveId: ObjectiveId; status: ObjectiveStatus }
export interface AssessmentInput { objectiveResults: readonly ObjectiveResult[];
  implementationLevels: Readonly<Partial<Record<RequirementId, ImplementationLevel>>> }
export interface RequirementOutcome { requirementId: RequirementId; status: RequirementStatus; allNa: boolean;
  counts: Record<ObjectiveStatus, number>; implementationLevel: ImplementationLevel | null; deduction: number }
export interface Deduction { requirementId: RequirementId; points: number }
export type ScoreResult =
  | { kind: 'scored'; score: number; max: number; floor: number; deductions: Deduction[]; notAssessed: RequirementId[] }
  | { kind: 'incomplete'; reason: 'prerequisite_not_met'; prerequisites: RequirementId[];
      max: number; floor: number; notAssessed: RequirementId[] };
export type IneligibleCode = 'not_not_met' | 'barred' | 'exceeds_point_limit';
export type EligibilityResult = { eligible: true }
  | { eligible: false; reasons: { code: IneligibleCode; citation: string }[] };
export type Blocker =
  | { code: 'prerequisite_not_met'; requirementId: RequirementId; citation: string }
  | { code: 'not_assessed'; requirementIds: RequirementId[] }
  | { code: 'below_threshold'; score: number; threshold: number; citation: string }
  | { code: 'poam_ineligible'; requirementId: RequirementId; reasons: IneligibleCode[]; citation: string };
export interface ConditionalResult { status: 'final' | 'conditional' | 'not_eligible' | 'incomplete'; blockers: Blocker[] }
export interface CloseoutClock { conditionalStatusDate: string; deadline: string; daysRemaining: number; expired: boolean }
export interface Cited<T> { value: T; citation: string }
export interface Regulation { id: 'cmmc-32-cfr-170'; version: string; sources: { title: string; url: string }[];
  conditionalMinScore: Cited<number>; poamMaxItemPoints: Cited<number>;
  poamPointExceptions: { requirementId: RequirementId; implementationLevel: ImplementationLevel; maxPoints: number; citation: string }[];
  poamBarred: Cited<RequirementId[]>; closeoutWindowDays: Cited<number>;
  closeoutConfirmedBy: Cited<Record<AssessmentType, 'organization' | 'c3pao'>> }
// errors.ts
export class RulesInputError extends Error { constructor(
  readonly code: 'unknown_objective' | 'duplicate_objective' | 'unknown_requirement' | 'invalid_implementation_level' | 'invalid_date',
  message: string) { super(message); this.name = 'RulesInputError'; } }
```

### Rules and their edges
- **Requirement status** (plan, Objectives are first-class):
  - Any `not_met` objective makes the requirement `not_met`, even if others are unassessed.
  - Otherwise, any `not_assessed` objective, or one with no result, makes it `not_assessed`.
  - Otherwise it is `met`. If every objective is `na`, it is `met` with `allNa: true`.
- **Input validation:** these throw `RulesInputError`:
  - an objective ID not in the catalog
  - the same objective listed twice
  - an implementation level on an unknown requirement, or on one without `partialCredit`
- **Score** (170.24(c)(2)):
  - `max` is the catalog's requirement count. `floor` is `max` minus the sum of worst-case points over `points` requirements. Both are derived from the data; neither is a literal.
  - Each `not_met` requirement deducts its points. For a partial-credit requirement: level `partial` deducts 3, and `none` or an unset level deducts 5 (worst case).
  - `met` and `not_assessed` requirements deduct 0, whatever their level. `not_assessed` IDs are listed in `notAssessed`.
  - **Prerequisite:** if any `prerequisite` requirement does not have every objective `met`, the result is `incomplete`, with no score. This covers Not Met, Not Assessed, and any N/A objective, because an SSP can't be not applicable.
  - The functions are pure: inputs are never mutated, and the same input gives the same output. `deductions` are in catalog order.
- **Regulation data** (`packages/rules/src/poam/regulation.ts`, `version: '1.0.0'`). This is the only place these values live, and each citation starts with `32 CFR 170.21` or `32 CFR 170.24`, at the most specific paragraph in the Cornell LII text:
  - `conditionalMinScore` is 88 (score/110 ≥ 0.8).
  - `poamMaxItemPoints` is 1.
  - The one exception is SC.L2-3.13.11 at `partial`, with `maxPoints` 3.
  - `poamBarred` is AC.L2-3.1.20, AC.L2-3.1.22, CA.L2-3.12.4, PE.L2-3.10.3, PE.L2-3.10.4 and PE.L2-3.10.5.
  - `closeoutWindowDays` is 180.
  - `closeoutConfirmedBy` is `{ self: 'organization', c3pao: 'c3pao' }`.
- **POA&M eligibility:**
  - Reasons are collected, not short-circuited, and returned in the order `not_not_met`, `barred`, `exceeds_point_limit`.
  - `not_not_met`: the status is `met` or `not_assessed`.
  - `barred`: the requirement is in the barred list.
  - `exceeds_point_limit`: the effective points (3 at `partial`, otherwise the requirement's points) are over the limit, and no exception matches both the requirement and the level.
    - 3.5.3 at `partial` is rejected.
    - 3.13.11 at `partial` is accepted.
    - 3.13.11 at `none` or unset is rejected.
  - An unknown requirement throws.
- **Conditional check:**
  - Blockers come in this order: `prerequisite_not_met`, `not_assessed` (one blocker listing every unassessed requirement), `below_threshold` (score under 88; 88 passes, 87 fails), then one `poam_ineligible` per `not_met` requirement that fails eligibility, in catalog order.
  - The status is `incomplete` if the score is incomplete, otherwise `not_eligible` if any blocker exists.
  - With no blockers, the status is `final` when no requirement is `not_met`, and `conditional` otherwise. Both mean the status is reachable: the stamp will read ACCEPT for them and HOLD for the rest. POA&M items don't exist yet, so `conditional` doesn't check that they exist.
  - The `not_assessed` blocker is a tool rule, not a regulation rule: a Conditional or Final claim needs every requirement assessed.
- **Closeout clock:**
  - Dates are `YYYY-MM-DD` calendar dates, computed in UTC, so DST never shifts a day. `deadline` is the Conditional Status Date plus `closeoutWindowDays`.
  - `daysRemaining` is the deadline minus today. It is 180 on the Conditional Status Date itself, 0 on the deadline, and negative after it. `expired` is true only when today is after the deadline.
  - A malformed or impossible date (`2026-02-30`, `11/23/2026`) throws `invalid_date`.
  - Checked values: 2026-03-01 → 2026-08-28; 2027-01-01 → 2027-06-30; 2028-01-01 → 2028-06-29 (2028 is a leap year).

### API contract (`apps/api/src/contract/`, imports only `zod`)
- `GET /api/health` returns 200 `{ status: 'ok', db: 'ok' }`. If the DB query fails, it returns 503 with the error envelope, code `db_unavailable`.
- **Error envelope:** every non-2xx response is `{ error: { code: string; message: string; requestId: string; details?: unknown } }`.
  - Codes: `not_found` (404), `validation_failed` (400; `details` holds the zod issues), `payload_too_large` (413; JSON body over 1 MiB), `db_unavailable` (503), `internal_error` (500).
  - A 500 carries a generic message only, with no stack or internals.
- **Request ID:** an incoming `x-request-id` is reused if it matches `^[A-Za-z0-9-]{1,64}$`; otherwise a UUID is generated. It is echoed in the `x-request-id` response header and appears in every log line for that request.
- **Responses** are parsed through their contract schema before sending. A handler result that fails its schema becomes a 500 `internal_error`, and the mismatch is logged.
- **Config:** validated with zod from env.
  - `API_PORT`: an integer from 1 to 65535, default 3001.
  - `DATABASE_PATH`: default `data/rampart.sqlite`, relative to `apps/api`, with the parent folder created if missing. `:memory:` is allowed.
  - `LOG_LEVEL`: a pino level, default `info`.
  - The host is fixed at `127.0.0.1`.
  - Invalid config throws `ConfigError` naming every bad key, and the server exits 1.
- **Logging:** pino JSON. `req.headers.cookie`, `req.headers.authorization` and `set-cookie` are redacted.
- **Security headers** through @fastify/helmet: CSP, `x-content-type-options: nosniff`, `x-frame-options` (or CSP `frame-ancestors 'none'`). No `x-powered-by`.
- **DB:** better-sqlite3 with Drizzle.
  - PRAGMAs: `journal_mode = WAL` (file DBs), `foreign_keys = ON`.
  - Migrations are SQL in `apps/api/db/migrations`, generated by drizzle-kit from `apps/api/db/schema.ts`. They are applied at server start and by `pnpm --filter @rampart/api db:migrate`, and a second run is a no-op.
  - The first migration creates only `assessment`:
    - `id` text primary key (UUID)
    - `type` text not null, default `'self'`, check in (`'self'`, `'c3pao'`)
    - `conditional_status_date` text, nullable
    - `catalog_version` text not null
    - `created_at` and `updated_at` text (ISO timestamps)

### Look contract (L1 defines it; all UI uses it)
- **Tokens:** `--rp-vellum #F2F1EC`, `--rp-sheet #FFFFFF`, `--rp-ink #111111`, `--rp-graphite #6B6B66`, `--rp-red #E10600`, `--rp-blue #1F4BFF`. No other colour exists anywhere in `apps/web`.
  - Rules and borders are 1.5 px Ink.
  - The bar track is Sheet with an Ink baseline.
  - Focus is a 2 px Ink outline, offset 2 px.
- **Type:** `--rp-font-display` is Space Grotesk 700, `--rp-font-body` is Inter 400/500/600, and `--rp-font-mono` is Space Mono 400/700, each with a system fallback.
  - The size tokens are 64, 40 and 28 (display); 18 and 16 (body); 16 (label and mono).
  - `font-size` is set only through `var(--rp-text-*)`. The `font` shorthand and inline `fontSize` are not used.
- **Contrast** (plan Look, contrast rule):
  - Body-size text pairs must reach 4.5:1: Ink, Graphite, Blue or Red on Sheet; Ink, Graphite or Blue on Vellum; Sheet on Red; Sheet on Blue; Sheet on Ink.
  - Red on Vellum (about 4.39:1) is allowed only in the large-text list (24 px+, or 18.7 px+ bold) at 3:1, and for non-text marks.
- **Fonts** come only from @fontsource imports. No `http(s)://` font URL or CDN link appears in CSS or HTML.
- **Breakpoint:** phone layout is `max-width: 767px`. Manual UI checks are done at 1280 px and 375 px.
- **Test hooks:** components expose `data-variant` and `data-status` attributes. Tests assert roles, text and data attributes, never CSS-module class names.

## Per-slice detail

### B1: Bootstrap: pnpm monorepo, strict TS, lint, Vitest, CI
- **Scope:**
  - Build everything under Workspace and tooling, and write both frozen types files exactly as the contract gives them.
  - The thinnest runnable stack:
    - `apps/api`: a `buildApp()` factory serving `GET /api/health` → `{ status: 'ok' }`, and `server.ts` listening on `127.0.0.1:${API_PORT ?? 3001}`. A1 replaces both.
    - `apps/web`: a Vite React page showing `PRODUCT_NAME`.
  - `packages/catalog/src/index.ts` and `packages/rules/src/index.ts` re-export only their types (and `errors.ts` for rules).
  - `.gitignore` covers `node_modules`, `dist`, `.env*`, `apps/api/data/` and `packages/catalog/sources/*.pdf`.
  - The root README covers setup (`corepack enable`, `pnpm install`, `pnpm dev`), the scripts, the parts and how they connect, and a "no CUI in V1" warning.
  - `CONTRIBUTING.md` covers conventional commits, `pnpm verify` before every PR, test-first rules, migrations only, regulatory changes as a data edit plus tests plus a citation, and the frozen-lockfile rule.
  - In `pod-docs/codebase-structure.md`, fill **What it is**, **Parts**, **How they connect** and **Stack & conventions**.
    - `## CI` lists the two jobs and their commands; it is not `none`.
    - `## Smoke recipe`:
      - install: `corepack enable; pnpm install`
      - start: `API_PORT=<api> WEB_PORT=<web> pnpm dev`, plus the PowerShell form `$env:API_PORT=<api>; $env:WEB_PORT=<web>; pnpm dev`
      - URLs: web `http://127.0.0.1:<web>/` and api `http://127.0.0.1:<api>/api/health`
      - `Verification: pnpm verify`
  - Does not include config validation, the DB, look tokens or the catalog.
- **Files owned:** `package.json`, `pnpm-workspace.yaml` (new), `pnpm-lock.yaml` (new), `tsconfig.base.json` (new), `tsconfig.json` (new), `eslint.config.js` (new), `.prettierrc.json` (new), `.prettierignore` (new), `.gitignore` (new), `.gitattributes` (new), `.editorconfig` (new), `vitest.config.ts` (new), `.github/workflows/pod-ci.yml` (new), `README.md`, `CONTRIBUTING.md` (new), `tests/repo/ci-workflow.test.ts` (new), `tests/repo/tooling.test.ts` (new), `pod-docs/codebase-structure.md`, `packages/catalog/{package.json,tsconfig.json,src/index.ts,src/types.ts}` (new), `packages/rules/{package.json,tsconfig.json,src/index.ts,src/types.ts,src/errors.ts}` (new), `apps/api/{package.json,tsconfig.json,tsup.config.ts,src/app.ts,src/server.ts,src/app.test.ts,src/contract/index.ts}` (new), `apps/web/{package.json,tsconfig.json,vite.config.ts,dev-ports.ts,dev-ports.test.ts,index.html,src/main.tsx,src/App.tsx,src/App.test.tsx,src/test-setup.ts}` (new)
- **Success criteria:**
  - `[test] The workflow runs on pull_request and on push to main — tests/repo/ci-workflow.test.ts › triggers on pull_request and push to main`
  - `[test] The verify job runs on ubuntu and windows with Node 24, corepack, a frozen-lockfile install and pnpm verify — tests/repo/ci-workflow.test.ts › verify job runs frozen install and pnpm verify on both OSes`
  - `[test] The secrets job runs gitleaks-action@v2 on full history — tests/repo/ci-workflow.test.ts › secrets job runs gitleaks v2 with fetch-depth 0`
  - `[test] The verify script runs lint, typecheck, test and build in that order and stops at the first failure — tests/repo/tooling.test.ts › verify chains the four steps with &&`
  - `[test] The strict compiler flags are on — tests/repo/tooling.test.ts › tsconfig.base enables every strict flag`
  - `[test] pnpm is pinned, Node >=24 is required, and every workspace package is ESM — tests/repo/tooling.test.ts › engines, packageManager and module type`
  - `[test] Health returns 200 ok — apps/api/src/app.test.ts › GET /api/health returns ok`
  - `[test] The web page renders the product name — apps/web/src/App.test.tsx › renders PRODUCT_NAME`
  - `[test] Dev ports default to 3000 and 3001, honour env, and reject non-integer or out-of-range values — apps/web/dev-ports.test.ts › resolves web and api ports`
  - `[manual] On this Windows machine, corepack enable, pnpm install and pnpm dev serve both URLs on 127.0.0.1 — open them in a browser`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### C1: Catalog: PDF conversion script, Rev 2 data, loader, count tests
- **Scope:**
  - **Conversion script** (`pnpm --filter @rampart/catalog convert`):
    - It downloads or reads two PDFs into the gitignored `packages/catalog/sources/`:
      - `https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-171r2.pdf`
      - `https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-171A.pdf`
      - If a URL has moved, record the real one.
    - It checks each file's SHA-256 against `scripts/sources.json`, where you pin the hashes on the first run, and refuses to write on a mismatch.
    - It extracts text with pdfjs-dist, parses requirements (basic or derived, from the PDF headings) and their `[a]…` objectives, and merges in `scripts/points.cfr170-24.json`.
      - Transcribe that file from https://www.law.cornell.edu/cfr/text/32/170.24 §(c)(2): the 5-point list, the 3-point list, the partial-credit pair and the prerequisite, with citation and retrieval date. Everything else is 1 point.
    - It applies `scripts/overrides.json` (hand fixes keyed by requirement or objective ID) and writes `data/nist-800-171-r2.json` deterministically.
  - **Loader:** `loadCatalog()` validates the JSON with a zod schema matching `types.ts` and caches it. `parseCatalog(json)` is exported for tests. Also exports `catalogKey`, `getRequirement(catalog, id)` and `normalizePracticeId`.
  - **`packages/catalog/README.md`:** how to re-run the conversion, the source URLs and hashes, and every override with its reason for the human to spot-check.
  - CI tests read only the committed JSON and fixtures, never the network.
  - Text fixtures are short excerpts of extracted PDF text, covering a page header and footer, a hyphenated line break, and an objective list that spans a page.
- **Files owned:** `packages/catalog/package.json` (scripts only), `packages/catalog/src/index.ts`, `packages/catalog/src/{schema.ts,load.ts}` (new), `packages/catalog/data/nist-800-171-r2.json` (new), `packages/catalog/scripts/{convert.ts,parse.ts,points.ts,overrides.ts,sources.json,points.cfr170-24.json,overrides.json}` (new), `packages/catalog/scripts/fixtures/*` (new), `packages/catalog/README.md` (new), `packages/catalog/src/catalog.test.ts` (new), `packages/catalog/src/schema.test.ts` (new), `packages/catalog/scripts/parse.test.ts` (new), `packages/catalog/scripts/points.test.ts` (new)
- **Success criteria:**
  - `[test] 14 families, 110 requirements and 320 objectives, with the per-family counts in the contract — packages/catalog/src/catalog.test.ts › counts families, requirements and objectives`
  - `[test] 44 requirements at 5 points, 14 at 3 and 51 at 1, with CA.L2-3.12.4 the only prerequisite — catalog.test.ts › point distribution matches 32 CFR 170.24(c)(2)`
  - `[test] Without the two partial-credit requirements, the 5-point list splits 23 basic and 19 derived; the 3-point list splits 7 and 7 — catalog.test.ts › listed points split by basic and derived`
  - `[test] Exactly 3.5.3 and 3.13.11 have partialCredit, with deduction 3 — catalog.test.ts › partial credit on 3.5.3 and 3.13.11 only`
  - `[test] 110 minus the worst-case points is −203 — catalog.test.ts › worst-case data floor is -203`
  - `[test] AC.L2-3.1.1 has objectives 3.1.1[a] to [f]; objective IDs are unique and prefixed by their requirement — catalog.test.ts › objective ids`
  - `[test] Metadata has both sources, each with a URL and a 64-hex SHA-256, and catalogKey is nist-800-171-r2@1.0.0 — catalog.test.ts › source metadata and key`
  - `[test] Every override ID exists and is listed in the README — catalog.test.ts › overrides are documented`
  - `[test] The schema rejects a duplicate requirement, an objective under the wrong requirement, a requirement with no objectives, and a family list that disagrees with the requirements — packages/catalog/src/schema.test.ts › rejects malformed catalogs`
  - `[test] The parser strips headers and footers, joins hyphenated breaks, reads objectives across a page break, and sorts 3.1.10 after 3.1.9 — packages/catalog/scripts/parse.test.ts › parses fixture excerpts`
  - `[test] A checksum mismatch throws without writing; the same inputs give byte-identical JSON; an override for an unknown ID, or one whose text equals the parsed text, throws — parse.test.ts › convert guards`
  - `[test] IA-L2-3.5.1 normalizes to IA.L2-3.5.1; an ID in two point lists, or one not in the catalog, throws — packages/catalog/scripts/points.test.ts › normalizes and validates point lists`
- **Depends on:** B1
- **One-way door:** none
- **Model:** opus

### R1: Rules: requirement status and SPRS score
- **Scope:**
  - Write the tests first.
  - Export from `@rampart/rules`:
    - `deriveRequirementOutcomes(catalog, input): RequirementOutcome[]` (catalog order)
    - `computeScore(catalog, input): ScoreResult`
    - `scoreMax(catalog)` and `scoreFloor(catalog)`
  - Follow the contract's status, validation and score rules. Every test table row cites 32 CFR 170.24 or the plan's Objectives rule.
  - Tests use a small fixture catalog builder you own. The real catalog is R3's job.
  - Does not include POA&M or Conditional logic.
- **Files owned:** `packages/rules/src/index.ts`, `packages/rules/src/{status.ts,score.ts,validate.ts}` (new), `packages/rules/src/testing/fixture-catalog.ts` (new), `packages/rules/src/status.test.ts` (new), `packages/rules/src/score.test.ts` (new)
- **Success criteria:**
  - `[test] Status table: any not_met gives not_met; a missing or not_assessed objective gives not_assessed; met plus na gives met; all na gives met with allNa — packages/rules/src/status.test.ts › derives requirement status`
  - `[test] Unknown objective, duplicate objective, level on a requirement without partial credit, and level on an unknown requirement each throw RulesInputError with their code — status.test.ts › rejects invalid input`
  - `[test] All met scores max; each not_met deducts its points; not_assessed deducts 0 and is listed — packages/rules/src/score.test.ts › scores from requirement outcomes`
  - `[test] Partial credit: not_met at partial deducts 3; at none or unset deducts 5; met at any level deducts 0 — score.test.ts › partial credit levels`
  - `[test] A prerequisite that is not_met, not_assessed, or has an na objective gives kind incomplete with no score — score.test.ts › prerequisite makes the result incomplete`
  - `[test] max and floor follow the fixture data, and changing a fixture's points changes the floor — score.test.ts › max and floor are derived from data`
  - `[test] Inputs are not mutated, and repeat calls give equal results with deductions in catalog order — score.test.ts › pure and deterministic`
- **Depends on:** B1
- **One-way door:** none
- **Model:** opus

### R2: Rules: POA&M eligibility, Conditional check, 180-day clock
- **Scope:**
  - Write the tests first.
  - `@rampart/rules/poam` exports:
    - `REGULATION`
    - `checkPoamEligibility(catalog, { requirementId, status, implementationLevel? }, regulation = REGULATION)`
    - `checkConditional(catalog, outcomes, score, regulation = REGULATION)`
    - `closeoutClock(conditionalStatusDate, today, regulation = REGULATION)`
    - `closeoutConfirmer(type, regulation = REGULATION)`
  - Follow the contract's regulation data, eligibility, Conditional and clock rules. `outcomes` and `score` are inputs, so don't import R1's code.
  - Tests use your own fixture catalog with the six barred IDs, 3.5.3, 3.13.11 and a 3-point requirement.
- **Files owned:** `packages/rules/src/poam/{index.ts,regulation.ts,eligibility.ts,conditional.ts,clock.ts,fixtures.ts}` (new), `packages/rules/src/poam/regulation.test.ts` (new), `packages/rules/src/poam/eligibility.test.ts` (new), `packages/rules/src/poam/conditional.test.ts` (new), `packages/rules/src/poam/clock.test.ts` (new)
- **Success criteria:**
  - `[test] Every regulation value carries a citation starting "32 CFR 170.21" or "32 CFR 170.24", and the barred list is exactly the six IDs — packages/rules/src/poam/regulation.test.ts › values are cited data`
  - `[test] Each of the six barred requirements is rejected with barred — eligibility.test.ts › rejects barred requirements`
  - `[test] A met or not_assessed requirement is rejected with not_not_met; a 1-point not_met requirement is accepted — eligibility.test.ts › only not_met requirements`
  - `[test] A 3-point requirement, and 3.5.3 at partial, are rejected with exceeds_point_limit; 3.13.11 at partial is accepted; 3.13.11 at none or unset is rejected — eligibility.test.ts › point limit and the 3.13.11 exception`
  - `[test] Reasons are all collected in contract order; an unknown requirement throws — eligibility.test.ts › collects reasons`
  - `[test] Passing a regulation with a different limit or barred list changes the outcome — eligibility.test.ts › rules read regulation data`
  - `[test] Score 88 with no other blockers is conditional; 87 gives below_threshold; all met at 110 is final — packages/rules/src/poam/conditional.test.ts › threshold and final`
  - `[test] An incomplete score gives incomplete with prerequisite_not_met; not_assessed requirements give one blocker; blockers come in contract order — conditional.test.ts › blockers and order`
  - `[test] A not_met barred requirement gives poam_ineligible with barred, and the status is not_eligible — conditional.test.ts › ineligible not_met blocks`
  - `[test] Deadline is the date plus 180 days for 2026-03-01, 2027-01-01 and 2028-01-01, with the expected dates in the contract — packages/rules/src/poam/clock.test.ts › computes the deadline`
  - `[test] daysRemaining is 180 on the start date, 0 on the deadline, and -1 the day after, when expired becomes true; malformed and impossible dates throw invalid_date — clock.test.ts › countdown edges`
  - `[test] Self gives organization and c3pao gives c3pao — clock.test.ts › closeout confirmer by assessment type`
- **Depends on:** B1
- **One-way door:** none
- **Model:** opus

### A1: API and DB skeleton: config, errors, logging, headers, migrations
- **Scope:**
  - Build everything under API contract: the zod config, the `buildApp({ config, db })` factory, server start (config → open DB → migrate → listen, exit 1 on failure), the error envelope, the request ID, redacted logging, helmet, the body limit, a response-schema helper, and the DB client, schema and first migration.
  - Add `db:migrate` and `db:generate` scripts in `apps/api`, plus a root `db:migrate`.
  - Update the root README's scripts, and the brief's `## Smoke recipe` **DB setup** line: migrations run on start, or `pnpm db:migrate`; no seed yet.
  - Does not include sessions, cookies, CSRF or any domain endpoint (assessment sprint).
  - If better-sqlite3 fails to install or build on Windows, add a `BLOCKED` queue entry rather than switching drivers.
- **Files owned:** `apps/api/package.json` (scripts only), `apps/api/tsconfig.json`, `apps/api/src/{app.ts,server.ts}`, `apps/api/src/{config.ts,errors.ts,logger.ts,respond.ts}` (new), `apps/api/src/contract/index.ts`, `apps/api/src/contract/{health.ts,error.ts}` (new), `apps/api/db/{schema.ts,client.ts,migrate.ts}` (new), `apps/api/db/migrations/*` (new), `apps/api/drizzle.config.ts` (new), `apps/api/src/app.test.ts`, `apps/api/src/config.test.ts` (new), `apps/api/src/respond.test.ts` (new), `apps/api/src/contract/contract.test.ts` (new), `apps/api/db/db.test.ts` (new), root `package.json` (scripts only), `README.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] Defaults apply; ports 1 and 65535 are accepted; 0, 65536 and "abc" are rejected; one ConfigError names every bad key — apps/api/src/config.test.ts › validates env`
  - `[test] Health gives 200 {status:'ok',db:'ok'}; with a closed DB it gives 503 db_unavailable in the envelope — apps/api/src/app.test.ts › health reports db state`
  - `[test] An unknown route gives 404 not_found in the envelope with a requestId — app.test.ts › not found envelope`
  - `[test] A JSON body over 1 MiB gives 413 payload_too_large — app.test.ts › body limit`
  - `[test] A thrown error gives 500 internal_error with a generic message and no stack — app.test.ts › internal errors do not leak`
  - `[test] A valid x-request-id is echoed; an invalid or missing one is replaced by a UUID — app.test.ts › request id`
  - `[test] Responses carry CSP and nosniff, and no x-powered-by — app.test.ts › security headers`
  - `[test] Log output redacts the cookie and authorization headers — app.test.ts › logs are redacted`
  - `[test] A payload that fails its response schema becomes a 500 internal_error — apps/api/src/respond.test.ts › rejects off-contract responses`
  - `[test] Contract files import only zod or relative paths, and PRODUCT_NAME is "Rampart" — apps/api/src/contract/contract.test.ts › contract is browser-safe`
  - `[test] Migrate creates assessment; a second run is a no-op; foreign_keys is on; type defaults to self and rejects other values — apps/api/db/db.test.ts › migrations and constraints`
- **Depends on:** B1
- **One-way door:** none
- **Model:** opus

### L1: Look: tokens, self-hosted fonts, base controls
- **Scope:**
  - Build everything under Look contract: `tokens.ts` (the source of truth), `tokens.css`, `base.css` (reset, Vellum body, Ink text, Inter 16), `fonts.ts` (the @fontsource imports for exactly the six weights) and `contrast.ts` (the WCAG ratio, plus the body and large text-pair lists).
  - **Base controls:**
    - `Button`: `primary` is solid red with Sheet text; `secondary` has a 1.5 px Ink border. Square, at least 44 px tall, `type="button"` by default.
    - `TextField`: label, underline-only input, error state. The error shows a red underline mark, with the message in Ink, linked by `aria-describedby` and `aria-invalid`.
    - `StatusChip`: met is a blue GO block plus "Met"; not_met is a red NO GO block plus "Not Met"; na is a dashed "—" plus "N/A"; not_assessed is a graphite "—" plus "Not Assessed".
    - `GraduatedBar`: `role="progressbar"`, ticks every 10%, an Ink travel bar, the value clamped to 0–100 (NaN → 0).
    - `SectionLabel`: a ballooned integer of 1 or more, then the text.
  - The guard tests scan all of `apps/web/src` and the HTML files, so they police every later UI slice too.
  - A dev-only specimen page at `/look.html` shows every control in every state; it is not in the build.
  - Does not include the ruler, the stamp or page layout (ssp-dashboard sprint).
- **Files owned:** `apps/web/src/look/{tokens.ts,tokens.css,base.css,fonts.ts,contrast.ts,index.ts}` (new), `apps/web/src/look/{Button,TextField,StatusChip,GraduatedBar,SectionLabel}.tsx` (new), `apps/web/src/look/*.module.css` (new), `apps/web/src/look/Specimen.tsx` (new), `apps/web/look.html` (new), `apps/web/src/look/tokens.test.ts` (new), `apps/web/src/look/contrast.test.ts` (new), `apps/web/src/look/guards.test.ts` (new), `apps/web/src/look/controls.test.tsx` (new)
- **Success criteria:**
  - `[test] Exactly six colour tokens with the plan's hex values; tokens.css matches tokens.ts; every size token is 16 px or more; the three font families have fallbacks — apps/web/src/look/tokens.test.ts › token values`
  - `[test] Every body pair is at least 4.5:1, every large pair at least 3:1, and red on Vellum is below 4.5 and absent from the body list — apps/web/src/look/contrast.test.ts › text pairs meet WCAG`
  - `[test] No colour literal outside tokens, no font-size except through var(--rp-text-*), no font shorthand or inline fontSize, and no http(s) font URL anywhere in apps/web — apps/web/src/look/guards.test.ts › only tokens and self-hosted fonts`
  - `[test] Button defaults to type=button, exposes data-variant, and a disabled button ignores clicks — apps/web/src/look/controls.test.tsx › Button`
  - `[test] The TextField label is associated, and the error sets aria-invalid and aria-describedby — controls.test.tsx › TextField`
  - `[test] StatusChip renders GO / NO GO / — with the status word for each of the four statuses — controls.test.tsx › StatusChip`
  - `[test] GraduatedBar sets aria-valuenow, and clamps -5 to 0, 150 to 100, and NaN to 0 — controls.test.tsx › GraduatedBar`
  - `[test] SectionLabel renders the balloon number with the text and throws RangeError for 0 or 1.5 — controls.test.tsx › SectionLabel`
  - `[manual] The specimen at 1280 px and 375 px matches look-3's Inspection column: square buttons, underline inputs, GO / NO GO blocks, graduated bar; no shadows, gradients or rounded cards; no horizontal scroll at 375 px — open http://127.0.0.1:<web>/look.html`
  - `[manual] Fonts load as same-origin woff2 files — DevTools Network on look.html`
- **Depends on:** B1
- **One-way door:** none
- **Model:** opus

### S1: Web shell: masthead, nav, routes, API client
- **Scope:**
  - `main.tsx` imports the look's fonts and base CSS and mounts a react-router app.
  - **Masthead:** the brand from `PRODUCT_NAME` in display type, and a text nav with Dashboard `/`, Assessment `/assessment`, POA&M `/poam`, Evidence `/evidence`, Policies `/policies`, SSP `/ssp` and Settings `/settings`. The active tab has `aria-current="page"` and a red underline.
  - Crosshair registration marks (aria-hidden) at the top corners. Sections are separated by 1.5 px Ink rules.
  - Each route has an `<h1>` and a one-line empty state ("This section isn't built yet."). Unknown paths show "Page not found" with a link to the Dashboard. `document.title` is `<Page> · <PRODUCT_NAME>`.
  - **Phone:** at 767 px and below, the nav collapses behind a "Menu" button with `aria-expanded`. Choosing a link closes it, and Escape closes it and returns focus to the button.
  - **`apiGet(path, schema)`:** parses the response with the contract schema and throws `ApiError { status, code, message, requestId? }`. The code comes from the error envelope, `network_error` on a fetch failure, or `invalid_response` for non-JSON or a schema mismatch.
  - **API status:** the shell calls health once on load. On failure it shows an alert: "Can't reach the API", with a Retry button, a red 1.5 px border and Ink text.
  - Uses only L1 controls and tokens.
  - Update the brief's `## Smoke recipe` **Key URLs** with the seven routes.
  - Does not include the inspection strip, the ruler, the user slot or the CUI banner (later sprints).
- **Files owned:** `apps/web/src/{main.tsx,App.tsx,App.test.tsx}`, `apps/web/src/shell/{Shell.tsx,Masthead.tsx,NavMenu.tsx,RegistrationMarks.tsx,ApiStatus.tsx,routes.tsx}` (new), `apps/web/src/shell/*.module.css` (new), `apps/web/src/pages/{PlaceholderPage.tsx,NotFound.tsx}` (new), `apps/web/src/api/client.ts` (new), `apps/web/src/api/client.test.ts` (new), `apps/web/src/shell/Shell.test.tsx` (new), `apps/web/src/shell/ApiStatus.test.tsx` (new), `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] All seven tabs link to their routes, and only the current one has aria-current=page — apps/web/src/shell/Shell.test.tsx › nav marks the current tab`
  - `[test] Each route renders its h1 and sets document.title — Shell.test.tsx › routes and titles`
  - `[test] An unknown path shows Page not found with a Dashboard link — Shell.test.tsx › not found`
  - `[test] The Menu button toggles aria-expanded; choosing a link closes it; Escape closes it and focuses the button — Shell.test.tsx › phone menu`
  - `[test] A valid response is parsed; the envelope maps to ApiError with code and requestId; fetch rejection gives network_error; non-JSON or a schema mismatch gives invalid_response — apps/web/src/api/client.test.ts › apiGet`
  - `[test] Nothing shows while health is ok; failure shows the alert; a successful Retry clears it — apps/web/src/shell/ApiStatus.test.tsx › api status banner`
  - `[manual] At 1280 px: the masthead, red underline on the active tab, registration marks at both top corners, and Inter, Space Grotesk and Space Mono rendered — pnpm dev, open http://127.0.0.1:<web>/`
  - `[manual] At 375 px: no horizontal scroll, the Menu opens and closes, and every tab is reachable — DevTools device mode`
  - `[manual] With the api stopped, the offline alert shows; after starting it, Retry clears it — stop and start the api`
- **Depends on:** L1, A1
- **One-way door:** none
- **Model:** sonnet

### R3: Rules against the real catalog: the plan's verification table
- **Scope:**
  - Run R1 and R2 against `loadCatalog()`, building the scenarios from catalog data. Pick requirements by their points; don't assume IDs beyond those the plan names.
  - Check that every requirement ID in `REGULATION` exists in the real catalog.
  - Write `packages/rules/README.md`, listing every rule with its citation and test file.
  - No new rule logic. If a real-catalog case fails, fix nothing here: add a `BLOCKED` queue entry naming the failing rule.
- **Files owned:** `packages/rules/src/catalog.integration.test.ts` (new), `packages/rules/README.md` (new)
- **Success criteria:**
  - `[test] All met scores 110; every points requirement not_met with 3.12.4 met scores -203, and scoreFloor equals -203 — packages/rules/src/catalog.integration.test.ts › extremes on the real catalog`
  - `[test] 3.12.4 not_met gives incomplete — catalog.integration.test.ts › missing SSP is incomplete`
  - `[test] 3.5.3 and 3.13.11 not_met deduct 3 at partial and 5 at none — catalog.integration.test.ts › partial credit on real data`
  - `[test] A built 88 is conditional and 87 is below_threshold — catalog.integration.test.ts › threshold on real data`
  - `[test] All six barred requirements are rejected; a real 3-point requirement other than 3.13.11 is rejected; 3.13.11 at partial is accepted — catalog.integration.test.ts › eligibility on real data`
  - `[test] Plan main flow: 3.1.20 not_met with a score of 72 gives not_eligible with below_threshold and poam_ineligible(3.1.20, barred) — catalog.integration.test.ts › main flow 72 with 3.1.20`
  - `[test] Every barred and exception ID in REGULATION exists in the catalog — catalog.integration.test.ts › regulation ids resolve`
- **Depends on:** C1, R1, R2
- **One-way door:** none
- **Model:** sonnet

## Sprint summary

- **Synced with merge-target:** up to date. The plan branch was cut from `main` this sprint, and `main` has had no new commits.
- **Slices shipped:** B1, C1, R1, R2, A1, L1, S1, R3 (PRs #1, #2 and #3 into `cmmc-l2-grc`)
- **Queue entries:** resolved 0, deferred 5. Two are PENDING for the human (C1 `[a]` objective IDs; C1 3.3.2 wording), and three are PENDING for the sprint-planner (R1 runtime status validation in the API; R2 `Regulation` lacks a not-met-only citation field; A1 client-error code mapping). All are in `pod-docs/handoff-queue.md`.
- **Slice log:**
  - B1: opus · medium · test-first yes · runtime both URLs on 127.0.0.1 via the Vite proxy, plus a fresh-clone verify · 7 NOTEs · time lost: corepack EPERM, and the better-sqlite3 13 node-gyp failure (pinned to ^12)
  - W1 wave fix: opus · medium · test-first yes · CI run 45344030186 failed because setup-node v5 called pnpm before corepack. Fixed with `package-manager-cache: false` and proven by CI run 45344487007 going green · time lost: none
  - C1: opus · medium · test-first yes (one red came from ENOENT) · runtime: converter on the real PDFs twice with identical sha256, a tampered PDF refused, a consumer import · 4 NOTEs · time lost: none
  - R1: opus · medium · test-first yes (two guard tests were green on the stub) · runtime: tsx through the package entry · 3 NOTEs · time lost: none
  - R2: opus · medium · test-first yes (some accept rows were green on the stub) · runtime: tsx through `@rampart/rules/poam`, plus dev servers · 4 NOTEs · time lost: none
  - A1: opus · medium · test-first yes · runtime: built server with curl, the Vite proxy, and a browser · 6 NOTEs · time lost: none
  - L1: opus · medium · test-first yes · runtime: `/look.html` at 1280 and 375 px in a browser, with same-origin woff2 fonts · 6 NOTEs · time lost: none
  - S1: sonnet · medium · test-first partly (red came from import failures, not assertions) · runtime: shell at 1280 and 375 px, plus the api stopped and started · 7 NOTEs · time lost: none
  - R3: sonnet · high · test-first n/a (it checks existing code; each test was proven red by breaking one expectation) · runtime: the real catalog through `@rampart/rules` · 0 NOTEs · time lost: none
  - Stalls: none
- **Agent context at hand-back:** about 1,133,000 tokens. That's the sum of each engineer's and planner's reported `subagent_tokens`, which is each agent's final context size, not tokens billed.
- **For the next sprint:**
  - The rules are pure functions keyed by the catalog, and the catalog is `nist-800-171-r2@1.0.0`.
  - The API error envelope, request ID, `respond()` schema helper and the `assessment` table exist.
  - `apps/web/src/shell/routes.tsx` (`APP_ROUTES`) is the single nav list, and `usePageTitle` sets page titles.
  - L1's `Button` does not forward refs.
  - `ApiStatus` treats every health failure the same.
  - The local pnpm needs the corepack workaround (`pod-docs/known-issues/corepack-enable-eperm.md`).
