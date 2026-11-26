// The dependency audit gate CI runs: `node scripts/audit-gate.ts [--dir <path>] [--expect-findings]`.
// It runs `pnpm audit --audit-level high --json` and decides from the JSON, not pnpm's exit code:
// a high or critical advisory fails unless audit-allowlist.json excuses it until a date, and
// anything it can't read (not JSON, a network error) fails closed.
// Node 24 runs this file directly (type stripping), so it uses `node:` imports only.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AllowlistEntry {
  /** The advisory's GHSA id (`GHSA-xxxx-xxxx-xxxx`) or its numeric npm id. */
  id: string;
  reason: string;
  /** The last UTC day the entry counts, `YYYY-MM-DD`. */
  until: string;
}

/** `findings`: high or critical advisories not excused. `error`: the gate couldn't decide. */
export type Verdict = 'pass' | 'findings' | 'error';

export interface GateResult {
  verdict: Verdict;
  failures: string[];
  warnings: string[];
}

export interface AuditRun {
  stdout: string;
  status: number | null;
}

export interface GateDeps {
  runAudit: (dir: string, args: string[]) => AuditRun;
  /** The text of audit-allowlist.json. */
  readAllowlist: () => string;
  exists: (path: string) => boolean;
  /** Today's UTC date, `YYYY-MM-DD`. */
  today: () => string;
  log: (line: string) => void;
  warn: (line: string) => void;
}

export interface GateArgs {
  dir: string;
  expectFindings: boolean;
}

/** An allowlist entry may run at most this many days past today. */
export const MAX_ALLOWLIST_DAYS = 30;

const FAILING = new Set(['high', 'critical']);
const PASSING = new Set(['moderate', 'low', 'info']);
const DAY_MS = 86_400_000;

interface Advisory {
  id?: unknown;
  github_advisory_id?: unknown;
  severity?: unknown;
  module_name?: unknown;
  title?: unknown;
  url?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(failure: string): GateResult {
  return { verdict: 'error', failures: [failure], warnings: [] };
}

/** Milliseconds since the epoch for a real `YYYY-MM-DD` UTC date, or null. */
function utcDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) return null;
  return time;
}

/** The entries, or the reason the allowlist can't be trusted. */
function readEntries(allowlist: unknown, today: string): AllowlistEntry[] | string {
  if (!Array.isArray(allowlist)) return 'audit-allowlist.json must be a JSON list';
  const todayTime = utcDay(today);
  if (todayTime === null) return `today is not a YYYY-MM-DD date: ${today}`;
  const entries: AllowlistEntry[] = [];
  for (const [index, raw] of (allowlist as unknown[]).entries()) {
    const where = `audit-allowlist.json entry ${String(index)}`;
    if (!isRecord(raw)) return `${where} is not an object`;
    const { id, reason, until } = raw;
    if (typeof id !== 'string' || id.trim() === '') return `${where} has no id`;
    if (typeof reason !== 'string' || reason.trim() === '') return `${where} (${id}) has no reason`;
    if (typeof until !== 'string') return `${where} (${id}) has no until date`;
    const untilTime = utcDay(until);
    if (untilTime === null) return `${where} (${id}) until is not a real YYYY-MM-DD date: ${until}`;
    if ((untilTime - todayTime) / DAY_MS > MAX_ALLOWLIST_DAYS) {
      return `${where} (${id}) until ${until} is more than ${String(MAX_ALLOWLIST_DAYS)} days ahead`;
    }
    entries.push({ id, reason, until });
  }
  return entries;
}

function advisoryIds(advisory: Advisory, key: string): string[] {
  const ids = [key];
  if (typeof advisory.id === 'string' || typeof advisory.id === 'number') {
    ids.push(String(advisory.id));
  }
  if (typeof advisory.github_advisory_id === 'string') ids.push(advisory.github_advisory_id);
  return ids;
}

function describeAdvisory(advisory: Advisory, key: string, severity: string): string {
  const id = typeof advisory.github_advisory_id === 'string' ? advisory.github_advisory_id : key;
  const name = typeof advisory.module_name === 'string' ? advisory.module_name : '?';
  const title = typeof advisory.title === 'string' ? advisory.title : '';
  const url = typeof advisory.url === 'string' ? ` ${advisory.url}` : '';
  return `${severity} ${id} in ${name}: ${title}${url}`;
}

/** Decides from `pnpm audit --json` output, the parsed allowlist and today's UTC date. */
export function evaluateAudit(output: string, allowlist: unknown, today: string): GateResult {
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    const start = output.trim().slice(0, 200);
    return errorResult(`pnpm audit did not print JSON: ${start === '' ? '(nothing)' : start}`);
  }
  if (isRecord(report) && isRecord(report.error)) {
    const { code, message } = report.error;
    return errorResult(`pnpm audit failed: ${String(code)} ${String(message)}`);
  }
  if (!isRecord(report) || !isRecord(report.advisories)) {
    return errorResult('pnpm audit printed JSON without an advisories map');
  }

  const entries = readEntries(allowlist, today);
  if (typeof entries === 'string') return errorResult(entries);

  const failures: string[] = [];
  const warnings: string[] = [];
  const live = entries.filter((item) => item.until >= today);
  for (const item of entries) {
    if (item.until < today) {
      failures.push(`allowlist entry ${item.id} expired ${item.until}: fix it or renew the entry`);
    }
  }

  const used = new Set<string>();
  for (const [key, value] of Object.entries(report.advisories)) {
    if (!isRecord(value)) return errorResult(`advisory ${key} is not an object`);
    const advisory = value as Advisory;
    const severity = typeof advisory.severity === 'string' ? advisory.severity.toLowerCase() : '';
    if (PASSING.has(severity)) continue;
    if (!FAILING.has(severity)) {
      return errorResult(`advisory ${key} has an unknown severity: ${String(advisory.severity)}`);
    }
    const ids = advisoryIds(advisory, key);
    const excuse = live.find((item) => ids.includes(item.id));
    if (excuse === undefined) {
      failures.push(describeAdvisory(advisory, key, severity));
    } else {
      used.add(excuse.id);
    }
  }
  for (const item of live) {
    if (!used.has(item.id)) {
      warnings.push(`allowlist entry ${item.id} matches no advisory: remove it`);
    }
  }
  return { verdict: failures.length > 0 ? 'findings' : 'pass', failures, warnings };
}

