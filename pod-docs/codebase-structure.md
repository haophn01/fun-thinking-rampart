# Codebase structure

_For agents: scout writes it and engineers read it before coding. You check it and fix what's wrong._

> High-level overview only — what the system is and how its parts fit. No file lists or deep directory trees: those change every sprint, and agents read the code for detail. Name a path only for a part's top-level folder.

The **`## Smoke recipe`** below tells each engineer how to bring the app up for browser verification (per `pod:engineer`'s instructions). Fill it in; engineers need it to verify their slices.

## What it is

Rampart (a placeholder name) is a self-hosted CMMC Level 2 readiness platform: one defense contractor runs it locally to assess the 320 NIST SP 800-171A Rev 2 objectives, see a live SPRS score and Conditional-status check, and keep a rules-checked POA&M. No CUI in V1.

## Parts

- `@rampart/catalog` (`packages/catalog`): the NIST SP 800-171 Rev 2 catalog as versioned data (families, requirements, objectives, SPRS points) with its types and loader.
- `@rampart/rules` (`packages/rules`): pure functions for requirement status, SPRS score, POA&M eligibility, the Conditional check and the 180-day clock; `@rampart/rules/poam` holds the cited regulation data.
- `@rampart/api` (`apps/api`): Fastify HTTP API under `/api`, the only writer of the SQLite database; `@rampart/api/contract` is the browser-safe contract (zod and constants such as `PRODUCT_NAME`).
- `@rampart/web` (`apps/web`): React 19 app built with Vite.

## How they connect

- Browser → web (Vite). In dev, Vite proxies `/api` to the api on `127.0.0.1:${API_PORT}`.
- web imports `@rampart/api/contract` (contract only, never server code), `@rampart/catalog` and `@rampart/rules` (for the live what-if score).
- api imports `@rampart/rules` and `@rampart/catalog`; rules imports catalog. Nothing imports web or api internals.
- Internal packages export TypeScript source (`exports` → `./src/*.ts`); only the apps build. tsup bundles the workspace packages into `apps/api/dist`, and Vite bundles the web app.
- State lives only in one SQLite file written by the api (from the API and DB skeleton slice on).

## Stack & conventions

- **Runtime and packages:** Node `>=24`; pnpm (pinned in the root `packageManager`, enabled with corepack); pnpm workspace `packages/*` and `apps/*`; every package is `"type": "module"`. `pnpm-workspace.yaml` allows only the `better-sqlite3` and `esbuild` build scripts and refuses versions published less than a day ago (`minimumReleaseAge: 1440`).
- **Lockfile frozen after bootstrap:** later slices may edit `scripts` in a package.json they own, never dependencies.
- **TypeScript 6** with `moduleResolution: "Bundler"` and strict flags in `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`). Each package has a `tsconfig.json` extending it and a `typecheck` script (`tsc --noEmit`); the root `tsconfig.json` covers `tests/` and root config files for the linter. Source imports are extensionless; config files that Vite or Node load directly (`vite.config.ts`) import with a `.ts` extension.
- **Lint and format:** ESLint flat config (`eslint.config.js`) with typescript-eslint `strictTypeChecked` (type-aware through the project service), react-hooks and eslint-config-prettier. Prettier: single quotes, width 100, `endOfLine: "lf"`; `.gitattributes` forces LF so Windows checkouts pass `prettier --check`. The frozen contract files `packages/catalog/src/types.ts`, `packages/rules/src/types.ts` and `packages/rules/src/errors.ts` are in `.prettierignore` so they stay word for word as the sprint doc writes them.
- **Tests:** Vitest at the root (`vitest.config.ts`) with projects `packages/*`, `apps/*` and `repo` (`tests/**/*.test.ts`). Globals are off: import `describe`/`it`/`expect` from `vitest`. The web project uses jsdom, Testing Library and jest-dom matchers (`apps/web/src/test-setup.ts`); the api is tested through `buildApp()` and `app.inject`.
- **Servers:** everything binds `127.0.0.1`. `WEB_PORT` defaults to 3000 and `API_PORT` to 3001; Vite uses `strictPort`. `apps/web/dev-ports.ts` validates both (integers 1–65535, different from each other).
- **API:** `buildApp({ config, db, now? })` in `apps/api` builds the Fastify app (`now` is the app clock; every expiry, lockout and audit `at` comes from it); `server.ts` only wires config → open DB → migrate → listen. Config is zod-validated env (`ConfigError` names every bad key). Errors always leave as the contract's envelope (`{ error: { code, message, requestId, details? } }`): throw `AppError(code, …)` for an expected failure, let zod input errors become `validation_failed`, and anything else becomes a generic 500. Handlers return `respond(schema, payload)` so responses are checked against the contract. Logs are pino JSON with a `requestId` on each line and secrets redacted.
- **Auth guard:** `registerApiRoutes(app, deps)` (`apps/api/src/routes/index.ts`) registers every session route in one encapsulated plugin whose `onRequest` guard is deny-by-default: a route needs a session unless it sets `config: { public: true }`; writes on a session need `x-csrf-token` (`skipCsrf: true` only for setup and sign-in); `config: { role: 'admin' }` limits a route to admins. Order: 401 → 403 `csrf_failed` → 403 `forbidden` → 400 → 404. The handler reads the session from `request.auth`. Add new api routes inside that plugin; health and test-only routes stay on the root. Sessions, passwords and lockout live in `apps/api/src/auth/`; every change writes `recordAudit(tx, …)` inside its transaction.
- **API tests:** `createHarness()` (`apps/api/src/testing/harness.ts`) gives an app on a migrated in-memory DB with a settable `clock`, `setupAdmin()`, `signIn()` and a `client()` that keeps the cookie and sends the CSRF header; it captures log lines in `logs`.
- **DB:** better-sqlite3 with Drizzle; schema in `apps/api/db/schema.ts`, SQL migrations generated by drizzle-kit into `apps/api/db/migrations` (never hand-edited after commit).
- **Product name:** only `PRODUCT_NAME` in `@rampart/api/contract` spells it.

