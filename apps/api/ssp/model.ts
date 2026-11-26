// The SSP as a pure outline: what the document says, in the order it says it. The render turns
// it into a .docx; nothing here reads a database, a clock or a file. The order follows the
// NIST SP 800-171 SSP template's sections 1-4, with the CMMC sections, the approvals and two
// appendices (assessment status and objectives) around them.
import { heading } from './model/common';
import { approvalBlocks, changesBlocks } from './model/control';
import { diagramBlocks } from './model/diagrams';
import { assessmentStatusBlocks, objectivesBlocks } from './model/appendices';
import { requirementsBlocks } from './model/requirements';
import { SSP_SECTIONS } from './model/sections';
import {
  assetBlocks,
  cuiBlocks,
  environmentTable,
  identificationBlocks,
  providerBlocks,
} from './model/system';
import type { SspBlock, SspModel, SspSource } from './model/types';

export { SSP_OUTLINE, SSP_SECTIONS } from './model/sections';
export { embedCandidates, mayEmbed } from './model/diagrams';
export type { SspBlock, SspExportEntry, SspModel, SspSource } from './model/types';

function titleBlocks(source: SspSource): SspBlock[] {
  return [
    { kind: 'title', text: 'System Security Plan' },
    { kind: 'subtitle', text: source.profile.systemName ?? 'System not named' },
    { kind: 'generated' },
  ];
}

function environmentBlocks(source: SspSource): SspBlock[] {
  return [heading(1, SSP_SECTIONS.environment), environmentTable(source), ...diagramBlocks(source)];
}

/** The SSP outline: the title block, then the ten top-level sections in order. */
export function buildSspModel(source: SspSource): SspModel {
  return {
    blocks: [
      ...titleBlocks(source),
      ...identificationBlocks(source),
      ...environmentBlocks(source),
      ...cuiBlocks(source),
      ...assetBlocks(source),
      ...providerBlocks(source),
      ...requirementsBlocks(source),
      ...changesBlocks(source),
      ...approvalBlocks(source),
      ...assessmentStatusBlocks(source),
      ...objectivesBlocks(source),
    ],
  };
}
