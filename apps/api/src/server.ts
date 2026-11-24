import { buildApp } from './app';

// Placeholder start-up: A1 replaces this with validated config, the DB and migrations.
const HOST = '127.0.0.1';
const port = Number(process.env.API_PORT ?? 3001);

const app = buildApp({ logger: true });

try {
  await app.listen({ host: HOST, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
