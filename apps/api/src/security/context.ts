import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';

/** What the security seams (headers, rate limits, web serving) read from the app. */
export interface SecurityContext {
  config: Config;
  /** The app clock; rate-limit windows run on it, never on `Date.now`. */
  now: () => Date;
}

/** The shape of each seam `buildApp` calls, in its fixed order, on the root instance. */
export type SecuritySeam = (app: FastifyInstance, ctx: SecurityContext) => void;
