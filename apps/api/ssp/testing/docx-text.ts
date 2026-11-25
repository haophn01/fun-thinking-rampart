// Test helpers: read a .docx back. fflate is a devDependency, so only tests import this file.
import { strFromU8, unzipSync } from 'fflate';

/** One part of a .docx (a zip file), as text. Throws when the part isn't there. */
export function docxPart(bytes: Uint8Array, path = 'word/document.xml'): string {
  const files = unzipSync(bytes, { filter: (file) => file.name === path });
  const part = files[path];
  if (part === undefined) throw new Error(`The .docx has no ${path}`);
  return strFromU8(part);
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

// A paragraph's start or end, a text run, a tab or a line break, in document order.
const TOKEN =
  /<w:p(?=[\s>/])[^>]*?(\/?)>|<\/w:p>|<w:t(?=[\s>])[^>]*>([^<]*)<\/w:t>|<w:t\s*\/>|<w:tab\/>|<w:br\/>/g;

/**
 * The text of `word/document.xml`: one line per paragraph (table cells are paragraphs too), with
 * tabs and breaks as `\t` and `\n` and XML entities decoded.
 */
export function docxText(bytes: Uint8Array): string {
  const xml = docxPart(bytes);
  const lines: string[] = [];
  let current: string | null = null;
  for (const match of xml.matchAll(TOKEN)) {
    const [token, selfClosing, text] = match;
    if (token.startsWith('<w:p')) {
      if (selfClosing === '/') lines.push('');
      else current = '';
    } else if (token === '</w:p>') {
      if (current !== null) lines.push(current);
      current = null;
    } else if (current !== null) {
      if (token === '<w:tab/>') current += '\t';
      else if (token === '<w:br/>') current += '\n';
      else current += decode(text ?? '');
    }
  }
  return lines.join('\n');
}
