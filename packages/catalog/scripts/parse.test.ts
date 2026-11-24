import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../src/index';
import { compareNistIds } from '../src/schema';
import {
  runConvert,
  serializeCatalog,
  sha256Hex,
  verifyChecksum,
  type ConvertInputs,
  type SourcesFile,
} from './convert';
import { cleanPage, mergeSources, parseAssessmentText, parseRequirementText } from './parse';
import { parsePointsFile } from './points';

/** Fixture pages are separated by a `<<PAGE>>` line. */
function fixturePages(name: string): string[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n<<PAGE>>\n');
}

const r2Pages = fixturePages('sp800-171r2.excerpt.txt');
const aPages = fixturePages('sp800-171a.excerpt.txt');

describe('parse', () => {
  it('parses fixture excerpts', () => {
    // Page header and footnote footer are stripped.
    const page = cleanPage(r2Pages[1] ?? '');
    expect(page[0]).toBe('DISCUSSION');
    expect(page.join('\n')).not.toMatch(
      /PROTECTING CONTROLLED|CHAPTER THREE PAGE|free of charge|___/,
    );
    expect(page.join('\n')).not.toContain('23 Mobile devices');
    expect(page.at(-1)).toBe(
      'confidentiality of CUI on mobile devices and computing platforms. Container-based encryption',
    );

    const assessment = parseAssessmentText(aPages);
    expect(assessment.families).toEqual([
      { section: '3.1', name: 'Access Control' },
      { section: '3.4', name: 'Configuration Management' },
    ]);
    // Chapter two's worked example (3.1.3) and the appendix are not requirements.
    expect(assessment.requirements.map((r) => r.nistId)).toEqual([
      '3.1.1',
      '3.1.2',
      '3.1.9',
      '3.1.10',
      '3.1.15',
      '3.1.19',
      '3.4.1',
      '3.4.4',
    ]);
    const byId = new Map(assessment.requirements.map((r) => [r.nistId, r]));

    // A line-end hyphen joins without a space and keeps the hyphen.
    expect(byId.get('3.1.15')?.text).toBe(
      'Authorize remote execution of privileged commands and remote access to security-relevant information.',
    );
    expect(byId.get('3.1.1')?.objectives.map((o) => o.id)).toEqual([
      '3.1.1[a]',
      '3.1.1[b]',
      '3.1.1[c]',
      '3.1.1[d]',
      '3.1.1[e]',
      '3.1.1[f]',
    ]);
    // An objective list that runs across a page break.
    expect(byId.get('3.1.9')?.objectives).toEqual([
      {
        id: '3.1.9[a]',
        text: 'privacy and security notices required by CUI-specified rules are identified, consistent, and associated with the specific CUI category.',
      },
      { id: '3.1.9[b]', text: 'privacy and security notices are displayed.' },
    ]);
    // A requirement with one unlettered determination statement gets [a].
    expect(byId.get('3.4.4')?.objectives).toEqual([
      {
        id: '3.4.4[a]',
        text: 'the security impact of changes to the system is analyzed prior to implementation.',
      },
    ]);

    const requirements = parseRequirementText(r2Pages);
    expect(requirements.requirements.map((r) => `${r.nistId}:${r.type}`)).toEqual([
      '3.1.1:basic',
      '3.1.2:basic',
      '3.1.9:derived',
      '3.1.10:derived',
      '3.1.15:derived',
      '3.1.19:derived',
      '3.4.1:basic',
      '3.4.4:derived',
    ]);
    const r2ById = new Map(requirements.requirements.map((r) => [r.nistId, r]));
    // The footnote mark after the period is dropped; a sidebar heading ends the statement.
    expect(r2ById.get('3.1.19')?.text).toBe(
      'Encrypt CUI on mobile devices and mobile computing platforms.',
    );
    expect(r2ById.get('3.1.2')?.text).toBe(
      'Limit system access to the types of transactions and functions that authorized users are permitted to execute.',
    );
    // A statement followed by a page break ends at the DISCUSSION on the next page.
    expect(r2ById.get('3.4.4')?.text).toBe(
      'Analyze the security impact of changes prior to implementation.',
    );

    const merged = mergeSources(requirements, assessment);
    expect(merged.requirements.map((r) => r.nistId)).toEqual(
      assessment.requirements.map((r) => r.nistId),
    );
    expect(merged.requirements.find((r) => r.nistId === '3.4.4')).toMatchObject({
      type: 'derived',
      family: 'CM',
    });

    // Numeric order: 3.1.10 sorts after 3.1.9.
    expect(['3.1.10', '3.10.1', '3.1.9', '3.2.1'].sort(compareNistIds)).toEqual([
      '3.1.9',
      '3.1.10',
      '3.2.1',
      '3.10.1',
    ]);
    const shuffled = mergeSources(
      { ...requirements, requirements: [...requirements.requirements].reverse() },
      { ...assessment, requirements: [...assessment.requirements].reverse() },
    );
    expect(shuffled.requirements.map((r) => r.nistId)).toEqual(
      merged.requirements.map((r) => r.nistId),
    );
  });

  it('refuses or reports sources that disagree', () => {
    const assessment = parseAssessmentText(aPages);
    const requirements = parseRequirementText(r2Pages);

    const missing = { ...assessment, requirements: assessment.requirements.slice(1) };
    expect(() => mergeSources(requirements, missing)).toThrow(
      /3\.1\.1 is in SP 800-171 but not in SP 800-171A/,
    );

    const reworded = {
      ...requirements,
      requirements: requirements.requirements.map((r) =>
        r.nistId === '3.1.9' ? { ...r, text: 'Provide notices.' } : r,
      ),
    };
    // A wording difference is reported, not resolved: the converter needs an override for it.
    expect(mergeSources(reworded, assessment).textDifferences).toEqual([
      {
        nistId: '3.1.9',
        sp800171: 'Provide notices.',
        sp800171a: 'Provide privacy and security notices consistent with applicable CUI rules.',
      },
    ]);
    expect(mergeSources(requirements, assessment).textDifferences).toEqual([]);
  });
});

