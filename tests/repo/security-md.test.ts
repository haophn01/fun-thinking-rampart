import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

function securityText(): string {
  return readFileSync(join(root, 'SECURITY.md'), 'utf8').replace(/\r\n/g, '\n');
}

const SECTIONS = [
  'Supported versions',
  'Reporting a vulnerability',
  'Threat model (STRIDE)',
  'NIST SP 800-171 self-mapping',
  'Known gaps',
  'Verification evidence',
] as const;

const REQUIREMENTS = [
  '3.1.8',
  '3.1.9',
  '3.1.10',
  '3.1.11',
  '3.3.1',
  '3.3.8',
  '3.5.3',
  '3.5.7',
  '3.5.8',
  '3.5.9',
  '3.5.10',
  '3.5.11',
  '3.13.11',
  '3.14.1',
  '3.14.2',
] as const;

const STRIDE_COMPONENTS = ['api', 'web', 'file store', 'CI'] as const;

const VERIFICATION_ITEMS = [
  'Route matrix',
  'CI',
  'Headers',
  'Rate limits',
  'Sessions',
  'Passwords',
  'Notice',
  'Lock',
  'MFA',
  'Uploads',
  'Redaction',
  'Audit chain',
  'FIPS',
  'SECURITY.md',
  'Regression',
] as const;

/** The body of one `## <name>` section, up to the next `## ` heading. */
function section(text: string, name: string): string {
  const start = text.indexOf(`\n## ${name}\n`);
  if (start === -1) throw new Error(`SECURITY.md has no "## ${name}" section`);
  const body = text.slice(start + name.length + 5);
  const next = body.indexOf('\n## ');
  return next === -1 ? body : body.slice(0, next);
}

/** The data rows of the first table in a section: cells trimmed, header and divider dropped. */
function tableRows(body: string): string[][] {
  const lines = body.split('\n').filter((l) => l.trimStart().startsWith('|'));
  return lines.slice(2).map((line) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim()),
  );
}

/** Backticked items in a cell. */
function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
}

interface TestRef {
  file: string;
  name: string;
}

/** `` `file` › test name `` entries joined by `; ` (a name may itself hold "; "). */
function testRefs(cell: string): TestRef[] {
  return [...cell.matchAll(/`([^`]+)` › (.+?)(?=; `|$)/g)].map((m) => ({
    file: m[1] ?? '',
    name: (m[2] ?? '').trim(),
  }));
}

/** A repo-relative path that stays inside the repo and exists. */
function repoPathProblem(path: string, kind: 'any' | 'file'): string | null {
  if (path === '' || isAbsolute(path) || normalize(path).startsWith('..')) {
    return `${path}: not a repo-relative path`;
  }
  const full = join(root, path);
  if (!existsSync(full)) return `${path}: does not exist`;
  if (kind === 'file' && !statSync(full).isFile()) return `${path}: is not a file`;
  return null;
}

/** A test name appears in its file as a whole string literal, not just a fragment. */
function testRefProblem(ref: TestRef): string | null {
  const pathProblem = repoPathProblem(ref.file, 'file');
  if (pathProblem !== null) return pathProblem;
  const source = readFileSync(join(root, ref.file), 'utf8');
  const literal = ["'", '"', '`'].some((q) => source.includes(`${q}${ref.name}${q}`));
  return literal ? null : `${ref.file}: no test named "${ref.name}"`;
}

