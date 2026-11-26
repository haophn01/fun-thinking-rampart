# Sprint: Security baseline: route matrix, supply-chain CI, production serving with CSP, hosted mode, rate limits, redaction

_From plan: pod-docs/plans/security-hardening.md · Slug: sec-baseline · Status: active · Generated: 2026-11-26_

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | S1 | Supply-chain CI: SHA-pinned actions, audit gate, Semgrep, pnpm settings, the one dependency add | sec-baseline-s1 | #28 | done | 78d507f | — |
| 1 | C1 | Security config, `HOSTED` mode, startup checks, app seams, route table, harness options | sec-baseline-c1 | #28 | done | 78d507f | — |
| 2 | H1 | Security headers: web CSP vs api CSP, HSTS hosted-only, Permissions-Policy | sec-baseline-h1 | — | pending | — | C1 |
| 2 | P1 | Production web serving from the api, and `pnpm start` on the production path | sec-baseline-p1 | — | pending | — | C1 |
| 2 | T1 | Rate limiting on every request, tight limits on setup and sign-in | sec-baseline-t1 | — | pending | — | S1, C1 |
| 2 | M1 | Access-control regression matrix over every api route | sec-baseline-m1 | — | pending | — | C1 |
| 2 | R1 | Log redaction review and tests | sec-baseline-r1 | — | pending | — | C1 |
| 3 | E1 | e2e on the production path, header spec, CSP violation check; docs | sec-baseline-e1 | — | pending | — | H1, P1, T1 |

Plan branch `security-hardening`; wave heads `sec-baseline-w1`, `sec-baseline-w2`, `sec-baseline-w3`. Merge target `main`. No migration and no one-way door in this sprint.

## Shared contract

### Conventions (everyone)
- **Ports:** slice dev runs use port base 3200: S1 3210/3211, C1 3220/3221, H1 3230/3231, P1 3240/3241, T1 3250/3251, M1 3260/3261, R1 3270/3271, E1 3280/3281. Never 3057–3156 (Windows-reserved). e2e owns 3290 (config server), 3293 (look's api), 3294 (security spec's hosted server).
- **e2e:** only one slice per wave runs `pnpm e2e`: C1 in wave 1, T1 in wave 2, E1 in wave 3.
- **pnpm locally:** `corepack pnpm …` (`corepack enable` fails with EPERM here). Scripts that call pnpm again need both a `pnpm.cmd` and an sh `pnpm` shim on PATH (as `scripts/start.ts` does).
- **Lockfile:** only S1 changes dependencies or `pnpm-lock.yaml`.
- **Pinned lists** (error codes, audit actions, route lists, workflow jobs) change only in the slice that changes the thing they pin, together with their test. This sprint adds no error code and no audit action: every 429 uses the existing `too_many_attempts`.
- **Source hygiene:** no control bytes or U+FFFD in any source file. Tests that compare same-moment rows order them by id. UI tests, if any, mock every call, wait for the request before answering it, and use 15 s timeouts.
- **New files** for this sprint's api security code live in `apps/api/src/security/`.

### Config (C1, `apps/api/src/config.ts`)
`Config` gains four fields, parsed from env with the existing rules (empty means unset; every bad key named in `ConfigError`):

| Env | Field | Values | Default |
|-----|-------|--------|---------|
| `HOSTED` | `hosted: boolean` | exactly `true` or `false` | `false` |
| `SERVE_WEB` | `serveWeb: boolean` | exactly `true` or `false` | `false` |
| `WEB_DIST_PATH` | `webDistPath: string` (absolute) | a path; relative resolves against `apps/api` | `../web/dist` |
| `RATE_LIMIT_MULTIPLIER` | `rateLimitMultiplier: number` | digits only, 1 to 1000 | `1` |

Edges: `TRUE`, `1`, `yes`, ` true` are refused for the booleans. `0`, `1001`, `1.5`, `-1`, `1e2` are refused for the multiplier.

### Startup check (C1, `apps/api/src/security/startup.ts`)
- `assertSafeStartup(config: Config): void` throws `StartupCheckError` (`name: 'StartupCheckError'`, `rules: string[]`, a message naming every broken rule) when any of these holds:
  - `hosted-needs-serve-web`: `HOSTED=true` without `SERVE_WEB=true` (hosted HTML must carry the CSP).
  - `hosted-real-rate-limits`: `HOSTED=true` with `RATE_LIMIT_MULTIPLIER` other than 1.
  - `hosted-log-level`: `HOSTED=true` with `LOG_LEVEL` `debug` or `trace`.
