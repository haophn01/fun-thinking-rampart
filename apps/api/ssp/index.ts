// The SSP export: an outline built from what the api reads, rendered as a .docx. It reads no
// database and no clock of its own, so the api's routes stay the only readers.
import { sspFileName } from '../src/contract';
import { buildSspModel, type SspSource } from './model';
import { renderSspDocx } from './render';

export { SSP_SECTIONS, buildSspModel, type SspBlock, type SspModel, type SspSource } from './model';
export { renderSspDocx, type RenderOptions } from './render';

export interface SspExport {
  /** `SSP-<system identifier>-<UTC date of generatedAt>.docx`. */
  fileName: string;
  bytes: Uint8Array;
}

/** The SSP document and its file name, both dated by the UTC day of `generatedAt`. */
export async function exportSsp(source: SspSource, generatedAt: Date): Promise<SspExport> {
  const today = generatedAt.toISOString().slice(0, 10);
  return {
    fileName: sspFileName(source.profile.systemIdentifier, today),
    bytes: await renderSspDocx(buildSspModel(source), { generatedAt }),
  };
}
