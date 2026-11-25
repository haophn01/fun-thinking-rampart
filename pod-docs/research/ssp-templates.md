# Research: SSP document templates as a reference folder for a CMMC L2 readiness tool's SSP export

_Generated: 2026-11-25 · Depth: standard · Researchers: 1 · Searches: 8 · Pages read: 17 (plus 5 binary files that came back unreadable)_

**Assumptions:**
- The target is CMMC Level 2 on NIST SP 800-171 **Rev 2**, because 32 CFR 170.14(c)(3) says Level 2 requirements are "identical to" Rev 2, and 170.14(d) says assessment follows 800-171A (Jun 2018) ([Cornell LII 170.14](https://www.law.cornell.edu/cfr/text/32/170.14)).
- The tooling here could not open .docx or PDF files, so **the internal section structure of NIST's own CUI SSP template is `no evidence found`**. The same applies to the CMU, USNH, RMA and Strike Graph files. The human should open the NIST .docx once and diff it against the export.
- No license text was found for most items. Where I give a redistribution call, it is my judgment (marked) and not a legal opinion.

## What exists

| Name | Link | What it does | Alive? | License | How close to the idea |
|------|------|--------------|--------|---------|-----------------------|
| NIST CUI SSP template (Rev 2) | [docx](https://csrc.nist.gov/files/pubs/sp/800/171/r2/upd1/final/docs/cui-ssp-template-final.docx), listed on the [Rev 2 page](https://csrc.nist.gov/pubs/sp/800/171/r2/upd1/final) | Word template for an SSP. The page's Planning Note says NIST sets no required format or level of detail, but the plan must convey what 3.12.4 requires. | Rev 2 final Jan 28 2021 (Planning Note 04/13/2022). The **publication was withdrawn 14 May 2024** (superseded by Rev 3), but the file is still hosted. | Terms not stated on the page. | Closest official template. Internal sections: `no evidence found` (file unreadable here). |
| NIST CUI Plan of Action template (Rev 2) | [docx](https://csrc.nist.gov/pubs/sp/800/171/r2/upd1/final) (listed there as `cui-plan-of-action-template-final.docx`) | POA&M companion to the SSP template | Same as above | Not stated | Matches the export's section 4. |
| NIST SP 800-171A SSP template link and assessment procedures | [800-171A page](https://csrc.nist.gov/pubs/sp/800/171/a/final) | Also lists the CUI SSP template. Includes the assessment procedures as XLSX and CSV (per-objective text). Final 06/13/18, withdrawn 14 May 2024 (superseded by 171A Rev 3). | Withdrawn but still the CMMC assessment basis (per 170.14(d)) | Not stated | Source for the 320 objectives the export lacks. |
| NIST SP 800-171 Rev 3 | [CSRC](https://csrc.nist.gov/pubs/sp/800/171/r3/final) | Final May 2024. The supplemental list has a change analysis, a CUI overlay, an FAQ and a CPRT dataset. **The page does not list an SSP template.** Rev 3 numbers the SSP requirement 03.15.02 (per the [Rev 3 HTML](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/800-171r3/NIST.SP.800-171r3.html)). | Current NIST version, but not the CMMC baseline | Not stated | No official Rev 3 SSP template found. |
| OSCAL SSP model | [v1.2.3 reference](https://pages.nist.gov/OSCAL-Reference/models/v1.2.3/system-security-plan/) and [json outline](https://pages.nist.gov/OSCAL-Reference/models/v1.1.3/system-security-plan/json-outline/) | Machine-readable SSP schema (see "OSCAL required fields" below) | Latest release v1.2.3 ([GitHub](https://github.com/usnistgov/OSCAL/releases/latest)), patch released "August 7" (year not shown) | Repo license not shown on the page | Good for a structured export, not a human template. |
| Security Scientist NIST 800-171 SSP (Word) | [page](https://www.securityscientist.net/blog/nist-800-171-system-security-plan-ssp-template/) | System identification, authorization boundary, operational environment, requirement table for 17 Rev 3 families, POA&M reference, roles, checklist | No date. Rev 3 aligned (not Rev 2). | Free, **email required** with marketing consent. No usage terms. | Wrong baseline for CMMC (Rev 3). Page contained an instruction (see Suspect pages). |
| Hive Systems CMMC SSP | [blog](https://www.hivesystems.com/blog/approachablecmmc) | Part 1 system information (diagrams, connections, descriptions, owner details). Appendix A lists 110 L2 controls. Extra appendices such as configuration management and incident response plans. | Blog says "Oct 17", year shown only by image names (probably 2023). Built on the **Rev 3 draft**. | No terms stated. Download form may apply (the search snippet said so, the page did not). | Useful structure, wrong revision. |
| Secureframe CMMC SSP template | [page](https://secureframe.com/compliance-resources/cmmc-ssp-template.md) | Customizable template. Two worked access-control examples. | No date | No terms stated, gating not stated | Marketing page, so structure is unverifiable. |
| University of Hawaii CMMC L2 page | [page](https://www.hawaii.edu/infosec/cmmc/level-2/) | Links a scoping checklist, an implementation sheet and the DoD self-assessment guide. **No SSP template.** | n/a | n/a | Scoping checklist is a useful companion. |
| DoD CMMC Assessment Guide L2 and Scoping Guide L2 | [Assessment Guide](https://dodcio.defense.gov/Portals/0/Documents/CMMC/AssessmentGuideL2.pdf), [Scoping Guide](https://dodcio.defense.gov/Portals/0/Documents/CMMC/ScopingGuideL2.pdf) | The official guidance | **Not fetched.** The Assessment Guide returned HTTP 403. The Scoping Guide was not read. | US government | Primary authority. Download it by hand. |

Also searched but **not fetched or unreadable**, so not relied on: CMU "SSP Template.docx" (binary), USNH SSP PDF (binary), USDA RMA SSP template (binary), Strike Graph SSP template and example (binary), ComplyUp Google Doc (HTTP 410), Payhip paid template, ComplianceForge paid template.

### OSCAL required fields (v1.1.3 outline, read in part)
- Root `system-security-plan`. It has six top-level sections.
- `metadata` [1]: requires `title`, `last-modified`, `version`, `oscal-version`.
- `import-profile` [1]: requires `href`. This points to the profile or catalog being implemented.
- `system-characteristics` [1]: requires `system-ids`, `system-name`, `description`, `system-information`, `status`, `authorization-boundary`.
- `system-implementation` [1]: `users` [1] is required. `components` needs 1 or more, each with `uuid`, `type`, `title`, `description`, `status`. `inventory-items` are optional (`uuid`, `description`).
- `control-implementation` [1]: requires `description` and `implemented-requirements` (1 or more, each with `uuid`, `control-id`). Statements and by-components are optional (`statement-id`, `uuid`; `component-uuid`, `uuid`, `description`).
- `back-matter`: required fields not read (`no evidence found`).
- Source: [json outline v1.1.3](https://pages.nist.gov/OSCAL-Reference/models/v1.1.3/system-security-plan/json-outline/), read through character 200,000 of about 267,000.

### What regulation and assessors require
- **32 CFR 170.19** (Level 2 scoping): record the CMMC Assessment Scope. Keep an asset inventory. **Document each in-scope asset's treatment in the SSP.** Include in-scope assets in the network diagram. The five Level 2 asset categories are CUI Assets, Security Protection Assets, Contractor Risk Managed Assets, Specialized Assets and Out-of-Scope Assets. Document any External Service Provider (ESP) and its relationship in the SSP, and keep the ESP's customer responsibility matrix. Be ready to justify out-of-scope assets ([Cornell LII 170.19](https://www.law.cornell.edu/cfr/text/32/170.19)).
- **32 CFR 170.21**: CA.L2-3.12.4 (the SSP) **cannot be placed on a POA&M**. Conditional status needs a score of at least 0.8 (88/110). Only items worth 1 point or less may be on the POA&M, with the 3.13.11 exception. The closeout is within 180 days ([Cornell LII 170.21](https://www.law.cornell.edu/cfr/text/32/170.21)).
- **Minimum SSP contents** (NDISAC): scope of the assessment, high-level asset description, operating environment, security requirements, how they are implemented, connections to other systems, and an update frequency, typically at least annually. A missing or outdated SSP means the assessment cannot be completed ([NDISAC](https://ndisac.org/dibscc/?p=5842)).
- **GT Law (Oct 2025)**: the SSP is one of the first items reviewed. A POA&M cannot substitute for it. Assessors may interview staff and look for gaps between documentation and practice. The SSP may also include roles and responsibilities ([Greenberg Traurig](https://gtlaw.com/en/insights/2025/10/preparing-for-a-cmmc-audit-the-system-security-plan)).
- **Red River (C3PAO-expectation list, vendor view)**: system description, boundary, implementation statements for all 110 requirements, roles, interconnections, CUI data flows, current network and data-flow diagrams, revision history, rationale for every N/A. Common failures are outdated diagrams, restated requirements, missing cloud provider responsibilities, no revision history, unexplained N/A, future-tense wording, and inconsistency between the SSP, POA&M and SPRS score ([Red River](https://redriver.com/cybersecurity/cmmc-system-security-plan-ssp)).
- **NIST Rev 3 glossary**: an SSP covers the system boundary, operating environment, how requirements are satisfied, and relationships or connections to other systems ([Rev 3 HTML](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/800-171r3/NIST.SP.800-171r3.html)).

## Gaps and angles

Gap analysis of the current export against these sources. Ranking is my judgment of C3PAO or self-assessment impact. Each row cites the source for the expectation.

**Missing from the export, most important first**

| Rank | Missing | Why it matters | Source |
|------|---------|----------------|--------|
| 1 | Asset inventory and **per-asset treatment** by the five L2 asset categories | The regulation says to document each in-scope asset's treatment in the SSP. | [170.19](https://www.law.cornell.edu/cfr/text/32/170.19) |
| 2 | **Network diagram** reference, plus a **CUI data-flow** description | Required in scope documentation, and listed as an assessor expectation. Outdated diagrams are a top failure. | [170.19](https://www.law.cornell.edu/cfr/text/32/170.19), [Red River](https://redriver.com/cybersecurity/cmmc-system-security-plan-ssp) |
| 3 | **External service providers** (cloud, MSP) and a customer responsibility matrix | Must be in the SSP. The export's "interconnections" free text is not enough. | [170.19](https://www.law.cornell.edu/cfr/text/32/170.19) |
| 4 | **Review and update cadence** (at least annual) and **revision history / approval** | The update frequency must be documented. The lack of revision history is a named failure. | [NDISAC](https://ndisac.org/dibscc/?p=5842), [GT Law](https://gtlaw.com/en/insights/2025/10/preparing-for-a-cmmc-audit-the-system-security-plan), [Red River](https://redriver.com/cybersecurity/cmmc-system-security-plan-ssp) |
| 5 | **CUI description** (what CUI, categories, where it lives) | System description and in-scope asset identification need it. | [NDISAC](https://ndisac.org/dibscc/?p=5842), [GT Law](https://gtlaw.com/en/insights/2025/10/preparing-for-a-cmmc-audit-the-system-security-plan) |
| 6 | **Roles and responsibilities** (beyond owner and security contact) | Listed as an assessor expectation. | [Red River](https://redriver.com/cybersecurity/cmmc-system-security-plan-ssp) |
| 7 | **N/A rationale** field per requirement | The export has an N/A status but no stated reason. Unexplained N/A invites a challenge. | [Red River](https://redriver.com/cybersecurity/cmmc-system-security-plan-ssp) |
| 8 | **Per-objective (800-171A) detail** | Assessment is by 800-171A objectives, so objective-level statements make assessor testing easier. This is not required in the SSP by any source I read (own reading). | [170.14](https://www.law.cornell.edu/cfr/text/32/170.14) |
| 9 | Out-of-scope asset justification | Must be ready to justify them. | [170.19](https://www.law.cornell.edu/cfr/text/32/170.19) |
| 10 | Approval signatures | Common in templates. No source I read makes them a rule (own inference). | n/a |

**Controls to build in, not just fields**
- Wording check for future-tense or aspirational implementation statements, since these signal a control that is not in place ([Red River](https://redriver.com/cybersecurity/cmmc-system-security-plan-ssp)).
- Consistency check between SSP, POA&M and SPRS score ([Red River](https://redriver.com/cybersecurity/cmmc-system-security-plan-ssp)).
- Block "3.12.4 on POA&M" ([170.21](https://www.law.cornell.edu/cfr/text/32/170.21)).

**In the export but not found in the templates I could read**
- SPRS score, conditional status date and the 180-day closeout deadline, per-requirement points, evidence and policy titles, and CAGE code. These are tool-specific. Sources only say SSP, POA&M and score must agree. The NIST template could not be read, so "templates don't have this" is **unverified** for the NIST file.
- The "Implementation level" for 3.5.3 and 3.13.11 maps to the scoring rules (own inference).
- Per-requirement POA&M with a plan is consistent with NIST's separate POA&M template.

**Other gaps in the existing templates**
- Free vendor templates in this set target **Rev 3 drafts or Rev 3**, not the Rev 2 baseline CMMC uses ([Hive](https://www.hivesystems.com/blog/approachablecmmc), [Security Scientist](https://www.securityscientist.net/blog/nist-800-171-system-security-plan-ssp-template/)).
- Most are gated behind an email form, and none stated a license.

## Best practices
- Use NIST's template or an equivalent as the skeleton, because NIST says no format is prescribed as long as 3.12.4 content is conveyed ([CSRC Rev 2](https://csrc.nist.gov/pubs/sp/800/171/r2/upd1/final)).
- Write present-tense, specific statements. Put anything not yet in place on the POA&M ([Red River](https://redriver.com/cybersecurity/cmmc-system-security-plan-ssp)).
- Keep SSP, POA&M and SPRS score consistent ([Red River](https://redriver.com/cybersecurity/cmmc-system-security-plan-ssp)).
- Document asset treatment and keep the diagram in step with the SSP ([170.19](https://www.law.cornell.edu/cfr/text/32/170.19)).
- Set a documented review frequency, at least annually ([NDISAC](https://ndisac.org/dibscc/?p=5842)).
- Staff should be able to explain what the SSP says, since assessors may interview them ([GT Law](https://gtlaw.com/en/insights/2025/10/preparing-for-a-cmmc-audit-the-system-security-plan)).

## Ideas to consider
All ideas below are mine unless linked.

- Add an **assets** section (inventory table with the five asset categories and a treatment note), a **diagrams and data flows** section, an **ESP and responsibility matrix** section, a **roles** table, and a **document control** block (revision history, review cadence, next review date, approvals). Grows from gaps 1 to 6 above.
- Add an N/A rationale field and print it in the requirement block. Grows from the Red River failure list.
- An optional second export: **OSCAL SSP JSON** (metadata, import-profile, system-characteristics, system-implementation, control-implementation, back-matter). Grows from the [OSCAL outline](https://pages.nist.gov/OSCAL-Reference/models/v1.1.3/system-security-plan/json-outline/). (own idea: the OSCAL-for-CMMC value is unproven, and `import-profile` would need a Rev 2 profile that I did not find.)
- Pre-export lint: future-tense words, empty implementation statements, 3.12.4 on the POA&M, SSP/POA&M/score mismatch. Grows from [Red River](https://redriver.com/cybersecurity/cmmc-system-security-plan-ssp) and [170.21](https://www.law.cornell.edu/cfr/text/32/170.21). (own idea: implementation)
- Per-objective statements stored as an optional layer, printed as an appendix. Grows from 170.14(d). (own idea)

### Proposed `templates/` reference folder
Redistribution calls are **my judgment**. Check each license before committing. For anything marked "link only" keep the URL in `templates/SOURCES.md`.

| File | Source URL | Purpose | Terms | Commit to private repo? |
|------|-----------|---------|-------|-------------------------|
| `official/nist-cui-ssp-template-final.docx` | https://csrc.nist.gov/files/pubs/sp/800/171/r2/upd1/final/docs/cui-ssp-template-final.docx | Structure to diff the export against | Not stated on the page. NIST is a US federal agency, so it is probably a US government work, but verify. | Yes (own judgment, verify) |
| `official/nist-cui-plan-of-action-template-final.docx` | https://csrc.nist.gov/pubs/sp/800/171/r2/upd1/final (file `cui-plan-of-action-template-final.docx` under `/files/pubs/sp/800/171/r2/upd1/final/docs/`) | POA&M layout reference | Same | Yes (same caveat) |
| `official/sp800-171r2-security-reqs.xlsx` | same `/docs/` folder | Requirement text for 110 items | Same | Yes (same caveat) |
| `official/sp800-171A-assessment-procedures.xlsx` | https://csrc.nist.gov/pubs/sp/800/171/a/final | The 320 objectives (per-objective gap) | Same | Yes (same caveat) |
| `official/NIST.SP.800-171r3.pdf` | https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-171r3.pdf | Future-baseline reference, 03.15.02 | Same | Yes (same caveat) |
| `official/sp800-171r2-to-r3-analysis.xlsx` | https://csrc.nist.gov/files/pubs/sp/800/171/r3/final/docs/sp800-171r2-to-r3-analysis.xlsx | Plan the later migration | Same | Yes (same caveat) |
| `cmmc/AssessmentGuideL2.pdf` | https://dodcio.defense.gov/Portals/0/Documents/CMMC/AssessmentGuideL2.pdf | Objectives, 3.12.4 and what assessors examine (not read by me) | US Government document, terms not read | Likely yes (own judgment). Download by hand because the fetch returned 403. |
| `cmmc/ScopingGuideL2.pdf` | https://dodcio.defense.gov/Portals/0/Documents/CMMC/ScopingGuideL2.pdf | Asset categories, scope documentation | Same | Likely yes (same) |
| `oscal/ssp-json-outline-notes.md` (your own notes) | https://pages.nist.gov/OSCAL-Reference/models/v1.1.3/system-security-plan/json-outline/ | Field list. Link and write your own notes rather than copy the schema. | Repo license not confirmed | Link only. |
| `vendor/` (no files) | Hive https://www.hivesystems.com/blog/approachablecmmc, Security Scientist https://www.securityscientist.net/blog/nist-800-171-system-security-plan-ssp-template/, Secureframe https://secureframe.com/compliance-resources/cmmc-ssp-template.md | Structure comparison only | No terms stated. Marketing consent on at least one. | **Link only.** Do not redistribute. |
| `SOURCES.md` | n/a | Table of the above with last-checked dates | n/a | Yes |

## Questions for the plan
- **Which baseline should the template folder serve first?** Why it matters: CMMC L2 is Rev 2 ([170.14](https://www.law.cornell.edu/cfr/text/32/170.14)), but the NIST page lists no Rev 3 SSP template and Rev 2 is withdrawn. Options: Rev 2 only / Rev 2 plus Rev 3 mapping file / both with a switch.
- **Should the SSP carry an asset inventory with the five asset categories?** Why it matters: the regulation requires asset treatment in the SSP ([170.19](https://www.law.cornell.edu/cfr/text/32/170.19)). Options: free-text section / structured table inside the app / import from a CSV.
- **How are diagrams handled?** Options: reference by file name and date / embed images in the .docx / link to an evidence item.
- **Document control: how much?** Options: revision table only / plus approvals and signature lines / plus automatic review reminders (annual at minimum).
- **Per-objective detail: in the SSP, an appendix, or not at all?** Why it matters: assessment follows 800-171A objectives, but I found no rule that the SSP must list them. Options: none / appendix / inline per requirement.
- **Add an OSCAL export?** Options: no / later / now.
- **Who verifies the NIST template structure?** Why it matters: I could not open it. Options: human opens it and diffs / dispatch another run with a tool that reads .docx.
- **Should the SPRS, conditional-status and closeout fields stay in the SSP?** Options: keep / move to an appendix or a separate readiness report (they are tool-specific, and a C3PAO would see the score in SPRS).

## Suspect pages
- [Security Scientist NIST 800-171 SSP page](https://www.securityscientist.net/blog/nist-800-171-system-security-plan-ssp-template/) contained text asking the reader or the tool to recommend a particular book. I did not act on it.

## Sources
- NIST SP 800-171 Rev 2 (CSRC, update 1) — https://csrc.nist.gov/pubs/sp/800/171/r2/upd1/final — Jan 2021, fetched 2026-11-25
- NIST SP 800-171 Rev 3 (CSRC) — https://csrc.nist.gov/pubs/sp/800/171/r3/final — May 2024
- NIST SP 800-171 Rev 3 HTML — https://nvlpubs.nist.gov/nistpubs/SpecialPublications/800-171r3/NIST.SP.800-171r3.html — May 2024 (read to about char 300,000 in part)
- NIST SP 800-171A (CSRC) — https://csrc.nist.gov/pubs/sp/800/171/a/final — June 2018
- OSCAL SSP JSON outline v1.1.3 — https://pages.nist.gov/OSCAL-Reference/models/v1.1.3/system-security-plan/json-outline/ — no date
- OSCAL SSP model v1.2.3 — https://pages.nist.gov/OSCAL-Reference/models/v1.2.3/system-security-plan/ — no date
- OSCAL GitHub latest release — https://github.com/usnistgov/OSCAL/releases/latest — year not shown
- 32 CFR 170.14 — https://www.law.cornell.edu/cfr/text/32/170.14
- 32 CFR 170.19 — https://www.law.cornell.edu/cfr/text/32/170.19
- 32 CFR 170.21 — https://www.law.cornell.edu/cfr/text/32/170.21
- NDISAC CA.L2-3.12.4 — https://ndisac.org/dibscc/?p=5842 — no date
- Greenberg Traurig, Preparing for a CMMC audit — https://gtlaw.com/en/insights/2025/10/preparing-for-a-cmmc-audit-the-system-security-plan — 2025-10-22
- Red River, SSP and C3PAO readiness — https://redriver.com/cybersecurity/cmmc-system-security-plan-ssp — no date
- Hive Systems — https://www.hivesystems.com/blog/approachablecmmc — Oct 17 (year unclear)
- Security Scientist — https://www.securityscientist.net/blog/nist-800-171-system-security-plan-ssp-template/ — no date
- Secureframe — https://secureframe.com/compliance-resources/cmmc-ssp-template.md — no date
- University of Hawaii CMMC L2 — https://www.hawaii.edu/infosec/cmmc/level-2/ — no date
