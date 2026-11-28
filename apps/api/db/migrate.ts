import { prepareDatabase } from '../src/audit/prepare';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { openDb } from './client';

// `pnpm db:migrate`: applies pending migrations to DATABASE_PATH, then chains any audit events
// written before the hash chain (once). The server also does this on start, so this is for
// migrating without starting it. A second run is a no-op.
const log = createLogger('info');
try {
  const config = loadConfig(process.env);
  const handle = openDb(config.databasePath);
  try {
    prepareDatabase(handle.db, log);
  } finally {
    handle.sqlite.close();
  }
  log.info({ databasePath: config.databasePath }, 'migrations applied');
} catch (error) {
  log.fatal({ err: error }, 'migration failed');
  process.exitCode = 1;
}
