# Sprint: Integrity — uploads, audit chain, FIPS, SECURITY.md

_From plan: pod-docs/plans/security-hardening.md · Slug: sec-integrity · Status: active · Generated: 2026-11-27_

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | A1 | Audit hash chain: hash on write, legacy backfill, verify api | sec-integrity-A1 | #42 | done | deb2cc3 | — |
| 1 | U1 | Upload content checker, zip guard, name sanitizer, sample files | sec-integrity-U1 | #42 | done | deb2cc3 | — |
| 1 | F1 | FIPS_MODE startup check and PBKDF2-SHA-256 passwords | sec-integrity-F1 | #42 | done | deb2cc3 | — |
| 2 | U2 | Upload hardening wired into evidence and policies | sec-integrity-U2 | #43 | done | 5f5d0a7 | U1 |
| 2 | V1 | Settings › Audit log: Verify audit log | sec-integrity-V1 | #43 | done | 5f5d0a7 | A1 |
| 3 | E1 | e2e: upload refusals, Verify, look of the Verify result | sec-integrity-E1 | #44 | done | a5ed547 | A1, U1, U2, V1 |
| 3 | D1 | SECURITY.md: disclosure, STRIDE, 800-171 self-mapping | sec-integrity-D1 | #44 | done | a5ed547 | A1, U2, F1, V1 |

## Shared contract

Everything in the earlier contracts still holds (foundation, assessment, sec-baseline, sec-auth, sec-mfa), except where this section changes it.

### Conventions (everyone)
- **Ports:** A1 3210–3212, U1 3220/3221, F1 3230/3231, U2 3240/3241, V1 3250/3251, E1 3260/3261, D1 3270/3271. e2e owns 3290, 3293, 3294 and 3295. Never use 3057–3156, 3000 or 3001.
- **e2e:** one slice per wave runs `pnpm e2e` (about 4 min): A1 (wave 1), U2 (wave 2), E1 (wave 3).
- **pnpm:** `corepack pnpm …`, with both shims on PATH for scripts that call pnpm. A vitest worker crash with exit 3221226505 is the known Windows issue: rerun once. Spawned-process tests get a 120 s timeout.
- **Lockfile frozen: no slice changes dependencies.** File types are sniffed by hand and zips are read with `node:zlib` (`inflateRawSync`, `crc32`), not `file-type`. That package can't judge text, doesn't catch zip bombs and needs a worker to be safe (see research). Our parsers are bounded and linear in time.
- **Pinned lists** (error codes, `ROUTE_MATRIX`, the startup rules, `UPLOAD_EXTENSIONS`, the refusal reasons) change only in the slice named here, with their test. A test that pins a changed file's exact rows or responses goes to the slice that changes that file.
- **Source hygiene:** no control bytes or U+FFFD in any source or data file. Write the bidi and zero-width characters as `\u` escapes. Mark secret-looking test literals (hex hashes, keys) `// nosemgrep: <rule> — <reason>`. Order same-moment rows by id in tests.
- **UI tests** mock every call, wait for the request before answering it, and use 15 s timeouts. UI uses only existing look controls and tokens (C · Inspection). New CSS goes in the slice's own new `*.module.css`. `[manual]` look checks are **measured** at 1280 and 375 px (computed styles and `scrollWidth`), never by screenshot.
- **API tests** use `createHarness()` (sign-in finishes MFA). Suites that drive `buildApp` directly use `signInThroughApi` with `RAMPART_SECRET_KEY: HARNESS_SECRET_KEY`.
- **Docs:** each slice updates its own `pod-docs/feature-details/` file, listed in Files owned, and the `pod-docs/features.md` rows it changes (that file is never in Files owned). D1 alone updates `pod-docs/codebase-structure.md`.

