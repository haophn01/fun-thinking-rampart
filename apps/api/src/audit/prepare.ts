import type { FastifyBaseLogger } from 'fastify';
import { runMigrations, type AppDb } from '../../db/client';
import { chainAuditLog } from './chain';

/**
 * Brings the database up to date before anything uses it: applies pending migrations, then the
 * one-time hash backfill of audit events written before the chain existed. Logs info
 * `{ chained }` when it filled any, and warns `{ unchained }` when events without a hash remain
 * after the chain started (Verify names the first). Throws on any failure; callers log it as
 * fatal and exit 1.
 */
export function prepareDatabase(db: AppDb, log: Pick<FastifyBaseLogger, 'info' | 'warn'>): void {
  runMigrations(db);
  const { chained, unchained } = chainAuditLog(db);
  if (chained > 0) log.info({ chained }, 'audit events chained');
  if (unchained > 0) {
    log.warn({ unchained }, 'audit events without a hash; Verify names the first');
  }
}
