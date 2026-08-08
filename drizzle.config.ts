import { defineConfig } from 'drizzle-kit';

/**
 * Generate-only configuration.
 *
 * drizzle-kit emits SQL into migrations/, and `wrangler d1 migrations apply`
 * applies it. Deliberately NOT using `drizzle-kit push`/`migrate`, which would
 * talk to D1 over HTTP and need a separate API token — and would give us two
 * migration systems disagreeing about what has been applied.
 *
 * One source of truth (src/store/schema.ts), one applier (wrangler).
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/store/schema.ts',
  out: './migrations',
});
