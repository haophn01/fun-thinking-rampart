// The SSP outline as a Word document. Only this file knows the docx library.
import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { PRODUCT_NAME } from '../src/contract';
import type { SspBlock, SspModel } from './model';

export interface RenderOptions {
  /** When the document is made: its "Generated … on <UTC date>" line. */
  generatedAt: Date;
}

const TITLE = 'System Security Plan';

/** US Letter with one-inch margins, in twentieths of a point. */
const PAGE = { width: 12240, height: 15840, margin: 1440 };
const TEXT_WIDTH = PAGE.width - 2 * PAGE.margin;

/** A list item's indent, in twentieths of a point. */
const LIST_INDENT = 360;

/** The blank a signature or an undated approval is written on. */
const SIGNATURE_BLANK = '_'.repeat(32);
const DATE_BLANK = '_'.repeat(12);

const HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const;

/**
 * Text XML 1.0 can hold: C0 controls other than tab, LF and CR, U+FFFE, U+FFFF and lone
 * surrogates are dropped; everything else, `<` and `&` included, is kept (docx escapes it).
 */
export function xmlSafe(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    '',
  );
}

/** The non-blank lines of a text, each safe for XML: one paragraph per line. */
export function linesOf(text: string): string[] {
  return xmlSafe(text)
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== '');
}

/** A text that belongs on one line (a label, a value, a title), its lines joined by spaces. */
function oneLine(text: string): string {
  return linesOf(text).join(' ');
}

type RunOptions = Exclude<ConstructorParameters<typeof TextRun>[0], string>;

/** A run of text. Its style is typed apart from `string`, so `bold` isn't read as String's. */
function run(text: string, style: Omit<RunOptions, 'text'> = {}): TextRun {
  const options: RunOptions = { ...style, text };
  return new TextRun(options);
}

function plain(text: string): Paragraph {
  return new Paragraph({ children: [run(text)] });
}

/** `Label: value`, or `Label:` alone, kept on the page of the lines that follow it. */
function labelled(label: string, value?: string): Paragraph {
  return new Paragraph({
    keepNext: value === undefined,
    children: [
      run(value === undefined ? `${label}:` : `${label}: `, { bold: true }),
      ...(value === undefined ? [] : [run(value)]),
    ],
  });
}

/** A cell's paragraphs. A cell always holds one, even an empty one, as Word requires. */
function cellParagraphs(text: string, bold: boolean): Paragraph[] {
  const lines = linesOf(text);
  if (lines.length === 0) return [new Paragraph({})];
  return lines.map((line) => new Paragraph({ children: [run(line, { bold })] }));
}

/** Column widths from each column's longest line, kept between 8 and 60 characters. */
function columnWidths(columns: string[], rows: string[][]): number[] {
  const weights = columns.map((column, i) => {
    const longest = Math.max(
      ...[column, ...rows.map((row) => row[i] ?? '')].flatMap((text) =>
        linesOf(text).map((line) => line.length),
      ),
      0,
    );
    return Math.min(60, Math.max(8, longest));
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => Math.floor((TEXT_WIDTH * weight) / total));
}

function table(columns: string[], rows: string[][]): Table {
  const widths = columnWidths(columns, rows);
  const row = (cells: string[], header: boolean) =>
    new TableRow({
      tableHeader: header,
      children: columns.map(
        (_, i) =>
          new TableCell({
            width: { size: widths[i] ?? 0, type: WidthType.DXA },
            children: cellParagraphs(cells[i] ?? '', header),
          }),
      ),
    });
  return new Table({
    width: { size: TEXT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: [row(columns, true), ...rows.map((cells) => row(cells, false))],
  });
}

/**
 * A picture on its own line, drawn at the model's size. `drawingId` numbers the drawings of this
 * document from 1: the library's own counter runs across documents, so a second render would
 * differ.
 */
function image(block: Extract<SspBlock, { kind: 'image' }>, drawingId: number): Paragraph {
  const alt = oneLine(block.altText);
  return new Paragraph({
    keepNext: true,
    children: [
      new ImageRun({
        type: block.type,
        data: block.data,
        transformation: { width: block.width, height: block.height },
        altText: { id: String(drawingId), name: alt, description: alt, title: alt },
      }),
    ],
  });
}

/** `<name>, <title>`, the signature line and the date, kept together on one page. */
function signature(block: Extract<SspBlock, { kind: 'signature' }>): Paragraph[] {
  return [
    new Paragraph({
      keepNext: true,
      children: [run(`${oneLine(block.name)}, ${oneLine(block.title)}`, { bold: true })],
    }),
    new Paragraph({ keepNext: true, children: [run(`Signature: ${SIGNATURE_BLANK}`)] }),
    plain(`Date: ${block.date === null ? DATE_BLANK : oneLine(block.date)}`),
  ];
}

interface RenderContext {
  today: string;
  /** The drawings rendered so far. */
  drawings: number;
}

function render(block: SspBlock, context: RenderContext): (Paragraph | Table)[] {
  switch (block.kind) {
    case 'title':
      return [new Paragraph({ heading: HeadingLevel.TITLE, text: oneLine(block.text) })];
    case 'subtitle':
      return [
        new Paragraph({
          children: [run(oneLine(block.text), { bold: true, size: 32 })],
        }),
      ];
    case 'generated':
      return [plain(`Generated by ${PRODUCT_NAME} on ${context.today}`)];
    case 'heading':
      return [new Paragraph({ heading: HEADINGS[block.level], text: oneLine(block.text) })];
    case 'paragraph':
      return linesOf(block.text).map(plain);
    case 'field':
      return [labelled(oneLine(block.label), oneLine(block.value))];
    case 'text':
      return [labelled(oneLine(block.label)), ...linesOf(block.text).map(plain)];
    case 'list':
      if (block.items.length === 0) return [labelled(oneLine(block.label), oneLine(block.empty))];
      return [
        labelled(oneLine(block.label)),
        ...block.items.map(
          (item) =>
            new Paragraph({
              indent: { left: LIST_INDENT },
              children: [run(oneLine(item))],
            }),
        ),
      ];
    case 'table':
      return [table(block.columns, block.rows)];
    case 'image':
      context.drawings += 1;
      return [image(block, context.drawings)];
    case 'signature':
      return signature(block);
  }
}

/**
 * The SSP as .docx bytes. The same model and `generatedAt` give the same `word/document.xml`
 * (with images, only the media and relationship IDs may differ); "today" is the UTC date of
 * `generatedAt`.
 */
export async function renderSspDocx(model: SspModel, options: RenderOptions): Promise<Uint8Array> {
  const context: RenderContext = {
    today: options.generatedAt.toISOString().slice(0, 10),
    drawings: 0,
  };
  const document = new Document({
    creator: PRODUCT_NAME,
    title: TITLE,
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE.width, height: PAGE.height },
            margin: {
              top: PAGE.margin,
              right: PAGE.margin,
              bottom: PAGE.margin,
              left: PAGE.margin,
            },
          },
        },
        children: model.blocks.flatMap((block) => render(block, context)),
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}