describe('SECURITY.md', () => {
  it('has the disclosure policy sections', () => {
    const text = securityText();
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([...SECTIONS]);
    expect(text).not.toMatch(/\bTODO\b|\bTBD\b/i);
    expect(text).not.toMatch(/<[^<>\n]*>/);
    const stray: number[] = [];
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      const control = code < 0x20 && code !== 0x0a && code !== 0x09;
      if (control || code === 0x7f || code === 0xfffd) stray.push(i);
    }
    expect(stray).toEqual([]);

    const reporting = section(text, 'Reporting a vulnerability');
    expect(reporting).toMatch(/private vulnerability reporting/i);
    expect(reporting).toMatch(/never .*public issue/i);
    expect(reporting).toMatch(/5 business days/);
    expect(reporting).toMatch(/30 days/);
    expect(reporting).toMatch(/high or critical/i);
  });

  it('names every known gap', () => {
    const gaps = section(securityText(), 'Known gaps');
    for (const needle of [
      /FIPS/,
      /argon2/i,
      /newest events/i,
      /virus scan/i,
      /encrypt(ed|ion) at rest/i,
      /ACL/,
      /synchronous/i,
      /WebAuthn/,
    ]) {
      expect(gaps).toMatch(needle);
    }
  });

  it('STRIDE covers api, web, file store and CI', () => {
    const rows = tableRows(section(securityText(), 'Threat model (STRIDE)'));
    const problems: string[] = [];
    for (const component of STRIDE_COMPONENTS) {
      const row = rows.find((r) => r[0] === component);
      if (row === undefined) {
        problems.push(`${component}: no row`);
        continue;
      }
      const cells = row.slice(1);
      if (cells.length !== 6) problems.push(`${component}: ${String(cells.length)} cells, not 6`);
      cells.forEach((cell, i) => {
        const letter = 'STRIDE'[i] ?? '?';
        if (cell.length < 20) problems.push(`${component} ${letter}: empty or too short`);
        // The code path is the backticked list in the cell's closing parenthesis.
        const paths = backticked(/\(([^()]*)\)\s*$/.exec(cell)?.[1] ?? '');
        if (paths.length === 0) problems.push(`${component} ${letter}: no code path`);
        for (const p of paths) {
          const problem = repoPathProblem(p, 'any');
          if (problem !== null) problems.push(`${component} ${letter}: ${problem}`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it('maps every touched 800-171 requirement to code and a test', () => {
    const rows = tableRows(section(securityText(), 'NIST SP 800-171 self-mapping'));
    expect(rows.map((r) => r[0])).toEqual([...REQUIREMENTS]);
    const problems: string[] = [];
    for (const row of rows) {
      const [requirement, control, code, tests, status] = row;
      const id = requirement ?? '?';
      if (row.length !== 5) problems.push(`${id}: ${String(row.length)} cells, not 5`);
      if ((control ?? '').length < 10) problems.push(`${id}: no control text`);
      if (!['Met', 'Partial', 'Gap'].includes(status ?? '')) {
        problems.push(`${id}: status "${status ?? ''}" is not Met, Partial or Gap`);
      }
      const paths = backticked(code ?? '');
      if (paths.length === 0) problems.push(`${id}: no code path`);
      for (const p of paths) {
        const problem = repoPathProblem(p, 'any');
        if (problem !== null) problems.push(`${id}: ${problem}`);
      }
      const refs = testRefs(tests ?? '');
      if (refs.length === 0) problems.push(`${id}: no test`);
      for (const ref of refs) {
        const problem = testRefProblem(ref);
        if (problem !== null) problems.push(`${id}: ${problem}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every plan Verification item cites a test', () => {
    const rows = tableRows(section(securityText(), 'Verification evidence'));
    const problems: string[] = [];
    for (const item of VERIFICATION_ITEMS) {
      const matching = rows.filter((r) => r[0] === item);
      if (matching.length !== 1) {
        problems.push(`${item}: ${String(matching.length)} rows, not 1`);
        continue;
      }
      const tests = matching[0]?.[matching[0].length - 1] ?? '';
      const refs = testRefs(tests);
      if (refs.length === 0) problems.push(`${item}: no test`);
      for (const ref of refs) {
        const problem = testRefProblem(ref);
        if (problem !== null) problems.push(`${item}: ${problem}`);
      }
    }
    // Any other row is only the orchestrator's CI-green check, which no test can show.
    for (const row of rows) {
      if ((VERIFICATION_ITEMS as readonly string[]).includes(row[0] ?? '')) continue;
      if (!/orchestrator/i.test(row.join(' '))) problems.push(`${row[0] ?? '?'}: unexpected row`);
    }
    expect(problems).toEqual([]);
  });
});
