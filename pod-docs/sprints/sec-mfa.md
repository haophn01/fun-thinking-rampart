# Sprint: MFA: TOTP for every user, recovery codes, replay guard, encrypted secrets, admin reset

_From plan: pod-docs/plans/security-hardening.md · Slug: sec-mfa · Status: active · Generated: 2026-11-26_

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | K1 | Contract: MFA schemas, session `mfa` state, error codes, audit actions and labels | sec-mfa-k1 | — | pending | — | — |
| 1 | C1 | Secret key (`RAMPART_SECRET_KEY` or a generated key file), AES-256-GCM, startup rule | sec-mfa-c1 | — | pending | — | — |
| 1 | T1 | TOTP and base32 on `node:crypto`, recovery codes, QR path; the one dependency add | sec-mfa-t1 | — | pending | — | — |
| 2 | R1 | MFA api: enroll, confirm, verify, recovery codes, replay guard, admin reset, limits | sec-mfa-r1 | — | pending | — | K1, C1, T1 |
| 2 | G1 | Web: MFA session states, enrollment with QR, recovery codes, challenge | sec-mfa-g1 | — | pending | — | K1 |
| 2 | U2 | Web: two-step status and reset in Settings › Users | sec-mfa-u2 | — | pending | — | K1 |
| 3 | A2 | MFA required: pending sessions at sign-in, the guard gate, e2e, docs | sec-mfa-a2 | — | pending | — | R1, G1, U2 |
| 3 | X1 | `pnpm admin:reset-mfa <email>` CLI for local recovery | sec-mfa-x1 | — | pending | — | R1 |

Plan branch `security-hardening`. Wave heads `sec-mfa-w1` … `sec-mfa-w3`. Merge target `main`. There's no migration: 0006 already added every column and table this sprint uses. A2 is the one-way door: it turns MFA on for every account. Its wave stops for the human unless they pre-approve it.

## Shared contract

Everything in the earlier contracts still holds (foundation, assessment, sec-baseline, sec-auth), except where this section changes it.

