# Audit log

## What it is
An append-only record of every status and content change: who, what, before and after, when. It is read under **Settings** > Audit log.

## How it works
- `recordAudit(tx, event)` (`apps/api/src/audit/record.ts`) is called inside the same transaction as the change, so both commit or both roll back.
- `before` and `after` hold only changed fields. If they are deep-equal nothing is written, so repeating a save is free; what-if never reaches the server.
- Keys `password`, `passwordHash`, `token`, `csrfToken` (and column spellings) are stripped at any depth.
- Migration 0002 adds SQL triggers that abort any UPDATE or DELETE on `audit_event`. Migration 0006 narrows the UPDATE trigger to allow one fill of a row's `prev_hash` and `hash`, from null, with every other column unchanged.
- **Hash chain (sec-integrity):** every event's `hash` is `auditHash(row)` (`apps/api/src/audit/chain.ts`): the lowercase SHA-256 hex of `JSON.stringify(['rampart-audit-v1', prevHash, at, actorUserId, assessmentId, action, entityType, entityId, before, after, requestId])`, each the stored column value (`before`/`after` as the stored JSON text, never re-parsed). `id` is left out; the `prev_hash` links keep the order. `recordAudit` reads the newest non-null `hash` in the caller's transaction and inserts the row with `prev_hash` set to it (null for the first event) and its own `hash`. Two events in one transaction chain in order; a rolled-back event leaves no trace; a no-op reads and writes nothing. The writer type is `Pick<AppDb, 'insert' | 'select'>`.
- **Legacy backfill:** `chainAuditLog(db)` fills `prev_hash`/`hash` on every event written before the chain, in id order (batches of 500), one UPDATE per row, all in one immediate transaction, and only while no event has a hash yet. Once any event has one it fills nothing and reports `unchained` (the null-hash count), so a row slipped in by raw SQL is never blessed. `prepareDatabase(db, log)` (`audit/prepare.ts`) runs migrations then the backfill; `server.ts` (before it listens) and `pnpm db:migrate` call it, logging info `{ chained }` or warn `{ unchained }`. `pnpm admin:reset-mfa` runs `chainAuditLog` before its transaction (it still never migrates).
- **Verify:** `GET /api/audit/verify` (any signed-in user, general rate bucket, writes nothing) walks every event in id order and stops at the first broken one: `unchained` (no hash), `prev_mismatch` (its link isn't the previous event's hash: an earlier event was changed and re-hashed, or removed) or `hash_mismatch` (the row doesn't match its hash). It answers `{ ok, checked, total, headHash, firstBroken: { id, at, action, problem } | null, verifiedAt }` (`auditVerifyResponseSchema`). `headHash` is the newest event's stored hash (null for an empty log, or when the newest has none or isn't a SHA-256). Example: a fresh install after setup answers `ok: true, checked: 2, total: 2`.
- **Known limit:** the hashes are unkeyed SHA-256 and the chain isn't anchored outside the database. Someone who can write the database file can append a forged event with a correct hash, re-hash every event from an edit onward, or remove the newest events, and Verify won't notice. Verify catches in-place edits, mid-chain deletions and unhashed rows. A signed export (parked) would close the gap.
- **Auth and settings actions (sec-auth):** "Password changed" (`auth.password_changed`, the user, no before or after), "Session locked" and "Session unlocked" (`auth.session_locked` / `auth.session_unlocked`, the user; a repeat lock or an unlock of an unlocked session writes nothing), "Sign-in notice acknowledged" (`auth.notice_acknowledged`, the user, `after: { digest }`, written just before "Signed in"), and "Settings changed" (`settings.updated`, entity type "Settings", id `sign_in_notice`, before and after `{ signInNotice }`; saving the same text writes nothing).
- **Two-step sign-in actions (sec-mfa):** "Two-step sign-in set up" (`auth.mfa_enrolled`, the user, no before or after, at enrollment's confirm), "Two-step sign-in verified" (`auth.mfa_verified`, the user, `after: { method: 'totp' }` or `{ method: 'recovery_code', remaining }`), and "Two-step sign-in reset" (`user.mfa_reset`, entity the reset user, actor the admin or null from the CLI, before `{ mfaEnrolled }` and after `{ mfaEnrolled: false }`; a reset with nothing stored writes nothing). "Signed in" is still written at the password step, before either of the first two. No secret, URI, code or recovery code is ever in a row.
- Example: set an objective Met to Not Met, open the log: the newest entry shows the label, time, actor and before/after JSON.

## Why it's this way
- Same-transaction writes mean no change can exist without its audit line.
- The append-only rule is enforced in the database, not just in code.
- The hash chain makes an edit or a deletion made with direct access to the file visible to Verify, which the triggers alone can't (whoever holds the file can drop them).
- The backfill fills only a log that has never been chained, so it can't be used to bless rows added later.

## Watch out
- Each new write path must call `recordAudit(tx, ...)` with its transaction.
- The time is the app clock (`buildApp({ now })`).
- Don't fill `prev_hash` or `hash` by hand: the trigger allows only one fill, and a row inserted with `hash` set can never be updated.
- Never insert into `audit_event` except through `recordAudit`: a raw insert has no hash, and Verify names it `unchained` for good.
- Changing any field of the canonical form (or its order) breaks every existing hash: a new form needs a new version tag and a plan for old rows.

## History
- 2026-11-25 · plan cmmc-l2-grc · built (assessment sprint, PRs #4 and #6) · [report](../reports/cmmc-l2-grc.html)
- 2026-11-26 · plan security-hardening · password, lock, unlock, notice and settings actions; `prev_hash`/`hash` columns and the narrowed update trigger (sec-auth sprint, PRs #33 to #35)
- 2026-11-27 · plan security-hardening · two-step set up, verified and reset actions (sec-mfa sprint, PRs #38, #39 and wave 3)
- 2026-11-27 · plan security-hardening · hash chain on write, one-time legacy backfill at start, `GET /api/audit/verify` (sec-integrity A1)
- 2026-11-27 · plan security-hardening · Settings › Audit log › **Verify audit log** button: "Audit log intact" with the event count, the newest hash and the time checked, or "Audit log broken" naming the first broken event and why; only the newest answer is shown, with Retry and the 429 wait on failure (sec-integrity V1, PR #43)
