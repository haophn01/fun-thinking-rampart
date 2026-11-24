import { compareNistIds, FAMILY_CODES, FAMILY_SECTIONS, sectionOf } from '../src/schema';
import type { FamilyCode } from '../src/types';

/**
 * Text parsing for the two NIST PDFs, after pdfjs has turned each page into lines.
 *
 * - SP 800-171 Rev. 2 gives each requirement's basic/derived type (from the headings
 *   inside each family) and its statement.
 * - SP 800-171A gives the same statement plus the lettered assessment objectives.
 *
 * Both are read only between the first "3.1 ACCESS CONTROL" heading and "APPENDIX A".
 */

export interface FamilyHeading {
  section: string;
  name: string;
}
export interface ParsedObjective {
  id: string;
  text: string;
}
export interface AssessmentRequirement {
  nistId: string;
  text: string;
  objectives: ParsedObjective[];
}
export interface StatementRequirement {
  nistId: string;
  type: 'basic' | 'derived';
  text: string;
}
export interface ParsedSource<T> {
  families: FamilyHeading[];
  requirements: T[];
}
export interface MergedRequirement {
  nistId: string;
  family: FamilyCode;
  type: 'basic' | 'derived';
  text: string;
  objectives: ParsedObjective[];
}
export interface MergedFamily extends FamilyHeading {
  code: FamilyCode;
}
/** A statement the two PDFs word differently; the converter refuses it unless an override settles it. */
export interface TextDifference {
  nistId: string;
  sp800171: string;
  sp800171a: string;
}
export interface MergedCatalogText {
  families: MergedFamily[];
  requirements: MergedRequirement[];
  textDifferences: TextDifference[];
}

