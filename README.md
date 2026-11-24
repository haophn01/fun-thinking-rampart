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

```sh
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` starts the api on http://127.0.0.1:3001 and the web app on http://127.0.0.1:3000. Both
bind to `127.0.0.1` only. Change the ports with `API_PORT` and `WEB_PORT`:

```sh
API_PORT=3011 WEB_PORT=3010 pnpm dev                 # bash
$env:API_PORT=3011; $env:WEB_PORT=3010; pnpm dev     # PowerShell
```

If `corepack enable` fails with `EPERM` (Node is installed in a folder you can't write to), either
run it from an elevated shell, or put the shims in a folder of your own that is on your `PATH`:
`corepack enable --install-directory <folder> pnpm`.

## Scripts

Run these from the repo root.

| Script           | What it does                                                               |
| ---------------- | -------------------------------------------------------------------------- |
| `pnpm dev`       | Runs the api (`tsx watch`) and the web app (Vite) in parallel              |
| `pnpm lint`      | `eslint .`, then `prettier --check .`                                      |
| `pnpm format`    | `prettier --write .`                                                       |
| `pnpm typecheck` | `tsc --noEmit` in every workspace package                                  |
| `pnpm test`      | `vitest run` across every package plus the repo checks in `tests/`         |
| `pnpm build`     | Bundles the api with tsup and the web app with Vite                        |
| `pnpm verify`    | lint, typecheck, test, build, in that order, stopping at the first failure |

Run `pnpm verify` before you open a pull request; CI runs the same command.

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
