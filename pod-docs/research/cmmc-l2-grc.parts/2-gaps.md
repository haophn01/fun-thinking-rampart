# Research: Single-contractor CMMC Level 2 GRC tool (gaps angle)

_Generated: 2026-11-23 · Depth: standard · Researchers: 1 · Searches: 6 · Pages read: 8 (1 more failed on a redirect)_

**Assumptions:** The tool serves one contractor tracking its own C3PAO readiness. V1 is workflow only, with no integrations. It runs locally now, and evidence may contain CUI. Most sources are vendor pages, so every claim below is vendor-stated unless noted.

## What exists
This part covers the gaps angle only. Tools below appear only as evidence for gaps. See the `existing` part for the full landscape.

| Name | Link | What it does | Alive? | License | How close to the idea |
|------|------|--------------|--------|---------|-----------------------|
| ControlMap (ScalePad) | https://www.scalepad.com/controlmap/cmmc | SSP builder, POA&M, SPRS, evidence linked to controls with CUI labels | Active, no figures found | Commercial | Close on features, but aimed at MSPs |
| DefectDojo Pro CMMC L2 assessments | https://docs.defectdojo.com/federal_compliance/cmmc_assessments/ | Per-requirement Met/Not met/NA/Planned, computes SPRS | Beta, Pro only | Commercial (Pro tier) | Partial: no objectives, no SSP |
| Vanta, Drata, Secureframe | https://www.complyjet.com/blog/best-cmmc-compliance-software | SOC 2-origin platforms with a CMMC module | Active | Commercial | Heavy, see gaps |

