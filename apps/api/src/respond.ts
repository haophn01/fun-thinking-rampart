import { z } from 'zod';

/** A handler built a response its contract schema rejects. The client gets a 500. */
export class ResponseContractError extends Error {
  constructor(readonly issues: z.core.$ZodIssue[]) {
    super('Response does not match its contract schema');
    this.name = 'ResponseContractError';
  }
}

/**
 * Parses a handler's result through its contract schema before it is sent. Unknown keys are
 * stripped, so nothing off-contract leaves the api; a mismatch throws `ResponseContractError`.
 */
export function respond<S extends z.ZodType>(schema: S, payload: z.input<S>): z.output<S> {
  const result = schema.safeParse(payload);
  if (!result.success) throw new ResponseContractError(result.error.issues);
  return result.data;
}