- Local mode (`HOSTED=false`) passes with any combination. Several broken rules are all listed, in the order above.
- `server.ts` calls it after `loadConfig` and **before** opening the database. A failure logs a fatal line with the message and exits 1, creating no database file. `buildApp` doesn't call it, so tests can build any combination. Later sprints add `FIPS_MODE` and secret-key rules here.

### App seams and request order (C1 writes `app.ts`; wave 2 fills the files)
- `export interface SecurityContext { config: Config; now: () => Date }`, in `security/context.ts`.
- `buildApp` registers, in this order, and wave-2 slices never edit `app.ts`:
  1. the route table's `onRoute` capture (below)
  2. the request-id hook (as today)
  3. `registerSecurityHeaders(app, ctx)` from `security/headers.ts` (H1). C1's version is today's helmet config moved as is.
  4. `registerRateLimit(app, ctx)` from `security/rate-limit.ts` (T1). C1's version does nothing.
  5. the early 404, the JSON-only parser rule, error handling, `/api/health` (as today)
  6. `registerApiRoutes(app, deps)` (as today)
  7. `registerWebApp(app, ctx)` from `security/web-app.ts` (P1). C1's version does nothing.
- Every response, including 404, 413, 415, 429 and 500, carries `x-request-id` and the security headers. A rate-limited request is refused before the guard runs, so a flood gets 429, not 401, and never touches the database.
- `ApiDeps` gains `config: Config`.
- Fastify gets `trustProxy: '127.0.0.1'` when hosted, and `false` otherwise. Locally an `X-Forwarded-For` header never changes `request.ip`. When hosted, it is honoured only from a peer at 127.0.0.1, the single local reverse proxy.

### Session cookie (C1, `apps/api/src/auth/cookie.ts`)
- `HOSTED_SESSION_COOKIE = '__Host-rampart_session'`. `SESSION_COOKIE` (`rampart_session`) in the contract stays the local name.
- `sessionCookieName(config)`, `readSessionToken(request, deps)`, `setSessionCookie(reply, deps, token)` and `clearSessionCookie(reply, deps)` are the only code that names or sets the cookie. `auth/routes.ts`, `users/routes.ts` and `auth/guard.ts` use them.
- **Local:** `rampart_session`, `HttpOnly; SameSite=Strict; Path=/`, with `Max-Age` as today and no `Secure`. Unchanged.
- **Hosted:** `__Host-rampart_session`, `HttpOnly; Secure; SameSite=Strict; Path=/`, with no `Domain`. Clearing uses the same attributes.
- In each mode only that mode's name is read: a `rampart_session` cookie sent to a hosted app is ignored (401 on a guarded route).

### Route table (C1, `apps/api/src/security/route-table.ts`)
- `listRoutes(app): RouteEntry[]` returns every route registered on that app, one entry per method, without Fastify's automatic HEAD routes, sorted by url and then method:
  `interface RouteEntry { method: string; url: string; guarded: boolean; public: boolean; skipCsrf: boolean; role: Role | null }`.
- `guarded` is true for routes registered inside the `registerApiRoutes` plugin.

### Test harness (C1, `apps/api/src/testing/harness.ts`)
- `createHarness({ env?: Record<string, string> })` merges `env` into the config it loads. By default `RATE_LIMIT_MULTIPLIER` is `'1000'`, so suites don't trip limits; rate-limit tests pass `env: { RATE_LIMIT_MULTIPLIER: '1' }`.
- The client keeps whichever session cookie the app's mode uses.
- `Harness.config` exposes the loaded `Config`.

### Security headers (H1, `security/headers.ts`)
- **Web CSP**, on every response whose path isn't `/api` or under `/api/`:
  `default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'`. Hosted mode appends `; upgrade-insecure-requests`. There is no `unsafe-inline`, `unsafe-eval`, `data:` or nonce.
