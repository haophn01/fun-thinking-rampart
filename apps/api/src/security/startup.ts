import { getFips } from 'node:crypto';
import type { Config } from '../config';

/** What `assertSafeStartup` asks about the running process; tests inject their own answer. */
export interface StartupProbe {
  /** Whether Node's crypto is in FIPS mode. */
  fipsEnabled: () => boolean;
}

/** The real process: `crypto.getFips()` is 1 only when Node runs with a FIPS provider. */
const PROCESS_PROBE: StartupProbe = { fipsEnabled: () => getFips() === 1 };

/** A rule `assertSafeStartup` enforces, with what the operator reads when it breaks. */
interface StartupRule {
  id: string;
  broken: (config: Config, probe: StartupProbe) => boolean;
  explain: string;
}

/** In the order the error lists them. */
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
  {
    // Local and hosted alike. The probe is asked only when FIPS is required.
    id: 'fips-required-not-enabled',
    broken: (config, probe) => config.fipsMode === 'required' && !probe.fipsEnabled(),
    explain:
      "FIPS_MODE=required but Node's crypto isn't in FIPS mode (crypto.getFips() is 0); run Node with --enable-fips and a FIPS-validated OpenSSL provider, or set FIPS_MODE=off",
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
 * Refuses unsafe hosted combinations, and FIPS_MODE=required without FIPS crypto. `server.ts`
 * calls it before opening the database; `buildApp` never does, so tests can build any
 * combination. Local mode passes unless FIPS is required and missing.
 */
export function assertSafeStartup(config: Config, probe: StartupProbe = PROCESS_PROBE): void {
  const broken = STARTUP_RULES.filter((rule) => rule.broken(config, probe));
  if (broken.length === 0) return;
  const detail = broken.map((rule) => `${rule.id}: ${rule.explain}`).join('; ');
  throw new StartupCheckError(
    broken.map((rule) => rule.id),
    `Unsafe startup configuration: ${detail}`,
  );
}
