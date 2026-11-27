# Audit log

## What it is
An append-only record of every status and content change: who, what, before and after, when. It is read under **Settings** > Audit log.

## How it works
- `recordAudit(tx, event)` (`apps/api/src/audit/record.ts`) is called inside the same transaction as the change, so both commit or both roll back.
- `before` and `after` hold only changed fields. If they are deep-equal nothing is written, so repeating a save is free; what-if never reaches the server.
- Keys `password`, `passwordHash`, `token`, `csrfToken` (and column spellings) are stripped at any depth.
- Migration 0002 adds SQL triggers that abort any UPDATE or DELETE on `audit_event`. Migration 0006 narrows the UPDATE trigger to allow one fill of a row's `prev_hash` and `hash`, from null, with every other column unchanged.
- **Hash columns:** `prev_hash` and `hash` stay empty (null) on every event until sec-integrity builds the hash chain and backfills them in code, once; nothing reads them yet.
- **Auth and settings actions (sec-auth):** "Password changed" (`auth.password_changed`, the user, no before or after), "Session locked" and "Session unlocked" (`auth.session_locked` / `auth.session_unlocked`, the user; a repeat lock or an unlock of an unlocked session writes nothing), "Sign-in notice acknowledged" (`auth.notice_acknowledged`, the user, `after: { digest }`, written just before "Signed in"), and "Settings changed" (`settings.updated`, entity type "Settings", id `sign_in_notice`, before and after `{ signInNotice }`; saving the same text writes nothing).
- Example: set an objective Met to Not Met, open the log: the newest entry shows the label, time, actor and before/after JSON.

## Why it's this way
- Same-transaction writes mean no change can exist without its audit line.
- The append-only rule is enforced in the database, not just in code.

## Watch out
- Each new write path must call `recordAudit(tx, ...)` with its transaction.
- The time is the app clock (`buildApp({ now })`).
- Don't fill `prev_hash` or `hash` by hand: the trigger allows only one fill, and the canonical form is sec-integrity's to define.

## History
- 2026-11-25 · plan cmmc-l2-grc · built (assessment sprint, PRs #4 and #6) · [report](../reports/cmmc-l2-grc.html)
- 2026-11-26 · plan security-hardening · password, lock, unlock, notice and settings actions; `prev_hash`/`hash` columns and the narrowed update trigger (sec-auth sprint, PRs #33 to #35)
