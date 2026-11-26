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

From a clean clone, one command installs, builds, migrates and starts the app (PowerShell or
bash):

```sh
corepack pnpm start
```

It runs `pnpm install --frozen-lockfile`, then `pnpm build`, then `pnpm db:migrate`, then the
built api with `SERVE_WEB=true`, and stops at the first step that fails with that step's exit
code. This is the production serving path: one server answers both the built pages and `/api` on
`WEB_PORT` (default 3000), with the strict Content-Security-Policy on every page. Open
http://127.0.0.1:3000: a new database shows Setup, where you create the first admin. Stop it with
Ctrl+C. `corepack pnpm` needs no `corepack enable`, so it works even where that command fails.
Port 3001 isn't used by `pnpm start`: it sets the api's `API_PORT` to `WEB_PORT`.

```sh
WEB_PORT=3010 corepack pnpm start                    # bash
$env:WEB_PORT=3010; corepack pnpm start              # PowerShell
```

For development, `pnpm dev` is unchanged: it starts the api (`tsx watch`) on
http://127.0.0.1:3001 and the web app (Vite, with hot reload) on http://127.0.0.1:3000, and Vite
proxies `/api` to the api. Both bind to `127.0.0.1` only. Vite serves no CSP, so check anything
CSP-related with `pnpm start` or `pnpm e2e`. Change the ports with `API_PORT` and `WEB_PORT`:

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

Each run builds the app (`pnpm build`), then starts one server on the production path: the built
api with `SERVE_WEB=true`, serving the built pages and `/api` on `127.0.0.1:E2E_WEB_PORT` (default
3290), with a new database and file store in a fresh temporary folder (`E2E_RUN_DIR`), so it never
touches `apps/api/data`. There is no Vite in the run. Its rate limits are the real ones raised a
hundredfold (`RATE_LIMIT_MULTIPLIER=100`) so the suite's own traffic never trips them. The build
makes the first start slow; the server gets 300 s to answer. A failing test keeps its
trace and screenshot in `test-results/`, and the HTML report goes to `playwright-report/`. Vitest
never collects `e2e/`, so `pnpm verify` needs no browser.

The specs, in the order Playwright runs them (file name order):

- `look.spec.ts` checks the Look, signed in, on every route in the nav (plus a requirement's
  detail and the phone menu) at 1280 and 375 px: no visible text under 16 px, only the six palette
  colours (or transparent) for text, backgrounds and borders, every text pair at 4.5:1 (3:1 for
  large text), and no horizontal scroll at 375 px. Because it runs first and the other specs need a
  fresh install, it starts a second api of its own on 3293 (`E2E_LOOK_API_PORT` overrides it)
  with its own database in the run folder, fills every page through that api, and routes the
  browser's `/api` calls to it. The pages still come from the run's server, under its CSP, and
  every page records zero CSP violations (a `securitypolicyviolation` listener). Every SSP tab is
  measured with its data, Lint & export with its findings on screen, and a seeded future-tense
  statement shows its finding there.
- `security.spec.ts` checks the security headers on the production path. On the run's server it
  only reads, signed out: `/` and `/assessment` carry the exact web CSP, `nosniff`,
  `no-referrer`, the Permissions-Policy and `X-Frame-Options: DENY` and no HSTS; `/api/health`
  carries the api CSP; the page loads only hashed `/assets/` files (immutable) and nothing from
  Vite; and the app loads with no CSP violation. It also starts a hosted server of its own on
  3294 (`HOSTED=true`, `SERVE_WEB=true`, real rate limits, so only a few requests;
  `E2E_HOSTED_PORT` overrides it) and checks HSTS and that setup's cookie is
  `__Host-rampart_session` with `Secure; HttpOnly; SameSite=Strict; Path=/` and no `Domain`, read
  from the `Set-Cookie` header (a browser keeps `__Host-` cookies only over TLS).
