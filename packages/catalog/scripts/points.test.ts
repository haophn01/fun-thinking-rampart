import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizePracticeId } from '../src/index';
import { assignScoring, parsePointsFile, type PointsFile } from './points';

const realPoints = parsePointsFile(
  JSON.parse(readFileSync(new URL('./points.cfr170-24.json', import.meta.url), 'utf8')) as unknown,
);

const requirements = [
  { id: 'AC.L2-3.1.1', type: 'basic' },
  { id: 'AC.L2-3.1.5', type: 'derived' },
  { id: 'AC.L2-3.1.6', type: 'derived' },
  { id: 'IA.L2-3.5.1', type: 'basic' },
  { id: 'IA.L2-3.5.3', type: 'derived' },
  { id: 'CA.L2-3.12.4', type: 'basic' },
] as const;

function smallFile(): PointsFile {
  return {
    source: {
      title: '32 CFR 170.24',
      url: 'https://www.law.cornell.edu/cfr/text/32/170.24',
      retrieved: '2026-11-23',
    },
    lists: [
      { points: 5, type: 'basic', citation: 'c5b', ids: ['AC .L2-3.1.1', 'IA-L2-3.5.1'] },
      { points: 3, type: 'derived', citation: 'c3d', ids: ['AC .L2- 3.1.5'] },
    ],
    remaining: { points: 1, type: 'derived', citation: 'c1' },
    partialCredit: [
      {
        id: 'IA.L2-3.5.3',
        points: 5,
        deduction: 3,
        label: 'MFA covers remote and privileged users only',
        citation: 'cp',
      },
    ],
    prerequisites: [{ id: 'CA.L2-3.12.4', citation: 'cpre' }],
  };
}

describe('points', () => {
  it('normalizes and validates point lists', () => {
    expect(normalizePracticeId('IA-L2-3.5.1')).toBe('IA.L2-3.5.1');
    expect(normalizePracticeId('AC .L2- 3.1.19')).toBe('AC.L2-3.1.19');
    expect(normalizePracticeId('SC.L2-3.13.11')).toBe('SC.L2-3.13.11');
    expect(() => normalizePracticeId('AC-3.1.1')).toThrow(/AC-3\.1\.1/);

    const scoring = assignScoring(requirements, smallFile());
    expect(scoring.get('IA.L2-3.5.1')).toEqual({
      kind: 'points',
      points: 5,
      citation: 'c5b',
      partialCredit: null,
    });
    expect(scoring.get('AC.L2-3.1.5')).toEqual({
      kind: 'points',
      points: 3,
      citation: 'c3d',
      partialCredit: null,
    });
    expect(scoring.get('AC.L2-3.1.6')).toEqual({
      kind: 'points',
      points: 1,
      citation: 'c1',
      partialCredit: null,
    });
    expect(scoring.get('IA.L2-3.5.3')).toEqual({
      kind: 'points',
      points: 5,
      citation: 'cp',
      partialCredit: {
        deduction: 3,
        label: 'MFA covers remote and privileged users only',
        citation: 'cp',
      },
    });
    expect(scoring.get('CA.L2-3.12.4')).toEqual({ kind: 'prerequisite', citation: 'cpre' });
    expect(scoring.size).toBe(requirements.length);

    const twice = smallFile();
    twice.lists[1]?.ids.push('IA.L2-3.5.1');
    expect(() => assignScoring(requirements, twice)).toThrow(
      /IA\.L2-3\.5\.1 is in two point lists/,
    );

    const twiceAcrossKinds = smallFile();
    twiceAcrossKinds.prerequisites.push({ id: 'IA.L2-3.5.3', citation: 'x' });
    expect(() => assignScoring(requirements, twiceAcrossKinds)).toThrow(
      /IA\.L2-3\.5\.3 is in two point lists/,
    );

    const unknown = smallFile();
    unknown.lists[0]?.ids.push('PE.L2-3.10.1');
    expect(() => assignScoring(requirements, unknown)).toThrow(
      /PE\.L2-3\.10\.1 is not in the catalog/,
    );
  });

  it('refuses a list whose basic or derived label disagrees with the catalog', () => {
    const wrongType = smallFile();
    wrongType.lists[1]?.ids.push('IA.L2-3.5.1');
    wrongType.lists[0]?.ids.splice(1, 1);
    expect(() => assignScoring(requirements, wrongType)).toThrow(/IA\.L2-3\.5\.1 is basic/);

    const basicLeftOver = smallFile();
    basicLeftOver.lists[0]?.ids.splice(1, 1);
    expect(() => assignScoring(requirements, basicLeftOver)).toThrow(
      /IA\.L2-3\.5\.1 is basic but is on no point list/,
    );
  });

  it('transcribes 32 CFR 170.24(c)(2) as the regulation lists it', () => {
    const sizes = realPoints.lists.map(
      (l) => `${String(l.points)}/${l.type}/${String(l.ids.length)}`,
    );
    expect(sizes).toEqual(['5/basic/23', '5/derived/19', '3/basic/7', '3/derived/7']);
    expect(realPoints.partialCredit.map((p) => [p.id, p.label])).toEqual([
      ['IA.L2-3.5.3', 'MFA covers remote and privileged users only'],
      ['SC.L2-3.13.11', 'Encryption employed but not FIPS-validated'],
    ]);
    expect(realPoints.prerequisites.map((p) => p.id)).toEqual(['CA.L2-3.12.4']);
    const citations = [
      ...realPoints.lists.map((l) => l.citation),
      realPoints.remaining.citation,
      ...realPoints.partialCredit.map((p) => p.citation),
      ...realPoints.prerequisites.map((p) => p.citation),
    ];
    for (const c of citations) expect(c).toMatch(/^32 CFR 170\.24\(c\)\(2\)/);
    expect(realPoints.source.url).toBe('https://www.law.cornell.edu/cfr/text/32/170.24');
    expect(realPoints.source.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects a malformed points file', () => {
    expect(() => parsePointsFile({ ...smallFile(), remaining: { points: 2 } })).toThrow(
      /points file/,
    );
  });
});
