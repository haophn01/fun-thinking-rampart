# System profile save

## What it is
The SSP's system characteristics: 13 fields (system name, identifier, organization, CAGE code, description, boundary, environment, interconnections, information types, owner and security contact with emails). One per assessment, edited in section 1 "System profile" of **SSP** > Identification & roles (`/ssp`, or `/ssp?tab=identification`), above the SSP-only identification fields and the roles table.

## How it works
- `GET` and `PATCH /api/system-profile` (`apps/api/src/system-profile/`). The field list and per-field rules live in `contract/system-profile.ts`, shared with the form.
- Blank or whitespace-only text becomes null. A CAGE code is trimmed, uppercased and must be exactly 5 letters or digits.
- Each save writes a `system_profile.updated` audit event; migration 0004 adds the `system_profile` table.
- Example: `1abc2` is stored as `1ABC2`; a 4-character code shows "A CAGE code is exactly 5 letters or digits" and saves nothing.

## Why it's this way
- One contract file drives the form, the API and the SSP table, so a new field is added in one place.

## Watch out
- Empty fields appear in the SSP as "Not provided".
- Don't put CUI in the description or boundary text.
- The same tab holds two forms on two routes: this one (`/api/system-profile`) and the SSP profile's identification fields (`/api/ssp/profile`, `SspProfileForm`). Each Save sends only its own form's keys.

## History
- 2026-11-25 · plan cmmc-l2-grc · built (ssp-dashboard sprint, PRs #10 and #11) · [report](../reports/cmmc-l2-grc.html)
- 2026-11-25 · plan ssp-export-v2 · the form moved, unchanged, into the Identification & roles tab of the SSP workspace (ssp-workspace sprint, PRs #17 and #18)
