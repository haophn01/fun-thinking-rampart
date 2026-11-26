// The SSP's headings, exact text: the NIST SP 800-171 outline's sections 1-4, the CMMC sections
// between them, the approvals and two appendices.

/** The ten level-1 headings, in document order. */
export const SSP_OUTLINE = [
  '1. System identification',
  '2. System environment',
  'CMMC: CUI description',
  'CMMC: Asset inventory',
  'CMMC: External service providers and responsibilities',
  '3. Requirements',
  '4. Record of changes',
  'Approvals',
  'Appendix A — Assessment status',
  'Appendix B — Assessment objectives',
] as const;

export const SSP_SECTIONS = {
  identification: SSP_OUTLINE[0],
  roles: '1.1 Roles and users',
  environment: SSP_OUTLINE[1],
  diagrams: '2.1 Diagrams',
  cui: SSP_OUTLINE[2],
  assets: SSP_OUTLINE[3],
  providers: SSP_OUTLINE[4],
  requirements: SSP_OUTLINE[5],
  changes: SSP_OUTLINE[6],
  approvals: SSP_OUTLINE[7],
  assessmentStatus: SSP_OUTLINE[8],
  objectives: SSP_OUTLINE[9],
} as const;
