import { openDb, runMigrations } from '../db/client';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createLogger } from './logger';

// Start-up order: config, open the DB, migrate, listen. Any failure logs and exits 1.
try {
  const config = loadConfig(process.env);
  const handle = openDb(config.databasePath);
  runMigrations(handle.db);

  const app = buildApp({ config, db: handle.db });
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
