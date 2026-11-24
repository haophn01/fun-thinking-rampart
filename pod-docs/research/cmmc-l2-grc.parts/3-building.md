# Research: CMMC Level 2 GRC platform (single contractor, workflow-first) — angle: building

_Generated: 2026-11-23 · Depth: standard · Researchers: 1 · Searches: 11 · Pages read: 12_

**Assumptions:** Single-tenant app for one defense contractor, run locally for now. V1 covers controls and objectives, SSP, POA&M, SPRS score, evidence and policies. Integrations come later. "800-171 r2 / 800-171A" is the target baseline, because CMMC still uses Rev 2 (see Gaps). Only the `building` angle is covered here. Competitor products (Vanta etc.) are out of scope.

## What exists
| Name | Link | What it does | Alive? | License | How close to the idea |
|------|------|--------------|--------|---------|-----------------------|
| NIST oscal-content (SP800-171) | https://github.com/usnistgov/oscal-content/tree/main/nist.gov/SP800-171 | Official OSCAL catalogs. The directory listing I saw shows only `rev3`. | NIST-maintained; no dates seen | NIST public content (not checked) | Catalog source, but the wrong revision for CMMC. |
| NIST CSRC 800-171A assessment procedures (XLSX/CSV) | https://csrc.nist.gov/pubs/sp/800/171/a/final | Assessment-objective spreadsheet and CSV. The PDF is normative if they differ. | Page is marked **withdrawn 2024-05-14**, superseded by 171A Rev 3 | US government work | The source for the 320 objectives, but see the Rev 2 note in Gaps. |
| compliance-trestle (OSCAL Compass) | https://github.com/oscal-compass/compliance-trestle | Python CLI and library. Creates, validates and edits OSCAL docs. Splits big docs into files for Git. Supports OSCAL 1.2.1. Markdown and draw.io authoring. | v5 active, v4 in maintenance. 293 stars. No release shown on the page. | Apache-2.0 | A building block for OSCAL import, export and validation. Not an app. |
| CISO Assistant Community (intuitem) | https://github.com/intuitem/ciso-assistant-community/blob/main/README.md | Full GRC app. Django + DRF, SvelteKit, Postgres or SQLite, Docker. Frameworks load from Excel or YAML libraries. Lists CMMC v2 and 800-171 r2/r3. Storage can be local, S3 or Azure Blob. | Active (requires Python 3.14+ and Node 24+). Star count not shown. | AGPL v3. The `enterprise/` directory is under a commercial license. | Closest open-source base to fork or study. The README gives no detail on CMMC depth (SPRS, POA&M rules). |
| GovReady-Q | https://github.com/oscal-club/awesome-oscal (listed there) | Open-source self-service GRC tool focused on OSCAL import and export. | Not checked | Not checked | Reference design for an OSCAL-backed SSP. |
| linville/cmmcdb | https://github.com/linville/cmmcdb | Django app that parses the CMMC model PDF into a normalized DB and exports XLSX and JSON. | **Archived 2026-03-12**. 1 star. | ISC | A data-model example only. It targets the CMMC model PDF. I couldn't confirm it has objectives or scoring. |
| FedRAMP OSCAL docs (SSP and POA&M) | https://automate.fedramp.gov/documentation/ssp/6-security-controls | Worked example of OSCAL SSP and POA&M conventions. | Not checked | n/a | Pattern reference. FedRAMP-specific rules, not CMMC. |

