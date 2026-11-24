import { z } from 'zod';

/** `GET /api/health`: the api is up and its database answers a query. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  db: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
