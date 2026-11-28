import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { docxPart } from '../../../ssp/testing/docx-text';
import {
  fakeExe,
  sampleDocx,
  sampleJpeg,
  samplePdf,
  samplePng,
  sampleXlsx,
  zipBombDocx,
  zipOf,
} from './samples';

const ascii = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

describe('upload samples', () => {
  it('samples are well-formed', () => {
    // PDF: the header, an xref that startxref points at, and %%EOF last.
    const pdf = ascii(samplePdf());
    expect(pdf).toMatch(/^%PDF-1\.\d\n/);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = /startxref\n(\d+)\n%%EOF\s*$/.exec(pdf);
    expect(startxref).not.toBeNull();
    expect(pdf.slice(Number(startxref?.[1]), Number(startxref?.[1]) + 4)).toBe('xref');
    // Each xref offset lands on its object.
    const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThanOrEqual(3);
    offsets.forEach((offset, i) => {
      expect(pdf.slice(offset).startsWith(`${String(i + 1)} 0 obj`)).toBe(true);
    });

    // PNG: the signature, then IHDR.
    const png = samplePng();
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(ascii(png.subarray(12, 16))).toBe('IHDR');

    // JPEG: SOI first, EOI last, with tables, a frame and a scan in between.
    const jpeg = sampleJpeg();
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
    for (const marker of [0xdb, 0xc0, 0xc4, 0xda]) {
      expect(jpeg.some((b, i) => b === 0xff && jpeg[i + 1] === marker)).toBe(true);
    }

    // DOCX and XLSX: real OOXML parts, read back by an independent unzipper.
    const docx = sampleDocx();
    expect(docxPart(docx)).toContain('<w:document');
    expect(docxPart(docx, '[Content_Types].xml')).toContain('wordprocessingml.document.main+xml');
    const xlsx = sampleXlsx();
    expect(docxPart(xlsx, 'xl/workbook.xml')).toContain('<workbook');
    expect(docxPart(xlsx, '[Content_Types].xml')).toContain('spreadsheetml.sheet.main+xml');
    expect(Object.keys(unzipSync(xlsx)).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);

    // zipOf: stored and deflated entries both read back.
    const zip = zipOf([
      { name: 'a.txt', data: 'hello', method: 'store' },
      { name: 'dir/b.txt', data: 'world '.repeat(50) },
    ]);
    const files = unzipSync(zip);
    expect(strFromU8(files['a.txt'] ?? new Uint8Array())).toBe('hello');
    expect(strFromU8(files['dir/b.txt'] ?? new Uint8Array())).toBe('world '.repeat(50));

    // The bomb is small on the wire and declares far more than 100 times that.
    const bomb = zipBombDocx();
    expect(bomb.length).toBeLessThan(100_000);
    const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
    const eocd = bomb.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    let at = view.getUint32(eocd + 16, true);
    let declared = 0;
    for (let i = 0; i < view.getUint16(eocd + 10, true); i += 1) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      declared += view.getUint32(at + 24, true);
      const variable =
        view.getUint16(at + 28, true) +
        view.getUint16(at + 30, true) +
        view.getUint16(at + 32, true);
      at += 46 + variable;
    }
    expect(declared).toBeGreaterThan(100 * bomb.length);
    expect(declared).toBeGreaterThanOrEqual(20 * 1024 * 1024);
    expect(docxPart(bomb)).toContain('<w:document');

    // The fake EXE: MZ, a PE header where e_lfanew says, then NULs.
    const exe = fakeExe();
    expect(ascii(exe.subarray(0, 2))).toBe('MZ');
    const peAt = new DataView(exe.buffer, exe.byteOffset).getUint32(0x3c, true);
    expect([...exe.subarray(peAt, peAt + 4)]).toEqual([0x50, 0x45, 0, 0]);
    expect(exe.subarray(-16).every((b) => b === 0)).toBe(true);

    // Plain Node, so the e2e specs can import it.
    const source = readFileSync(fileURLToPath(new URL('./samples.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/from\s+['"]vitest|import\(\s*['"]vitest|require\(\s*['"]vitest/);
  });

  it('samples are deterministic', () => {
    expect(sampleDocx()).toEqual(sampleDocx());
    expect(sampleXlsx()).toEqual(sampleXlsx());
    expect(samplePdf()).toEqual(samplePdf());
  });
});