## Gaps and angles
- **No official OSCAL for 800-171 Rev 2 found.** NIST's `SP800-171` directory shows only `rev3` ([GitHub](https://github.com/usnistgov/oscal-content/tree/main/nist.gov/SP800-171)). A DoD training deck says CMMC uses Rev 2 and that Rev 3 is not currently implemented for CMMC ([DARPA/DoD deck](https://www.darpa.mil/sites/default/files/attachment/2026-01/cmmc-20-tech-office-training.pdf), seen as a search result only). The Rev 2 and Rev 3 requirement sets differ. The planner must decide how to get Rev 2 data: build your own catalog from the Rev 2 and 171A spreadsheets, or from the PDF.
- **The 800-171A source is withdrawn.** The NIST page says it was withdrawn 2024-05-14 and replaced by 171A Rev 3 ([NIST](https://csrc.nist.gov/pubs/sp/800/171/a/final)). The 320-objective count comes from the original 171A. Archive a copy and check its provenance.
- **Some JSON/XLSX may be non-normative.** NIST says the PDF wins if the CSV, XLSX and PDF disagree ([NIST](https://csrc.nist.gov/pubs/sp/800/171/a/final)). Add a verification step when you import, for example counts per family.
- **OSCAL coverage of objectives is unconfirmed.** I found no evidence on how 171A objectives would be encoded in an OSCAL catalog. NIST's catalog doc lists "control objectives" and "assessment methods" as control contents but doesn't say how they are encoded ([NIST OSCAL catalog](https://pages.nist.gov/OSCAL/learn/concepts/layer/control/catalog)).
- **CISO Assistant's CMMC depth is unverified.** Its README lists CMMC v2 as a framework and gives no detail on scoring or POA&M ([README](https://github.com/intuitem/ciso-assistant-community/blob/main/README.md)).

## Best practices
- **Model the controls as data (catalog), separate from your implementation records.** OSCAL does this: a catalog has metadata, parameters, groups, controls and back matter. Controls can hold statements, objectives and assessment methods ([NIST](https://pages.nist.gov/OSCAL/learn/concepts/layer/control/catalog)).
- **Mirror the OSCAL SSP shape for the SSP.** Its sections are metadata, import-profile, system characteristics, system implementation (users, interconnections, services, inventory) and control implementation. Each implemented requirement references a control ID that must exist in the baseline. It can carry responsible roles, implementation status, and a description of how it is satisfied, down to the statement level ([NIST SSP](https://pages.nist.gov/OSCAL/learn/concepts/layer/implementation/ssp)).
- **Keep the POA&M linked to the SSP rather than duplicating system detail.** OSCAL's POA&M imports the SSP and holds risks and POA&M items with a remediation plan and status ([NIST POA&M](https://pages.nist.gov/OSCAL/learn/concepts/layer/assessment/poam/)).
- **Hard-code the SPRS scoring table as reference data, and score from objective status.** Rules from 32 CFR 170.24(c)(2) ([Cornell LII](https://www.law.cornell.edu/cfr/text/32/170.24)):
  - The maximum score equals the number of L2 requirements (110). Each NOT MET requirement subtracts its value. The score can go negative.
  - 5-point requirements: 23 basic and 19 derived (42 total). 3-point: 7 basic and 7 derived (14 total). Every other derived requirement is 1 point. The page gives the full ID lists. The 42/14/54 split is my arithmetic from the page's lists, and one vendor blog reports the same counts.
  - IA.L2-3.5.3 (MFA): subtract 3 if MFA covers only remote and privileged users, 5 if it covers no users.
  - SC.L2-3.13.11 (encryption): subtract 3 if encryption is used but not FIPS-validated, 5 if no encryption.
  - The lowest score is -203 per a vendor glossary ([Secureframe](https://secureframe.com/glossary/dod-assessment-methodology.md)), not the primary source. The DoD Assessment Methodology v1.2.1 PDF itself was not fetched.
- **POA&M eligibility is a rules engine over the score** ([32 CFR 170.21, Cornell LII](https://www.law.cornell.edu/cfr/text/32/170.21)):
  - A POA&M applies only to requirements assessed NOT MET, and only to reach Conditional status.
  - The assessment score divided by the 110 requirements must be at least 0.8 (88 points).
  - Every item on a POA&M must be worth 1 point or less. The one exception is SC.L2-3.13.11 at 3 points (encryption used but not FIPS-validated).
  - Six requirements are barred from any POA&M: AC.L2-3.1.20, AC.L2-3.1.22, CA.L2-3.12.4, PE.L2-3.10.3, PE.L2-3.10.4, PE.L2-3.10.5.
  - Closeout must be confirmed by an assessment within 180 days of the Conditional Status Date. For L2 self-assessment the organization does it. For certification a C3PAO does it. If it isn't closed, Conditional status expires. The closeout covers only the NOT MET requirements that had a POA&M.
  - The text sets no numeric limit on POA&M items.
  - Model the Conditional Status Date as a field that starts a 180-day clock.
- **The SSP is a hard prerequisite.** CA.L2-3.12.4 requires an SSP at assessment time. Without an up-to-date SSP the assessment cannot be completed ([32 CFR 170.24](https://www.law.cornell.edu/cfr/text/32/170.24)). Each NOT MET requirement must have a POA&M in place. A POA&M does not substitute for implementing the requirement ([same page](https://www.law.cornell.edu/cfr/text/32/170.24)).
- **Use a Python/Django-style CRUD stack with Postgres or SQLite.** CISO Assistant and cmmcdb both do. CISO Assistant adds a Docker Compose setup that works on Windows through WSL2 ([README](https://github.com/intuitem/ciso-assistant-community/blob/main/README.md)).
- **Import OSCAL, don't author in it.** Trestle validates OSCAL 1.2.1 JSON/YAML, so you can export SSP/POA&M and check them with it ([trestle](https://github.com/oscal-compass/compliance-trestle)). Every OSCAL doc needs a root `uuid`, and `last-modified` must be updated when content changes ([NIST](https://pages.nist.gov/OSCAL/learn/concepts/layer/control/catalog)).
- **CUI hosting rules shape the later hosting choice.** DFARS 252.204-7012 applies NIST SP 800-171 to contractor systems. If an external cloud provider holds covered defense information, it must meet FedRAMP Moderate equivalent requirements, and it must comply with the clause's incident reporting and related terms. Cyber incidents must be reported within 72 hours via dibnet.dod.mil ([Cornell LII](https://www.law.cornell.edu/cfr/text/48/252.204-7012)). The clause text I fetched doesn't address self-hosted systems explicitly (that follows from (b)(2)(i)). Evidence storage on a plain dev laptop or a non-GovCloud host is the issue to settle early.

## Ideas to consider
- Scoring and POA&M-eligibility as a small pure-function library with a table-driven test suite built from 170.24 and 170.21 — grows from the scoring and POA&M rules above.
- Store 320 objectives as first-class rows (MET / NOT MET / N/A per objective) and derive each requirement's status from them. Derive the SPRS score from those — grows from the 110/320 structure and the rules above.
- Treat the catalog as a versioned, importable file (JSON in OSCAL shape or a YAML library) with a checksum and a count test — grows from the withdrawn-source and non-normative-spreadsheet gaps.
- A "Conditional status" view: live score, 88-point threshold, barred-requirement warnings, 180-day countdown, closeout checklist — grows from the 170.21 rules.
- Evidence store behind an abstract interface (local filesystem now, S3 or Blob later) with hashing, so the later hosting move doesn't change the data model — grows from CISO Assistant's storage options and the CUI hosting risk.
- Export SSP and POA&M as OSCAL JSON and as a human-readable document (DOCX/PDF) — (own idea)
- Keep the data model OSCAL-compatible but not OSCAL-native (UUIDs for every entity, status enum aligned to OSCAL implementation-status) — (own idea)
- Evaluate forking or extending CISO Assistant against building from scratch. Check the AGPL v3 obligations first — grows from the CISO Assistant row.

## Questions for the plan
- **Which catalog source for Rev 2?** — why it matters: NIST publishes OSCAL only for Rev 3, and the 171A (Rev 2 era) spreadsheet/CSV page is marked withdrawn — options: build your own from the PDF and spreadsheet / use CISO Assistant's 800-171 r2 library (license and accuracy unchecked) / go with Rev 3 despite CMMC using Rev 2.
- **Build, or fork CISO Assistant?** — why it matters: it already has frameworks, evidence and Docker, but it is AGPL v3 with a commercial `enterprise/` directory, and CMMC scoring depth is unverified — options: fork / use as a reference only / build from scratch.
- **Is OSCAL the internal model or only an export?** — why it matters: OSCAL is a good fit for SSP and POA&M, but I found no evidence of objective-level encoding for 800-171 — options: native OSCAL JSON / relational DB with OSCAL import and export / no OSCAL in V1.
- **Where may evidence live while it may contain CUI?** — why it matters: DFARS 7012 requires FedRAMP Moderate equivalent for external clouds holding CDI, and a dev machine is still a system holding CUI — options: keep no CUI in V1 (metadata and links only) / encrypted local with controls / delay hosting decisions until CUI is in scope.
- **How should partial-credit items (3.5.3 and 3.13.11) be modeled?** — why it matters: they are scored 0/-3/-5 rather than binary — options: per-requirement "implementation level" enum / special-case fields / treat as binary and note it.
- **Does V1 need a POA&M for each NOT MET objective or requirement?** — why it matters: 170.24 says each NOT MET requirement must have a POA&M, while POA&M eligibility depends on the score and point values — options: requirement-level only / objective-level linked to a requirement.

## Suspect pages
- none

## Sources
- 32 CFR 170.21 — https://www.law.cornell.edu/cfr/text/32/170.21 — no date shown
- 32 CFR 170.24 — https://www.law.cornell.edu/cfr/text/32/170.24 — no date shown
- 48 CFR 252.204-7012 — https://www.law.cornell.edu/cfr/text/48/252.204-7012 — no date shown
- NIST oscal-content SP800-171 directory — https://github.com/usnistgov/oscal-content/tree/main/nist.gov/SP800-171 — no date shown
- compliance-trestle — https://github.com/oscal-compass/compliance-trestle — no date shown
- CISO Assistant Community README — https://github.com/intuitem/ciso-assistant-community/blob/main/README.md — no date shown
- linville/cmmcdb — https://github.com/linville/cmmcdb — archived 2026-03-12
- NIST OSCAL catalog concept page — https://pages.nist.gov/OSCAL/learn/concepts/layer/control/catalog — no date shown
- NIST OSCAL SSP concept page — https://pages.nist.gov/OSCAL/learn/concepts/layer/implementation/ssp — no date shown
- NIST OSCAL POA&M concept page — https://pages.nist.gov/OSCAL/learn/concepts/layer/assessment/poam/ — no date shown
- NIST SP 800-171A (withdrawn) — https://csrc.nist.gov/pubs/sp/800/171/a/final — withdrawn 2024-05-14
- Secureframe DoD Assessment Methodology glossary — https://secureframe.com/glossary/dod-assessment-methodology.md — no date shown (vendor, secondary)

Note: the GovReady-Q row and the DoD/DARPA deck came from search results and were not fetched. Treat both as leads. The DoD Assessment Methodology v1.2.1 PDF was not fetched. SPRS submission rules, the 3-year validity period, and the 320-objective count were not verified from a fetched primary source.
