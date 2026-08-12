import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * The tests that have to run inside workerd.
 *
 * Kept to the properties that only exist there. The main suite runs in node
 * against fakes, which is why it is fast — and why it said nothing when a refusal
 * thrown inside a Durable Object stopped being a refusal on the way out: RPC
 * rebuilds an error from its name rather than its class, and no test in this
 * repository had ever crossed that hop.
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/wrangler.jsonc' } })],
  test: {
    include: ['src/**/*.boundary.test.ts'],
  },
});
