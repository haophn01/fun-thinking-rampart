// Builds the bundled password blocklist:
// `node scripts/build-blocklist.ts <file> [--out <path>] [--source <url>]`.
// <file> is a downloaded copy of the upstream list, kept outside the repo. It is read as bytes and
// never executed. The script keeps lines of BLOCKLIST_MIN_LENGTH to BLOCKLIST_MAX_LENGTH UTF-16
// units (what the password policy could otherwise accept), drops lines with control characters,
// invalid UTF-8 or U+FFFD, lowercases, dedupes and sorts, then writes
// `{ source, sha256, count, passwords }`. The same input always gives the same bytes.
// Node 24 runs this file directly (type stripping), so it uses `node:` imports only.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The password policy's bounds (`passwordSchema` in the api contract). */
export const BLOCKLIST_MIN_LENGTH = 12;
export const BLOCKLIST_MAX_LENGTH = 128;

/** The upstream list, pinned to a SecLists commit. `SOURCES.md` records the rest. */
export const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/danielmiessler/SecLists/c205c36a445bff37f8e58a9ec829105cd4975c58/Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT = join(
  repoRoot,
  'apps',
  'api',
  'src',
  'auth',
  'blocklist',
  'common-passwords.json',
);

export interface BuildArgs {
  file: string;
  out: string;
  source: string;
}

const USAGE = 'usage: node scripts/build-blocklist.ts <file> [--out <path>] [--source <url>]';
// C0 controls, DEL, C1 controls and the replacement character.
// eslint-disable-next-line no-control-regex
const UNWANTED = /[\u0000-\u001f\u007f-\u009f\ufffd]/u;
const NEWLINE = 0x0a;
const BOM = [0xef, 0xbb, 0xbf];

/** The input split into lines (LF or CRLF), without a final empty line or a leading BOM. */
function splitLines(input: Uint8Array): Uint8Array[] {
  let start = BOM.every((byte, i) => input[i] === byte) ? BOM.length : 0;
  const out: Uint8Array[] = [];
  for (let i = start; i <= input.length; i++) {
    if (i === input.length || input[i] === NEWLINE) {
      let end = i;
      if (end > start && input[end - 1] === 0x0d) end--;
      if (i < input.length || end > start) out.push(input.subarray(start, end));
      start = i + 1;
    }
  }
  return out;
}

/** The number of lines in the input, as the upstream count reads them. */
export function countLines(input: Uint8Array): number {
  return splitLines(input).length;
}

/** The kept entries: in bounds, clean, lowercased, unique and sorted by UTF-16 code unit. */
export function filterPasswords(input: Uint8Array): string[] {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const kept = new Set<string>();
  for (const raw of splitLines(input)) {
    let line: string;
    try {
      line = decoder.decode(raw);
    } catch {
      continue;
    }
    if (UNWANTED.test(line)) continue;
    const lower = line.toLowerCase();
    if (!inBounds(line) || !inBounds(lower)) continue;
    kept.add(lower);
  }
  return [...kept].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function inBounds(value: string): boolean {
  return value.length >= BLOCKLIST_MIN_LENGTH && value.length <= BLOCKLIST_MAX_LENGTH;
}

/** The JSON file's text: one entry per line, so a rebuild diffs line by line. */
export function buildBlocklist(input: Uint8Array, source: string): string {
  const passwords = filterPasswords(input);
  const sha256 = createHash('sha256').update(input).digest('hex');
  const head = `{"source":${JSON.stringify(source)},"sha256":"${sha256}","count":${String(passwords.length)},"passwords":[`;
  const body = passwords.map((p) => JSON.stringify(p)).join(',\n');
  return passwords.length === 0 ? `${head}]}\n` : `${head}\n${body}\n]}\n`;
}

export function parseBuildArgs(argv: string[]): BuildArgs {
  let file: string | undefined;
  let out = DEFAULT_OUT;
  let source = DEFAULT_SOURCE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--out' || arg === '--source') {
      const value = argv[++i];
      if (value === undefined) throw new Error(USAGE);
      if (arg === '--out') out = value;
      else source = value;
    } else if (arg.startsWith('--') || file !== undefined) {
      throw new Error(USAGE);
    } else {
      file = arg;
    }
  }
  if (file === undefined) throw new Error(USAGE);
  return { file, out, source };
}

function main(argv: string[]): number {
  let args: BuildArgs;
  try {
    args = parseBuildArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const input = readFileSync(args.file);
  const json = buildBlocklist(input, args.source);
  writeFileSync(args.out, json);
  const count = (JSON.parse(json) as { count: number }).count;
  console.log(`kept ${String(count)} of ${String(countLines(input))} lines; wrote ${args.out}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
