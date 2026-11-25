import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const templates = join(root, 'templates');

interface Row {
  name: string;
  path: string;
  url: string;
  date: string;
  sha256: string;
  status: string;
  terms: string;
}

/** Table rows of templates/SOURCES.md: name | path | URL | date | SHA-256 | status | terms. */
function readRows(): Row[] {
  const text = readFileSync(join(templates, 'SOURCES.md'), 'utf8');
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 7 || cells[0] === 'Source' || /^-+$/.test(cells[0] ?? '')) continue;
    const [name, path, url, date, sha256, status, terms] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    rows.push({ name, path: path.replace(/`/g, ''), url, date, sha256, status, terms });
  }
  return rows;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else out.push(relative(templates, full).split(sep).join('/'));
  }
  return out;
}

const committed = (r: Row) => r.path !== 'link only';
const files = () => listFiles(templates).filter((f) => f !== 'SOURCES.md');

describe('templates/ reference folder', () => {
  it('every committed file is listed', () => {
    const rows = readRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const f of files()) {
      const row = rows.find((r) => r.path === f);
      expect(row, `${f} has no SOURCES.md row`).toBeDefined();
    }
    for (const r of rows) {
      expect(r.url, r.name).toMatch(/^https:\/\/\S+$/);
      expect(r.date, r.name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(r.date)), r.name).toBe(false);
      expect(r.terms.length, r.name).toBeGreaterThan(0);
    }
  });

  it('hashes match', () => {
    for (const r of readRows().filter(committed)) {
      const full = join(templates, r.path);
      expect(existsSync(full), `${r.path} is marked committed but missing`).toBe(true);
      const sha = createHash('sha256').update(readFileSync(full)).digest('hex');
      expect(r.sha256, r.path).toBe(sha);
    }
  });

  it('vendor templates are links only', () => {
    expect(existsSync(join(templates, 'vendor'))).toBe(false);
    const rows = readRows();
    for (const host of ['hivesystems.com', 'securityscientist.net', 'secureframe.com']) {
      const row = rows.find((r) => r.url.includes(host));
      expect(row, host).toBeDefined();
      expect(row?.path).toBe('link only');
    }
    for (const r of rows.filter((x) => !committed(x))) {
      expect(files()).not.toContain(r.path);
    }
  });

  it('required sources are covered', () => {
    const rows = readRows();
    const ssp = rows.find((r) => r.path === 'official/cui-ssp-template-final.docx');
    expect(ssp, 'NIST SSP template row').toBeDefined();
    expect(existsSync(join(templates, 'official/cui-ssp-template-final.docx'))).toBe(true);
    for (const guide of ['AssessmentGuideL2', 'ScopingGuideL2']) {
      const row = rows.find((r) => r.url.includes(guide));
      expect(row, guide).toBeDefined();
      if (row && !committed(row)) {
        expect(row.status, guide).toMatch(/HTTP \d{3}/);
      }
    }
  });

  it('files stay small', () => {
    for (const f of files()) {
      expect(statSync(join(templates, f)).size, f).toBeLessThanOrEqual(20 * 1024 * 1024);
    }
  });
});
