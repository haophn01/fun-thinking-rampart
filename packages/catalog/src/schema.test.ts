import { describe, expect, it } from 'vitest';
import { parseCatalog } from './index';
import type { Catalog } from './types';

const SHA = 'a'.repeat(64);

function validCatalog(): Catalog {
  return {
    id: 'nist-800-171-r2',
    version: '1.0.0',
    sources: [
      {
        title: 'SP 800-171 Rev. 2',
        url: 'https://example.test/a.pdf',
        sha256: SHA,
        retrieved: '2026-11-23',
      },
    ],
    families: [
      {
        code: 'AC',
        nistSection: '3.1',
        name: 'Access Control',
        requirementIds: ['AC.L2-3.1.1', 'AC.L2-3.1.2'],
      },
      {
        code: 'CA',
        nistSection: '3.12',
        name: 'Security Assessment',
        requirementIds: ['CA.L2-3.12.4'],
      },
    ],
    requirements: [
      {
        id: 'AC.L2-3.1.1',
        nistId: '3.1.1',
        family: 'AC',
        type: 'basic',
        text: 'Limit system access.',
        scoring: {
          kind: 'points',
          points: 5,
          citation: '32 CFR 170.24(c)(2)(i)(B)(1)(i)',
          partialCredit: null,
        },
        objectives: [
          { id: '3.1.1[a]', text: 'authorized users are identified.' },
          { id: '3.1.1[b]', text: 'system access is limited to authorized users.' },
        ],
      },
      {
        id: 'AC.L2-3.1.2',
        nistId: '3.1.2',
        family: 'AC',
        type: 'basic',
        text: 'Limit transactions.',
        scoring: {
          kind: 'points',
          points: 5,
          citation: '32 CFR 170.24(c)(2)(i)(B)(4)(i)',
          partialCredit: {
            deduction: 3,
            label: 'Partial',
            citation: '32 CFR 170.24(c)(2)(i)(B)(4)(i)',
          },
        },
        objectives: [{ id: '3.1.2[a]', text: 'transactions are defined.' }],
      },
      {
        id: 'CA.L2-3.12.4',
        nistId: '3.12.4',
        family: 'CA',
        type: 'basic',
        text: 'Develop a system security plan.',
        scoring: { kind: 'prerequisite', citation: '32 CFR 170.24(c)(2)(i)(B)(5)' },
        objectives: [{ id: '3.12.4[a]', text: 'a system security plan is developed.' }],
      },
    ],
  };
}

function req(catalog: Catalog, index: number) {
  const found = catalog.requirements[index];
  if (!found) throw new Error(`fixture has no requirement ${String(index)}`);
  return found;
}

describe('catalog schema', () => {
  it('accepts a well-formed catalog and returns it unchanged', () => {
    const catalog = validCatalog();
    expect(parseCatalog(structuredClone(catalog))).toEqual(catalog);
  });

  it('rejects malformed catalogs', () => {
    const duplicate = validCatalog();
    duplicate.requirements.push(structuredClone(req(duplicate, 0)));
    expect(() => parseCatalog(duplicate)).toThrow(/duplicate requirement AC\.L2-3\.1\.1/);

    const wrongParent = validCatalog();
    req(wrongParent, 1).objectives.push({ id: '3.1.1[c]', text: 'misplaced.' });
    expect(() => parseCatalog(wrongParent)).toThrow(
      /objective 3\.1\.1\[c\] is not under AC\.L2-3\.1\.2/,
    );

    const empty = validCatalog();
    req(empty, 1).objectives = [];
    expect(() => parseCatalog(empty)).toThrow(/AC\.L2-3\.1\.2 has no objectives/);

    const familyMismatch = validCatalog();
    const ac = familyMismatch.families[0];
    if (!ac) throw new Error('fixture has no AC family');
    ac.requirementIds = ['AC.L2-3.1.1'];
    expect(() => parseCatalog(familyMismatch)).toThrow(
      /family AC lists .* but its requirements are/,
    );
  });

  it('rejects ids that disagree with their family and NIST number', () => {
    const badId = validCatalog();
    req(badId, 0).id = 'AT.L2-3.1.1';
    expect(() => parseCatalog(badId)).toThrow(/AT\.L2-3\.1\.1/);

    const badSection = validCatalog();
    req(badSection, 2).nistId = '3.1.4';
    expect(() => parseCatalog(badSection)).toThrow(/3\.1\.4/);
  });

  it('rejects an objective id used twice and a short checksum', () => {
    const twice = validCatalog();
    req(twice, 0).objectives.push({ id: '3.1.1[a]', text: 'again.' });
    expect(() => parseCatalog(twice)).toThrow(/duplicate objective 3\.1\.1\[a\]/);

    const shortSha = validCatalog();
    const source = shortSha.sources[0];
    if (!source) throw new Error('fixture has no source');
    source.sha256 = 'abc';
    expect(() => parseCatalog(shortSha)).toThrow();
  });

  it('rejects requirements out of numeric order', () => {
    const swapped = validCatalog();
    const [first, second, third] = swapped.requirements;
    if (!first || !second || !third) throw new Error('fixture needs three requirements');
    swapped.requirements = [second, first, third];
    const ac = swapped.families[0];
    if (!ac) throw new Error('fixture has no AC family');
    ac.requirementIds = ['AC.L2-3.1.2', 'AC.L2-3.1.1'];
    expect(() => parseCatalog(swapped)).toThrow(/order/);
  });
});
