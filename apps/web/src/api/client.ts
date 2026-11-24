import { errorEnvelopeSchema } from '@rampart/api/contract';

/** `network_error` and `invalid_response` come from the client; every other code is the api's. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(init: { status: number; code: string; message: string; requestId?: string }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    if (init.requestId !== undefined) this.requestId = init.requestId;
  }
}

/** What `apiGet` needs from a contract schema (zod's `safeParse` fits). */
export interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

async function readJson(response: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: (await response.json()) as unknown };
  } catch {
    return { ok: false };
  }
}

/** GET a path from the api and parse the body with its contract schema. Throws `ApiError`. */
export async function apiGet<T>(path: string, schema: ResponseSchema<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError({
      status: 0,
      code: 'network_error',
      message: 'The request could not reach the API.',
    });
  }

  const body = await readJson(response);
  const invalid = (message: string) =>
    new ApiError({ status: response.status, code: 'invalid_response', message });

  if (!response.ok) {
    const envelope = body.ok ? errorEnvelopeSchema.safeParse(body.value) : undefined;
    if (envelope?.success) {
      const { code, message, requestId } = envelope.data.error;
      throw new ApiError({ status: response.status, code, message, requestId });
    }
    throw invalid(`The API answered ${String(response.status)} without an error envelope.`);
  }

  if (!body.ok) throw invalid('The API response was not JSON.');
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) throw invalid('The API response did not match its contract.');
  return parsed.data;
}