- **Api CSP**, on `/api` and everything under `/api/`: as today, `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- **On every response:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, and no `X-Powered-By`.
- **HSTS:** `Strict-Transport-Security: max-age=31536000; includeSubDomains` only when hosted. Locally the header is absent (helmet's default is switched off).
- The path is read without the query string. `/apix` is a web path; `/api` and `/api/` are api paths.

### Production web serving (P1, `security/web-app.ts`)
- With `serveWeb`, `registerWebApp` reads `webDistPath` once at build time into a manifest of URL path → file. A missing `index.html` makes `buildApp` throw `WebBuildMissingError`, with the message ``SERVE_WEB=true but <path>/index.html is missing. Run `pnpm build` first.``.
- **Manifest:** regular files only. Dotfiles, symlinks and extensions outside this list are skipped:
  - `.html` text/html; charset=utf-8
  - `.js` text/javascript; charset=utf-8
  - `.css` text/css; charset=utf-8
  - `.woff2` font/woff2
  - `.woff` font/woff
  - `.svg` image/svg+xml
  - `.png` image/png
  - `.ico` image/x-icon
  - `.txt` text/plain; charset=utf-8
  - `.json` application/json
  - `.webmanifest` application/manifest+json

  Files added after start aren't served.
- **GET and HEAD:**
  - a manifest path → the file, with its type. Under `/assets/` it gets `Cache-Control: public, max-age=31536000, immutable`; anything else gets `no-cache`.
  - `/api`, `/api/…` with no api route → the JSON 404 envelope, `No route for GET <path>`, exactly as today.
  - another path whose last segment has an extension → the JSON 404 envelope. A missing asset is never answered with HTML.
  - any other path (`/`, `/assessment`, `/ssp`) → `index.html` with `no-cache` (the SPA fallback).
- Lookup uses only the manifest, so `..`, `%2e%2e`, `%2f`, backslashes and absolute paths can never reach a file outside the dist folder. Query strings are ignored. Other methods on non-api paths keep today's 404.
- Without `serveWeb`, no web route exists: `GET /` is the JSON 404, as today.
- `apps/web` builds with `build.assetsInlineLimit: 0`, so no asset becomes a `data:` URI the CSP would block.
- **`pnpm start`** (`scripts/start.ts`) runs these steps, each stopping at the first failure:
  1. `install` (`install --frozen-lockfile`)
  2. `build` (`build`)
  3. `migrate` (`db:migrate`)
  4. `serve` (`--filter @rampart/api start`)

  The serve step's env is the caller's, plus `SERVE_WEB=true` and `API_PORT` set to `WEB_PORT` when that's set, else `3000`. The human keeps opening `http://127.0.0.1:3000/`. `pnpm dev` (Vite and the api) is unchanged and is for development only.

### Rate limits (T1, `security/rate-limit.ts`, using `@fastify/rate-limit` from S1)
- `RATE_LIMITS = { general: { max: 600, windowMs: 60_000 }, auth: { max: 10, windowMs: 60_000 } }`. The effective `max` is `max × config.rateLimitMultiplier`.
- `AUTH_LIMITED_ROUTES = ['POST /api/setup', 'POST /api/session']` is pinned by test. sec-auth and sec-mfa append their password and MFA routes.
- **Keys:** every request is keyed by `request.ip`. Each auth route has its own bucket per IP, and its requests don't count in the general bucket. Everything else counts in the general bucket per IP, including unknown routes, `/api/health` and static files.
- **Window:** fixed. It starts at a key's first counted request, and time comes from `ctx.now` (a store driven by the app clock, never `Date.now`). Request number `max` passes and `max + 1` gets 429. Once the window has passed, the next request starts a fresh window.
- **The 429:** status 429 with the envelope `{ code: 'too_many_attempts', message: 'Too many requests. Try again later.', details: { retryAfterSeconds } }`. `retryAfterSeconds` is the whole seconds until the window ends, rounded up, and at least 1. The `Retry-After` header carries the same number. Security headers and `x-request-id` are present. The existing sign-in page already shows "Too many attempts. Try again in N minutes." for this code.
- The account lockout (5 failures, 15 min) is unchanged and independent.

### Access-control matrix (M1, `security/route-matrix.ts`)
- `ROUTE_MATRIX: Record<'<METHOD> <url>', MatrixEntry>` has exactly one entry per `listRoutes` entry whose url is `/api` or starts with `/api/`.
- `MatrixEntry` gives:
  - `access: 'public' | 'session' | 'admin'`
  - a valid sample request (url with params, body)
  - `idor`: either a seeder that creates a row under a **second assessment** and returns the url naming it, or `{ notApplicable: '<reason>' }` (users are global; catalog ids are the same for every assessment).
- `UNGUARDED_API_ROUTES = ['GET /api/health']` and `CSRF_EXEMPT = ['POST /api/setup', 'POST /api/session']` are pinned.

### Redaction (R1, `apps/api/src/logger.ts`, `testing/redaction.ts`)
- No log line ever holds any of these: a password, a session token or cookie value, a CSRF token, a TOTP or recovery code, or a secret. That holds at every level, `trace` included.
- `REDACT_PATHS` also covers these keys at the top level and one level down (`x` and `*.x`), for later sprints: `password`, `currentPassword`, `newPassword`, `csrfToken`, `token`, `code`, `recoveryCode`, `secret`.
- `expectNoSecrets(logs, secrets: string[])` fails, naming the line, if any serialized log line contains any secret. It refuses a secret shorter than 8 characters, to avoid false positives.