- `shell.spec.ts` checks that a fresh install shows Setup.
- `smoke.spec.ts` walks the plan's Verification path: create the admin, reach 72 with
  AC.L2-3.1.20 Not Met (HOLD, its blocker, and the POA&M refusal), fix it and reach ACCEPT with
  eligible POA&M items, upload evidence and see its SHA-256 (a CUI item refuses a file), upload and
  link a policy, fill the system profile and export the SSP (its text holds the profile and every
  requirement's status and statement inside section 3). Then it fills the SSP workspace (a role
  through the UI; the SSP profile, one asset per category, a provider named on an ESP matrix row,
  a PNG and a PDF diagram, the CUI item as the data flow and a dated approval through the api),
  checks that the pre-export check on Lint & export matches `GET /api/ssp/lint`, exports again and
  reads the v2 document back (the ten headings in order, the role, one embedded PNG, the PDF and
  CUI reference lines, the export's own record-of-changes row, which the api then stores as an
  `export` revision, the signature lines and both appendices), and reads the audit log. Scores
  are planned from the catalog's points, never typed in.

## Scripts

Run these from the repo root.

| Script            | What it does                                                               |
| ----------------- | -------------------------------------------------------------------------- |
| `pnpm start`      | Frozen install, build, `db:migrate`, then serve all on `WEB_PORT` (3000)   |
| `pnpm dev`        | Development: the api (`tsx watch`) and the web app (Vite) in parallel      |
| `pnpm lint`       | `eslint .`, then `prettier --check .`                                      |
| `pnpm format`     | `prettier --write .`                                                       |
| `pnpm typecheck`  | `tsc --noEmit` in every workspace package                                  |
| `pnpm test`       | `vitest run` across every package plus the repo checks in `tests/`         |
| `pnpm build`      | Bundles the api with tsup and the web app with Vite                        |
| `pnpm verify`     | lint, typecheck, test, build, in that order, stopping at the first failure |
| `pnpm e2e`        | Playwright specs in `e2e/` against a fresh production build (see above)    |
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

