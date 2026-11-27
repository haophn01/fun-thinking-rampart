# Policy upload and link

## What it is
A policy library. Each policy keeps versioned files (with SHA-256) and is linked to the requirements it covers.

## How it works
- `POST /api/policies` creates the policy; `POST .../versions` uploads a file (same raw-body protocol, `readUpload` checks and local store as evidence: only `.csv .docx .jpeg .jpg .pdf .png .txt .xlsx`, and the bytes must really be that type, or 415 `file_refused`); `PUT .../requirements` replaces the whole set of linked requirements.
- A refused file shows the api's message in the policy's alert (`failureText` in `usePolicies.ts`).
- Each change writes an audit event in the same transaction.
- The Policies page shows the latest file with its hash and "N requirements linked".
- Files: `apps/api/src/policies/`, `apps/web/src/pages/policies/`; the SSP export reads policies for its per-requirement text.
- Example: tick a requirement, Save, reload: "1 requirement linked" with the box still ticked.

## Why it's this way
- Same storage interface as evidence, so one later change adds encryption for both.
- Links are a full-set replace, so the UI and the server can't drift.

## Watch out
- Evidence uses "KiB" and Policies uses "KB" for file sizes (two `formatSize` copies; queued as someday cleanup).
- Policy files are not CUI-checked: V1 isn't approved for CUI.
- Markdown (`.md`) policies can't be uploaded any more; save them as `.txt`. Policy files stored before the guard keep working.

## History
- 2026-11-25 · plan cmmc-l2-grc · built (poam-evidence sprint, PRs #8 and #9) · [report](../reports/cmmc-l2-grc.html)
- 2026-11-27 · plan security-hardening · uploads checked by content and `file_refused` shown on the policy (sec-integrity sprint, U2)