## CI

`.github/workflows/pod-ci.yml`, on `pull_request` and on `push` to `main`, with `permissions: contents: read, pull-requests: read`:

- **verify** (matrix `ubuntu-latest`, `windows-latest`): checkout, setup-node 24, `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm verify`.
- **secrets** (ubuntu): checkout with `fetch-depth: 0`, then `gitleaks/gitleaks-action@v2` with `GITHUB_TOKEN`.

## Key docs

- `README.md`: setup, scripts, parts.
- `CONTRIBUTING.md`: commits, test-first, migrations-only, regulatory changes, frozen lockfile.
- `pod-docs/plans/cmmc-l2-grc.md`: the plan, its Look and its verification table.
- `pod-docs/decisions.md`: the SPRS point values and the merge target.

## Smoke recipe

- **Install:** `corepack enable; pnpm install`. If `corepack enable` fails with `EPERM` (Node's folder isn't writable, as with nvm4w on the dev machine), use `corepack enable --install-directory <a folder on your PATH> pnpm`, or call `corepack pnpm …` directly.
- **Start commands:** `API_PORT=<api> WEB_PORT=<web> pnpm dev` (bash), or `$env:API_PORT=<api>; $env:WEB_PORT=<web>; pnpm dev` (PowerShell). One command runs both servers; stop it with Ctrl+C.
- **DB setup:** migrations run when the api starts, or run `pnpm db:migrate`. The database is `apps/api/data/rampart.sqlite` unless `DATABASE_PATH` says otherwise (use a scratch path to keep runs apart). No seed yet.
- **Login credentials:** none are seeded. On a fresh database the first run shows Setup, where you create the admin (any email, a password of 12 or more characters); then sign in with it. Without the web UI: `POST /api/setup` with `{ email, displayName, password }`, keep the `rampart_session` cookie and send `csrfToken` as `x-csrf-token` on writes.
- **Key URLs:** web routes `http://127.0.0.1:<web>/` (Dashboard), `/assessment`, `/poam`, `/evidence`, `/policies`, `/ssp` and `/settings` (each an empty-state page for now; any other path shows "Page not found"); the shell calls health on load and shows a "Can't reach the API" alert with Retry when the api is down; api `http://127.0.0.1:<api>/api/health` (public) and `/api/session` (public; reports `setupRequired`); every other api route needs a session. The api is also reachable through the web origin at `http://127.0.0.1:<web>/api/health` (Vite proxy).
- **Verification:** `pnpm verify`
