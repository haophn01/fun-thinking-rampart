import type { Config } from '../config';

/** A rule `assertSafeStartup` enforces, with what the operator reads when it breaks. */
interface StartupRule {
  id: string;
  broken: (config: Config) => boolean;
  explain: string;
}

/** In the order the error lists them. Later sprints append the FIPS rule. */
const STARTUP_RULES: readonly StartupRule[] = [
  {
    id: 'hosted-needs-serve-web',
    broken: (config) => config.hosted && !config.serveWeb,
    explain: 'HOSTED=true needs SERVE_WEB=true, so the hosted HTML carries the CSP',
  },
  {
    id: 'hosted-real-rate-limits',
    broken: (config) => config.hosted && config.rateLimitMultiplier !== 1,
    explain: 'HOSTED=true needs RATE_LIMIT_MULTIPLIER=1 (the real limits)',
  },
  {
    id: 'hosted-log-level',
    broken: (config) =>
      config.hosted && (config.logLevel === 'debug' || config.logLevel === 'trace'),
    explain: 'HOSTED=true refuses LOG_LEVEL debug and trace',
  },
  {
    id: 'hosted-needs-secret-key',
    broken: (config) => config.hosted && config.secretKeyHex === null,
    explain:
      'HOSTED=true needs RAMPART_SECRET_KEY (64 hex characters); hosted mode never uses a key file',
  },
];

/** Thrown when the config is unsafe to start; `rules` names every broken rule, in order. */
export class StartupCheckError extends Error {
  constructor(
    readonly rules: string[],
    message: string,
  ) {
    super(message);
    this.name = 'StartupCheckError';
  }
}

/**
 * Refuses unsafe hosted combinations. `server.ts` calls it before opening the database;
 * `buildApp` never does, so tests can build any combination. Local mode always passes.
 */
export function assertSafeStartup(config: Config): void {
  const broken = STARTUP_RULES.filter((rule) => rule.broken(config));
  if (broken.length === 0) return;
  const detail = broken.map((rule) => `${rule.id}: ${rule.explain}`).join('; ');
  throw new StartupCheckError(
    broken.map((rule) => rule.id),
    `Unsafe startup configuration: ${detail}`,
  );
}