### Supply chain and CI (S1)
- **`pnpm-workspace.yaml`:**
  - `allowBuilds` lists exactly `better-sqlite3`, `@node-rs/argon2` and `esbuild` as `true`. If pnpm 10.34.9 ignores or rejects `allowBuilds`, keep `onlyBuiltDependencies` with the same three names and say so in the PR.
  - `strictDepBuilds: true`
  - `minimumReleaseAge: 1440`
  - `trustPolicy: no-downgrade`
  - `blockExoticSubdeps: true`
- **Workflow:**
  - Every `uses:` names a 40-hex commit SHA with a trailing `# v<version>` comment, and every container image is pinned `@sha256:<64 hex>`.
  - Jobs, in order: `verify`, `secrets`, `e2e` (steps as today), `audit`, `semgrep`.
  - Top-level permissions stay `contents: read, pull-requests: read`.
- **`audit` (ubuntu):**
  - checkout, setup-node 24 (`package-manager-cache: false`), `corepack enable`
  - `node scripts/audit-gate.ts` on the repo
  - `node scripts/audit-gate.ts --expect-findings --dir tests/fixtures/supply-chain/vulnerable`: this step proves the gate fails on a lockfile with a known high-severity advisory.
- **`scripts/audit-gate.ts`:**
  - runs `pnpm audit --audit-level high --json` in a directory and decides from the JSON:
    - fails on any `high` or `critical` advisory not in `audit-allowlist.json`
    - passes on `moderate`, `low` and `info`
    - fails closed on non-JSON output or a network error
  - `audit-allowlist.json` (repo root) is `[{ id, reason, until: 'YYYY-MM-DD' }]`, empty at the start. An entry past `until` (a UTC date) no longer counts and fails the gate. An entry that matches nothing passes with a warning.
  - `--expect-findings` inverts the gate: it exits 0 only when the gate would fail on findings.
- **`semgrep` (ubuntu):** runs in the `semgrep/semgrep` image pinned by digest. Steps: checkout, then `semgrep scan --config p/default --config p/typescript --config p/react --severity ERROR --error --metrics off`. `.semgrepignore` covers `node_modules/`, `tests/fixtures/`, `templates/` and `dist/`.
- `gitleaks/gitleaks-action` stays (SHA of v2). CodeQL isn't used: it needs paid GHAS on a private repo.

## Per-slice detail

### S1: Supply-chain CI: SHA-pinned actions, audit gate, Semgrep, pnpm settings, the one dependency add
- **Scope:**
  - Apply the contract's Supply chain and CI section.
  - Add `@fastify/rate-limit` to `@rampart/api` dependencies: the newest Fastify-5 release that `minimumReleaseAge` allows. This is this sprint's only dependency change, and the resolution exercises `trustPolicy` and `minimumReleaseAge`.
  - If `pnpm audit` finds a high or critical advisory in today's tree, upgrade the package within its range. If that's not possible, add an allowlist entry with a reason and an `until` date at most 30 days ahead, plus a PENDING queue line.
  - Semgrep ERROR findings in shipping code that this slice can't fix in its own files → `--exclude-rule <id>` with a reason comment, plus a PENDING queue line naming the file. Never edit files other slices own.
  - Add the fixture lockfile to `.prettierignore`.
  - Add the supply-chain rules to CONTRIBUTING.md.
  - Out of scope: Dependabot and SARIF upload.
- **Files owned:**
  - `.github/workflows/pod-ci.yml`
  - `tests/repo/ci-workflow.test.ts`
  - `tests/repo/supply-chain.test.ts` (new)
  - `scripts/audit-gate.ts` (new)
  - `tests/repo/audit-gate.test.ts` (new)
  - `audit-allowlist.json` (new)
  - `tests/fixtures/supply-chain/vulnerable/package.json` (new)
  - `tests/fixtures/supply-chain/vulnerable/pnpm-lock.yaml` (new)
  - `tests/fixtures/supply-chain/audit-*.json` (new, canned audit reports)
  - `.semgrepignore` (new)
  - `.prettierignore`
  - `pnpm-workspace.yaml`
  - `apps/api/package.json`
  - `pnpm-lock.yaml`
  - `CONTRIBUTING.md`
