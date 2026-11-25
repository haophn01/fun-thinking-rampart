# Research: CMMC Level 2 GRC platform for a single defense contractor (NIST SP 800-171 r2, 110 requirements / 320 objectives)

_Generated: 2026-11-23 · Depth: standard · Researchers: 3 · Searches: 22 · Pages read: 29_

**Assumptions:** Single organization tracking its own C3PAO readiness (not multi-tenant, not MSP). V1 is workflow only: controls and objectives, SSP, POA&M, SPRS score, evidence, policies. Integrations come later. Runs locally for now, and evidence may contain CUI. "Radicle GRC" was read as Radiant Defense, which no part found (`no evidence found`). Rev 2 as the baseline comes from the brief. The merged parts hold no fetched source that states it, so confirm it. Most product facts are vendor-stated and pricing is mostly hidden.

## What exists
| Name | Link | What it does | Alive? (last release · stars · users) | License | How close to the idea |
|------|------|--------------|---------------------------------------|---------|-----------------------|
| clucraft/cmmc | https://github.com/clucraft/cmmc | Dashboard (SPRS gauge, family heatmap), all 110 practices with implementation statements, POA&Ms, evidence files, SSP export to .docx, SPRS and gap reports. React, Node/Express, PostgreSQL/Prisma, Docker Compose. | 1 star, 0 forks, 19 commits; last-commit date not shown | MIT | Closest to V1 scope and self-hosted, but a tiny hobby project. Page didn't mention 320 objectives, policies or per-user access. |
| CISO Assistant Community (intuitem) | https://github.com/intuitem/ciso-assistant-community/blob/main/README.md | Full GRC app. Django + DRF, SvelteKit, Postgres or SQLite, Docker. Frameworks load from Excel or YAML libraries; lists CMMC v2 and 800-171 r2/r3. Evidence storage local, S3 or Azure Blob. | Active (needs Python 3.14+, Node 24+); star count not shown | AGPL v3; enterprise/ directory under a commercial license | Closest open-source base to fork or study. README gives no detail on CMMC depth (SPRS, POA&M rules). |
| ARMS (Orcannus) | https://orcannus.github.io/ARMS | Single HTML file: 110-control assessment, SPRS calculator, POA&M tracker with Gantt, evidence catalog, HTML report export, Claude-powered advisor. Data in browser local storage with JSON save/load. | (c) 2025; no update date shown | Proprietary, $39.99 perpetual; no source link | Close in scope but single-user. No objective tracking, SSP generator or multi-user shown. |
| DefectDojo CMMC L2 Assessments | https://docs.defectdojo.com/federal_compliance/cmmc_assessments/ | Scores 110 requirements by DoD weights, computes SPRS, checks conditional status, tracks the 180-day POA&M clock, gives scan evidence for 3.4.1, 3.4.2, 3.4.6, 3.4.7. | Labeled Pro and beta | Commercial (Pro) | Partial. Per-requirement results only, no objectives, no SSP; docs call the score advisory. |
| Exostar Certification Assistant | https://exostar.com/certification-assistant | Guided 800-171 / CMMC L2 self-assessment, real-time SPRS, SSP generation, POA&M dashboards and reminders, central evidence and policy storage. | Alive; page carries a CMMC Phase 2 suspension notice (July 13, 60-day review) | Commercial, "Talk to Sales" | Close in V1 scope. SaaS, hosting not stated. |
| PreVeil GRC | https://www.preveil.com/grc/ | Readiness dashboard, evidence and task tracking, generates SSP and POA&M. Level 1 GRC free, work carries to Level 2. | Alive | Commercial, pricing not listed | Close. SPRS not mentioned. Sits beside PreVeil's CUI enclave; whether it can be bought without the enclave is `no evidence found`. |
| Secureframe Defense (formerly Federal) | https://secureframe.com/blog/announcing-secureframe-federal.md | SSP Builder, POA&M Manager, SPRS generator, gap assessments for CMMC 1-3; integrates with GCC High, Intune GCC High, AWS GovCloud, Azure Government. | Announced June 2025, later renamed and expanded (vendor-reported) | Commercial | Closest to the full vision incl. later integrations. States its platform cannot collect and store CUI (see Gaps). |
| Vanta (CMMC) | https://vanta.com/resources/best-cmmc-compliance-management-software | 800-171 mapping, automated evidence, SSP workflows, POA&M, "Government Cloud" described as FedRAMP 20x Moderate authorized. | Alive | Commercial, enterprise-oriented | Full-featured. Source is Vanta's own article. |
| Paramify | https://vanta.com/resources/best-cmmc-compliance-management-software | CMMC / 800-171 gap analysis, OSCAL-based SSP, POA&M with Jira and ServiceNow. Limited native AWS GovCloud integration. | Alive | Commercial; price unconfirmed | Strong on SSP and POA&M. Described only in a competitor's roundup. |
| IntelliGRC | https://vanta.com/resources/best-cmmc-compliance-management-software | Traditional GRC for CMMC and 800-171; described as configuration-heavy, no deep API integrations. | Alive | Commercial | Heavy for a single org. Competitor-sourced. |
| ScalePad ControlMap | https://www.scalepad.com/controlmap/cmmc | Mapped to 800-171 and 171A; SSP builder, POA&M, SPRS, shared responsibility matrix, evidence from M365/AWS, optional GovCloud deployment. | Alive | Commercial | Feature match but built for MSPs. |
| Drata | https://help.drata.com/en/articles/14724964-nist-sp-800-171-rev-2-self-assessment | Shows 171A objectives per requirement, exports a status report. Does not compute or submit SPRS; SSP is manual evidence. | Alive | Commercial | Weakest CMMC fit; its docs say you score SPRS yourself. |
| compliance-trestle (oscal-compass) | https://github.com/oscal-compass/compliance-trestle | Python CLI/SDK to create, validate and edit OSCAL docs, splits large docs for Git, OSCAL 1.2.1. | v5 active, v4 maintenance; 293 stars, 111 forks | Apache-2.0 | Building block, not a product. |
| linville/cmmcdb | https://github.com/linville/cmmcdb | Django app parsing the CMMC model PDF into a normalized DB, exports XLSX and JSON. | Archived 2026-03-12; 1 star | ISC | Data-model example only; objectives and scoring unconfirmed. |
| NIST oscal-content SP800-171 | https://github.com/usnistgov/oscal-content/tree/main/nist.gov/SP800-171 | Official OSCAL catalogs; the listing I saw shows only `rev3`. | NIST-maintained | Not checked | Catalog source, but no Rev 2 seen. |
| NIST SP 800-171A (XLSX/CSV/PDF) | https://csrc.nist.gov/pubs/sp/800/171/a/final | Assessment objectives spreadsheet and CSV; PDF is normative if they differ. | Page marked withdrawn 2024-05-14, superseded by 171A Rev 3 | US government work | Source of the 320 objectives; see Gaps. |

