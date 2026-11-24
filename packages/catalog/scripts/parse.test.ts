import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareNistIds } from '../src/schema';
import { cleanPage, mergeSources, parseAssessmentText, parseRequirementText } from './parse';

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