### Conventions (everyone)
- **Ports:** K1 3210/3211, C1 3220/3221, T1 3230/3231, R1 3240/3241, G1 3250/3251, U2 3260/3261, A2 3270/3271, X1 3280/3281. e2e owns 3290, 3293, 3294 and 3295. Never use 3057–3156, 3000 or 3001.
- **e2e:** one slice per wave runs `pnpm e2e`: C1 (wave 1), G1 (wave 2), A2 (wave 3).
- **pnpm:** `corepack pnpm …`, with both shims on PATH for scripts that call pnpm. A vitest worker crash with exit 3221226505 is the known Windows issue: rerun once.
- **Lockfile:** only T1 changes dependencies or `pnpm-lock.yaml`. Other slices may edit only `scripts` in a package.json they own.
- **Pinned lists** (error codes, audit actions and labels, `ROUTE_MATRIX`, `AUTH_LIMITED_ROUTES`, `REDACT_PATHS`, the guard's route lists, the startup rules) change only in the slice named here, together with their test. Tests that pin exact session or user responses, or exact audit rows, belong to the slice that adds the field.
- **Source hygiene:** no control bytes or U+FFFD in any source or data file. Order same-moment rows by id in tests. Test passwords avoid the blocklist (`PassWord1234`, one character 12 times).
- **UI tests** mock every call, wait for the request before answering it, and use 15 s timeouts. UI uses only existing look controls and tokens. New CSS goes in the slice's own new `*.module.css`. `[manual]` look checks are **measured** at 1280 and 375 px (computed styles and `scrollWidth`), never by screenshot.
- **The human's account keeps working:** it signs in with its password, then enrolls in-app. No step needs a seeded secret or a reset.

### Sprint decision: TOTP on `node:crypto`, not otplib
The plan's scope names otplib. This sprint builds HOTP and TOTP (RFC 4226 and RFC 6238: HMAC-SHA1, 6 digits, 30 s) on `node:crypto` instead, checked against both RFCs' test vectors. Why:
- otplib v13 is a breaking rewrite with no release date found (see research).
- It keeps no replay state, so the app owns replay protection either way.
- The e2e helpers can import the same pure module.

The orchestrator records this in `decisions.md`. The only new packages are a QR encoder (runtime) and a QR decoder (dev, tests only), both added by T1.

### Contract (K1, `apps/api/src/contract/mfa.ts`, new, re-exported from `index.ts`)
- **Constants:** `TOTP_DIGITS = 6`, `TOTP_PERIOD_SECONDS = 30`, `TOTP_WINDOW_STEPS = 1`, `TOTP_SECRET_BYTES = 20`, `RECOVERY_CODE_COUNT = 10`, `RECOVERY_CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'` (Crockford base32, lowercase, without i, l, o or u).
- **`MFA_STATES = ['none', 'enroll', 'challenge']`** and `mfaStateSchema`.
  - `enroll`: the user has no `mfa_enrolled_at`.
  - `challenge`: the user is enrolled, and the session has `mfa_pending`.
  - `none`: neither applies.
- **`sessionResponseSchema`** gains `mfa: mfaStateSchema.default('none')`. **`userSchema`** gains `mfaEnrolled: z.boolean().default(false)`.
- **Inputs:**
  - `totpCodeSchema`: a string with every whitespace character removed, then `/^\d{6}$/`.
  - `recoveryCodeInputSchema`: a string of at most 64 characters, lowercased, with spaces and `-` removed, then exactly 10 characters from the alphabet.
- **Requests:**
  - `mfaConfirmRequestSchema = strict { code }`
  - `mfaVerifyRequestSchema = strict { code } | strict { recoveryCode }`: exactly one of the two. Both or neither fails.
- **`mfaEnrollmentResponseSchema`** is `{ secret, otpauthUri, qr: { size, path } }`:
  - `secret` matches `/^[A-Z2-7]{32}$/`
  - `otpauthUri` starts with `otpauth://totp/`
  - `size` is an integer from 21 to 177, the QR matrix side without a quiet zone
  - `path` matches `/^(M\d{1,3} \d{1,3}h\d{1,3}v1h-\d{1,3}z)*$/`, one run per row of dark modules
- **`mfaEnrolledResponseSchema = sessionResponseSchema.extend({ recoveryCodes })`**: exactly 10 codes, each matching `/^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/`.
- **Error codes,** appended in this order, each with an `ERROR_MESSAGES` text:
  - `mfa_required` 403: "Finish two-step sign-in to continue."
  - `invalid_mfa_code` 401: "That code didn't work. Enter the newest code from your app."
  - `mfa_wrong_step` 409: "This two-step sign-in step doesn't apply now. Reload the page."
- **Audit actions,** appended, with web labels:
  - `auth.mfa_enrolled`: "Two-step sign-in set up"
  - `auth.mfa_verified`: "Two-step sign-in verified"
  - `user.mfa_reset`: "Two-step sign-in reset"

### Secret key and encryption (C1)
- **Config:**
  - `RAMPART_SECRET_KEY` → `secretKeyHex: string | null`: 64 hex characters, any case, stored lowercase. Refused (and named in `ConfigError`): 63 or 65 characters, a non-hex character, or all 32 bytes equal.
  - `SECRET_KEY_PATH` → `secretKeyPath`, default `data/rampart-secret.key`, resolved against `apps/api`. `apps/api/data/` is already git-ignored.
- **`loadSecretKey(config): Buffer`** (`security/secret-key.ts`):
  - When the env var is set, its key wins, and the file is never read or written.
  - Hosted mode without the env var: the startup rule below has already refused to start.
  - Locally, an existing file is read: 64 hex characters, optionally followed by one `\n` or `\r\n`. Anything else throws `SecretKeyFileError` naming the path and **never regenerates** the key, because a new key would orphan every stored secret.
  - Locally, a missing file is created: 32 random bytes as lowercase hex plus `\n`, mode 0o600, and parent folders as needed.
    - The create is atomic: write a temp file, then `link` it to the path. On `EEXIST`, read the winner's key. A concurrent start never reads a half-written file.
    - One info log line names the path and never the key.
- **`deriveKeys(master)`** gives `{ mfaSecret, recoveryCode }`, each `hkdfSync('sha256', master, empty salt, info, 32)`. The `info` strings are `rampart/mfa-secret/v1` and `rampart/recovery-code/v1`.
- **`encryptSecret(key, plaintext, aad)` / `decryptSecret(key, enc, aad)`** (`security/secrets.ts`):
  - AES-256-GCM with a fresh random 12-byte IV for every call
  - format `v1.<iv>.<ciphertext>.<tag>`, each part base64url
  - for MFA secrets, `aad` is `user:<userId>`
  - a wrong key, a wrong aad, any changed byte or a bad format throws `SecretDecryptError`, and the error never includes the input
- **Startup rule,** appended after the existing three: `hosted-needs-secret-key` (`HOSTED=true` without `RAMPART_SECRET_KEY`).
- **`server.ts`** runs `loadConfig` → `assertSafeStartup` → `loadSecretKey` → `openDb`. A key failure logs a fatal line and exits 1, with no database file created.
- **`buildApp({ secretKey? })`:**
  - The key comes from the option, else `config.secretKeyHex`, else a random in-memory key (tests only).
  - `ApiDeps` gains `keys: { mfaSecret: Buffer; recoveryCode: Buffer }`.
  - The harness sets `RAMPART_SECRET_KEY` to the exported `HARNESS_SECRET_KEY` (`'0123456789abcdef'` four times) unless `env` overrides it.
- **e2e:** `security.spec.ts`'s hosted server (3294) gets a fixed `RAMPART_SECRET_KEY`. The other e2e servers share the default key file.

### TOTP, recovery codes, QR (T1, `apps/api/src/auth/mfa/`, pure, with no DB and no config)
- **`base32.ts`:** RFC 4648. Encoding is uppercase with no padding. Decoding accepts upper or lower case and throws on any other character or on padding.
- **`totp.ts`:**
  - `hotp(secret, counter, digits = 6)` follows RFC 4226: an 8-byte big-endian counter, dynamic truncation, zero-padded.
  - `totpStep(at) = floor(unixSeconds / 30)`.
  - `totpAt(secret, at)`.
  - `matchTotp(secret, code, at, window = 1)` returns the **highest** step in `[step − window, step + window]` whose code equals `code`, compared in constant time, or `null`.
  - `generateSecret()` gives 20 random bytes.
  - `otpauthUri({ issuer: PRODUCT_NAME, account: email, secret })` gives `otpauth://totp/<enc(issuer)>:<enc(account)>?secret=<B32>&issuer=<enc(issuer)>&algorithm=SHA1&digits=6&period=30`, where `enc` is `encodeURIComponent`.
- **`recovery-codes.ts`:**
  - `generateRecoveryCodes()` gives 10 codes that are unique within the set, formatted `xxxxx-xxxxx`, drawn from `RECOVERY_CODE_ALPHABET` without modulo bias.
  - `normalizeRecoveryCode(input)` returns the 10 bare characters or `null`.
  - `hashRecoveryCode(key, normalized)` is the HMAC-SHA-256 hex of `recovery-code:v1:<normalized>`.
- **`qr.ts`:** `qrPath(text)` returns `{ size, path }` in the contract's shape, from the QR library's matrix at error correction M, with no quiet zone. Each row gives one `M<x> <y>h<n>v1h-<n>z` per run of dark modules.

### MFA api (R1, `apps/api/src/auth/mfa/`, inside the guarded plugin; every route needs a session and CSRF)

| Route | When | Success | Failures |
|---|---|---|---|
| `POST /api/session/mfa/enroll` (no body) | the user isn't enrolled | 200 `mfaEnrollmentResponse`. A new secret is stored encrypted in `mfa_secret_enc` and replaces any pending one; `mfa_last_step` is set to null. No audit event | 409 `mfa_wrong_step` when the user is enrolled |
| `POST /api/session/mfa/enroll/confirm` `{ code }` | not enrolled, with a pending secret | 200 `mfaEnrolledResponse` (rotated cookie). In one transaction: `mfa_enrolled_at = now`, `mfa_last_step` = the matched step, the user's old recovery codes are deleted and 10 new hashes inserted, the session is rotated with `mfa_pending` false, and `auth.mfa_enrolled` is written | 409 `mfa_wrong_step` (enrolled, or no pending secret); 401 `invalid_mfa_code`, **not** counted in the lockout; 400 |
| `POST /api/session/mfa/verify` `{ code }` or `{ recoveryCode }` | enrolled, and the session has `mfa_pending` | 200 `sessionResponse` (rotated cookie, `mfa_pending` false). Clears the failure count and writes `auth.mfa_verified` with `after: { method: 'totp' }`, or `{ method: 'recovery_code', remaining }` | 409 `mfa_wrong_step`; 400; 429 while the account is locked (not counted); 401 `invalid_mfa_code`, counted in the lockout (`recordFailure`, `fromSession`). The 5th failure gives 401 `unauthenticated`, ends all the user's sessions and clears the cookie |
| `POST /api/users/:id/mfa/reset` (admin, no body) | — | 200 `userResponse`. Clears `mfa_secret_enc`, `mfa_last_step` and `mfa_enrolled_at`, deletes the user's recovery codes, ends **all** the user's sessions (clearing the cookie when it's the caller's) and writes `user.mfa_reset` with before `{ mfaEnrolled }` and after `{ mfaEnrolled: false }`. When nothing is stored (no secret, no codes), the answer is 200 with no event and no sessions ended | 404 for an unknown id |

- **Verify order:** body → state → account lock → code → replay.
  - TOTP: `matchTotp` at `deps.now()`. Then `UPDATE user SET mfa_last_step = s WHERE id = ? AND (mfa_last_step IS NULL OR mfa_last_step < s)`. Zero rows changed is a replay, which answers 401 `invalid_mfa_code` like a wrong code.
  - So each step is accepted once per user, and never a step at or below the last one accepted.
  - Recovery code: `UPDATE mfa_recovery_code SET used_at = now WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`. Zero rows changed means invalid.
- **Undecryptable secret** (the key changed): 500 `internal_error`. The log names the user id and never the secret. An admin reset or the CLI recovers the account.
- **`resetMfa(tx, userId, { actorUserId, requestId, now }): boolean`** (`reset.ts`) does the reset and its audit event, and returns whether anything changed. Both the route and the CLI use it.
- **`toUser`** fills `mfaEnrolled` (`mfa_enrolled_at` is not null).
- **Pinned lists:**
  - `AUTH_LIMITED_ROUTES` appends `POST /api/session/mfa/enroll`, `POST /api/session/mfa/enroll/confirm` and `POST /api/session/mfa/verify`.
  - The reset route uses the general bucket.
  - `ROUTE_MATRIX` gets four entries: the three session routes (`session`, `idor: SESSION_ROUTE`) and the reset route (`admin`, `idor: USERS_GLOBAL`).
  - `REDACT_PATHS` appends `otpauthUri` and `recoveryCodes`.
- **Harness:**
  - `setupAdmin()` and `signIn()` by default leave a full session. After the api answers, an unenrolled user is enrolled directly in the DB with `HARNESS_MFA_SECRET` (exported, base32) encrypted under the harness keys, and that session's `mfa_pending` is set to false.
  - `{ mfa: 'as_stored' }` skips both steps.
  - `h.totp(email, at = clock.now())` gives the current code for the user's stored secret.
  - Existing suites stay green unchanged.

### MFA required (A2)
- **Sessions:**
  - `createSession(…, { mfaPending })`. Sign-in creates `mfa_pending: true`, and so does setup.
  - `ActiveSession.mfa` is computed per request from the user row and the session, as the contract defines it.
  - `GET /api/session`, setup, sign-in, unlock and change password all report `mfa`. A pending session still gets its `user` and `csrfToken`.
- **Guard order:** 401 → 403 `csrf_failed` → 423 `session_locked` → 403 `mfa_required` → 403 `password_change_required` → 403 `forbidden` → 400 → 404. Public routes are never gated.
  - `MFA_ROUTES` = `LOCKED_SESSION_ROUTES` plus the three `/api/session/mfa/*` routes.
  - `PASSWORD_CHANGE_ROUTES` appends the same three, so a user with a temporary password enrolls first and then changes the password.
- **Existing sessions:** a session from before this sprint (`mfa_pending` 0) of an unenrolled user is in state `enroll` on its next request. The human's open tab shows enrollment, with no sign-in needed.
- **`auth.signed_in`** is still written at the password step, and `auth.mfa_verified` or `auth.mfa_enrolled` after it.
- **e2e:**
  - `e2e/helpers/api.ts` `signIn(request, email, password, { totpSecret? })` completes MFA as the session asks. For `enroll` it calls enroll and confirm, and returns the secret and the recovery codes. For `challenge` it verifies with `totpSecret`.
  - It never reuses a step: it uses the current step, or the next one if the current is used, or else waits for the next step.
  - Codes come from `apps/api/src/auth/mfa/totp.ts`.
- **Undo (orchestrator, if the human asks):**
  1. Revert A2's merge commit: `git revert -m 1 <A2 merge>`.
  2. Then end every session, so no session that only passed the password step becomes a full one: stop the app, run `node -e "const D=require('better-sqlite3');new D('data/rampart.sqlite').prepare('DELETE FROM session').run();console.log('sessions ended')"` in `apps/api`, and start the app again.
  3. Stored secrets and codes stay encrypted and unused.
- **Keep the key with the DB:** after users enroll, `apps/api/data/rampart-secret.key` must be backed up with `rampart.sqlite`. Losing it means every user needs a reset (`pnpm admin:reset-mfa`).

### Web (G1 builds the session flow; U2 the users panel)
- **`api/client.ts`:**
  - A 401 `invalid_mfa_code` never runs `onUnauthenticated`.
  - A 403 `mfa_required` from any call runs the new `onMfaRequired` hook, which re-reads the session.
- **`useSession()`:**
  - New statuses: `mfa_enroll`, `mfa_challenge` and `mfa_recovery_codes`, all held sessions (`endSession` works from them).
  - Precedence: `locked` > `mfa_enroll` / `mfa_challenge` > `password_change` > `signed_in`.
  - New methods:
    - `startMfaEnrollment()` returns the enrollment and doesn't change the state.
    - `confirmMfaEnrollment(code)` applies the rotated session's CSRF token and moves to `mfa_recovery_codes`, with `recoveryCodes` set.
    - `acknowledgeRecoveryCodes()` applies the saved session (`signed_in` or `password_change`) and drops the codes.
    - `verifyMfa({ code } | { recoveryCode })` applies the session.
  - While in `mfa_recovery_codes`, a re-read for the same user with `mfa: 'none'` keeps that status and the codes. A signed-out answer drops them.
  - `lock()` and `IdleLock` are unchanged: they apply only while `signed_in` or `password_change`.
- **Screens** (in the auth frame, existing controls, a Sheet card on Vellum, 16 px minimum):
  - **Enroll:** heading "Set up two-step sign-in".
    - It calls `startMfaEnrollment` once per show, and only the newest answer is shown.
    - The QR is `<svg role="img" aria-label="QR code for your authenticator app">` with a viewBox of `size + 8` (a 4-module quiet zone), a Sheet background and the path filled with the Ink token. No `data:` URL and no innerHTML.
    - The manual key (`data-testid="mfa-manual-key"`) is shown in groups of 4, in Space Mono (`--rp-font-mono`), with the account email.
    - A "6-digit code" field (`inputMode="numeric"`, `autoComplete="one-time-code"`), Confirm, and Sign out.
  - **Recovery codes:** heading "Save your recovery codes".
    - The codes are an `<ol data-testid="recovery-codes">` in mono, with the text "Each code works once. You won't see them again."
    - Copy writes the codes, one per line, through `navigator.clipboard`. A failure shows "Couldn't copy. Write them down."
    - Continue is disabled until the "I saved my recovery codes" checkbox is checked.
  - **Challenge:** heading "Enter your code", a "6-digit code" field, Verify, "Use a recovery code" (which switches to a "Recovery code" field, and back), and Sign out.
  - **On all three:**
    - A code that isn't 6 digits after removing spaces, or a recovery code that doesn't normalize, shows a field error and sends nothing.
    - `invalid_mfa_code` shows the contract text on the field and clears it.
    - 429 shows `tooManyRequestsText`.
    - `mfa_wrong_step` re-reads the session.
- **Settings › Users (U2):** each row shows "Two-step sign-in: Set up" or "Not set up". Admins get "Reset two-step sign-in" on enrolled rows.
  - Success shows "Two-step sign-in reset for <name>. They set it up again at their next sign-in."
  - On your own row it ends your session, as a password reset does.
  - A failure shows an Alert. There's no confirm step, following the decision for self-reset.

### CLI (X1)
- `pnpm admin:reset-mfa <email>` runs the root script → `@rampart/api` script → `tsx src/auth/mfa/cli.ts`. It reads `DATABASE_PATH` through `loadConfig`.
- It never creates a database and never migrates:
  - a missing file exits 1 with "No database at <path>."
  - a database without `user.mfa_enrolled_at` exits 1 with "Start Rampart once to update the database, then run this again."
- The email is trimmed and lowercased.
  - An unknown email exits 1.
  - A wrong number of arguments prints the usage and exits 2.
- On success it runs `resetMfa` with actor null and requestId null, prints "Two-step sign-in reset for <email>. They set it up again at their next sign-in, and all their sessions have ended.", and exits 0.
- With nothing stored, it prints "<email> has no two-step sign-in set up. Nothing changed." and exits 0.
- It works while the app runs (SQLite WAL, busy timeout 5 s).

## Per-slice detail

### K1: Contract
- **Scope:** add the contract's Contract section, the three labels in `auditLabels.ts`, and the updated pinned lists and schema pins. No routes.
- **Files owned:**
  - `apps/api/src/contract/mfa.ts` (new)
  - `apps/api/src/contract/auth.ts`
  - `apps/api/src/contract/users.ts`
  - `apps/api/src/contract/audit.ts`
  - `apps/api/src/contract/error.ts`
  - `apps/api/src/contract/index.ts`
  - `apps/api/src/contract/schemas.test.ts`
  - `apps/api/src/contract/contract.test.ts`
  - `apps/api/src/contract/browser.test.ts`
  - `apps/api/src/contract/sec-auth.test.ts`
  - `apps/api/src/contract/sec-mfa.test.ts` (new)
  - `apps/web/src/pages/settings/auditLabels.ts`
  - `apps/web/src/pages/settings/AuditLog.test.tsx`
- **Success criteria:**
  - `[test]` `ERROR_CODES` ends with the three new codes at 403, 401 and 409, each with its message — `apps/api/src/contract/schemas.test.ts` › error codes and statuses
  - `[test]` the audit actions equal the old list plus the three, in order — `schemas.test.ts` › other enums and constants
  - `[test]` a session answer without `mfa` parses to `'none'` (in jitless mode too), an unknown state fails, and a user without `mfaEnrolled` parses to false — `apps/api/src/contract/sec-mfa.test.ts` › defaults keep old answers parsing
  - `[test]` `' 123 456 '` passes as `123456`; `12345`, `1234567` and `12a456` fail; `ABCDE-FGHJK` and ` abcde fghjk ` normalize; a code with `i`, `l`, `o` or `u`, 9 or 11 characters, or 65 input characters fails — `sec-mfa.test.ts` › code and recovery code inputs
  - `[test]` verify takes exactly one of code or recoveryCode (both, neither and an extra key fail); confirm is strict — `sec-mfa.test.ts` › mfa request rules
  - `[test]` the enrollment response refuses a 31-character or lowercase secret, a non-`otpauth://totp/` URI, size 20 or 178, and a path holding `<` or `"`; the enrolled response needs exactly 10 well-formed codes — `sec-mfa.test.ts` › mfa response rules
  - `[test]` the sec-auth session defaults still hold, now with `mfa: 'none'` — `apps/api/src/contract/sec-auth.test.ts` › session response defaults
  - `[test]` every new action has a non-blank label — `apps/web/src/pages/settings/AuditLog.test.tsx` › labels cover the contract
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### C1: Secret key and encryption
- **Scope:** build the contract's Secret key and encryption section: config, `secret-key.ts`, `secrets.ts`, the startup rule, the `server.ts` order, the `buildApp` option and `ApiDeps.keys`, the harness default key, and the hosted e2e server's key. This slice runs `pnpm e2e`. Out of scope: anything that encrypts MFA data (R1).
- **Files owned:**
  - `apps/api/src/config.ts`
  - `apps/api/src/config.test.ts`
  - `apps/api/src/server.ts`
  - `apps/api/src/app.ts`
  - `apps/api/src/routes/index.ts`
  - `apps/api/src/security/secret-key.ts` (new)
  - `apps/api/src/security/secret-key.test.ts` (new)
  - `apps/api/src/security/secrets.ts` (new)
  - `apps/api/src/security/secrets.test.ts` (new)
  - `apps/api/src/security/startup.ts`
  - `apps/api/src/security/startup.test.ts`
  - `apps/api/src/testing/harness.ts`
  - `apps/api/src/testing/harness.test.ts`
  - `e2e/security.spec.ts`
- **Success criteria:**
  - `[test]` a 64-hex key in either case parses to lowercase; 63 and 65 characters, a `g`, and 64 zeros are each refused and named; `SECRET_KEY_PATH` resolves against `apps/api` — `apps/api/src/config.test.ts` › secret key settings
  - `[test]` locally a missing file is created (64 hex plus `\n`, mode 0o600 on POSIX) and the same key is read on the next call; with the env var set the file is never created; the log names the path and not the key — `apps/api/src/security/secret-key.test.ts` › local key file is generated once
  - `[test]` a file with 63 characters, a trailing space or two newlines throws `SecretKeyFileError` naming the path and leaves the file byte-identical; `\r\n` is accepted — `secret-key.test.ts` › a bad key file is never replaced
  - `[test]` two processes started at once on an empty folder both return the same key — `secret-key.test.ts` › concurrent starts agree on one key
  - `[test]` a round trip returns the plaintext; two encryptions of the same input differ; a wrong key, a wrong aad, one flipped byte in any part, and a `v2.` or 3-part string each throw `SecretDecryptError` without the input in the message — `apps/api/src/security/secrets.test.ts` › AES-256-GCM seals and refuses tampering
  - `[test]` `deriveKeys` is deterministic, and its two keys differ from each other and from the master — `secrets.test.ts` › derived keys are separate
  - `[test]` `hosted-needs-secret-key` fires alone and is listed after the other three; hosted with the key passes; local always passes — `apps/api/src/security/startup.test.ts` › unsafe hosted combinations are refused
  - `[test]` `tsx src/server.ts` with a corrupt key file exits 1 naming the file, and creates no database file — `startup.test.ts` › server refuses a bad key before opening the database
  - `[test]` the harness defaults the key to `HARNESS_SECRET_KEY` and takes an `env` override — `apps/api/src/testing/harness.test.ts` › env overrides and hosted cookie
  - `[test]` the hosted server starts with its key, and `pnpm e2e` stays green — `e2e/security.spec.ts` › hosted mode sends HSTS and a __Host- Secure cookie
- **Depends on:** —
- **One-way door:** none. The next start of the human's app creates `apps/api/data/rampart-secret.key`. Nothing is encrypted with it until wave 2, so deleting the file undoes it.
- **Model:** opus

### T1: TOTP, recovery codes, QR and the dependency add
- **Scope:**
  - Build the contract's TOTP, recovery codes, QR section.
  - Add the QR encoder to `@rampart/api` `dependencies` and a QR decoder to `devDependencies`, both at exact versions (no `^`). Prefer `uqr` (encoder) and `jsqr` (decoder). Each must be pure JS with no dependencies and no install scripts, and must pass `minimumReleaseAge`, `trustPolicy`, `strictDepBuilds` and the audit gate. If one fails, use `qrcode-generator` instead and say why in the PR. `allowBuilds` doesn't change.
- **Files owned:**
  - `apps/api/src/auth/mfa/base32.ts` (new)
  - `apps/api/src/auth/mfa/totp.ts` (new)
  - `apps/api/src/auth/mfa/recovery-codes.ts` (new)
  - `apps/api/src/auth/mfa/qr.ts` (new)
  - `apps/api/src/auth/mfa/totp.test.ts` (new)
  - `apps/api/src/auth/mfa/recovery-codes.test.ts` (new)
  - `apps/api/src/auth/mfa/qr.test.ts` (new)
  - `apps/api/package.json`
  - `pnpm-lock.yaml`
- **Success criteria:**
  - `[test]` base32 round-trips 0–40 random bytes and RFC 4648 §10's vectors (`foobar` → `MZXW6YTBOI`); decoding refuses `1`, `8`, `=` and spaces, and accepts lowercase — `apps/api/src/auth/mfa/totp.test.ts` › base32 follows RFC 4648
  - `[test]` HOTP matches RFC 4226 Appendix D (counters 0–9 → 755224 … 520489) — `totp.test.ts` › HOTP matches RFC 4226
  - `[test]` 8-digit TOTP matches RFC 6238 Appendix B (SHA-1) at 59, 1111111109, 1111111111, 1234567890, 2000000000 and 20000000000 — `totp.test.ts` › TOTP matches RFC 6238
  - `[test]` step edges: 29.999 s is step 0 and 30.000 s is step 1; `matchTotp` accepts steps s−1, s and s+1, refuses s−2 and s+2, returns the highest matching step, and refuses a 5-digit or non-digit code — `totp.test.ts` › window and step edges
  - `[test]` the otpauth URI is exact for an email with `+` and `@`, and its secret decodes to the input — `totp.test.ts` › otpauth URI
  - `[test]` 10 codes, unique and in format, over 1,000 runs; each character's frequency over 100,000 draws is within 5 % of uniform; normalizing accepts case, hyphens and spaces, and refuses `i`, `l`, `o`, `u` and a wrong length; the hash is 64 hex, the same for both spellings, and different under another key — `apps/api/src/auth/mfa/recovery-codes.test.ts` › recovery codes
  - `[test]` for a real otpauth URI, the path is rendered to an RGBA bitmap in the test with a 4-module quiet zone, and the decoder reads back exactly the URI. The three 7×7 finder patterns sit at the corners, and `size` is 17 + 4 × version — `apps/api/src/auth/mfa/qr.test.ts` › QR path decodes to the input
  - `[test]` the path matches the contract's regex, and its module count equals the matrix's dark count — `qr.test.ts` › path is safe and complete
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### R1: MFA api
- **Scope:** build the contract's MFA api section: the four routes, `repository.ts`, `reset.ts`, `toUser`'s field, the pinned lists, the logger keys and the harness. Tests set `session.mfa_pending` in the DB for the challenge (A2 makes sign-in set it). Out of scope: the guard gate and sign-in (A2), and the CLI (X1).
- **Files owned:**
  - `apps/api/src/auth/mfa/routes.ts` (new)
  - `apps/api/src/auth/mfa/repository.ts` (new)
  - `apps/api/src/auth/mfa/reset.ts` (new)
  - `apps/api/src/auth/mfa/enroll.test.ts` (new)
  - `apps/api/src/auth/mfa/verify.test.ts` (new)
  - `apps/api/src/auth/mfa/reset.test.ts` (new)
  - `apps/api/src/routes/index.ts`
  - `apps/api/src/users/routes.ts`
  - `apps/api/src/users/users.test.ts`
  - `apps/api/src/security/route-matrix.ts`
  - `apps/api/src/security/route-matrix.test.ts`
  - `apps/api/src/security/rate-limit.ts`
  - `apps/api/src/security/rate-limit.test.ts`
  - `apps/api/src/logger.ts`
  - `apps/api/src/logger.test.ts`
  - `apps/api/src/testing/harness.ts`
  - `apps/api/src/testing/harness.test.ts`
- **Success criteria:**
  - `[test]` enroll gives 200 with a 32-character secret, a URI naming the user's email, and a QR path; `mfa_secret_enc` starts with `v1.` and holds neither the base32 nor the hex secret; a second enroll replaces the secret, and the first secret's code then gives 401 — `apps/api/src/auth/mfa/enroll.test.ts` › enroll stores an encrypted secret
  - `[test]` confirm with the right code gives 200 with 10 codes and a rotated cookie and CSRF token (the old token gets 401); `mfa_enrolled_at` and `mfa_last_step` are set; 10 hashes are stored and none equals a code; one `auth.mfa_enrolled` is written; every code parses with the contract schema — `enroll.test.ts` › confirm enrolls and rotates
  - `[test]` a wrong confirm code gives 401 `invalid_mfa_code` and counts no failure (6 wrong codes don't lock the account); confirm before enroll, and confirm or enroll once enrolled, give 409 `mfa_wrong_step` — `enroll.test.ts` › confirm edges
  - `[test]` verify with the current code gives 200, a rotated cookie, `mfa_pending` false and `auth.mfa_verified` `{ method: 'totp' }`; the same code again (re-pended session) gives 401; at the same clock the step+1 code passes and the step−1 code then fails; codes at s−2 and s+2 fail; the enrollment code can't be used to verify — `apps/api/src/auth/mfa/verify.test.ts` › replay guard accepts each step once
  - `[test]` two verifies with the same code at once: exactly one gives 200 — `verify.test.ts` › concurrent replay
  - `[test]` a recovery code works once (in any case and with or without the hyphen), and the audit row gives `remaining: 9`; reusing it, or using another user's code, gives 401; with all 10 used, TOTP still works — `verify.test.ts` › recovery codes are single-use
  - `[test]` wrong codes count with sign-in failures; the 5th gives 401 `unauthenticated`, ends all sessions, clears the cookie and writes `auth.locked_out`; while the account is locked verify gives 429 and doesn't count; a bad format gives 400 and doesn't count; verify on a non-pending or unenrolled session gives 409 — `verify.test.ts` › verify failures share the lockout
  - `[test]` a secret sealed under another key gives 500 `internal_error`, and the log holds the user id but not the secret — `verify.test.ts` › undecryptable secret
  - `[test]` an admin reset clears the three columns and the codes, ends all the target's sessions and writes `user.mfa_reset` with before and after; a reset of your own also clears the cookie; a second reset gives 200 with no event; an unknown id gives 404; a contributor gives 403 — `apps/api/src/auth/mfa/reset.test.ts` › admin reset is audited and signs out everywhere
  - `[test]` the user list reports `mfaEnrolled` per user — `apps/api/src/users/users.test.ts` › users report two-step status
  - `[test]` `AUTH_LIMITED_ROUTES` is the old list plus the three; the 11th verify in a minute gives 429 — `apps/api/src/security/rate-limit.test.ts` › tight routes are pinned
  - `[test]` the matrix passes with the four entries — `apps/api/src/security/route-matrix.test.ts` › every api route has exactly one matrix entry
  - `[test]` `log.info({ otpauthUri, body: { recoveryCodes } })` is censored at both depths — `apps/api/src/logger.test.ts` › redacts secret keys one level deep
  - `[test]` harness `signIn` and `setupAdmin` leave the user enrolled with `HARNESS_MFA_SECRET` and the session not pending; `{ mfa: 'as_stored' }` changes nothing; `h.totp` equals `totpAt` for that secret — `apps/api/src/testing/harness.test.ts` › signIn completes MFA by default
- **Depends on:** K1, C1, T1
- **One-way door:** none
- **Model:** opus

### G1: Web session flow
- **Scope:** build the contract's Web section for `client.ts`, `useSession` and the three screens, with the Gate showing each status in the auth frame. Until A2 the api always answers `mfa: 'none'`, so the app's behaviour doesn't change. This slice runs `pnpm e2e`. Out of scope: Settings › Users (U2).
- **Files owned:**
  - `apps/web/src/api/client.ts`
  - `apps/web/src/api/client.test.ts`
  - `apps/web/src/auth/session.tsx`
  - `apps/web/src/auth/Gate.tsx`
  - `apps/web/src/auth/gate.test.tsx`
  - `apps/web/src/auth/MfaEnrollPage.tsx` (new)
  - `apps/web/src/auth/MfaChallengePage.tsx` (new)
  - `apps/web/src/auth/RecoveryCodesPage.tsx` (new)
  - `apps/web/src/auth/Mfa.module.css` (new)
  - `apps/web/src/auth/mfa-enroll.test.tsx` (new)
  - `apps/web/src/auth/mfa-challenge.test.tsx` (new)
  - `apps/web/src/auth/recovery-codes.test.tsx` (new)
- **Success criteria:**
  - `[test]` a 401 `invalid_mfa_code` doesn't run `onUnauthenticated`; a 403 `mfa_required` runs `onMfaRequired` once — `apps/web/src/api/client.test.ts` › mfa rules
  - `[test]` the gate shows enroll for `mfa: 'enroll'` and the challenge for `'challenge'`; locked wins over both; both win over `mustChangePassword`; a 403 `mfa_required` mid-session re-reads and shows enroll — `apps/web/src/auth/gate.test.tsx` › gate states for MFA
  - `[test]` confirm shows the codes; a re-read for the same user keeps them; Continue opens the app, or the forced change page when `mustChangePassword` is set; a signed-out re-read drops them — `gate.test.tsx` › recovery codes survive a re-read
  - `[test]` the enroll page posts once per show; when two answers arrive out of order only the newer secret shows; the key is grouped by 4 in the mono font; the svg has the role and label, a viewBox of `size + 8` and the given path, and no `<img>` or innerHTML — `apps/web/src/auth/mfa-enroll.test.tsx` › enrollment shows QR and key
  - `[test]` `12 34 56` sends `123456`; 5 digits sends nothing and shows the field error; `invalid_mfa_code` shows the text and clears the field; 429 shows the wait; 409 re-reads; a failed start shows an Alert with Retry — `mfa-enroll.test.tsx` › confirm edges
  - `[test]` Continue is disabled until the box is checked; Copy writes 10 lines; a clipboard rejection shows the fallback text — `apps/web/src/auth/recovery-codes.test.tsx` › codes must be confirmed
  - `[test]` the challenge sends `{ code }`, or `{ recoveryCode }` after switching; a malformed recovery code sends nothing; `invalid_mfa_code` clears the field; a 401 `unauthenticated` lands on Sign in with "Your session ended. Sign in again."; Sign out signs out — `apps/web/src/auth/mfa-challenge.test.tsx` › challenge by code or recovery code
  - `[manual]` at 1280 and 375 px the three screens have no horizontal scroll, text of 16 px or more, only token colours, and the key in Space Mono — measure computed styles and `scrollWidth` in the browser against mocked answers
  - `[test]` `pnpm e2e` stays green — `e2e/smoke.spec.ts` › (whole suite green)
- **Depends on:** K1
- **One-way door:** none
- **Model:** opus

### U2: Settings › Users two-step status and reset
- **Scope:** build the contract's Settings › Users line in `UsersPanel`, calling `POST /api/users/:id/mfa/reset` through `apiSend` with `userResponseSchema`.
- **Files owned:**
  - `apps/web/src/pages/settings/UsersPanel.tsx`
  - `apps/web/src/pages/settings/UsersPanel.test.tsx`
  - `apps/web/src/pages/settings/UsersPanelMfa.module.css` (new, only if needed)
- **Success criteria:**
  - `[test]` rows show "Set up" or "Not set up" from `mfaEnrolled`, and a missing field reads "Not set up" — `apps/web/src/pages/settings/UsersPanel.test.tsx` › two-step status per user
  - `[test]` an admin resets an enrolled user: one POST, the row turns "Not set up" and the notice shows; a contributor and an unenrolled row get no button; a failure shows an Alert — `UsersPanel.test.tsx` › reset two-step sign-in
  - `[test]` resetting your own row ends your session — `UsersPanel.test.tsx` › resetting your own two-step sign-in signs you out
  - `[manual]` at 1280 and 375 px the users panel has no horizontal scroll and text of 16 px or more — measure in the browser
- **Depends on:** K1
- **One-way door:** none
- **Model:** sonnet

### A2: MFA required for every user
- **Scope:**
  - Build the contract's MFA required section: `createSession`'s option, `ActiveSession.mfa`, the guard gate and lists, sign-in and setup creating pending sessions, and `mfa` on every session answer.
  - Update the api suites that post setup or sign-in directly, or pin exact session responses.
  - Extend the redaction run over enroll, confirm, verify (code and recovery code) and reset. Check the base32 secret, the URI, each recovery code, the quoted TOTP codes (`"123456"`, 8 characters) and the key hex.
  - Update e2e: the helper; `smoke.spec.ts` enrolls in the UI after setup by reading `mfa-manual-key`; `look.spec.ts` seeds through the helper and measures the three new screens with the CSP collector; `auth.spec.ts` (3295) adds the MFA tests below.
  - Docs:
    - `README.md`: MFA, the key file and its backup, the CLI
    - `pod-docs/codebase-structure.md`: Stack and Smoke recipe. How to sign in by script: the helper, or enroll and verify with `totp.ts`
    - `pod-docs/feature-details/setup-and-sign-in.md`
    - `pod-docs/feature-details/audit-log.md`
    - `pod-docs/feature-details/mfa.md` (new)
  - This slice runs `pnpm e2e`.
- **Files owned:**
  - `apps/api/src/auth/sessions.ts`
  - `apps/api/src/auth/guard.ts`
  - `apps/api/src/auth/routes.ts`
  - `apps/api/src/auth/session-routes.ts`
  - `apps/api/src/auth/mfa/gate.test.ts` (new)
  - `apps/api/src/auth/session.test.ts`
  - `apps/api/src/auth/setup.test.ts`
  - `apps/api/src/auth/sign-in.test.ts`
  - `apps/api/src/auth/sign-in-notice.test.ts`
  - `apps/api/src/auth/change-password.test.ts`
  - `apps/api/src/auth/lock.test.ts`
  - `apps/api/src/auth/csrf.test.ts`
  - `apps/api/src/users/temporary-password.test.ts`
  - `apps/api/src/security/hosted.test.ts`
  - `apps/api/src/security/redaction.test.ts`
  - `apps/api/src/testing/harness.ts`
  - `apps/api/src/testing/harness.test.ts`
  - `e2e/helpers/api.ts`
  - `e2e/auth.spec.ts`
  - `e2e/look.spec.ts`
  - `e2e/smoke.spec.ts`
  - `README.md`
  - `pod-docs/codebase-structure.md`
  - `pod-docs/feature-details/setup-and-sign-in.md`
  - `pod-docs/feature-details/audit-log.md`
  - `pod-docs/feature-details/mfa.md` (new)
- **Success criteria:**
  - `[test]` sign-in of an enrolled user gives `mfa: 'challenge'`; guarded GETs and writes give 403 `mfa_required`; verify, lock, unlock, `GET /api/session` and sign-out work; after verify the cookie is new and everything works — `apps/api/src/auth/mfa/gate.test.ts` › sign-in waits for the code
  - `[test]` setup and the sign-in of an unenrolled user give `mfa: 'enroll'`; only the MFA and lock routes answer; after confirm the state is `none` — `gate.test.ts` › every user must enroll
  - `[test]` an account with data and a session from before this sprint (`mfa_pending` 0, not enrolled) reads `enroll` on its next request, enrolls, then reads its assessment unchanged; its password still signs in — `gate.test.ts` › existing account enrolls at next use and keeps its data
  - `[test]` guard order at its edges: pending without CSRF gives `csrf_failed`; locked and pending gives 423; pending with a temporary password gives `mfa_required`, then after enrolling `password_change_required`; pending as a contributor on an admin route gives `mfa_required` — `apps/api/src/auth/csrf.test.ts` › guard order with MFA
  - `[test]` after an admin reset the user's next sign-in reads `enroll` — `gate.test.ts` › reset forces re-enrollment
  - `[test]` signed-out and setup-required session answers equal the old pins plus `mfa: 'none'` — `apps/api/src/auth/session.test.ts` › session status
  - `[test]` across the MFA flows at `trace`, in local and hosted mode, no log line holds the secret, URI, any recovery code, a quoted code, the key, a password, a token or a Set-Cookie value — `apps/api/src/security/redaction.test.ts` › no secret reaches the logs in local mode
  - `[test]` the admin is set up in the UI, enrolls by typing the code from the manual key, confirms the codes and reaches the dashboard; the suite stays green — `e2e/smoke.spec.ts` › set up the admin in the UI
  - `[test]` sign-in with the notice, password and TOTP opens the app; the same code on a second sign-in in the same step is refused; a recovery code works once; the audit log shows "Two-step sign-in verified" — `e2e/auth.spec.ts` › sign-in with TOTP
  - `[test]` an admin resets a user's two-step sign-in; that user's next sign-in shows "Set up two-step sign-in"; the audit log shows "Two-step sign-in reset" — `auth.spec.ts` › admin reset forces re-enrollment
  - `[test]` the three new screens record zero CSP violations, no horizontal scroll at 375 px, text of 16 px or more, and the key in Space Mono — `e2e/look.spec.ts` › auth screens hold the look
- **Depends on:** R1, G1, U2
- **One-way door:** after this merges, every account needs a code from an authenticator app at each sign-in. Anyone without one, the human included, is asked to set it up straight after their password, or at their next click if already signed in. Undo: revert the slice's merge commit, then end every session as the contract's Undo step says, so no half-finished sign-in becomes a full one. Back up `apps/api/data/rampart-secret.key` with the database. Losing it means every user needs `pnpm admin:reset-mfa`.
- **Model:** opus

### X1: `admin:reset-mfa` CLI
- **Scope:** build the contract's CLI section with `resetMfa` from R1, plus the two package scripts. No other api change.
- **Files owned:**
  - `apps/api/src/auth/mfa/cli.ts` (new)
  - `apps/api/src/auth/mfa/cli.test.ts` (new)
  - `apps/api/package.json` (scripts only)
  - `package.json` (scripts only)
- **Success criteria:**
  - `[test]` against a temp DB with an enrolled user, the CLI (spawned with `DATABASE_PATH`) exits 0 with the success text. The three columns and the codes are cleared, the user's sessions are gone, and one `user.mfa_reset` row has a null actor and a null request id. Another user is untouched — `apps/api/src/auth/mfa/cli.test.ts` › resets one user's MFA
  - `[test]` ` Ada@Example.COM ` matches `ada@example.com`; an unknown email exits 1; no argument or two arguments exit 2 with the usage; an unenrolled user exits 0 with "Nothing changed" and no audit row — `cli.test.ts` › argument and user edges
  - `[test]` a missing DB path exits 1 and creates no file; a DB at migration 0005 exits 1 with the "Start Rampart once" text and stays at 0005 — `cli.test.ts` › never creates or migrates a database
  - `[test]` it succeeds while another connection holds the DB open in WAL mode — `cli.test.ts` › works while the app runs
  - `[test]` the root `admin:reset-mfa` script calls the api script, which runs `src/auth/mfa/cli.ts` — `cli.test.ts` › scripts are wired
- **Depends on:** R1
- **One-way door:** none
- **Model:** opus
