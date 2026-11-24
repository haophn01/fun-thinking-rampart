export interface DevPorts {
  web: number;
  api: number;
}

export const DEFAULT_WEB_PORT = 3000;
export const DEFAULT_API_PORT = 3001;

export class DevPortsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevPortsError';
  }
}

type PortResult = { ok: true; port: number } | { ok: false; problem: string };

function readPort(name: string, raw: string | undefined, fallback: number): PortResult {
  if (raw === undefined || raw === '') return { ok: true, port: fallback };
  // Digits only: rejects signs, decimals, exponents, hex and surrounding spaces.
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return { ok: true, port };
  return { ok: false, problem: `${name} must be an integer from 1 to 65535, got "${raw}"` };
}

/** Reads WEB_PORT and API_PORT for the Vite dev server and its /api proxy. */
export function resolveDevPorts(env: Readonly<Record<string, string | undefined>>): DevPorts {
  const web = readPort('WEB_PORT', env.WEB_PORT, DEFAULT_WEB_PORT);
  const api = readPort('API_PORT', env.API_PORT, DEFAULT_API_PORT);

  if (!web.ok || !api.ok) {
    const problems = [web, api].flatMap((result) => (result.ok ? [] : [result.problem]));
    throw new DevPortsError(problems.join('; '));
  }

  if (web.port === api.port) {
    throw new DevPortsError(`WEB_PORT and API_PORT must differ, both are ${String(web.port)}`);
  }
  return { web: web.port, api: api.port };
}
