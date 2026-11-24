import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { catalogKey, getRequirement, loadCatalog, type Requirement } from './index';

const catalog = loadCatalog();

const pointsOf = (r: Requirement) => (r.scoring.kind === 'points' ? r.scoring.points : 0);
const partialIds = (rs: readonly Requirement[]) =>
  rs
    .filter((r) => r.scoring.kind === 'points' && r.scoring.partialCredit !== null)
    .map((r) => r.id);

describe('catalog data', () => {
  it('counts families, requirements and objectives', () => {
    expect(catalog.families.map((f) => `${f.nistSection} ${f.code}`)).toEqual([
      '3.1 AC',
      '3.2 AT',
      '3.3 AU',
      '3.4 CM',
      '3.5 IA',
      '3.6 IR',
      '3.7 MA',
      '3.8 MP',
      '3.9 PS',
      '3.10 PE',
      '3.11 RA',
      '3.12 CA',
      '3.13 SC',
      '3.14 SI',
    ]);
    expect(catalog.families.map((f) => f.requirementIds.length)).toEqual([
      22, 3, 9, 9, 11, 3, 6, 9, 2, 6, 3, 4, 16, 7,
    ]);
    expect(catalog.requirements).toHaveLength(110);
    expect(catalog.requirements.flatMap((r) => r.objectives)).toHaveLength(320);
  });

  it('point distribution matches 32 CFR 170.24(c)(2)', () => {
    const count = (points: number) =>
      catalog.requirements.filter((r) => pointsOf(r) === points).length;
    expect(count(5)).toBe(44);
    expect(count(3)).toBe(14);
    expect(count(1)).toBe(51);
    expect(
      catalog.requirements.filter((r) => r.scoring.kind === 'prerequisite').map((r) => r.id),
    ).toEqual(['CA.L2-3.12.4']);
  });

  it('listed points split by basic and derived', () => {
    const partial = new Set(partialIds(catalog.requirements));
    const listed = catalog.requirements.filter((r) => !partial.has(r.id));
    const split = (points: number) => {
      const at = listed.filter((r) => pointsOf(r) === points);
      return {
        basic: at.filter((r) => r.type === 'basic').length,
        derived: at.filter((r) => r.type === 'derived').length,
      };
    };
    expect(split(5)).toEqual({ basic: 23, derived: 19 });
    expect(split(3)).toEqual({ basic: 7, derived: 7 });
    // 32 CFR 170.24(c)(2)(i)(B)(3): everything else is a derived requirement worth 1.
    expect(split(1)).toEqual({ basic: 0, derived: 51 });
  });

  it('partial credit on 3.5.3 and 3.13.11 only', () => {
    expect(partialIds(catalog.requirements)).toEqual(['IA.L2-3.5.3', 'SC.L2-3.13.11']);
    const labels = catalog.requirements.flatMap((r) =>
      r.scoring.kind === 'points' && r.scoring.partialCredit
        ? [
            [
              r.id,
              r.scoring.points,
              r.scoring.partialCredit.deduction,
              r.scoring.partialCredit.label,
            ],
          ]
        : [],
    );
    expect(labels).toEqual([
      ['IA.L2-3.5.3', 5, 3, 'MFA covers remote and privileged users only'],
      ['SC.L2-3.13.11', 5, 3, 'Encryption employed but not FIPS-validated'],
    ]);
  });

  it('worst-case data floor is -203', () => {
    const worstCase = catalog.requirements.reduce((sum, r) => sum + pointsOf(r), 0);
    expect(catalog.requirements.length - worstCase).toBe(-203);
  });

  it('objective ids', () => {
    expect(getRequirement(catalog, 'AC.L2-3.1.1')?.objectives.map((o) => o.id)).toEqual([
      '3.1.1[a]',
      '3.1.1[b]',
      '3.1.1[c]',
      '3.1.1[d]',
      '3.1.1[e]',
      '3.1.1[f]',
    ]);
    const ids = catalog.requirements.flatMap((r) => r.objectives.map((o) => o.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of catalog.requirements) {
      for (const o of r.objectives) expect(o.id.startsWith(`${r.nistId}[`)).toBe(true);
    }
  });

  it('source metadata and key', () => {
    expect(catalog.sources.map((s) => s.url)).toEqual([
      'https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-171r2.pdf',
      'https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-171A.pdf',
    ]);
    for (const s of catalog.sources) {
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(catalogKey(catalog)).toBe('nist-800-171-r2@1.0.0');
  });

  it('overrides are documented', () => {
    const { overrides } = JSON.parse(
      readFileSync(new URL('../scripts/overrides.json', import.meta.url), 'utf8'),
    ) as { overrides: { id: string; text: string; reason: string }[] };
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const known = new Set(
      catalog.requirements.flatMap((r) => [r.id, ...r.objectives.map((o) => o.id)]),
    );
    for (const o of overrides) {
      expect(known.has(o.id), `${o.id} is in the catalog`).toBe(true);
      expect(readme, `README lists ${o.id}`).toContain(`\`${o.id}\``);
      expect(readme, `README gives the reason for ${o.id}`).toContain(o.reason);
    }
  });
});

describe('loader', () => {
  it('validates once and caches', () => {
    expect(loadCatalog()).toBe(catalog);
  });

  it('looks requirements up by exact id', () => {
    expect(getRequirement(catalog, 'IA.L2-3.5.1')?.nistId).toBe('3.5.1');
    expect(getRequirement(catalog, 'IA-L2-3.5.1')).toBeUndefined();
    expect(getRequirement(catalog, 'AC.L2-3.1.99')).toBeUndefined();
  });
});
