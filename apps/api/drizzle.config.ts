import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @rampart/api db:generate` writes a new SQL migration from db/schema.ts.
// Migrations are the only way the database changes; never edit one that has been committed.
export default defineConfig({
  dialect: 'sqlite',
  schema: './db/schema.ts',
  out: './db/migrations',
});