const PAGE_CHROME = [
  /^SP 800-171, REVISION 2 PROTECTING CONTROLLED UNCLASSIFIED INFORMATION$/,
  /^NIST SP 800-171A ASSESSING SECURITY REQUIREMENTS FOR CONTROLLED UNCLASSIFIED INFORMATION$/,
  /^_{10,}$/,
  /^(CHAPTER [A-Z]+|APPENDIX [A-Z]) PAGE [0-9]+$/,
  /^This publication is available free of charge from: https:\/\/doi\.org\/10\.6028\/NIST\.SP\.800-171(r2|A)$/,
];
/** A footnote at the foot of a page: "23 Mobile devices and ...". */
const FOOTNOTE = /^[0-9]{1,3} [A-Z(“"[]/;
const FAMILY_HEADING = /^(3\.[0-9]+) ([A-Z][A-Z ,-]*[A-Z])$/;
const CHAPTER_START = '3.1 ACCESS CONTROL';
const CHAPTER_END = 'APPENDIX A';

/** Page header lines and the footnotes at the foot of the page are removed; blank lines too. */
export function cleanPage(page: string): string[] {
  const lines = page
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !PAGE_CHROME.some((re) => re.test(line)));
  const footnoteAt = lines.findIndex((line) => FOOTNOTE.test(line));
  return footnoteAt === -1 ? lines : lines.slice(0, footnoteAt);
}

/** Joins wrapped lines. A line ending in a hyphen joins the next with no space, keeping the hyphen. */
export function joinLines(lines: readonly string[]): string {
  let text = '';
  for (const line of lines) {
    if (text === '') text = line;
    else if (/[A-Za-z]-$/.test(text) && /^[A-Za-z]/.test(line)) text += line;
    else text += ` ${line}`;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function chapterThree(pages: readonly string[]): string[] {
  const lines = pages.flatMap(cleanPage);
  const start = lines.indexOf(CHAPTER_START);
  if (start === -1) throw new Error(`no "${CHAPTER_START}" heading found`);
  const end = lines.indexOf(CHAPTER_END, start);
  return lines.slice(start, end === -1 ? undefined : end);
}

const SMALL_WORDS = new Set(['and', 'of', 'the', 'for']);
function titleCase(heading: string): string {
  return heading
    .toLowerCase()
    .split(' ')
    .map((word, i) =>
      i > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

const KNOWN_SECTIONS = new Set<string>(Object.values(FAMILY_SECTIONS));
function familyHeading(line: string): FamilyHeading | undefined {
  const match = FAMILY_HEADING.exec(line);
  if (!match?.[1] || !match[2] || !KNOWN_SECTIONS.has(match[1])) return undefined;
  return { section: match[1], name: titleCase(match[2]) };
}

const SECURITY_REQUIREMENT = /^(3\.[0-9]+\.[0-9]+) SECURITY REQUIREMENT$/;
const OBJECTIVE = /^(3\.[0-9]+\.[0-9]+)\[([a-z]+)\] (.+)$/;

/** Parses SP 800-171A chapter three: statements and their lettered objectives. */
export function parseAssessmentText(pages: readonly string[]): ParsedSource<AssessmentRequirement> {
  const families: FamilyHeading[] = [];
  const requirements: AssessmentRequirement[] = [];
  let mode: 'none' | 'statement' | 'intro' | 'objectives' | 'methods' = 'none';
  let current:
    | { nistId: string; statement: string[]; objectives: { id: string; lines: string[] }[] }
    | undefined;

  const finish = () => {
    if (!current) return;
    const { nistId } = current;
    const objectives = current.objectives.map((o) => ({ id: o.id, text: joinLines(o.lines) }));
    objectives.forEach((o, i) => {
      const expected = `${nistId}[${String.fromCharCode(97 + i)}]`;
      if (o.id !== expected)
        throw new Error(`${nistId}: expected objective ${expected}, found ${o.id}`);
    });
    requirements.push({ nistId, text: joinLines(current.statement), objectives });
    current = undefined;
  };

  for (const line of chapterThree(pages)) {
    const family = familyHeading(line);
    if (family) {
      finish();
      families.push(family);
      mode = 'none';
      continue;
    }
    const start = SECURITY_REQUIREMENT.exec(line);
    if (start?.[1]) {
      finish();
      const nistId = start[1];
      if (sectionOf(nistId) !== families.at(-1)?.section) {
        throw new Error(`${nistId} appears outside its family heading`);
      }
      if (requirements.some((r) => r.nistId === nistId)) throw new Error(`${nistId} appears twice`);
      current = { nistId, statement: [], objectives: [] };
      mode = 'statement';
      continue;
    }
    if (!current) continue;
    if (line === 'ASSESSMENT OBJECTIVE') {
      mode = 'intro';
      continue;
    }
    if (line === 'POTENTIAL ASSESSMENT METHODS AND OBJECTS') {
      mode = 'methods';
      continue;
    }
    switch (mode) {
      case 'statement':
        current.statement.push(line);
        break;
      case 'intro':
        if (line === 'Determine if:') {
          mode = 'objectives';
        } else if (line.startsWith('Determine if ')) {
          // One unlettered determination statement: it becomes objective [a].
          current.objectives.push({
            id: `${current.nistId}[a]`,
            lines: [line.slice('Determine if '.length)],
          });
          mode = 'objectives';
        } else {
          throw new Error(`${current.nistId}: unexpected text before its objectives: ${line}`);
        }
        break;
      case 'objectives': {
        const objective = OBJECTIVE.exec(line);
        if (objective?.[1] && objective[3]) {
          if (objective[1] !== current.nistId) {
            throw new Error(
              `objective ${objective[1]}[${objective[2] ?? ''}] found under ${current.nistId}`,
            );
          }
          current.objectives.push({
            id: `${objective[1]}[${objective[2] ?? ''}]`,
            lines: [objective[3]],
          });
        } else {
          const last = current.objectives.at(-1);
          if (!last) throw new Error(`${current.nistId}: text before the first objective: ${line}`);
          last.lines.push(line);
        }
        break;
      }
      case 'methods':
      case 'none':
        break;
    }
  }
  finish();
  return { families, requirements };
}

const TYPE_HEADINGS: Record<string, 'basic' | 'derived'> = {
  'Basic Security Requirements': 'basic',
  'Derived Security Requirements': 'derived',
};
const STATEMENT_START = /^(3\.[0-9]+\.[0-9]+) ([A-Z].*)$/;
/** An all-capitals line, such as "DISCUSSION" or a sidebar title, ends a statement. */
const CAPS_LINE = /^[A-Z][A-Z ,'’()/-]+$/;
/** Footnote marks printed after a statement's final punctuation: "platforms.23", "accounts.24 25". */
const FOOTNOTE_MARKS = /([.;:])[0-9]{1,2}( [0-9]{1,2})*$/;

/** Parses SP 800-171 Rev. 2 chapter three: each statement and its basic/derived type. */
export function parseRequirementText(pages: readonly string[]): ParsedSource<StatementRequirement> {
  const families: FamilyHeading[] = [];
  const requirements: StatementRequirement[] = [];
  let type: 'basic' | 'derived' | undefined;
  let current: { nistId: string; type: 'basic' | 'derived'; lines: string[] } | undefined;

  const finish = () => {
    if (!current) return;
    const text = joinLines(current.lines).replace(FOOTNOTE_MARKS, '$1');
    requirements.push({ nistId: current.nistId, type: current.type, text });
    current = undefined;
  };

  for (const line of chapterThree(pages)) {
    const family = familyHeading(line);
    if (family) {
      finish();
      families.push(family);
      type = undefined;
      continue;
    }
    const heading = TYPE_HEADINGS[line];
    if (heading) {
      finish();
      type = heading;
      continue;
    }
    const start = STATEMENT_START.exec(line);
    const section = families.at(-1)?.section;
    const previous = requirements.at(-1)?.nistId;
    if (
      start?.[1] &&
      start[2] &&
      type &&
      sectionOf(start[1]) === section &&
      (current === undefined || compareNistIds(start[1], current.nistId) > 0) &&
      (previous === undefined || compareNistIds(start[1], previous) > 0)
    ) {
      finish();
      current = { nistId: start[1], type, lines: [start[2]] };
      continue;
    }
    if (!current) continue;
    if (CAPS_LINE.test(line)) finish();
    else current.lines.push(line);
  }
  finish();
  return { families, requirements };
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Joins the two sources: both must list the same families and requirements. Statement text
 * is taken from SP 800-171A, whose layout carries no footnote marks; wording that differs
 * from SP 800-171 is listed in `textDifferences`. Requirements come out in numeric NIST order.
 */
export function mergeSources(
  statements: ParsedSource<StatementRequirement>,
  assessment: ParsedSource<AssessmentRequirement>,
): MergedCatalogText {
  const familyKey = (f: FamilyHeading) => `${f.section} ${f.name}`;
  const r2Families = statements.families.map(familyKey).join(' | ');
  const aFamilies = assessment.families.map(familyKey).join(' | ');
  if (r2Families !== aFamilies) {
    throw new Error(
      `family headings differ: SP 800-171 [${r2Families}] vs SP 800-171A [${aFamilies}]`,
    );
  }

  const byId = new Map(assessment.requirements.map((r) => [r.nistId, r]));
  const r2Ids = new Set(statements.requirements.map((r) => r.nistId));
  for (const r of assessment.requirements) {
    if (!r2Ids.has(r.nistId))
      throw new Error(`${r.nistId} is in SP 800-171A but not in SP 800-171`);
  }

  const codeBySection = new Map<string, FamilyCode>(
    FAMILY_CODES.map((code) => [FAMILY_SECTIONS[code], code]),
  );
  const textDifferences: TextDifference[] = [];
  const requirements = statements.requirements.map((s): MergedRequirement => {
    const a = byId.get(s.nistId);
    if (!a) throw new Error(`${s.nistId} is in SP 800-171 but not in SP 800-171A`);
    if (normalize(a.text) !== normalize(s.text)) {
      textDifferences.push({ nistId: s.nistId, sp800171: s.text, sp800171a: a.text });
    }
    const family = codeBySection.get(sectionOf(s.nistId));
    if (!family) throw new Error(`${s.nistId} is in no known family`);
    return { nistId: s.nistId, family, type: s.type, text: a.text, objectives: a.objectives };
  });
  requirements.sort((x, y) => compareNistIds(x.nistId, y.nistId));

  const families = statements.families.map((f): MergedFamily => {
    const code = codeBySection.get(f.section);
    if (!code) throw new Error(`unknown family section ${f.section}`);
    return { ...f, code };
  });
  textDifferences.sort((x, y) => compareNistIds(x.nistId, y.nistId));
  return { families, requirements, textDifferences };
}