### Audit chain (A1)
- **Canonical form:** `auditHash(row)` is the lowercase SHA-256 hex of the UTF-8 bytes of `JSON.stringify(['rampart-audit-v1', prevHash, at, actorUserId, assessmentId, action, entityType, entityId, before, after, requestId])`. Each value is the **stored column value** (a string or null; `before` and `after` are the stored JSON text, never re-parsed). `id` is left out because the hash is set at insert time, and the `prev_hash` links keep the order.
- **On write:** inside the caller's transaction, `recordAudit` reads `prev` (the `hash` of the newest row whose `hash` is not null, or null when there is none), then inserts the row with `prev_hash = prev` and `hash = auditHash(row)`. The writer type becomes `Pick<AppDb, 'insert' | 'select'>`, which every caller already passes. A no-op (deep-equal before and after) reads and writes nothing. Two events in one transaction chain in order, and a rolled-back event leaves no trace.
- **Legacy backfill:** `chainAuditLog(db): { chained: number; unchained: number }` runs in **one transaction**, and only when **no** row has a hash yet. It walks the rows in id order, in batches of 500 by `id > last`, and runs one `UPDATE audit_event SET prev_hash = ?, hash = ? WHERE id = ?` per row. `prev_hash` stays null on the first row only, and nothing else changes (migration 0006's fill-once trigger allows exactly this). Once any row has a hash, it fills nothing and reports `unchained` (the count of null-hash rows), so a row slipped in later by raw SQL is never blessed into the chain.
- **`prepareDatabase(db, log)`** (`audit/prepare.ts`) runs `runMigrations` and then `chainAuditLog`. It logs info `{ chained }` when `chained > 0`, and warn `{ unchained }` ("audit events without a hash; Verify names the first") when `unchained > 0`. `server.ts` (before `buildApp` and `listen`) and `db/migrate.ts` call it. A failure is the existing fatal log and exit 1. The MFA CLI (`runResetMfa`) runs `chainAuditLog` before its transaction and never migrates.
- **Verify:** `verifyAuditChain(db, now)` walks every row in id order. `expected` starts as null. For each row:
  - `hash` is null → broken, `unchained`
  - `prev_hash` isn't `expected` → `prev_mismatch`
  - `hash` isn't `auditHash(row)` → `hash_mismatch`
  - otherwise it counts as checked, and `expected = hash`

  It stops at the first broken row. Known limit: removing the newest rows can't be detected, because the head isn't anchored outside the DB. `headHash` is shown so a user can record it.
- **Contract (`contract/audit.ts`):** `AUDIT_CHAIN_PROBLEMS = ['unchained', 'prev_mismatch', 'hash_mismatch']`. `auditVerifyResponseSchema = { ok, checked, total, headHash, firstBroken, verifiedAt }`:
  - `ok`: boolean
  - `checked` and `total`: integers ≥ 0
  - `headHash`: `sha256Schema.nullable()`, the newest row's stored hash
  - `firstBroken`: `{ id: int, at: string, action: string, problem }` or null. `at` and `action` are plain strings, because a tampered row may hold anything.
  - `verifiedAt`: ISO datetime
  - a refine requires `ok === (firstBroken === null)`, and `checked === total` when ok
- **Route:** `GET /api/audit/verify` is for any signed-in user, in the general rate bucket. It writes nothing and no audit event. `ROUTE_MATRIX`: `{ access: 'session', sample: { url: '/api/audit/verify' }, idor: { notApplicable: 'the whole audit log, not an assessment row' } }`.
- **Backup (orchestrator, before the wave-1 merge reaches the checkout the human's app runs from):** in `apps/api`, run `node -e "const D=require('better-sqlite3');new D('data/rampart.sqlite',{readonly:true}).backup('data/rampart.pre-chain.sqlite').then(()=>console.log('backup ok'))"`. **Restore:** stop the app, copy `data/rampart.pre-chain.sqlite` over `data/rampart.sqlite`, delete `rampart.sqlite-wal` and `-shm`, then revert A1's merge commit. After a plain revert (no restore), the hashes stay in place and unused. Events the old code writes afterwards are unchained, and Verify names the first of them once A1 is back.

### Uploads (U1 builds the checker; U2 wires it)
- **`contract/uploads.ts`** (new, U1; U2 re-exports it from `index.ts`):
  - `ZIP_LIMITS = { maxEntries: 1000, maxExpandedBytes: 104_857_600, maxRatio: 100, maxInflatedPartBytes: 1_048_576 }`
  - `FILE_REFUSED_REASONS = ['content_mismatch', 'not_text', 'markup_in_text', 'macro_enabled', 'encrypted', 'zip_too_many_entries', 'zip_too_large', 'zip_ratio', 'zip_malformed', 'zip_unsafe_path']`
  - `DETECTED_FILE_TYPES = ['pdf', 'png', 'jpeg', 'docx', 'xlsx', 'text', 'markup', 'executable', 'archive', 'unknown']`
  - `fileRefusedDetailsSchema = { reason, extension, detected? }`
  - `fileRefusedMessage(reason, extension, detected?)`. `<EXT>` is the extension without its dot, uppercased.
    - content_mismatch: "This file's contents aren't a real <EXT> file." When `detected` isn't `unknown`, it adds " It looks like <d>.", where `<d>` is one of: a PDF, a PNG image, a JPEG image, a Word document, an Excel workbook, a text file, a web page or SVG, a program, an archive.
    - not_text: "This file isn't plain text. Save it as UTF-8 text and try again."
    - markup_in_text: "This text file holds web markup (HTML, SVG or XML), which can't be uploaded."
    - macro_enabled: "Files with macros can't be uploaded. Save it as .docx or .xlsx without macros."
    - encrypted: "Password-protected files can't be uploaded."
    - zip_too_many_entries: "This file holds more than 1,000 parts."
    - zip_too_large: "This file expands to more than 100 MiB."
    - zip_ratio: "This file expands to more than 100 times its size."
    - zip_malformed: "This file is damaged or uses an unsupported format."
    - zip_unsafe_path: "This file holds a part with an unsafe name."
- **Kinds by extension:** `.pdf` pdf, `.png` png, `.jpg`/`.jpeg` jpeg, `.docx` docx, `.xlsx` xlsx, `.txt`/`.csv` text.
  - pdf: starts with `%PDF-` + digit + `.` + digit at byte 0
  - png: the 8-byte signature, then `IHDR` at bytes 12–15
  - jpeg: `FF D8 FF`
  - docx/xlsx: `PK 03 04`, passes the zip guard, and holds `[Content_Types].xml` plus `word/document.xml` (docx) or `xl/workbook.xml` (xlsx). Any `*vbaProject.bin` entry, or `macroEnabled` (any case) in the content types, is `macro_enabled`.
  - text: strip a UTF-8 BOM, then require a fatal UTF-8 decode and no code points U+0000–U+0008, U+000B, U+000E–U+001F or U+007F (tab, LF, FF and CR pass). If the first non-whitespace text starts (any case) with `<!doctype`, `<html`, `<svg`, `<?xml` or `<script`, the answer is `markup_in_text`.
- **`detected`** (for messages): pdf, png and jpeg by their signatures. A zip is docx, xlsx or archive, by its parts. `MZ`, `\x7FELF`, the Mach-O magics or `#!` are executable. Rar, 7z, gzip, bzip2, xz or `ustar` at byte 257 are archive. A first non-whitespace `<` is markup. Text that passes the text check is text. Anything else is unknown.
- **Zip guard order:**
  1. Find the EOCD in the last 65,557 bytes. It must be on disk 0, not ZIP64 (`0xFFFF` or `0xFFFFFFFF`), with the central directory inside the file, and its count must equal the number of records parsed. Otherwise `zip_malformed`.
  2. More than 1,000 entries → `zip_too_many_entries`.
  3. Per entry: flag bit 0 → `encrypted`. A name with NUL, a leading `/` or `\`, any `\`, a `..` segment or `X:` → `zip_unsafe_path`. A method other than 0 or 8, a stored size mismatch or a duplicate name → `zip_malformed`.
  4. The declared uncompressed total above 104,857,600 → `zip_too_large`.
  5. The total above 100 × the upload's byte length → `zip_ratio`.
  6. Inflate each entry with `maxOutputLength` set to its declared size. More, less or a CRC mismatch → `zip_malformed`.

  Exactly 1,000 entries, exactly 104,857,600 bytes and exactly 100:1 pass.
- **`sanitizeFileName(name): string | null`** (`uploads/file-name.ts`):
  1. NFC
  2. remove U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+2069 and U+FEFF
  3. replace each of `< > : " | ? *` with `_`
  4. prefix `_` when the part before the first `.` is a Windows device name (CON, PRN, AUX, NUL, COM1–9, LPT1–9, any case)
  5. re-check with `fileNameSchema`; a failure returns null

  Example: `report‮fdp.exe` becomes `reportfdp.exe`, which the extension check then refuses.
- **`UPLOAD_EXTENSIONS`** becomes exactly `['.csv', '.docx', '.jpeg', '.jpg', '.pdf', '.png', '.txt', '.xlsx']`.
- **Error code** `file_refused` (415) is appended after `mfa_wrong_step`. Its envelope message is `fileRefusedMessage(…)`, with `details` per `fileRefusedDetailsSchema`.
- **`readUpload` order:** octet-stream body (415) → name header (400) → `sanitizeFileName` (null gives 400 `validation_failed` on `x-file-name`) → extension (415 `unsupported_file_type`, `details.allowed`) → empty (400) → size (413) → content (415 `file_refused`). The sanitized name is what gets stored, returned and audited. A refusal stores nothing and writes no event.
- **Existing stored files aren't touched:** legacy versions still list, download byte-identical and link as diagrams. Only new uploads are checked.
- **Samples** (`apps/api/src/uploads/testing/samples.ts`, plain Node, no vitest import, so e2e can import it):
  - `samplePdf()`, `samplePng()` (reuses `pngOf` from `ssp/testing/docx-text.ts`), `sampleJpeg()`, `sampleDocx()`, `sampleXlsx()` (minimal valid files)
  - `zipOf(entries, { encrypted?, declaredSize? })`
  - `zipBombDocx()` (`sampleDocx` plus a 20 MiB zero part, deflated, so the ratio is above 100)
  - `fakeExe()` (`MZ`, a PE header and NULs)

### FIPS (F1)
- **Config:** `FIPS_MODE` → `fipsMode: 'off' | 'required'`, default `off`. Only those exact lowercase values are accepted. `on`, `REQUIRED`, `true` and ` required` are refused and named in `ConfigError`.
- **Startup rule,** appended last: `fips-required-not-enabled`, broken when `fipsMode === 'required'` and the probe says FIPS is off. It applies in local and hosted mode alike. Explain text: "FIPS_MODE=required but Node's crypto isn't in FIPS mode (crypto.getFips() is 0); run Node with --enable-fips and a FIPS-validated OpenSSL provider, or set FIPS_MODE=off". The signature is `assertSafeStartup(config, probe = { fipsEnabled: () => getFips() === 1 })`.
- **Passwords (`auth/password.ts`):** `PasswordScheme = 'argon2id' | 'pbkdf2-sha256'`, and `passwordSchemeFor(config)` gives pbkdf2 only when FIPS is required.
  - `hashPassword(pw, scheme = 'argon2id')`. PBKDF2-HMAC-SHA-256 uses async `crypto.pbkdf2`, `PBKDF2_ITERATIONS = 600_000`, a 16-byte salt and a 32-byte key, stored as `$pbkdf2-sha256$i=600000$<salt>$<key>` (standard base64, no padding).
  - `verifyPassword(stored, pw, scheme = 'argon2id')` picks the scheme from the stored prefix, so both kinds always verify. PBKDF2 compares with `timingSafeEqual`. Iterations outside 100,000–10,000,000, a bad salt, a bad key length, bad base64 or an unknown prefix → false, never a throw. A null `stored` verifies against that scheme's dummy hash (`DUMMY_HASH` or `DUMMY_PBKDF2_HASH`) and returns false.
- **Callers** pass `passwordSchemeFor(deps.config)`: setup and the sign-in dummy (`auth/routes.ts`), change and unlock (`session-routes.ts`), create and reset (`users/routes.ts`). The reuse check verifies history by prefix.
- **No rehash at sign-in:** argon2 hashes stored before FIPS was required keep working (a gap SECURITY.md records).

## Per-slice detail

### A1: Audit hash chain: hash on write, legacy backfill, verify api
- **Scope:** build the contract's Audit chain section: `audit/chain.ts` (new: `auditHash`, `chainAuditLog`, `verifyAuditChain`), hash on write in `record.ts`, `audit/prepare.ts` called from `server.ts` and `db/migrate.ts`, `chainAuditLog` in the MFA CLI, the verify route and schema, and its `ROUTE_MATRIX` entry. Don't touch `schema.ts` or add a migration. Don't change `GET /api/audit`'s response. Update `feature-details/audit-log.md` (the chain, the backfill, Verify, the known limit) and the Audit log row in `features.md`.
- **Files owned:** `apps/api/src/audit/chain.ts` (new), `apps/api/src/audit/chain.test.ts` (new), `apps/api/src/audit/prepare.ts` (new), `apps/api/src/audit/prepare.test.ts` (new), `apps/api/src/audit/verify.test.ts` (new), `apps/api/src/audit/record.ts`, `apps/api/src/audit/record.test.ts`, `apps/api/src/audit/list.ts`, `apps/api/src/contract/audit.ts`, `apps/api/src/contract/audit-verify.test.ts` (new), `apps/api/src/security/route-matrix.ts`, `apps/api/src/security/route-matrix.test.ts`, `apps/api/src/server.ts`, `apps/api/db/migrate.ts`, `apps/api/src/auth/mfa/cli.ts`, `apps/api/src/auth/mfa/cli.test.ts`, `pod-docs/feature-details/audit-log.md`
- **Success criteria:**
  - `[test] auditHash equals a vector computed independently with a node:crypto one-liner (recorded in the test) for a row with nulls and JSON text — apps/api/src/audit/chain.test.ts › auditHash matches the pinned vector`
  - `[test] the first event has prev_hash null; each later event's prev_hash is the previous hash, also for two events in one transaction; a no-op writes nothing — apps/api/src/audit/chain.test.ts › recordAudit links each event to the one before`
  - `[test] a rolled-back event leaves no row, and the next event links to the last committed one — apps/api/src/audit/chain.test.ts › a rolled-back event leaves the chain intact`
  - `[test] 1,201 legacy null-hash rows are chained in id order with one UPDATE each, and nothing else changes; a second run chains 0; an empty log chains 0 — apps/api/src/audit/chain.test.ts › chains legacy events once, in id order, across batches`
  - `[test] with one hashed row present, a raw-inserted null row isn't filled and is reported as unchained — apps/api/src/audit/chain.test.ts › leaves unhashed events alone once the chain has started`
  - `[test] a temp trigger that aborts on row 3 makes the backfill throw with rows 1–2 still null — apps/api/src/audit/chain.test.ts › the backfill is one transaction`
  - `[test] the exact-row pin now holds prev_hash null and the computed hash — apps/api/src/audit/record.test.ts › stores before and after as JSON, with before null on create`
  - `[test] verify on a fresh harness after several writes is ok with checked = total and headHash = the newest hash; an empty log is ok, 0/0, headHash null — apps/api/src/audit/verify.test.ts › GET /api/audit/verify passes on a fresh log and an empty one`
  - `[test] a DB built at migration 0005 with audit rows, then prepareDatabase, then more writes, verifies ok — apps/api/src/audit/verify.test.ts › passes on a migrated DB`
  - `[test] with the update trigger dropped, editing one row's after makes verify name that id with hash_mismatch and checked = id − 1 — apps/api/src/audit/verify.test.ts › names the edited event`
  - `[test] re-hashing an edited row, or deleting a row (delete trigger dropped), names the next row with prev_mismatch — apps/api/src/audit/verify.test.ts › names the event after a re-hashed or deleted one`
  - `[test] a raw-inserted null-hash row is named unchained, and events written after it still link to the last hashed row — apps/api/src/audit/verify.test.ts › names an event added outside Rampart`
  - `[test] removing the newest row (trigger dropped) still verifies ok, with a different headHash — apps/api/src/audit/verify.test.ts › a removed newest event is not detected (documented limit)`
  - `[test] the refine refuses ok with firstBroken, broken without it, and ok with checked ≠ total; at and action take any string — apps/api/src/contract/audit-verify.test.ts › auditVerifyResponseSchema edges`
  - `[test] spawned db/migrate.ts on a legacy DB chains every row, logs { chained }, and exits 0 — apps/api/src/audit/prepare.test.ts › db:migrate chains a legacy log`
  - `[test] spawned server.ts on a legacy DB (port 3212) answers health, and after it is killed every row is chained — apps/api/src/audit/prepare.test.ts › the server chains a legacy log before it listens`
  - `[test] runResetMfa on a legacy DB chains the old rows, then writes a linked user.mfa_reset; verify is ok — apps/api/src/auth/mfa/cli.test.ts › chains a legacy log before it writes`
  - `[test] the matrix covers GET /api/audit/verify (401 signed out; no IDOR) — apps/api/src/security/route-matrix.test.ts › every api route has exactly one matrix entry`
- **Depends on:** —
- **One-way door:** On the first start after this merges, Rampart writes a hash into every existing audit event in the human's database, once, and the database then refuses to change or clear those hashes. Undo: revert the slice's merge commit (the hashes stay in the rows, unused and harmless). To get the rows back exactly as they were, stop the app and restore the backup taken before the merge.
- **Model:** opus

### U1: Upload content checker, zip guard, name sanitizer, sample files
- **Scope:** pure modules with no route changes: `contract/uploads.ts`; `uploads/file-check.ts` with `checkFileContent(extension, bytes): { reason, detected? } | null` and `detectFileType(bytes)`; `uploads/zip.ts` with `inspectZip(bytes)`; `uploads/file-name.ts` with `sanitizeFileName`; and the samples. All follow the contract's Uploads section. Don't edit `readUpload`, `files.ts`, `error.ts` or `index.ts`.
- **Files owned:** `apps/api/src/contract/uploads.ts` (new), `apps/api/src/contract/uploads.test.ts` (new), `apps/api/src/uploads/file-check.ts` (new), `apps/api/src/uploads/file-check.test.ts` (new), `apps/api/src/uploads/zip.ts` (new), `apps/api/src/uploads/zip.test.ts` (new), `apps/api/src/uploads/file-name.ts` (new), `apps/api/src/uploads/file-name.test.ts` (new), `apps/api/src/uploads/testing/samples.ts` (new), `apps/api/src/uploads/testing/samples.test.ts` (new)
- **Success criteria:**
  - `[test] every reason's message is exact, with <EXT> uppercased and the detected sentence only when known — apps/api/src/contract/uploads.test.ts › fileRefusedMessage texts`
  - `[test] samplePdf, samplePng, sampleJpeg, sampleDocx, sampleXlsx, a docx from the SSP renderer, a .txt and a UTF-8 BOM .csv all pass — apps/api/src/uploads/file-check.test.ts › accepts real PDF, PNG, JPEG, DOCX, XLSX, TXT and CSV`
  - `[test] fakeExe as .pdf gives content_mismatch/executable; a PNG as .jpg gives jpeg/png; a docx as .xlsx gives docx; a plain zip as .docx gives archive; " %PDF-1.4" and "%PDF-" alone are refused — apps/api/src/uploads/file-check.test.ts › refuses bytes that don't match the extension, naming what they are`
  - `[test] text: NUL, 0x07, 0x1B, 0x7F, invalid UTF-8 and a UTF-16 BOM give not_text; tab, CR, LF, FF and U+FFFD text pass; "  <!DOCTYPE html>", "<svg", "<?xml", "<script" give markup_in_text; "a<b" passes — apps/api/src/uploads/file-check.test.ts › text check edges`
  - `[test] a vbaProject.bin part, or macroEnabled in the content types, gives macro_enabled — apps/api/src/uploads/file-check.test.ts › refuses macro-enabled office files`
  - `[test] exactly 1,000 entries pass and 1,001 give zip_too_many_entries — apps/api/src/uploads/zip.test.ts › entry count edge`
  - `[test] a declared total of exactly 104,857,600 passes and 104,857,601 gives zip_too_large — apps/api/src/uploads/zip.test.ts › expanded size edge`
  - `[test] exactly 100:1 passes, just over gives zip_ratio, and zipBombDocx gives zip_ratio without inflating anything — apps/api/src/uploads/zip.test.ts › ratio edge`
  - `[test] encrypted flag; ../, /abs, a\b, C:x and NUL names; method 12; ZIP64 markers; truncated EOCD; a bad CRC; a duplicate name; a count mismatch — each gives its reason — apps/api/src/uploads/zip.test.ts › refuses encrypted, unsafe paths, odd methods, zip64 and damage`
  - `[test] an entry whose data inflates past its declared size gives zip_malformed, with output capped at the declared size — apps/api/src/uploads/zip.test.ts › refuses an entry that inflates past its declared size`
  - `[test] RTLO and zero-width characters are removed; < > : " | ? * become _; CON.pdf becomes _CON.pdf and com1.txt becomes _com1.txt; an NFD name comes back NFC; a name that becomes empty gives null — apps/api/src/uploads/file-name.test.ts › sanitizeFileName edges`
  - `[test] samples are what they claim (PDF header and %%EOF, JPEG SOI/EOI, the docx readable by docxPart) and the module imports no vitest — apps/api/src/uploads/testing/samples.test.ts › samples are well-formed`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### F1: FIPS_MODE startup check and PBKDF2-SHA-256 passwords
- **Scope:** the contract's FIPS section: the config field, the startup rule with its probe, the PBKDF2 scheme in `password.ts`, and the four call sites. `buildApp` still never runs the startup check. Don't touch `server.ts`. Update `feature-details/setup-and-sign-in.md` (FIPS_MODE, the PBKDF2 option, no rehash).
- **Files owned:** `apps/api/src/config.ts`, `apps/api/src/config.test.ts`, `apps/api/src/security/startup.ts`, `apps/api/src/security/startup.test.ts`, `apps/api/src/auth/password.ts`, `apps/api/src/auth/password.test.ts` (new), `apps/api/src/auth/fips-passwords.test.ts` (new), `apps/api/src/auth/routes.ts`, `apps/api/src/auth/session-routes.ts`, `apps/api/src/users/routes.ts`, `pod-docs/feature-details/setup-and-sign-in.md`
- **Success criteria:**
  - `[test] unset and empty give off; off and required parse; on, REQUIRED, true and " required" are refused and named — apps/api/src/config.test.ts › FIPS_MODE`
  - `[test] required with the probe off breaks only fips-required-not-enabled, listed last after hosted rules, in local and hosted mode; probe on, or off mode, passes — apps/api/src/security/startup.test.ts › fips-required-not-enabled`
  - `[test] spawned server.ts with FIPS_MODE=required on a Node where getFips() is 0 exits 1, logs the rule at level 60 and creates no DB (skipped with a note when getFips() is 1) — apps/api/src/security/startup.test.ts › server refuses FIPS_MODE=required without FIPS crypto`
  - `[test] a pbkdf2 hash matches the format with i=600000, verifies, and refuses a wrong password; two hashes of one password differ — apps/api/src/auth/password.test.ts › pbkdf2-sha256 hashes and verifies`
  - `[test] i=0, 99999, 10000001, i=abc, a 15-byte salt, a 31-byte key, bad base64 and an unknown prefix each give false without throwing — apps/api/src/auth/password.test.ts › refuses malformed pbkdf2 hashes without throwing`
  - `[test] an argon2 hash verifies under scheme pbkdf2 and a pbkdf2 hash under argon2 — apps/api/src/auth/password.test.ts › verifies either scheme whatever the mode`
  - `[test] null stored returns false and runs the pbkdf2 dummy when the scheme is pbkdf2 (spy) — apps/api/src/auth/password.test.ts › an unknown user spends the mode's hash time`
  - `[test] with FIPS_MODE=required: setup, an admin-created temporary password and a change all store $pbkdf2-sha256$, and sign-in works — apps/api/src/auth/fips-passwords.test.ts › FIPS_MODE=required stores PBKDF2 hashes for setup, change and temporary passwords`
  - `[test] an admin set up with FIPS off still signs in after buildApp is rebuilt on the same DB with FIPS required, and their next change stores PBKDF2 — apps/api/src/auth/fips-passwords.test.ts › accounts from before FIPS_MODE still sign in`
  - `[test] reusing a password whose history hash is argon2 is refused while the current hash is PBKDF2 — apps/api/src/auth/fips-passwords.test.ts › reuse check spans both schemes`
- **Depends on:** —
- **One-way door:** none (FIPS_MODE defaults to off, so nothing changes unless it is set)
- **Model:** opus

### U2: Upload hardening wired into evidence and policies
- **Scope:** the contract's `readUpload` order, the new `UPLOAD_EXTENSIONS`, `file_refused`, and `export * from './uploads'` in `index.ts`. Add a harness helper `h.seedFileVersion({ evidenceItemId, bytes, fileName })` that stores a version as a pre-guard upload would (the store plus a direct row insert), and move every test that uploaded fake bytes onto the samples or that helper (the GIF/WEBP-as-PNG diagram, lint and export cases become seeded legacy files). Web: Policies shows a `file_refused` message, as Evidence already does. e2e: the `.md` policy files in `smoke.spec.ts` and `look.spec.ts` become `.txt`. Update `feature-details/evidence.md` and `policies.md`, and the Evidence row in `features.md` (a renamed EXE is refused).
- **Files owned:** `apps/api/src/contract/files.ts`, `apps/api/src/contract/error.ts`, `apps/api/src/contract/index.ts`, `apps/api/src/contract/contract.test.ts`, `apps/api/src/contract/schemas.test.ts`, `apps/api/src/uploads/upload.ts`, `apps/api/src/uploads/upload.test.ts`, `apps/api/src/uploads/upload-guard.test.ts` (new), `apps/api/src/testing/harness.ts`, `apps/api/src/evidence/versions.test.ts`, `apps/api/src/evidence/download.test.ts`, `apps/api/src/policies/versions.test.ts`, `apps/api/src/policies/items.test.ts`, `apps/api/src/ssp-data/diagrams/diagrams.test.ts`, `apps/api/src/ssp/export.test.ts`, `apps/api/src/ssp/lint.test.ts`, `apps/web/src/pages/policies/usePolicies.ts`, `apps/web/src/pages/policies/list.test.tsx`, `apps/web/src/pages/evidence/upload.test.tsx`, `apps/web/src/api/client.test.ts`, `e2e/smoke.spec.ts`, `e2e/look.spec.ts`, `pod-docs/feature-details/evidence.md`, `pod-docs/feature-details/policies.md`
- **Success criteria:**
  - `[test] UPLOAD_EXTENSIONS is exactly the eight, and uploadProblem refuses .md, .zip, .svg, .html and .exe — apps/api/src/contract/schemas.test.ts › UPLOAD_EXTENSIONS is the strict list`
  - `[test] file_refused is appended last with 415 — apps/api/src/contract/contract.test.ts › health and error schemas match the contract`
  - `[test] the order holds: body, header, sanitize (null gives 400), extension, empty, size, content (415 file_refused with details) — apps/api/src/uploads/upload.test.ts › readUpload`
  - `[test] on evidence and policies: fakeExe as report.pdf, a.svg, page.html and zipBombDocx each refused with their code and message; samplePdf, samplePng, sampleDocx and sampleXlsx get 201 — apps/api/src/uploads/upload-guard.test.ts › refuses a renamed EXE, an SVG, an HTML file and a zip-bomb docx, and accepts real files`
  - `[test] a refusal stores no bytes, adds no version and writes no audit event — apps/api/src/uploads/upload-guard.test.ts › nothing is stored or audited on a refusal`
  - `[test] "a‮fdp.txt" is stored and returned as "afdp.txt", and "CON.txt" as "_CON.txt", in the version, the download name and the audit event — apps/api/src/uploads/upload-guard.test.ts › sanitized names are stored and returned`
  - `[test] a seeded legacy GIF named map.png still lists, downloads byte-identical and is still not embeddable; uploading the same bytes now gives file_refused — apps/api/src/uploads/upload-guard.test.ts › stored files from before the guard still list and download`
  - `[test] a mocked 415 file_refused shows its message on the policy — apps/web/src/pages/policies/list.test.tsx › shows a refused file's reason`
  - `[test] a mocked 415 file_refused shows its message on the evidence item — apps/web/src/pages/evidence/upload.test.tsx › shows a refused file's reason`
  - `[test] a .md or .zip file is refused before sending, with the new allowed list — apps/web/src/api/client.test.ts › a .md or .zip file is refused before sending`
  - `[test] the full e2e run is green with the .txt policy files — e2e/smoke.spec.ts › policy upload and link`
- **Depends on:** U1
- **One-way door:** none (the allowlist is narrower; reverting the merge restores the old list, and stored files never change)
- **Model:** opus

### V1: Settings › Audit log: Verify audit log
- **Scope:** a new `AuditVerify` component, rendered at the top of `AuditLog.tsx`. A Button "Verify audit log" calls `GET /api/audit/verify` (`auditVerifyResponseSchema`) only when clicked. Each click re-runs it, and only the newest answer is shown. While it runs, the button is disabled with the label "Verifying…", and a polite live line reads "Checking every event's hash…". The results:
  - **Ok:** `Alert tone="info"` titled "Audit log intact". The body reads "All N events check out." (`N` with `toLocaleString('en-US')`), "The 1 event checks out." for one, or "No events yet. Nothing to check." for none. Then a "Newest hash" label with `headHash` in `--rp-font-mono` (`overflow-wrap: anywhere`), and "Checked <local time>" in a `<time dateTime>`.
  - **Broken:** `Alert tone="error"` titled "Audit log broken". The body reads "The chain breaks at event <id>: <ACTION_LABELS[action] or the raw action>, <local time of at, or the raw at>." Then one of: unchained "It has no hash: it was added outside Rampart."; prev_mismatch "Its link to the event before it doesn't match: an earlier event was changed or removed."; hash_mismatch "Its contents don't match its hash: it was changed after it was written." Then "<checked> events before it check out."
  - **Failure:** "Couldn't verify the audit log." with Retry. A 429 shows `tooManyRequestsText(details)`.

  Update the Audit log row in `features.md` (Verify shows "Audit log intact").
- **Files owned:** `apps/web/src/pages/settings/AuditVerify.tsx` (new), `apps/web/src/pages/settings/AuditVerify.module.css` (new), `apps/web/src/pages/settings/AuditVerify.test.tsx` (new), `apps/web/src/pages/settings/AuditLog.tsx`
- **Success criteria:**
  - `[test] opening Settings › Audit log sends no verify request until the button is clicked; existing AuditLog tests stay green — apps/web/src/pages/settings/AuditVerify.test.tsx › sends nothing until clicked`
  - `[test] ok answers for 0, 1 and 1,234 events show the exact texts, the hash in mono and the time — apps/web/src/pages/settings/AuditVerify.test.tsx › shows intact with the count and newest hash`
  - `[test] each of the three problems shows its sentence with the event id, the label and the checked count; an unknown action shows raw — apps/web/src/pages/settings/AuditVerify.test.tsx › names the first broken event and its problem`
  - `[test] a 500 shows the error with Retry, which re-sends; a 429 with retryAfterSeconds 30 shows "Too many requests. Try again in 30 seconds." — apps/web/src/pages/settings/AuditVerify.test.tsx › shows an error with Retry, and the 429 wait`
  - `[test] two clicks with the first answer arriving last show only the second — apps/web/src/pages/settings/AuditVerify.test.tsx › only the newest answer is shown`
  - `[manual] at 1280 and 375 px the result has no horizontal overflow (scrollWidth ≤ clientWidth), the 64-hex hash wraps, text is ≥ 16 px, and the button and Alert use the existing controls — measure in a browser on the production path`
- **Depends on:** A1
- **One-way door:** none
- **Model:** sonnet

### E1: e2e: upload refusals, Verify, look of the Verify result
- **Scope:** new tests at the end of smoke's `verification path` describe (signed in as smoke's admin, config server 3290), and the Verify result measured in look's existing `auth screens hold the look` test. Samples come from `apps/api/src/uploads/testing/samples.ts`. Keep the run near 4 min, and never reuse a TOTP step (`nextTotpCode`).
- **Files owned:** `e2e/smoke.spec.ts`, `e2e/look.spec.ts`, `e2e/helpers/api.ts`
- **Success criteria:**
  - `[test] Evidence UI: report.pdf with fakeExe bytes shows "This file's contents aren't a real PDF file. It looks like a program." and adds no version; diagram.svg shows the pre-check list and sends no request; via the api, page.html gives 415 unsupported_file_type, a .txt starting <!doctype html> gives file_refused/markup_in_text, and zipBombDocx gives file_refused/zip_ratio; samplePdf, samplePng, sampleDocx and sampleXlsx get 201 — e2e/smoke.spec.ts › upload refusals`
  - `[test] Settings › Audit log › Verify audit log shows "Audit log intact" with N and the newest hash equal to GET /api/audit/verify's checked and headHash — e2e/smoke.spec.ts › audit log verifies`
  - `[test] the intact result, and a broken result fulfilled through the look spec's route, hold the look at 1280 and 375 px (no overflow, text ≥ 16 px, the hash in Space Mono) with zero CSP violations — e2e/look.spec.ts › auth screens hold the look`
- **Depends on:** A1, U1, U2, V1
- **One-way door:** none
- **Model:** opus

### D1: SECURITY.md: disclosure, STRIDE, 800-171 self-mapping
- **Scope:** a root `SECURITY.md` with these sections, in order:
  - `## Supported versions`
  - `## Reporting a vulnerability`: following CISO Assistant's; GitHub private vulnerability reporting, never a public issue; what to include; agent-default targets of acknowledgement in 5 business days and a fix or plan in 30 days for high or critical
  - `## Threat model (STRIDE)`: a table with rows for api, web, file store and CI, and a cell for each of the six letters (threat, mitigation, code path)
  - `## NIST SP 800-171 self-mapping`: `| Requirement | Control | Code | Test | Status |`, with Code as backticked repo paths and Test as `` `file` › test name `` entries joined by `; `. Rows: 3.1.8, 3.1.9, 3.1.10, 3.1.11, 3.3.1, 3.3.8, 3.5.3, 3.5.7, 3.5.8, 3.5.9, 3.5.10, 3.5.11, 3.13.11, 3.14.1 and 3.14.2. Status is Met, Partial or Gap.
  - `## Known gaps`: FIPS (Windows Node, argon2 hashes kept), the chain's unanchored head, no virus scanning, encryption at rest by host disk, Windows key-file ACLs (queue item), synchronous upload parsing
  - `## Verification evidence`: one row per plan Verification item (Route matrix, CI, Headers, Rate limits, Sessions, Passwords, Notice, Lock, MFA, Uploads, Redaction, Audit chain, FIPS, SECURITY.md, Regression), each citing tests that exist at wave 3 start (earlier sprints, A1, U1, U2, F1, V1; not E1's new tests). "CI green on the final PR" is marked as a check the orchestrator does.

  An item with no test gets a black-box test in `apps/api/src/security/plan-verification.test.ts` if the harness can cover it. Otherwise raise a PENDING. Also add a README link, and update `codebase-structure.md` (Stack: FIPS_MODE, the upload guard, the audit chain; Smoke recipe: `FIPS_MODE`, the allowed types, Verify).
- **Files owned:** `SECURITY.md` (new), `tests/repo/security-md.test.ts` (new), `apps/api/src/security/plan-verification.test.ts` (new, only if needed), `README.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] every listed requirement has a row; every Code path exists; every Test file exists and contains its test name; Status is Met, Partial or Gap — tests/repo/security-md.test.ts › maps every touched 800-171 requirement to code and a test`
  - `[test] the STRIDE table has api, web, file store and CI, each with all six letters filled — tests/repo/security-md.test.ts › STRIDE covers api, web, file store and CI`
  - `[test] each of the 15 Verification items has a row citing at least one existing test (CI-green excepted) — tests/repo/security-md.test.ts › every plan Verification item cites a test`
  - `[test] the six sections appear in order, and there's no TODO, TBD or <…> placeholder — tests/repo/security-md.test.ts › has the disclosure policy sections`
- **Depends on:** A1, U2, F1, V1
- **One-way door:** none
- **Model:** opus

## Sprint summary

- **Synced with merge-target:** up to date (`main` has not moved since 91161a6).
- **Slices shipped:** A1, U1 and F1 (#42); U2 and V1 (#43); E1 and D1 (#44).
- **One-way door:** A1, the audit backfill. The human approved it ("merge the audit-chain wave"). The DB was backed up to `apps/api/data/rampart.pre-chain.sqlite` and to `D:/Projects/Rampart-backups/2026-11-27-pre-chain`. The human's app chained all 11 events.
- **Queue:**
  - resolved the A1 door
  - added the human item "enable GitHub private vulnerability reporting" (before hosting)
- **Decisions taken:**
  - a corrupt stored hash fails sign-in with 401
  - a fake file on a CUI item gets 415 before 409
  - the web pre-check refuses invisible characters in names
  - E1's red step shown by mutating the expected values
- **Slice log:**
  - A1: opus · high
  - U1: opus · medium
  - F1: opus · medium
  - U2: opus · medium
  - V1: sonnet · medium
  - E1: opus · medium
  - D1: opus · medium
  - One 5-hour limit stop (E1 and D1), resumed with nothing lost. No stalls.
- **Wave fixes:** none. The only board fix was that the branch names on the board are uppercase.
- **Wave checks:** verify 1,350 → 1,368 → 1,373; e2e 26 → 26 → 29. CI green on all 7 jobs for #42, #43 and #44.
- **Agent context at hand-back:** about 1,180,000 tokens (the sum of final context sizes, not billed).
- **For plan complete:**
  - `SECURITY.md` maps every plan Verification item to a test.
  - `features.md` rows were updated by the slices.
  - Known gaps are listed in `SECURITY.md`.