- **Success criteria:**
  - `[test]` every `uses:` in every job is pinned to a 40-hex SHA with a `# v` comment, and a tag or branch ref fails — `tests/repo/ci-workflow.test.ts` › every action is pinned to a commit SHA
  - `[test]` every container image is pinned by sha256 digest — `tests/repo/ci-workflow.test.ts` › container images are pinned by digest
  - `[test]` the jobs are exactly `verify, secrets, e2e, audit, semgrep`; verify and e2e keep their steps; permissions are unchanged — `tests/repo/ci-workflow.test.ts` › jobs and permissions
  - `[test]` the audit job runs the gate on the repo, then `--expect-findings` on the fixture — `tests/repo/ci-workflow.test.ts` › audit job gates the repo and proves itself on the fixture
  - `[test]` semgrep runs with `--severity ERROR --error --metrics off` and the three configs — `tests/repo/ci-workflow.test.ts` › semgrep job fails on high-severity findings
  - `[test]` gitleaks still runs with fetch-depth 0 and `GITHUB_TOKEN` — `tests/repo/ci-workflow.test.ts` › secrets job runs gitleaks with fetch-depth 0
  - `[test]` the workspace allows exactly the three build scripts and sets `strictDepBuilds`, `minimumReleaseAge: 1440`, `trustPolicy: no-downgrade` and `blockExoticSubdeps` — `tests/repo/supply-chain.test.ts` › pnpm supply-chain settings
  - `[test]` the gate fails on a high and on a critical advisory, and passes on moderate, low and info — `tests/repo/audit-gate.test.ts` › fails on high or critical only
  - `[test]` non-JSON output and a network-error report fail the gate — `tests/repo/audit-gate.test.ts` › fails closed
  - `[test]` an allowlisted id passes up to and including its `until` date and fails the day after; a stale entry passes with a warning — `tests/repo/audit-gate.test.ts` › allowlist entries expire
  - `[test]` `--expect-findings` exits 0 on a high report and 1 on a clean one — `tests/repo/audit-gate.test.ts` › expect-findings inverts the gate
  - `[test]` verify still runs a frozen install and `pnpm verify` on ubuntu and windows, so the settings are proven on both OSes (link the green wave-PR run, audit and semgrep included, in the PR) — `tests/repo/ci-workflow.test.ts` › verify job runs frozen install and pnpm verify on both OSes
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### C1: Security config, `HOSTED` mode, startup checks, app seams, route table, harness options
- **Scope:**
  - Build the contract's Config, Startup check, App seams, Session cookie, Route table and Test harness sections.
  - Move today's helmet config into `security/headers.ts` unchanged.
  - Add do-nothing `security/rate-limit.ts` and `security/web-app.ts` with the contract's signatures.
  - Keep every existing test green, local behaviour unchanged, and e2e green (this slice runs `pnpm e2e`).
  - Out of scope: the header values, the limits and the static serving themselves.
- **Files owned:**
  - `apps/api/src/config.ts`
  - `apps/api/src/config.test.ts`
  - `apps/api/src/app.ts`
  - `apps/api/src/server.ts`
  - `apps/api/src/routes/index.ts`
  - `apps/api/src/auth/guard.ts`
  - `apps/api/src/auth/routes.ts`
  - `apps/api/src/users/routes.ts`
  - `apps/api/src/auth/cookie.ts` (new)
  - `apps/api/src/security/context.ts` (new)
  - `apps/api/src/security/startup.ts` (new)
  - `apps/api/src/security/startup.test.ts` (new)
  - `apps/api/src/security/hosted.test.ts` (new)
  - `apps/api/src/security/route-table.ts` (new)
  - `apps/api/src/security/route-table.test.ts` (new)
  - `apps/api/src/security/headers.ts` (new)
  - `apps/api/src/security/rate-limit.ts` (new)
  - `apps/api/src/security/web-app.ts` (new)
  - `apps/api/src/testing/harness.ts`
  - `apps/api/src/testing/harness.test.ts`
- **Success criteria:**
  - `[test]` the four new env keys parse with their defaults, and each refused value is named in `ConfigError` — `apps/api/src/config.test.ts` › hosted, serve-web, dist path and rate-limit multiplier
  - `[test]` each startup rule fires alone; several are listed in order; local mode passes any combination — `apps/api/src/security/startup.test.ts` › unsafe hosted combinations are refused
  - `[test]` `tsx src/server.ts` with `HOSTED=true` and no `SERVE_WEB` exits 1, names the rule, and creates no database file — `apps/api/src/security/startup.test.ts` › server refuses an unsafe hosted config before opening the database
  - `[test]` locally, setup sets `rampart_session` without `Secure`, as before — `apps/api/src/security/hosted.test.ts` › local cookie is unchanged
  - `[test]` hosted, setup sets `__Host-rampart_session` with `HttpOnly; Secure; SameSite=Strict; Path=/` and no Domain; sign-out and a self-reset clear it with the same attributes — `apps/api/src/security/hosted.test.ts` › hosted cookie is __Host- and Secure
  - `[test]` hosted, a `rampart_session` cookie is ignored and gives 401 — `apps/api/src/security/hosted.test.ts` › hosted mode reads only its own cookie name
  - `[test]` locally `X-Forwarded-For` doesn't change `request.ip`; hosted it does from 127.0.0.1 and doesn't from 10.0.0.5 — `apps/api/src/security/hosted.test.ts` › trustProxy only for the local proxy when hosted
  - `[test]` `listRoutes` lists health (unguarded, public) and the guarded auth routes with their flags, without HEAD, sorted — `apps/api/src/security/route-table.test.ts` › lists every route with its guard flags
  - `[test]` the harness defaults the multiplier to 1000, takes `env` overrides, and keeps the hosted cookie — `apps/api/src/testing/harness.test.ts` › env overrides and hosted cookie
  - `[test]` locally, after the move into `security/headers.ts`, `/api/health` and an unknown route keep today's api CSP, nosniff and DENY, and the existing suites and `pnpm e2e` stay green — `apps/api/src/security/hosted.test.ts` › local behaviour is unchanged
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### H1: Security headers: web CSP vs api CSP, HSTS hosted-only, Permissions-Policy
- **Scope:**
  - Rewrite `security/headers.ts` to the contract's Security headers section.
  - Update the header pins in `app.test.ts`.
  - Out of scope: serving files (P1); tests use a stand-in non-api route registered in the test.
