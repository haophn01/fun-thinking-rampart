# Rampart

A self-hosted CMMC Level 2 readiness platform. One defense contractor runs it locally to assess
the 320 NIST SP 800-171A (Rev 2) objectives, see a live SPRS score, check Conditional status and
keep a rules-checked POA&M. "Rampart" is a placeholder name; the code spells it only once, as
`PRODUCT_NAME` in `@rampart/api/contract`.

> **No CUI in V1.** Do not put Controlled Unclassified Information in this tool. V1 has no
> encrypted storage, no hosting hardening and no backups. Evidence that contains CUI is stored as a
> reference only, never as a file.

## Setup

You need Node 24 or later. pnpm comes from corepack, pinned by the `packageManager` field in
`package.json`, so everyone runs the same version.

From a clean clone, one command installs, migrates and starts the app (PowerShell or bash):

```sh
corepack pnpm start
```

It runs `pnpm install --frozen-lockfile`, then `pnpm db:migrate`, then `pnpm dev`, and stops at
the first step that fails with that step's exit code. Open http://127.0.0.1:3000: a new database
shows Setup, where you create the first admin. Stop it with Ctrl+C. `corepack pnpm` needs no
`corepack enable`, so it works even where that command fails.

`pnpm dev` starts the api on http://127.0.0.1:3001 and the web app on http://127.0.0.1:3000. Both
bind to `127.0.0.1` only. Change the ports with `API_PORT` and `WEB_PORT` (`pnpm start` passes them
through):

```sh
API_PORT=3011 WEB_PORT=3010 pnpm dev                 # bash
$env:API_PORT=3011; $env:WEB_PORT=3010; pnpm dev     # PowerShell
```

