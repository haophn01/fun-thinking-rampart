// Whether a diagram's file is a picture the export can embed, read from its stored bytes. The
// name check in the repository only picks the links worth reading; the bytes decide.
import { imageInfo } from '../../../ssp/image-info';
import type { FileStore } from '../../../storage';
import type { DiagramLink } from '../../contract';
import { AppError } from '../../errors';
import { readFileVersion } from '../../evidence/repository';
import type { Reader } from '../common';

/** How many file verdicts each store keeps before it forgets the oldest. */
const CACHE_LIMIT = 1024;

/**
 * Each store's verdicts, by SHA-256: `true` when the bytes read as a PNG or JPEG. A version's
 * bytes never change (its SHA-256 is recorded with it), so a verdict holds for good. Keyed by
 * store, so one store's files never answer for another's.
 */
const verdicts = new WeakMap<FileStore, Map<string, boolean>>();

function cacheOf(store: FileStore): Map<string, boolean> {
  let cache = verdicts.get(store);
  if (cache === undefined) {
    cache = new Map();
    verdicts.set(store, cache);
  }
  return cache;
}

function remember(cache: Map<string, boolean>, sha256: string, verdict: boolean): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(sha256, verdict);
}

export interface CheckedDiagrams {
  /** The links, with `embeddable` false for each file whose bytes are not a PNG or JPEG. */
  diagrams: DiagramLink[];
  /** The bytes this check read, by link id: only images, so the export needn't read them again. */
  bytes: Map<string, Uint8Array>;
}

/**
 * Settles `embeddable` from the bytes. Only a link the name check passed is read, through the
 * hash-checked evidence read, and each file once per store. A file the app can't read (missing
 * or altered) keeps the name's verdict and isn't remembered: the export then says it couldn't
 * be read, as before. A CUI item's link is never read and never embeddable.
 */
export async function checkDiagramImages(
  db: Reader,
  store: FileStore,
  links: readonly DiagramLink[],
): Promise<CheckedDiagrams> {
  const cache = cacheOf(store);
  const bytes = new Map<string, Uint8Array>();
  const diagrams: DiagramLink[] = [];
  for (const link of links) {
    const { resolved } = link;
    if (
      !link.embeddable ||
      link.evidence.containsCui ||
      resolved === null ||
      resolved.kind !== 'file' ||
      resolved.sha256 === null
    ) {
      // Not a candidate (the name check already said no for a CUI item): never read.
      diagrams.push(link);
      continue;
    }
    const known = cache.get(resolved.sha256);
    if (known !== undefined) {
      diagrams.push(known ? link : { ...link, embeddable: false });
      continue;
    }
    let file: Uint8Array;
    try {
      file = (await readFileVersion(db, store, link.evidence.id, resolved.version)).bytes;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      diagrams.push(link);
      continue;
    }
    const isImage = imageInfo(file) !== null;
    remember(cache, resolved.sha256, isImage);
    if (isImage) bytes.set(link.id, file);
    diagrams.push(isImage ? link : { ...link, embeddable: false });
  }
  return { diagrams, bytes };
}

/** `checkDiagramImages` for one link, such as the answer to a write. */
export async function checkDiagramImage(
  db: Reader,
  store: FileStore,
  link: DiagramLink,
): Promise<DiagramLink> {
  const { diagrams } = await checkDiagramImages(db, store, [link]);
  return diagrams[0] ?? link;
}