- **Files owned:**
  - `apps/api/src/security/headers.ts`
  - `apps/api/src/security/headers.test.ts` (new)
  - `apps/api/src/app.test.ts`
- **Success criteria:**
  - `[test]` a non-api path gets exactly the web CSP string, with no `unsafe-inline`, `unsafe-eval` or `data:` — `apps/api/src/security/headers.test.ts` › web paths get the strict web CSP
  - `[test]` `/api`, `/api/` and `/api/health` get the api CSP; `/apix` gets the web CSP; a query string doesn't change the choice — `apps/api/src/security/headers.test.ts` › the CSP is chosen by path at its edges
  - `[test]` nosniff, DENY, `no-referrer`, the Permissions-Policy, COOP, CORP and no `X-Powered-By` appear on a 200, a 404, a 415 and a 500 — `apps/api/src/security/headers.test.ts` › common headers on every response
  - `[test]` HSTS is absent locally; hosted it is `max-age=31536000; includeSubDomains`, and the web CSP gains `upgrade-insecure-requests` — `apps/api/src/security/headers.test.ts` › HSTS and upgrade only when hosted
  - `[test]` the existing api header pins still hold — `apps/api/src/app.test.ts` › security headers
- **Depends on:** C1
- **One-way door:** none
- **Model:** opus

### P1: Production web serving from the api, and `pnpm start` on the production path
- **Scope:**
  - Build the contract's Production web serving section: the manifest, the GET/HEAD rules, `WebBuildMissingError`, `assetsInlineLimit: 0`, and the four-step `pnpm start` with the serve step's env.
  - Out of scope: headers (H1), e2e and docs (E1).
- **Files owned:**
  - `apps/api/src/security/web-app.ts`
  - `apps/api/src/security/web-app.test.ts` (new)
  - `scripts/start.ts`
  - `tests/repo/start-script.test.ts`
  - `apps/web/vite.config.ts`
- **Success criteria:**
  - `[test]` a manifest file is served with its content type; `/assets/` files are immutable and others `no-cache` — `apps/api/src/security/web-app.test.ts` › serves built files with type and caching
  - `[test]` `/`, `/assessment` and `/ssp?tab=export` answer `index.html` with `no-cache`; HEAD works — `apps/api/src/security/web-app.test.ts` › SPA fallback for page paths
  - `[test]` a missing `/assets/x.js` and `GET /api/nope` answer the JSON 404 envelope, never HTML — `apps/api/src/security/web-app.test.ts` › missing assets and api paths stay JSON 404
  - `[test]` `..`, `%2e%2e`, `%2f`, backslash and absolute-path requests never return a sentinel file placed next to the dist folder — `apps/api/src/security/web-app.test.ts` › no path escapes the dist folder
  - `[test]` dotfiles, symlinks, unlisted extensions and files added after start aren't served — `apps/api/src/security/web-app.test.ts` › manifest is fixed and allowlisted
  - `[test]` a missing `index.html` throws `WebBuildMissingError` with the contract's message; without `serveWeb`, `GET /` is the JSON 404 — `apps/api/src/security/web-app.test.ts` › serve-web off and build missing
  - `[test]` `startSteps()` is install, build, migrate, serve; it stops at the first failure; serve's exit code is the script's — `tests/repo/start-script.test.ts` › runs install, build, migrate, serve
  - `[test]` the serve step gets `SERVE_WEB=true` and `API_PORT` from `WEB_PORT`, else 3000; other steps keep the caller's env — `tests/repo/start-script.test.ts` › serve step env
  - `[test]` the web build config sets `assetsInlineLimit` to 0 — `tests/repo/start-script.test.ts` › web build inlines no assets
