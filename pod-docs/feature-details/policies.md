# Policy upload and link

## What it is
A policy library. Each policy keeps versioned files (with SHA-256) and is linked to the requirements it covers.

## How it works
- `POST /api/policies` creates the policy; `POST .../versions` uploads a file (same raw-body protocol and local store as evidence); `PUT .../requirements` replaces the whole set of linked requirements.
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

## History
- 2026-11-25 · plan cmmc-l2-grc · built (poam-evidence sprint, PRs #8 and #9) · [report](../reports/cmmc-l2-grc.html)