## Gaps and angles
- Open-source options are thin: the only self-hosted CMMC-specific tracker found has 1 star and 0 forks; ARMS has no source link. CISO Assistant is a broader GRC base with unverified CMMC depth. — [clucraft](https://github.com/clucraft/cmmc), [ARMS](https://orcannus.github.io/ARMS), [CISO Assistant](https://github.com/intuitem/ciso-assistant-community/blob/main/README.md)
- Objective-level (320) tracking is thin. DefectDojo records results per requirement only; ControlMap names 171A criteria without describing objective tracking; Drata displays objectives and expects evidence on each; Secureframe says an SSP should address each requirement and objective. — [DefectDojo](https://docs.defectdojo.com/federal_compliance/cmmc_assessments/), [ControlMap](https://www.scalepad.com/controlmap/cmmc), [Drata](https://help.drata.com/en/articles/14724964-nist-sp-800-171-rev-2-self-assessment), [Secureframe docs](https://secureframe.com/hub/cmmc/documentation.md)
- Scoring vendors disagree: Drata declines to compute SPRS, DefectDojo calls its score beta and advisory. — [Drata](https://help.drata.com/en/articles/14724964-nist-sp-800-171-rev-2-self-assessment), [DefectDojo](https://docs.defectdojo.com/federal_compliance/cmmc_assessments/)
- Many "CMMC" tools began as SOC 2 / ISO 27001 products; they "don't map neatly onto NIST 800-171 control numbers" and some treat CMMC as "a thin overlay". Vanta's CMMC is "an add-on to a broader platform"; Vanta and Drata "can track SPRS but require more configuration to surface it clearly". (Competitor blog.) — [ComplyJet](https://www.complyjet.com/blog/best-cmmc-compliance-software)
- Drata and Hyperproof are called heavy for small teams; Vanta "expensive for CMMC-only use cases"; Drata renewals reportedly rise 10-20% a year. (Competitor blog.) — [ComplyJet](https://www.complyjet.com/blog/best-cmmc-compliance-software)
- Apptega is "better suited to MSPs and consultants than individual contractors"; ControlMap is MSP-oriented too. A single-contractor readiness tool is an underserved framing. — [ComplyJet](https://www.complyjet.com/blog/best-cmmc-compliance-software), [ControlMap](https://www.scalepad.com/controlmap/cmmc)
- SaaS GRC tools avoid CUI: Secureframe says its platform "cannot collect and store CUI". A local or self-hosted tool could handle CUI evidence, subject to hosting rules. — [Secureframe](https://secureframe.com/hub/cmmc/manual-vs-automated)
- Secureframe describes traditional federal tools as mostly point-in-time documentation and remediation planning (vendor claim). — [Secureframe](https://secureframe.com/blog/cmmc-level-2-compliance)
- Vendor limits per Vanta's roundup (verify): Secureframe supports a single identity provider and has thin federal depth; Paramify has limited GovCloud integrations. — [Vanta roundup](https://vanta.com/resources/best-cmmc-compliance-management-software)
- Pricing is hidden for most vendors; only ARMS ($39.99) is public in fetched pages.
- Public user-review evidence is scarce; no Reddit or assessor-side feedback found. — [ComplyJet](https://www.complyjet.com/blog/best-cmmc-compliance-software)
- **Vendor-reported, verify:** Secureframe says DoD suspended CMMC implementation milestones on July 13, 2026, that Program Managers may only designate Level 1 (Self) or Level 2 (Self) in new solicitations, and that C3PAO requirements are being removed. Exostar's page independently shows a Phase 2 suspension notice (July 13, 60-day review). No official DoD source was fetched. — [Secureframe](https://secureframe.com/blog/cmmc-level-2-compliance), [Exostar](https://exostar.com/certification-assistant)
- Catalog data: NIST's OSCAL SP800-171 directory shows only rev3. The 171A page is withdrawn (2024-05-14) and says the PDF wins if CSV/XLSX/PDF differ. How 171A objectives are encoded in OSCAL is unconfirmed. — [oscal-content](https://github.com/usnistgov/oscal-content/tree/main/nist.gov/SP800-171), [NIST 171A](https://csrc.nist.gov/pubs/sp/800/171/a/final), [OSCAL catalog](https://pages.nist.gov/OSCAL/learn/concepts/layer/control/catalog)

## Best practices
- Tie evidence to each assessment objective, so every objective has evidence. — [Drata](https://help.drata.com/en/articles/14724964-nist-sp-800-171-rev-2-self-assessment)
- Score per the DoD methodology: start at 110, each requirement worth 1, 3 or 5 points, NOT MET subtracts its value, score can go negative (floor -203 per a vendor glossary, not the primary source). Scores expire after 3 years (vendor). — [32 CFR 170.24](https://www.law.cornell.edu/cfr/text/32/170.24), [Secureframe glossary](https://secureframe.com/glossary/dod-assessment-methodology.md)
- Point values: 5-point = 23 basic + 19 derived (42); 3-point = 7 basic + 7 derived (14); every other derived requirement is 1 point (the 42/14/54 split is arithmetic from the page's lists). Partial credit: IA.L2-3.5.3 (MFA) subtracts 3 if only remote/privileged users are covered, 5 if none; SC.L2-3.13.11 subtracts 3 if encryption is not FIPS-validated, 5 if none. — [32 CFR 170.24](https://www.law.cornell.edu/cfr/text/32/170.24)
- POA&M eligibility is a rules engine: applies only to NOT MET requirements and only for Conditional status; score/110 must be at least 0.8 (88); every item worth 1 point or less, except SC.L2-3.13.11 at 3 points; six requirements barred (AC.L2-3.1.20, AC.L2-3.1.22, CA.L2-3.12.4, PE.L2-3.10.3, PE.L2-3.10.4, PE.L2-3.10.5); closeout confirmed within 180 days of the Conditional Status Date, else Conditional status expires; no numeric cap on items. — [32 CFR 170.21](https://www.law.cornell.edu/cfr/text/32/170.21), [DefectDojo](https://docs.defectdojo.com/federal_compliance/cmmc_assessments/)
- The SSP is a hard prerequisite (CA.L2-3.12.4); each NOT MET requirement must have a POA&M, which does not substitute for implementing it. Keep the POA&M living (updated at least monthly, vendor guidance); have SSP, POA&M and policies ready before testing. — [32 CFR 170.24](https://www.law.cornell.edu/cfr/text/32/170.24), [Secureframe docs](https://secureframe.com/hub/cmmc/documentation.md)
- Model controls as a catalog (data) separate from implementation records. Mirror the OSCAL SSP shape (metadata, system characteristics, implementation, control implementation with status and roles); link the POA&M to the SSP rather than duplicating system detail. — [OSCAL catalog](https://pages.nist.gov/OSCAL/learn/concepts/layer/control/catalog), [OSCAL SSP](https://pages.nist.gov/OSCAL/learn/concepts/layer/implementation/ssp), [OSCAL POA&M](https://pages.nist.gov/OSCAL/learn/concepts/layer/assessment/poam/)
- Import/export OSCAL rather than authoring in it; trestle validates OSCAL 1.2.1. Every OSCAL doc needs a root uuid and updated last-modified. Export SSP to Word as clucraft does. — [trestle](https://github.com/oscal-compass/compliance-trestle), [clucraft](https://github.com/clucraft/cmmc)
- Keep data local with JSON export (ARMS pattern); a CRUD stack on Postgres or SQLite with Docker is the common build (CISO Assistant, cmmcdb, clucraft). — [ARMS](https://orcannus.github.io/ARMS), [CISO Assistant](https://github.com/intuitem/ciso-assistant-community/blob/main/README.md)
- CUI hosting: DFARS 252.204-7012 applies 800-171 to contractor systems; an external cloud provider holding covered defense information must meet FedRAMP Moderate equivalent; cyber incidents are reported within 72 hours via dibnet.dod.mil. The clause text fetched doesn't address self-hosted systems explicitly. "Equivalent" per a secondary Secureframe summary means 100% of the FedRAMP Moderate baseline, a 3PAO assessment and zero control-related POA&Ms (verify against the DoD CIO memo). — [48 CFR 252.204-7012](https://www.law.cornell.edu/cfr/text/48/252.204-7012), [Secureframe](https://secureframe.com/blog/fedramp-equivalency-cmmc)

## Ideas to consider
- Make the 320 objectives first-class rows (MET / NOT MET / N/A) and derive requirement status, SPRS and SSP from them — grows from the objective-level gap and the 110/320 structure.
- Scoring and POA&M eligibility as a pure-function library with a table-driven test suite from 170.24 and 170.21, plus known DoD example scores — grows from the scoring disagreement and the rules above; the example-score tests are (own idea).
- "Conditional status" view: live score, 88 threshold, barred-requirement warnings, 180-day countdown, closeout checklist, what-if SPRS — grows from the 170.21 rules.
- Versioned, importable catalog file with checksum and per-family count test — grows from the withdrawn 171A source and non-normative spreadsheet gaps.
- Rules and weights held as data apart from code, so regulatory changes are data edits — (own idea), prompted by the reported July 2026 suspension.
- Evidence store behind an abstract interface (local filesystem now, S3/Blob later) with hashing; encryption at rest from day one — grows from CISO Assistant's storage options and the CUI hosting rule.
- Self-hosted, single-org positioning (not MSP, not multi-tenant), able to hold CUI evidence that SaaS tools avoid — grows from the MSP and CUI gaps.
- Data model OSCAL-compatible but not OSCAL-native (UUID per entity, status enum aligned to OSCAL); export SSP/POA&M as OSCAL JSON plus DOCX/PDF — (own idea).
- Fork or study clucraft (MIT) for schema, or CISO Assistant as a base (check AGPL v3 duties first) — grows from the What exists rows.

## Questions for the plan
- Build from scratch, fork clucraft/cmmc (MIT), or fork CISO Assistant (AGPL v3)? — why it matters: clucraft matches V1 scope but has 1 star and unknown quality; CISO Assistant has frameworks, evidence and Docker but AGPL, a commercial enterprise/ directory and unverified CMMC depth — options: fork clucraft / fork CISO Assistant / reference only / scratch
- Build or buy? — why it matters: pricing is mostly hidden and several commercial tools already cover V1 scope (Exostar, PreVeil, Secureframe) — options: build / buy / hybrid
- Track 320 objectives as first-class records, or 110 requirements only? — why it matters: a C3PAO assesses objectives; most products read track at requirement level — options: objectives first-class / requirements with objective checklist
- Is the target still a C3PAO assessment? — why it matters: two vendors report a July 2026 suspension and self-assessment designations, with no official DoD source fetched — options: verify with DoD sources then keep C3PAO / support self and C3PAO
- Which source for the Rev 2 catalog? — why it matters: NIST OSCAL shows only Rev 3 and 171A is withdrawn — options: build own from PDF and spreadsheet / CISO Assistant 800-171 r2 library (license and accuracy unchecked) / Rev 3
- Which authority encodes weights and POA&M rules? — why it matters: vendor sources differ in detail — options: encode from 32 CFR 170.21/170.24 and DoD methodology v1.2.1, citing each rule
- How to model partial-credit items (3.5.3, 3.13.11)? — why it matters: scored 0/-3/-5, not binary — options: implementation-level enum / special-case fields / binary with note
- POA&M at requirement or objective level? — why it matters: 170.24 requires a POA&M per NOT MET requirement; eligibility depends on score and points — options: requirement-level only / objective-level linked to requirement
- Is OSCAL the internal model, or export only? — why it matters: good fit for SSP/POA&M, but objective-level encoding unconfirmed — options: native OSCAL / relational DB with import-export / no OSCAL in V1
- Where may evidence live while it may contain CUI? — why it matters: external clouds holding CDI need FedRAMP Moderate equivalent; a dev laptop is still a system holding CUI — options: no real CUI in V1 (metadata and links) / encrypted local store with controls / defer until hosting is decided
- SSP export formats? — why it matters: Word is common; Paramify offers OSCAL — options: docx only / docx plus OSCAL

## Suspect pages
- none

## Sources
- clucraft/cmmc — https://github.com/clucraft/cmmc
- ARMS — https://orcannus.github.io/ARMS
- DefectDojo CMMC L2 Assessments — https://docs.defectdojo.com/federal_compliance/cmmc_assessments/
- PreVeil GRC — https://www.preveil.com/grc/
- Vanta roundup (vendor-authored) — https://vanta.com/resources/best-cmmc-compliance-management-software
- Exostar Certification Assistant — https://exostar.com/certification-assistant
- ScalePad ControlMap — https://www.scalepad.com/controlmap/cmmc
- Secureframe Federal announcement — https://secureframe.com/blog/announcing-secureframe-federal.md
- Drata help article — https://help.drata.com/en/articles/14724964-nist-sp-800-171-rev-2-self-assessment
- compliance-trestle — https://github.com/oscal-compass/compliance-trestle
- ComplyJet, Best CMMC Compliance Software — https://www.complyjet.com/blog/best-cmmc-compliance-software
- Secureframe, FedRAMP Equivalency for CMMC — https://secureframe.com/blog/fedramp-equivalency-cmmc
- Secureframe, CMMC documentation — https://secureframe.com/hub/cmmc/documentation.md
- Secureframe, DoD Assessment Methodology — https://secureframe.com/glossary/dod-assessment-methodology.md
- Secureframe, CMMC Level 2 compliance — https://secureframe.com/blog/cmmc-level-2-compliance
- Secureframe, manual vs automated — https://secureframe.com/hub/cmmc/manual-vs-automated
- 32 CFR 170.21 — https://www.law.cornell.edu/cfr/text/32/170.21
- 32 CFR 170.24 — https://www.law.cornell.edu/cfr/text/32/170.24
- 48 CFR 252.204-7012 — https://www.law.cornell.edu/cfr/text/48/252.204-7012
- NIST oscal-content SP800-171 — https://github.com/usnistgov/oscal-content/tree/main/nist.gov/SP800-171
- CISO Assistant Community README — https://github.com/intuitem/ciso-assistant-community/blob/main/README.md
- linville/cmmcdb — https://github.com/linville/cmmcdb
- NIST OSCAL catalog concept — https://pages.nist.gov/OSCAL/learn/concepts/layer/control/catalog
- NIST OSCAL SSP concept — https://pages.nist.gov/OSCAL/learn/concepts/layer/implementation/ssp
- NIST OSCAL POA&M concept — https://pages.nist.gov/OSCAL/learn/concepts/layer/assessment/poam/
- NIST SP 800-171A (withdrawn) — https://csrc.nist.gov/pubs/sp/800/171/a/final

## Not found
- Radicle GRC / Radiant Defense: `no evidence found`.
- Official DoD source for the July 13, 2026 CMMC milestone suspension: none fetched; only Secureframe and Exostar report it.
- Unverified lead, not a fact: a DoD/DARPA training deck reportedly saying CMMC uses Rev 2 (search result only).
- Unverified lead, not a fact: GovReady-Q, an open-source OSCAL-focused GRC tool (search result only).
- Unverified lead, not a fact: Paramify price of $8k to $25k a year from G2/FitGap snippets (G2 returned 403).
- Pricing for most vendors; PreVeil GRC without the enclave; CMMC depth of CISO Assistant; objective encoding in OSCAL; DoD Assessment Methodology v1.2.1 PDF; eCFR primary text (fetch failed; Cornell LII used).