- **Depends on:** C1
- **One-way door:** none
- **Model:** opus

### T1: Rate limiting on every request, tight limits on setup and sign-in
- **Scope:**
  - Build the contract's Rate limits section in `security/rate-limit.ts` with `@fastify/rate-limit` and a store on the app clock.
  - Make unknown routes count, editing `errors.ts` only if the early 404 must defer to the limiter.
  - Set `RATE_LIMIT_MULTIPLIER: '100'` on the e2e api servers (`playwright.config.ts` and `look.spec.ts`'s own api).
  - This slice runs `pnpm e2e` in wave 2.
  - Out of scope: per-user keys, and a shared store across processes (documented as one process).
- **Files owned:**
  - `apps/api/src/security/rate-limit.ts`
  - `apps/api/src/security/rate-limit.test.ts` (new)
  - `apps/api/src/errors.ts`
  - `playwright.config.ts`
  - `e2e/look.spec.ts`
- **Success criteria:**
  - `[test]` sign-in passes 10 times and the 11th is 429 `too_many_attempts` with `Retry-After` equal to `details.retryAfterSeconds` (≥ 1, whole seconds) — `apps/api/src/security/rate-limit.test.ts` › sign-in is limited to 10 a minute
  - `[test]` setup has its own bucket; sign-in requests don't use up the general bucket — `apps/api/src/security/rate-limit.test.ts` › auth routes have their own buckets
  - `[test]` the general limit passes 600 and refuses the 601st, for guarded routes, health and unknown routes alike — `apps/api/src/security/rate-limit.test.ts` › general limit counts every request
  - `[test]` after advancing the app clock 60 s the key passes again; at 59.5 s `Retry-After` is 1 — `apps/api/src/security/rate-limit.test.ts` › window resets on the app clock
  - `[test]` a signed-out flood gets 429, not 401, and the 429 carries security headers and `x-request-id` — `apps/api/src/security/rate-limit.test.ts` › limit runs before the guard
  - `[test]` locally a changing `X-Forwarded-For` shares one bucket; hosted, two forwarded clients get separate buckets — `apps/api/src/security/rate-limit.test.ts` › keyed per client, through the proxy when hosted
  - `[test]` a multiplier of 3 allows 30 sign-ins — `apps/api/src/security/rate-limit.test.ts` › multiplier scales the limits
  - `[test]` `AUTH_LIMITED_ROUTES` is exactly the pinned list, and each one exists in `listRoutes` — `apps/api/src/security/rate-limit.test.ts` › tight routes are pinned
  - `[test]` the account lockout still locks at 5 failures under the limit — `apps/api/src/security/rate-limit.test.ts` › lockout is unchanged
  - `[test]` `pnpm e2e` passes with the limits on — `e2e/look.spec.ts` › (whole suite green)
- **Depends on:** S1, C1
- **One-way door:** none
- **Model:** opus

### M1: Access-control regression matrix over every api route
- **Scope:**
  - Write `ROUTE_MATRIX` and one generated test over it, per the contract's Access-control matrix section.
  - Seed a second assessment (created later than the active one) and its rows directly through Drizzle.
  - A real gap the matrix finds (a cross-assessment id that doesn't answer 404) is fixed in that module's repository in this slice and named in the PR.
- **Files owned:**
  - `apps/api/src/security/route-matrix.ts` (new)
  - `apps/api/src/security/route-matrix.test.ts` (new)
  - `apps/api/src/poam/repository.ts`, `apps/api/src/evidence/repository.ts`, `apps/api/src/policies/repository.ts` and `apps/api/src/ssp-data/{roles,assets,diagrams,providers,document-control}/repository.ts` — only to fix a gap the matrix finds
- **Success criteria:**
  - `[test]` the matrix keys equal the `/api` routes from `listRoutes`, so a missing or extra entry fails and names the route — `apps/api/src/security/route-matrix.test.ts` › every api route has exactly one matrix entry
  - `[test]` each entry's `access` matches the route's flags; only `UNGUARDED_API_ROUTES` are unguarded and only `CSRF_EXEMPT` skip CSRF — `apps/api/src/security/route-matrix.test.ts` › declared access matches the guard
  - `[test]` every `session` and `admin` route answers 401 `unauthenticated` signed out — `apps/api/src/security/route-matrix.test.ts` › 401 when signed out
  - `[test]` every non-exempt write answers 403 `csrf_failed` signed in without the header, and with a wrong one — `apps/api/src/security/route-matrix.test.ts` › 403 without CSRF on writes
  - `[test]` every `admin` route answers 403 `forbidden` to a contributor sending CSRF — `apps/api/src/security/route-matrix.test.ts` › 403 for the wrong role
  - `[test]` every route with an `idor` seeder answers 404 `not_found` for the other assessment's id, and a write leaves that row unchanged — `apps/api/src/security/route-matrix.test.ts` › 404 for another assessment's id
- **Depends on:** C1
- **One-way door:** none
- **Model:** opus

### R1: Log redaction review and tests
- **Scope:**
  - Review every log call in `apps/api/src`.
  - Add the contract's extra `REDACT_PATHS` keys.
  - Write `expectNoSecrets`.
  - Prove that no secret is logged over this sprint's flows: setup, sign-in (right and wrong password), creating a user, resetting a password, a CSRF write, sign-out and a 500, at `trace`, in local and hosted mode.
  - Out of scope: MFA and password-change flows (sec-auth and sec-mfa extend the test).
- **Files owned:**
  - `apps/api/src/logger.ts`
  - `apps/api/src/logger.test.ts`
  - `apps/api/src/testing/redaction.ts` (new)
  - `apps/api/src/security/redaction.test.ts` (new)
- **Success criteria:**
  - `[test]` across the flows at `trace`, no log line contains any password used, the session token, the CSRF token or a Set-Cookie value — `apps/api/src/security/redaction.test.ts` › no secret reaches the logs in local mode
  - `[test]` the same holds in hosted mode with the `__Host-` cookie — `apps/api/src/security/redaction.test.ts` › no secret reaches the logs in hosted mode
  - `[test]` a direct `log.info({ password, body: { newPassword, code, secret } })` is censored at both depths — `apps/api/src/logger.test.ts` › redacts secret keys one level deep
  - `[test]` `expectNoSecrets` fails on a planted secret and names the line, and refuses a secret under 8 characters — `apps/api/src/security/redaction.test.ts` › expectNoSecrets catches and guards
- **Depends on:** C1
- **One-way door:** none
- **Model:** opus

### E1: e2e on the production path, header spec, CSP violation check; docs
- **Scope:**
  - Switch the Playwright config server to the production path: one server on 3290 running `pnpm build`, then `pnpm --filter @rampart/api start` with `SERVE_WEB=true`, a temp DB and file store, `LOG_LEVEL=warn`, `RATE_LIMIT_MULTIPLIER=100`, and a 300 s start timeout. The Vite server goes. `look.spec.ts`'s api port defaults to 3293 directly.
  - Add `e2e/security.spec.ts`:
    - on 3290 it does only signed-out reads (it sorts before `shell` and `smoke`, which need a fresh install)
    - it starts its own hosted server on 3294 (`HOSTED=true`, `SERVE_WEB=true`) for the HSTS and cookie checks
  - Add a `securitypolicyviolation` collector to every look-spec page.
  - Docs: README (`pnpm start` is the production path, `pnpm dev` for development, the new env keys); `pod-docs/codebase-structure.md` (Stack, CI jobs, Smoke recipe); `pod-docs/feature-details/setup-and-sign-in.md` (hosted cookie, rate limits).
  - This slice runs `pnpm e2e` in wave 3.
- **Files owned:**
  - `playwright.config.ts`
  - `e2e/security.spec.ts` (new)
  - `e2e/look.spec.ts`
  - `README.md`
  - `pod-docs/codebase-structure.md`
  - `pod-docs/feature-details/setup-and-sign-in.md`
- **Success criteria:**
  - `[test]` `GET /` and `GET /assessment` on 3290 return HTML with the exact web CSP, nosniff, `no-referrer`, the Permissions-Policy and `X-Frame-Options: DENY`, and no HSTS — `e2e/security.spec.ts` › production HTML carries the strict CSP and headers
  - `[test]` `GET /api/health` carries the api CSP — `e2e/security.spec.ts` › api responses keep the api CSP
  - `[test]` the hosted server sends HSTS, and setup's Set-Cookie is `__Host-rampart_session` with `Secure; HttpOnly; SameSite=Strict; Path=/` and no Domain — `e2e/security.spec.ts` › hosted mode sends HSTS and a __Host- Secure cookie
  - `[test]` the first page load on 3290 shows no CSP violation, and the shell renders — `e2e/security.spec.ts` › the built app loads under the CSP
  - `[test]` every look-spec route, at 1280 and 375 px, records zero CSP violations, and the look assertions pass unchanged — `e2e/look.spec.ts` › (each route test, with the violation collector)
  - `[test]` the config server is the production build: `index.html` loads only hashed `/assets/` files (immutable) and no `/@vite/client`; `shell` and `smoke` then pass unchanged on it — `e2e/security.spec.ts` › the config server is the production build
- **Depends on:** H1, P1, T1
- **One-way door:** none
- **Model:** opus
