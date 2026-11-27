import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from './file-name';

describe('sanitizeFileName', () => {
  it('sanitizeFileName edges', () => {
    // RTLO and the other bidi controls, and the zero-width characters, are removed.
    expect(sanitizeFileName('report\u202efdp.exe')).toBe('reportfdp.exe');
    expect(
      sanitizeFileName('a\u200bb\u200cc\u200dd\u200ee\u200ff\u202ag\u202bh\u202ci\u202dj.pdf'),
    ).toBe('abcdefghij.pdf');
    expect(sanitizeFileName('a\u2060b\u2061c\u2062d\u2063e\u2064f.pdf')).toBe('abcdef.pdf');
    expect(sanitizeFileName('a\u2066b\u2067c\u2068d\u2069e\ufefff.pdf')).toBe('abcdef.pdf');
    // Characters just outside the ranges stay.
    expect(sanitizeFileName('a\u200ab\u2010c\u2065d.pdf')).toBe('a\u200ab\u2010c\u2065d.pdf');

    // Windows-reserved punctuation becomes _.
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');

    // Device names before the first dot get a _ prefix, in any case.
    expect(sanitizeFileName('CON.pdf')).toBe('_CON.pdf');
    expect(sanitizeFileName('com1.txt')).toBe('_com1.txt');
    for (const name of ['prn.txt', 'Aux.pdf', 'NUL.csv', 'COM9.png', 'lpt1.docx', 'LPT9.tar.pdf']) {
      expect(sanitizeFileName(name)).toBe(`_${name}`);
    }
    expect(sanitizeFileName('con')).toBe('_con');
    expect(sanitizeFileName('CON .pdf')).toBe('_CON .pdf');
    expect(sanitizeFileName('  CON.pdf')).toBe('_CON.pdf');
    expect(sanitizeFileName('CON\u200b.pdf')).toBe('_CON.pdf');
    for (const name of [
      'console.pdf',
      'com0.txt',
      'com10.txt',
      'lpt.txt',
      'my con.pdf',
      'a.con.pdf',
    ]) {
      expect(sanitizeFileName(name)).toBe(name);
    }

    // NFD in, NFC out.
    expect(sanitizeFileName('cafe\u0301.pdf')).toBe('caf\u00e9.pdf');

    // Ordinary names pass through, trimmed.
    expect(sanitizeFileName('Access Policy v2.pdf')).toBe('Access Policy v2.pdf');
    expect(sanitizeFileName('  report.pdf  ')).toBe('report.pdf');

    // A name that ends up empty, or that the file-name schema refuses, is null.
    for (const name of [
      '',
      '   ',
      '\u202e\u200b',
      '\ufeff',
      'a/b.pdf',
      'a\\b.pdf',
      'a\u0001.pdf',
      '..',
    ]) {
      expect(sanitizeFileName(name), JSON.stringify(name)).toBeNull();
    }
    expect(sanitizeFileName(`${'a'.repeat(251)}.pdf`)).toBe(`${'a'.repeat(251)}.pdf`);
    expect(sanitizeFileName(`${'a'.repeat(252)}.pdf`)).toBeNull();
  });
});