## Gaps and angles
- Many "CMMC" tools began as SOC 2 or ISO 27001 products. They "don't map neatly onto NIST 800-171 control numbers", and some treat CMMC as "a thin overlay". — [ComplyJet](https://www.complyjet.com/blog/best-cmmc-compliance-software) (a competitor's blog)
- Vanta's CMMC module is "an add-on to a broader platform". Vanta and Drata "can track SPRS but require more configuration to surface it clearly". The same page asks whether SSPs and POA&Ms are generated or still "built in Word". — [ComplyJet](https://www.complyjet.com/blog/best-cmmc-compliance-software)
- Drata and Hyperproof are called heavy for small teams. Vanta is "expensive for CMMC-only use cases". Drata renewals reportedly rise 10-20% a year. — [ComplyJet](https://www.complyjet.com/blog/best-cmmc-compliance-software)
- Apptega is "better suited to MSPs and consultants than individual contractors". ControlMap is also MSP-oriented. A single-contractor, self-readiness tool is an underserved framing. — [ComplyJet](https://www.complyjet.com/blog/best-cmmc-compliance-software), [ControlMap](https://www.scalepad.com/controlmap/cmmc)
- Objective-level (800-171A, 320 objectives) tracking is thin. DefectDojo records results per requirement only and doesn't cover objectives or SSP management. ControlMap's page names 800-171A criteria but doesn't describe objective-level tracking. Secureframe says an SSP should address each requirement and objective. — [DefectDojo](https://docs.defectdojo.com/federal_compliance/cmmc_assessments/), [ControlMap](https://www.scalepad.com/controlmap/cmmc), [Secureframe docs](https://secureframe.com/hub/cmmc/documentation.md)
- Even Secureframe says its platform "cannot collect and store CUI". Scoping, risk analysis and judgment-based work stay with people. SaaS GRC tools therefore avoid CUI evidence, which a local or self-hosted tool could handle. — [Secureframe manual vs automated](https://secureframe.com/hub/cmmc/manual-vs-automated)
- Secureframe describes traditional federal tools as mostly point-in-time documentation and remediation planning, not ongoing evidence handling. This is a vendor claim. — [Secureframe](https://secureframe.com/blog/cmmc-level-2-compliance)
- Public user-review evidence is scarce. Some CMMC-specific tools have "no" or "very few" reviews. I found no Reddit or assessor-side feedback. — [ComplyJet](https://www.complyjet.com/blog/best-cmmc-compliance-software)
- Regulatory churn is a gap for any tool. A Secureframe post says DoD suspended CMMC implementation milestones on July 13, 2026. It says Program Managers may only designate Level 1 (Self) or Level 2 (Self) in new solicitations, and that C3PAO requirements are being removed. The post says this is the position as of its writing. Verify against official DoD sources, since this is a single vendor source. — [Secureframe](https://secureframe.com/blog/cmmc-level-2-compliance)

## Best practices
- Treat the POA&M as a living document, updated at least monthly. Have SSP, POA&M and policies ready before the C3PAO begins testing. — [Secureframe docs](https://secureframe.com/hub/cmmc/documentation.md)
- Score per the DoD Assessment Methodology. The score starts at 110, each requirement is worth 1, 3 or 5 points, the floor is -203, and scores expire after 3 years. — [Secureframe glossary](https://secureframe.com/glossary/dod-assessment-methodology.md)
- Model POA&M eligibility in the scoring logic. Conditional status needs a score of at least 88 and only POA&M-eligible gaps (among requirements above 1 point, only 3.13.11), and the POA&M must close within 180 days. This comes from DefectDojo docs. Other vendor sources disagree on details, so verify against 32 CFR 170.21 and the DoD methodology. The eCFR fetch failed, so I did not confirm it. — [DefectDojo](https://docs.defectdojo.com/federal_compliance/cmmc_assessments/)
- Store CUI evidence only in a FedRAMP Moderate (or equivalent) environment when it sits in an external cloud service. "Equivalent" means 100% of the FedRAMP Moderate baseline, a 3PAO assessment, and zero control-related POA&Ms. The requirement applies when the contract has DFARS 252.204-7012. The summary is secondary, so verify against the DoD CIO memo. — [Secureframe FedRAMP equivalency](https://secureframe.com/blog/fedramp-equivalency-cmmc)

## Ideas to consider
- A single-org, self-hosted readiness tracker (not MSP, not multi-tenant) with first-class tracking of all 320 objectives. Rolling up to requirements, SSP and score is possible. — grows from the objective-level and MSP gaps above
- An SSP generated from objective-level answers, so it needn't be written in Word. — grows from the ComplyJet SSP/POA&M gap
- A scoring engine that shows what-if SPRS, the 88 threshold and POA&M eligibility live. — grows from the SPRS-configuration gap
- Evidence kept on local or controlled storage, with metadata-only sync to anything cloud-hosted. — grows from the CUI gap
- Rules/config data (weights, eligibility, objectives) held separately from code, so regulatory changes are data edits. — (own idea), prompted by the July 2026 churn

## Questions for the plan
- Will CUI-bearing evidence be stored in the tool, or only references to it? — why it matters: a cloud host of CUI evidence faces FedRAMP Moderate equivalency, and even Secureframe avoids storing CUI — options: references only / local encrypted store / FedRAMP-authorized host later
- Is the target still a C3PAO assessment, given the reported July 2026 suspension and self-assessment designations? — why it matters: this changes which workflows (affirmation, self-score) matter most — options: verify with official DoD sources then keep C3PAO / support both self and C3PAO
- Do objectives (320) get tracked as first-class records, or only the 110 requirements? — why it matters: tools like DefectDojo skip objectives, and a C3PAO assesses at objective level — options: objectives first-class / requirements with notes
- Which authority defines POA&M eligibility and weights? — why it matters: vendor sources disagree — options: encode from 32 CFR 170.21 and the DoD methodology v1.2.1, with a citation per rule

## Suspect pages
- none

## Sources
- ComplyJet, Best CMMC Compliance Software — https://www.complyjet.com/blog/best-cmmc-compliance-software — undated
- Secureframe, FedRAMP Equivalency for CMMC — https://secureframe.com/blog/fedramp-equivalency-cmmc — undated
- ScalePad ControlMap CMMC — https://www.scalepad.com/controlmap/cmmc — undated
- Secureframe, CMMC documentation — https://secureframe.com/hub/cmmc/documentation.md — undated
- DefectDojo, CMMC Level 2 Assessments (Pro) — https://docs.defectdojo.com/federal_compliance/cmmc_assessments/ — undated
- Secureframe, DoD Assessment Methodology — https://secureframe.com/glossary/dod-assessment-methodology.md — undated
- Secureframe, CMMC Level 2 compliance — https://secureframe.com/blog/cmmc-level-2-compliance — undated
- Secureframe, manual vs automated — https://secureframe.com/hub/cmmc/manual-vs-automated — undated