| Variable                | Default               | Rules                                                                                                                                                                                                                                                                     |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_PORT`              | `3001`                | An integer from 1 to 65535                                                                                                                                                                                                                                                |
| `DATABASE_PATH`         | `data/rampart.sqlite` | Relative paths are resolved from `apps/api`; the folder is created; `:memory:` works                                                                                                                                                                                      |
| `LOG_LEVEL`             | `info`                | A pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                                                                                                                                                                              |
| `STORAGE_PATH`          | `data/files`          | The evidence and policy file store. Relative paths are resolved from `apps/api`; the folder is created on the first upload; whitespace only is refused                                                                                                                    |
| `HOSTED`                | `false`               | Exactly `true` or `false`. `true` means the api sits behind one local reverse proxy on 127.0.0.1 that terminates HTTPS: HSTS, the `__Host-rampart_session` Secure cookie, `upgrade-insecure-requests` in the page CSP, and `X-Forwarded-For` honoured only from 127.0.0.1 |
| `SERVE_WEB`             | `false`               | Exactly `true` or `false`. `true` serves the built web app (`WEB_DIST_PATH`) from the api; a missing `index.html` stops the start (run `pnpm build` first). `pnpm start` sets it                                                                                          |
| `WEB_DIST_PATH`         | `../web/dist`         | The built web app's folder. Relative paths are resolved from `apps/api`. Read once at start: files added later aren't served                                                                                                                                              |
| `RATE_LIMIT_MULTIPLIER` | `1`                   | Digits only, 1 to 1000. Multiplies every rate limit's maximum (600 requests a minute per IP, and 10 a minute per IP each for setup and sign-in). Tests and e2e raise it; hosted mode needs 1                                                                              |

An empty value counts as unset. The host is always `127.0.0.1`. With `HOSTED=true` the api also
refuses to start (exit code 1, before it opens the database) unless `SERVE_WEB=true`,
`RATE_LIMIT_MULTIPLIER` is 1 and `LOG_LEVEL` isn't `debug` or `trace`, naming every rule broken.
A request over a rate limit gets 429 `too_many_attempts` with `Retry-After`. On start the api opens the SQLite
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
| `GET /api/system-profile`                           | any user | `{ profile }`: the SSP's system characteristics, every field `null` until the first save                                                            |
| `PATCH /api/system-profile`                         | any user | Any of the profile fields; blank becomes `null`, a CAGE code is 5 letters or digits, `{}` gives 400. Answers with `{ profile }`                     |
| `GET /api/ssp/lint`                                 | any user | The pre-export check: `{ version, findings, counts: { errors, warnings } }`, findings in rule order. Writes nothing                                 |
| `GET /api/ssp/export`                               | any user | The System Security Plan as a `.docx` download, `SSP-<system identifier>-<UTC date>.docx`. Appends one `export` entry to the record of changes      |

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
- **Conditional status** needs a score of at least 88 and an open POA&M item for every Not Met
  requirement (32 CFR 170.24(c)(2)(i)(B)(6)); a Not Met requirement with no open item is a
  `poam_missing` blocker.
- **SSP export:** the document follows the NIST SP 800-171 SSP outline: 1 System identification
  (with 1.1 Roles and users), 2 System environment (with 2.1 Diagrams), the CMMC CUI description,
  asset inventory and service providers with the responsibility matrix, 3 Requirements (each with
  its NIST status, points, owner, current and planned implementation, N/A rationale, policies,
  evidence and open POA&M item), 4 Record of changes, Approvals (signature lines), Appendix A
  (assessment status, SPRS, POA&M) and Appendix B (all 320 objectives). Up to 10 PNG or JPEG
  diagrams not flagged CUI are embedded; the rest are referenced by file name and SHA-256, or by
  where a CUI file is kept. Each export appends `Exported as <file name>` to the record of
  changes, after the document renders and before it is sent. Fill the data on the SSP workspace
  tabs or through the `/api/ssp/*` routes.
- **Pre-export check:** `GET /api/ssp/lint` runs `lintSspFrom` from `@rampart/rules` over the
  assessment, assets, diagram links and document control: errors (the SSP requirement isn't Met,
  no assets, an out-of-scope asset without a justification, no network diagram, review overdue,
  empty statements, Not Met without a POA&M item) and warnings (N/A without a rationale,
  future-tense statements, SSP and POA&M disagree, large images, images over the embed limit).
  The web app runs the same function on Lint & export. Findings never block the export.

## The dashboard

The Dashboard (`/`) reads the saved assessment. It shows the SPRS score on a ruler from the lowest
possible score to 110 with the Conditional line at 88, a feature control frame (`IN TOL` at 88 or
more), and the inspector's stamp: **ACCEPT** when Conditional or Final status is reachable,
otherwise **HOLD** with the number of blockers. Beside it are the Conditional check (each blocker
with its citation, the open POA&M count and the 180-day closeout clock), objective counts, family
progress and a "Needs attention" list, and under them the inspection strip. The SSP workspace
(`/ssp`) has six tabs; its Lint & export tab shows how ready the SSP is, the pre-export check and
the **Export SSP (.docx)** link.

## Parts

| Package            | Folder             | What it does                                                                                                                                                                                               |
| ------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@rampart/catalog` | `packages/catalog` | The NIST SP 800-171 Rev 2 catalog as versioned data: families, requirements, objectives and SPRS points                                                                                                    |
| `@rampart/rules`   | `packages/rules`   | Pure functions: requirement status, SPRS score, POA&M eligibility, Conditional check, 180-day clock, and the SSP pre-export check (`ssp-lint`)                                                             |
| `@rampart/api`     | `apps/api`         | Fastify HTTP API on `/api`, the only writer of the SQLite database; also owns the shared contract                                                                                                          |
| (part of the api)  | `apps/api/ssp`     | Export v2: a pure outline in the NIST SSP order from the catalog, profiles, SSP workspace data, assessment, POA&M, policies and evidence, rendered as a `.docx` with embedded diagrams and signature lines |
| `@rampart/web`     | `apps/web`         | React app built with Vite                                                                                                                                                                                  |

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
