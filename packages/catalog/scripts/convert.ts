import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseCatalog } from '../src/schema';
import type { Catalog, CatalogSource, Family, Requirement } from '../src/types';
import { applyOverrides, parseOverridesFile, type OverridesFile } from './overrides';
import { mergeSources, parseAssessmentText, parseRequirementText } from './parse';
import { assignScoring, parsePointsFile, type PointsFile } from './points';

/**
 * `pnpm --filter @rampart/catalog convert`: reads the two NIST PDFs (downloading any that are
 * missing into `sources/`), checks them against the SHA-256 pins in `sources.json`, and writes
 * `data/nist-800-171-r2.json`.
 */

const sourcePinSchema = z.object({
  title: z.string().min(1),
  url: z.url(),
  /** File name under `packages/catalog/sources/` (gitignored). */
  file: z.string().regex(/^[\w.-]+\.pdf$/),
  /** Null until pinned; the converter then refuses to run and prints the hash to pin. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  retrieved: z.iso.date(),
});
const sourcesFileSchema = z.object({
  catalogVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** SP 800-171 Rev. 2: requirement statements and their basic/derived type. */
  requirements: sourcePinSchema,
  /** SP 800-171A: assessment objectives. */
  assessment: sourcePinSchema,
});

export type SourcePin = z.infer<typeof sourcePinSchema>;
export type SourcesFile = z.infer<typeof sourcesFileSchema>;

export interface ConvertInputs {
  sources: SourcesFile;
  points: PointsFile;
  overrides: OverridesFile;
  readSource: (pin: SourcePin) => Promise<Uint8Array>;
  extractPages: (bytes: Uint8Array) => Promise<string[]>;
  writeOutput: (json: string) => Promise<void>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyChecksum(pin: SourcePin, bytes: Uint8Array): void {
  const actual = sha256Hex(bytes);
  if (pin.sha256 === null) {
    throw new Error(`${pin.file} has no pinned SHA-256; pin ${actual} in scripts/sources.json`);
  }
  if (actual !== pin.sha256) {
    throw new Error(`${pin.file}: SHA-256 ${actual} does not match the pinned ${pin.sha256}`);
  }
}

/** Stable byte layout: two-space JSON, keys in construction order, trailing newline. */
export function serializeCatalog(catalog: Catalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

interface BuildInputs {
  version: string;
  sources: CatalogSource[];
  r2Pages: readonly string[];
  aPages: readonly string[];
  points: PointsFile;
  overrides: OverridesFile;
}

export function buildCatalog(inputs: BuildInputs): Catalog {
  const merged = mergeSources(
    parseRequirementText(inputs.r2Pages),
    parseAssessmentText(inputs.aPages),
  );
  const drafts = merged.requirements.map((r) => ({ ...r, id: `${r.family}.L2-${r.nistId}` }));

  const overridden = new Set(inputs.overrides.overrides.map((o) => o.id));
  for (const d of merged.textDifferences) {
    const id = drafts.find((r) => r.nistId === d.nistId)?.id ?? d.nistId;
    if (!overridden.has(id)) {
      throw new Error(
        `${id}: SP 800-171 and SP 800-171A word the statement differently ` +
          `("${d.sp800171}" vs "${d.sp800171a}"); add an override in scripts/overrides.json`,
      );
    }
  }

  const scoring = assignScoring(drafts, inputs.points);
  const requirements = applyOverrides(drafts, inputs.overrides).map((r): Requirement => {
    const s = scoring.get(r.id);
    if (!s) throw new Error(`${r.id} has no scoring`);
    return {
      id: r.id,
      nistId: r.nistId,
      family: r.family,
      type: r.type,
      text: r.text,
      scoring: s,
      objectives: r.objectives.map((o) => ({ id: o.id, text: o.text })),
    };
  });

  const families = merged.families.map((f): Family => ({
    code: f.code,
    nistSection: f.section,
    name: f.name,
    requirementIds: requirements.filter((r) => r.family === f.code).map((r) => r.id),
  }));

  return parseCatalog({
    id: 'nist-800-171-r2',
    version: inputs.version,
    sources: inputs.sources,
    families,
    requirements,
  });
}

/** Verifies both sources, builds and validates the catalog, then writes it once. */
export async function runConvert(inputs: ConvertInputs): Promise<Catalog> {
  const { requirements: r2Pin, assessment: aPin } = inputs.sources;
  const pinned: { pin: SourcePin; bytes: Uint8Array }[] = [];
  for (const pin of [r2Pin, aPin]) {
    const bytes = await inputs.readSource(pin);
    verifyChecksum(pin, bytes);
    pinned.push({ pin, bytes });
  }
  const [r2, a] = pinned;
  if (!r2 || !a) throw new Error('both sources are required');

  const catalog = buildCatalog({
    version: inputs.sources.catalogVersion,
    sources: pinned.map(({ pin, bytes }) => ({
      title: pin.title,
      url: pin.url,
      sha256: sha256Hex(bytes),
      retrieved: pin.retrieved,
    })),
    r2Pages: await inputs.extractPages(r2.bytes),
    aPages: await inputs.extractPages(a.bytes),
    points: inputs.points,
    overrides: inputs.overrides,
  });
  await inputs.writeOutput(serializeCatalog(catalog));
  return catalog;
}

/** pdfjs text items in content order, with a newline wherever the PDF ends a line. */
async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(
      content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join(''),
    );
  }
  await task.destroy();
  return pages;
}

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(resolve(packageDir, path), 'utf8')) as unknown;

async function readOrDownload(pin: SourcePin): Promise<Uint8Array> {
  const path = resolve(packageDir, 'sources', pin.file);
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    console.log(`downloading ${pin.url}`);
    const response = await fetch(pin.url);
    if (!response.ok) throw new Error(`${pin.url}: HTTP ${String(response.status)}`);
    if (response.url !== pin.url) {
      console.warn(
        `${pin.url} moved to ${response.url}; record the new URL in scripts/sources.json`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(resolve(packageDir, 'sources'), { recursive: true });
    await writeFile(path, bytes);
    return bytes;
  }
}

async function main(): Promise<void> {
  const output = resolve(packageDir, 'data', 'nist-800-171-r2.json');
  const catalog = await runConvert({
    sources: sourcesFileSchema.parse(await readJson('scripts/sources.json')),
    points: parsePointsFile(await readJson('scripts/points.cfr170-24.json')),
    overrides: parseOverridesFile(await readJson('scripts/overrides.json')),
    readSource: readOrDownload,
    extractPages: extractPdfPages,
    writeOutput: async (json) => {
      await mkdir(resolve(packageDir, 'data'), { recursive: true });
      await writeFile(output, json);
    },
  });
  const objectives = catalog.requirements.reduce((n, r) => n + r.objectives.length, 0);
  console.log(
    `wrote ${output}: ${String(catalog.families.length)} families, ` +
      `${String(catalog.requirements.length)} requirements, ${String(objectives)} objectives`,
  );
}

const entry = process.argv[1];
if (entry && resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
