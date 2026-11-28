import { openDb } from '../db/client';
import { createLocalStore } from '../storage';
import { buildApp } from './app';
import { prepareDatabase } from './audit/prepare';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { loadSecretKey } from './security/secret-key';
import { assertSafeStartup } from './security/startup';

// Start-up order: config, the startup check, the secret key, open the DB, migrate, chain the
// audit events written before the hash chain (once), listen. An unsafe config or a bad key stops
// before the DB opens, so it never creates a database file. The file store creates its folder on
// the first upload, so start-up never writes to STORAGE_PATH. Any failure logs and exits 1.
try {
  const config = loadConfig(process.env);
  assertSafeStartup(config);
  const log = createLogger(config.logLevel);
  const secretKey = loadSecretKey(config, log);
  const handle = openDb(config.databasePath);
  prepareDatabase(handle.db, log);

  const app = buildApp({
    config,
    db: handle.db,
    secretKey,
    store: createLocalStore(config.storagePath),
  });
  app.addHook('onClose', () => {
    handle.sqlite.close();
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().finally(() => process.exit(0));
    });
  }

  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  createLogger('info').fatal({ err: error }, 'api failed to start');
  process.exit(1);
}
