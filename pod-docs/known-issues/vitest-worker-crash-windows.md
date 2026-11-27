# vitest worker sometimes crashes on Windows (exit 3221226505)

_Found: 2026-11-26 · by: T1 and the orchestrator (sec-baseline) · plan: security-hardening_

**What happens:** now and then a vitest fork worker, or the e2e api process, exits with code `3221226505` (`0xC0000409`, STATUS_STACK_BUFFER_OVERRUN, a native crash) partway through a run. vitest reports `Worker exited unexpectedly … while running test file …` (seen on `apps/api/src/security/web-app.test.ts`). It also once left an orphaned e2e api on port 3291.

**It isn't a test failure:** rerunning passes. The crashing file passed 5 of 5 times alone, and the full `pnpm verify` passed on rerun. CI on windows-latest hasn't shown it.

**Workaround:** rerun `pnpm verify` or `pnpm e2e` once. If an orphaned process holds 3290/3291/3293/3294, stop only that process, after checking it belongs to your worktree.

**Fix someday:** likely a native module (better-sqlite3 or @node-rs/argon2) racing at worker exit under Windows forks. Try vitest `pool: 'threads'` or `--no-file-parallelism` for the api project if it becomes frequent.