const encoder = new TextEncoder();
const fixtureBytes = {
  r2: encoder.encode(
    readFileSync(new URL('./fixtures/sp800-171r2.excerpt.txt', import.meta.url), 'utf8'),
  ),
  a: encoder.encode(
    readFileSync(new URL('./fixtures/sp800-171a.excerpt.txt', import.meta.url), 'utf8'),
  ),
};
const fixturePoints = parsePointsFile(
  JSON.parse(
    readFileSync(new URL('./fixtures/points.excerpt.json', import.meta.url), 'utf8'),
  ) as unknown,
);

function fixtureSources(): SourcesFile {
  return {
    catalogVersion: '1.0.0',
    requirements: {
      title: 'SP 800-171 Rev. 2 (excerpt)',
      url: 'https://example.test/NIST.SP.800-171r2.pdf',
      file: 'NIST.SP.800-171r2.pdf',
      sha256: sha256Hex(fixtureBytes.r2),
      retrieved: '2026-11-23',
    },
    assessment: {
      title: 'SP 800-171A (excerpt)',
      url: 'https://example.test/NIST.SP.800-171A.pdf',
      file: 'NIST.SP.800-171A.pdf',
      sha256: sha256Hex(fixtureBytes.a),
      retrieved: '2026-11-23',
    },
  };
}

/** Runs the converter on the fixtures; the "PDF" bytes are the fixture text, split into pages. */
async function convertFixtures(overrides: Partial<ConvertInputs> = {}) {
  const writes: string[] = [];
  const catalog = await runConvert({
    sources: fixtureSources(),
    points: fixturePoints,
    overrides: { overrides: [] },
    readSource: (pin) =>
      Promise.resolve(pin.file.endsWith('r2.pdf') ? fixtureBytes.r2 : fixtureBytes.a),
    extractPages: (bytes) =>
      Promise.resolve(new TextDecoder().decode(bytes).replace(/\r\n/g, '\n').split('\n<<PAGE>>\n')),
    writeOutput: (json) => {
      writes.push(json);
      return Promise.resolve();
    },
    ...overrides,
  });
  return { catalog, writes };
}