/** 0 or 1. With --expect-findings, 0 only when the gate failed on findings. */
export function gateExitCode(verdict: Verdict, expectFindings: boolean): number {
  if (expectFindings) return verdict === 'findings' ? 0 : 1;
  return verdict === 'pass' ? 0 : 1;
}

export function parseGateArgs(argv: string[]): GateArgs {
  const args: GateArgs = { dir: '.', expectFindings: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--expect-findings') {
      args.expectFindings = true;
    } else if (arg === '--dir') {
      const dir = argv[index + 1];
      if (dir === undefined || dir.startsWith('--')) throw new Error('--dir needs a path');
      args.dir = dir;
      index += 1;
    } else {
      throw new Error(`unknown argument ${String(arg)}`);
    }
  }
  return args;
}

/**
 * The audit command. A folder without its own pnpm-workspace.yaml (the fixture) is audited as its
 * own project: otherwise pnpm finds the repo's workspace above it and audits that instead.
 */
export function auditArgs(isWorkspaceRoot: boolean): string[] {
  const args = ['audit', '--audit-level', 'high', '--json'];
  return isWorkspaceRoot ? args : [...args, '--ignore-workspace'];
}

function decide(dir: string, deps: GateDeps): GateResult {
  // Without its own lockfile, pnpm would quietly audit a parent workspace instead.
  if (!deps.exists(join(dir, 'pnpm-lock.yaml'))) return errorResult(`no pnpm-lock.yaml in ${dir}`);
  let allowlist: unknown;
  try {
    allowlist = JSON.parse(deps.readAllowlist());
  } catch (error) {
    return errorResult(`audit-allowlist.json is not JSON: ${(error as Error).message}`);
  }
  const run = deps.runAudit(dir, auditArgs(deps.exists(join(dir, 'pnpm-workspace.yaml'))));
  return evaluateAudit(run.stdout, allowlist, deps.today());
}

/** Runs the gate and returns the exit code. */
export function runGate(argv: string[], deps: GateDeps): number {
  let args: GateArgs;
  try {
    args = parseGateArgs(argv);
  } catch (error) {
    deps.log(`audit gate: ${(error as Error).message}`);
    return 1;
  }
  const dir = resolve(args.dir);
  const label = args.expectFindings ? 'audit gate (expect findings)' : 'audit gate';
  const result = decide(dir, deps);
  for (const warning of result.warnings) deps.warn(`${label}: warning: ${warning}`);
  for (const failure of result.failures) deps.log(`${label}: ${failure}`);
  const code = gateExitCode(result.verdict, args.expectFindings);
  deps.log(`${label}: ${result.verdict} in ${dir}, exit ${String(code)}`);
  return code;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How to start pnpm without a shell: the entry file pnpm set in `npm_execpath` when it launched
 * this script, else corepack's pnpm entry next to Node (on Windows the only other pnpm is a .cmd,
 * which needs a shell), else `pnpm` on PATH (CI, after `corepack enable`).
 */
export function pnpmLauncher(
  env: NodeJS.ProcessEnv,
  execPath: string,
  exists: (path: string) => boolean,
): { command: string; prefix: string[] } {
  const entry = env.npm_execpath;
  if (entry !== undefined && entry !== '') {
    return /.[cm]?js$/i.test(entry)
      ? { command: execPath, prefix: [entry] }
      : { command: entry, prefix: [] };
  }
  const corepackPnpm = join(dirname(execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js');
  if (exists(corepackPnpm)) return { command: execPath, prefix: [corepackPnpm] };
  return { command: 'pnpm', prefix: [] };
}

/** The real deps. */
export function realDeps(): GateDeps {
  const pnpm = pnpmLauncher(process.env, process.execPath, existsSync);
  return {
    runAudit: (dir, args) => {
      const child = spawnSync(pnpm.command, [...pnpm.prefix, ...args], {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: 1 << 26,
      });
      if (child.error !== undefined)
        process.stderr.write(`${child.error.message}
`);
      if (child.stderr !== '') process.stderr.write(child.stderr);
      return { stdout: child.stdout, status: child.status };
    },
    readAllowlist: () => readFileSync(join(repoRoot, 'audit-allowlist.json'), 'utf8'),
    exists: existsSync,
    today: () => new Date().toISOString().slice(0, 10),
    log: (line) => {
      console.log(line);
    },
    warn: (line) => {
      console.warn(line);
    },
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = runGate(process.argv.slice(2), realDeps());
}
