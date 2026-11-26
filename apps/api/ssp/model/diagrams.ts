// Section 2.1: each diagram link as an embedded figure or a line that says where it is. The embed
// rule lives here, so the route only decides which bytes to read.
import { DIAGRAM_KIND_LABELS, type DiagramLink } from '../../src/contract';
import { fitImage, imageInfo } from '../image-info';
import { heading, paragraph } from './common';
import { SSP_SECTIONS } from './sections';
import type { SspBlock, SspSource } from './types';

/**
 * Whether a link may take an embed slot: marked embeddable, and a file of an item not flagged
 * "contains CUI". The flag is checked again here, so a CUI item is never embedded, whatever its
 * `embeddable` says.
 */
export function mayEmbed(link: DiagramLink): boolean {
  return link.embeddable && !link.evidence.containsCui && link.resolved?.kind === 'file';
}

/** The links the export would embed if their bytes read: the first `max` that may embed. */
export function embedCandidates(links: readonly DiagramLink[], max: number): DiagramLink[] {
  return links.filter(mayEmbed).slice(0, Math.max(0, max));
}

const utcDay = (timestamp: string) => new Date(timestamp).toISOString().slice(0, 10);

type Resolved = NonNullable<DiagramLink['resolved']>;

/** `<title> v<version>, <fileName>, SHA-256 <sha256>, <date>` for a file. */
function fileDetails(link: DiagramLink, resolved: Resolved): string {
  const cui = link.evidence.containsCui ? 'contains CUI, ' : '';
  return (
    `${link.evidence.title} v${String(resolved.version)}, ${cui}${resolved.fileName ?? ''}, ` +
    `SHA-256 ${resolved.sha256 ?? ''}, ${utcDay(resolved.createdAt)}`
  );
}

function referenceLine(link: DiagramLink, resolved: Resolved | null, reason: string): string {
  const head = `${link.caption} — ${DIAGRAM_KIND_LABELS[link.kind]}:`;
  if (resolved === null) return `${head} ${link.evidence.title}, no version recorded yet`;
  if (resolved.kind === 'reference') {
    const cui = link.evidence.containsCui ? 'contains CUI, ' : '';
    return (
      `${head} ${link.evidence.title} v${String(resolved.version)}, ${cui}kept at ` +
      `${resolved.location ?? ''}, ${utcDay(resolved.createdAt)}`
    );
  }
  return `${head} ${fileDetails(link, resolved)}${reason}`;
}

export function diagramBlocks(source: SspSource): SspBlock[] {
  const slots = new Set(embedCandidates(source.diagrams, source.maxEmbeddedImages));
  let figure = 0;
  const lines = source.diagrams.flatMap((link): SspBlock[] => {
    const { resolved } = link;
    if (!mayEmbed(link) || resolved === null) return [paragraph(referenceLine(link, resolved, ''))];
    if (!slots.has(link)) {
      const max = String(source.maxEmbeddedImages);
      return [
        paragraph(referenceLine(link, resolved, ` (referenced: the SSP embeds at most ${max} images)`)),
      ];
    }
    const bytes = source.images.get(link.id);
    const info = bytes === undefined ? null : imageInfo(bytes);
    if (bytes === undefined || info === null) {
      return [paragraph(referenceLine(link, resolved, " (referenced: the image couldn't be read)"))];
    }
    figure += 1;
    const size = fitImage(info);
    return [
      { kind: 'image', data: bytes, type: info.type, ...size, altText: link.caption },
      paragraph(
        `Figure ${String(figure)}. ${link.caption} — ${DIAGRAM_KIND_LABELS[link.kind]}, ` +
          fileDetails(link, resolved),
      ),
    ];
  });
  return [
    heading(2, SSP_SECTIONS.diagrams),
    ...(lines.length === 0 ? [paragraph('No diagrams linked.')] : lines),
  ];
}