describe('convert', () => {
  it('convert guards', async () => {
    // A checksum mismatch throws before anything is written.
    const tampered = fixtureSources();
    tampered.assessment.sha256 = 'f'.repeat(64);
    const writes: string[] = [];
    await expect(
      convertFixtures({
        sources: tampered,
        writeOutput: (json) => {
          writes.push(json);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/NIST\.SP\.800-171A\.pdf: SHA-256 .* does not match the pinned f{64}/);
    expect(writes).toEqual([]);

    // Same inputs, byte-identical JSON, which parses back as a valid catalog.
    const first = await convertFixtures();
    const second = await convertFixtures();
    expect(first.writes).toHaveLength(1);
    expect(second.writes).toEqual(first.writes);
    expect(first.writes[0]).toBe(serializeCatalog(first.catalog));
    expect(first.writes[0]?.endsWith('}\n')).toBe(true);
    expect(parseCatalog(JSON.parse(first.writes[0] ?? '') as unknown)).toEqual(first.catalog);
    expect(first.catalog.sources.map((s) => s.sha256)).toEqual([
      sha256Hex(fixtureBytes.r2),
      sha256Hex(fixtureBytes.a),
    ]);

    // An override for an unknown id, or one that changes nothing, throws.
    await expect(
      convertFixtures({
        overrides: { overrides: [{ id: '3.1.1[z]', text: 'x.', reason: 'test' }] },
      }),
    ).rejects.toThrow(/override 3\.1\.1\[z\] matches no requirement or objective/);
    await expect(
      convertFixtures({
        overrides: {
          overrides: [
            { id: '3.1.9[b]', text: 'privacy and security notices are displayed.', reason: 'test' },
          ],
        },
      }),
    ).rejects.toThrow(/override 3\.1\.9\[b\] does not change the parsed text/);
    await expect(
      convertFixtures({
        overrides: {
          overrides: [
            { id: 'AC.L2-3.1.9', text: 'Changed.', reason: 'test' },
            { id: 'AC.L2-3.1.9', text: 'Changed again.', reason: 'test' },
          ],
        },
      }),
    ).rejects.toThrow(/override AC\.L2-3\.1\.9 is listed twice/);
  });

  it('applies overrides and settles wording differences only through one', async () => {
    const fixed = await convertFixtures({
      overrides: {
        overrides: [{ id: '3.1.9[b]', text: 'notices are displayed.', reason: 'test' }],
      },
    });
    const req = fixed.catalog.requirements.find((r) => r.id === 'AC.L2-3.1.9');
    expect(req?.objectives[1]).toEqual({ id: '3.1.9[b]', text: 'notices are displayed.' });

    // The fixture SP 800-171 words 3.1.10 differently: refused until an override picks the text.
    const reworded = new TextDecoder()
      .decode(fixtureBytes.r2)
      .replace(
        'to prevent access and viewing of data after a',
        'to prevent access to and viewing of data after a',
      );
    const rewordedBytes = encoder.encode(reworded);
    const sources = fixtureSources();
    sources.requirements.sha256 = sha256Hex(rewordedBytes);
    const readSource = (pin: { file: string }) =>
      Promise.resolve(pin.file.endsWith('r2.pdf') ? rewordedBytes : fixtureBytes.a);
    await expect(convertFixtures({ sources, readSource })).rejects.toThrow(
      /AC\.L2-3\.1\.10: SP 800-171 and SP 800-171A word the statement differently/,
    );
    const settled = await convertFixtures({
      sources,
      readSource,
      overrides: {
        overrides: [
          {
            id: 'AC.L2-3.1.10',
            text: 'Use session lock with pattern-hiding displays to prevent access to and viewing of data after a period of inactivity.',
            reason: 'test',
          },
        ],
      },
    });
    expect(settled.catalog.requirements.find((r) => r.id === 'AC.L2-3.1.10')?.text).toContain(
      'access to and',
    );
  });

  it('refuses to run without a pinned checksum and names the hash to pin', async () => {
    const unpinned = fixtureSources();
    unpinned.requirements.sha256 = null;
    await expect(convertFixtures({ sources: unpinned })).rejects.toThrow(
      `NIST.SP.800-171r2.pdf has no pinned SHA-256; pin ${sha256Hex(fixtureBytes.r2)}`,
    );
    expect(() => {
      verifyChecksum(fixtureSources().requirements, fixtureBytes.r2);
    }).not.toThrow();
  });
});
