# Contributing

## Before every pull request

Run `pnpm verify`. It runs lint, typecheck, test and build, in that order, and stops at the first
failure. CI runs the same command on Ubuntu and Windows, plus a gitleaks secret scan over the full
history. A red check blocks the merge.

CI also runs `pnpm e2e` (Playwright, Chromium) on both OSes. Run it locally when you change a
page or a route the end-to-end specs drive; it needs `pnpm exec playwright install chromium` once.
Specs live in `e2e/*.spec.ts` and Vitest never collects them.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/), scoped by the area of code:
`feat(rules): …`, `fix(api): …`, `test(catalog): …`, `build(repo): …`, `ci: …`.

- One change per commit, so a reviewer can read them in order. A test goes in the same commit as
  the code it covers. A rename or move is a commit of its own.
- Docs that record a change go in that change's commit.

## Test first

- Write the test before the code and watch it fail on an assertion. A test that passes before the
  code exists tests nothing.
- Test through the public interface. Mock only what the app doesn't control; the local database
  is the app's own, so use a real one.
- Never weaken a test to make it pass.
- Keep logic out of glue (entry files, wiring, route handlers) so tests can reach it.

## Database changes: migrations only

Never change the database by hand or edit an applied migration. Change `apps/api/db/schema.ts`,
generate a new migration with drizzle-kit, and commit both.

## Regulatory changes: data, tests, citation

The SPRS points, POA&M limits, barred requirements and closeout window are data, not code
(`packages/catalog/data` and `packages/rules/src/poam/regulation.ts`). A change to any of them is:

1. a data edit,
2. a test that pins the new value, and
3. a citation to the paragraph of 32 CFR 170 (or the NIST publication) that says so.

## Dependencies: the lockfile is frozen

`pnpm-lock.yaml` changes only in a pull request whose purpose is to change dependencies. CI
installs with `pnpm install --frozen-lockfile`, so a lockfile that disagrees with a
`package.json` fails the build. Install with pnpm only (through corepack); never add a second
lockfile. New versions must be at least a day old (`minimumReleaseAge` in `pnpm-workspace.yaml`).

## Supply chain

- **Actions are pinned by commit.** Every `uses:` in `.github/workflows/` names a full 40-hex
  commit SHA with a `# v<version>` comment, and every container image is pinned
  `@sha256:<digest>`. A tag or a branch can be moved after review; a SHA can't. Look the SHA up
  from the release (`git ls-remote --tags https://github.com/<owner>/<repo>`; for an annotated
  tag take the `^{}` line); never type one from memory. `tests/repo/ci-workflow.test.ts` fails on
  an unpinned line.

## No CUI

Never commit, upload or paste Controlled Unclassified Information, real or sample. V1 is not built
to hold it. Use made-up data in tests and screenshots.
