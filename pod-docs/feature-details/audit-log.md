# Audit log

## What it is
An append-only record of every status and content change: who, what, before and after, when. It is read under **Settings** > Audit log.

## How it works
- `recordAudit(tx, event)` (`apps/api/src/audit/record.ts`) is called inside the same transaction as the change, so both commit or both roll back.
- `before` and `after` hold only changed fields. If they are deep-equal nothing is written, so repeating a save is free; what-if never reaches the server.
- Keys `password`, `passwordHash`, `token`, `csrfToken` (and column spellings) are stripped at any depth.
- Migration 0002 adds SQL triggers that abort any UPDATE or DELETE on `audit_event`.
- Example: set an objective Met to Not Met, open the log: the newest entry shows the label, time, actor and before/after JSON.

## Why it's this way
- Same-transaction writes mean no change can exist without its audit line.
- The append-only rule is enforced in the database, not just in code.

## Watch out
- Each new write path must call `recordAudit(tx, ...)` with its transaction.
- The time is the app clock (`buildApp({ now })`).

## History
- 2026-11-25 · plan cmmc-l2-grc · built (assessment sprint, PRs #4 and #6) · [report](../reports/cmmc-l2-grc.html)