To type plain `pnpm …`, run `corepack enable` once. If it fails with `EPERM` (Node is installed in
a folder you can't write to), either run it from an elevated shell, put the shims in a folder of
your own that is on your `PATH` (`corepack enable --install-directory <folder> pnpm`), or keep
prefixing commands with `corepack`.

### End-to-end tests

`pnpm e2e` runs the Playwright specs in `e2e/` in Chromium. It needs the browser once per machine:

```sh
pnpm exec playwright install chromium
pnpm e2e
```

Each run starts its own api (without watch) and web app on `127.0.0.1`, on `E2E_WEB_PORT`
(default 3290) and `E2E_API_PORT` (default 3291), with a new database and file store in a fresh
temporary folder (`E2E_RUN_DIR`), so it never touches `apps/api/data`. A failing test keeps its
trace and screenshot in `test-results/`, and the HTML report goes to `playwright-report/`. Vitest
never collects `e2e/`, so `pnpm verify` needs no browser.

## Scripts

Run these from the repo root.

| Script            | What it does                                                               |
| ----------------- | -------------------------------------------------------------------------- |
| `pnpm start`      | Frozen install, then `db:migrate`, then `dev` (`scripts/start.ts`)         |
| `pnpm dev`        | Runs the api (`tsx watch`) and the web app (Vite) in parallel              |
| `pnpm lint`       | `eslint .`, then `prettier --check .`                                      |
| `pnpm format`     | `prettier --write .`                                                       |
| `pnpm typecheck`  | `tsc --noEmit` in every workspace package                                  |
| `pnpm test`       | `vitest run` across every package plus the repo checks in `tests/`         |
| `pnpm build`      | Bundles the api with tsup and the web app with Vite                        |
| `pnpm verify`     | lint, typecheck, test, build, in that order, stopping at the first failure |
| `pnpm e2e`        | Playwright specs in `e2e/` against a fresh api and web app (see above)     |
| `pnpm db:migrate` | Applies pending database migrations (the api also does this on start)      |

Run `pnpm verify` before you open a pull request; CI runs the same command, and runs `pnpm e2e`
in a job of its own on Ubuntu and Windows.

`pnpm --filter @rampart/api db:generate` writes a new SQL migration into
`apps/api/db/migrations` from `apps/api/db/schema.ts`. The database changes only through
migrations: change the schema, generate, commit the SQL, and never edit a migration once it is
committed.

## Configuration

The api reads these environment variables and refuses to start (exit code 1) if any is invalid,
naming every bad one:

| Variable        | Default               | Rules                                                                                                                                                  |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `API_PORT`      | `3001`                | An integer from 1 to 65535                                                                                                                             |
| `DATABASE_PATH` | `data/rampart.sqlite` | Relative paths are resolved from `apps/api`; the folder is created; `:memory:` works                                                                   |
| `LOG_LEVEL`     | `info`                | A pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                                                           |
| `STORAGE_PATH`  | `data/files`          | The evidence and policy file store. Relative paths are resolved from `apps/api`; the folder is created on the first upload; whitespace only is refused |

An empty value counts as unset. The host is always `127.0.0.1`. On start the api opens the SQLite
database (WAL, foreign keys on), applies pending migrations, then listens. There is no seed data
yet.

Uploaded files are content-addressed: each is stored once under its SHA-256 at
`<STORAGE_PATH>/<first two hex characters>/<sha256>`, and its bytes are hashed again on every
download, so a missing or altered file is reported instead of served. Writes go through
`<STORAGE_PATH>/tmp/` and are renamed into place. Files are not encrypted at rest yet, and the
api never deletes them. Back up the `STORAGE_PATH` folder together with the database.

The api logs JSON lines (pino) with the request's id on every line; cookies, `authorization` and
`set-cookie` are redacted. Every error response has the same shape,
`{ "error": { "code", "message", "requestId", "details"? } }`, and the `x-request-id` header
carries the same id.

## Sign-in and security defaults

The first run has no users: open the web app and **Setup** creates the first admin (any email, a
password of 12 to 128 characters) and the self-assessment. After that, setup answers 409 and
admins add people under Settings.

- **Every api route needs a signed-in user** except `GET /api/health`, `GET /api/session`,
  `POST /api/setup`, `POST /api/session` (sign in) and `DELETE /api/session` (sign out).
- **Passwords** are hashed with Argon2id (`@node-rs/argon2` defaults). Passwords, hashes and
  session tokens never appear in a response, a log line or the audit log.
- **Sessions** live in the database; the browser holds a random token in the `rampart_session`
  cookie (`HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`), and the database stores only its
  SHA-256. A session ends after 2 hours idle or 12 hours in all. Sign-in always starts a new
  session. Deactivating a user or resetting their password ends all their sessions. There is no
  `Secure` flag yet because V1 serves plain http on `127.0.0.1`.
- **CSRF:** every `POST`, `PUT`, `PATCH` and `DELETE` made with a session must send the
  session's token (from `GET /api/session`) in the `x-csrf-token` header. Bodies must be
  `application/json`, so a cross-site form can't post.
- **Lockout:** the 5th wrong password in a row locks the account for 15 minutes (429 with
  `Retry-After`). Unknown emails, wrong passwords and inactive users all get the same 401.
- **Roles:** `admin` manages users and assessment settings; `contributor` records results. The
  last active admin can't be demoted or deactivated. Users are never deleted.
- **Audit log:** every change is written to an append-only `audit_event` table in the same
  transaction; `GET /api/audit` pages through it newest first.

## API endpoints

Every route below needs a signed-in user, and every write needs the `x-csrf-token` header and a
JSON body. Request bodies are strict: an unknown key gives 400.

| Route                                               | Who      | What it does                                                                                                                                        |
| --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/assessment`                               | any user | The assessment, its stored objective results and requirement state (catalog order), the evaluation, and the POA&M closeout clock (or `null`)        |
| `PATCH /api/assessment`                             | admin    | `{ type?, conditionalStatusDate? }`; a `null` date clears it. Answers with the whole view                                                           |
| `PUT /api/assessment/objectives/:objectiveId`       | any user | `{ status, note }`, with `status` exactly `met`, `not_met`, `na` or `not_assessed`. URL-encode the ID (`3.1.1%5Ba%5D`). Answers with the evaluation |
| `PATCH /api/assessment/requirements/:requirementId` | any user | `{ implementationStatement?, implementationLevel?, ownerId? }`; `null` unsets. Answers with the evaluation                                          |

- **One evaluation:** every response's `evaluation` is `evaluateAssessment` from `@rampart/rules`
  over the stored rows, the same function the web app runs for its live and what-if scores. A
  missing objective result means not assessed.
- **Implementation level** is only for the partial-credit requirements (3.5.3 and 3.13.11); on
  any other requirement it gives 400. `null` means the worst case.
- **Owner:** `ownerId` must be an active user (400 otherwise). An owner deactivated later stays
  assigned and shows `active: false`.
- **Closeout clock:** "today" is the UTC date of the api's clock.
- **Audit:** each write and its audit event commit in one transaction; only changed fields are
  recorded, and a write that changes nothing answers 200 and records nothing.
- Unknown objectives and requirements give 404; with no assessment row (before setup) every
  assessment route gives 404.

## Parts

| Package            | Folder             | What it does                                                                                            |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `@rampart/catalog` | `packages/catalog` | The NIST SP 800-171 Rev 2 catalog as versioned data: families, requirements, objectives and SPRS points |
| `@rampart/rules`   | `packages/rules`   | Pure functions: requirement status, SPRS score, POA&M eligibility, Conditional check, 180-day clock     |
| `@rampart/api`     | `apps/api`         | Fastify HTTP API on `/api`, the only writer of the SQLite database; also owns the shared contract       |
| `@rampart/web`     | `apps/web`         | React app built with Vite                                                                               |

## How they connect

- The browser talks only to the web app's origin. In dev, Vite proxies `/api` to the api.
- The web app imports `@rampart/api/contract` (zod schemas and constants, nothing server-side),
  `@rampart/catalog` and `@rampart/rules`, so it can show a live what-if score without a round trip.
- The api imports `@rampart/rules` to derive status, score and eligibility, and the rules read
  points and objective lists from `@rampart/catalog`.
- Internal packages export their TypeScript source. Only the apps build: tsup bundles the
  workspace packages into the api, and Vite does the same for the web app.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
