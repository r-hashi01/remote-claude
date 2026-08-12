import { defineConfig } from 'vitest/config';

/**
 * One runner for both halves of the repository.
 *
 * The Worker and the SDK are separate packages that must not import each
 * other's code, but their tests exercise the same kind of thing — pure domain
 * rules and use cases wired to fakes — and there is no reason to run them with
 * two different tools.
 *
 * This used to add "nothing here needs workerd: anything that would is in the
 * infrastructure layer, which is deliberately thin enough to read". Thin enough
 * to read is not the same as tested, and the gap it left was expensive: a refusal
 * thrown inside a Durable Object arrived as a plain Error, so every refusal the
 * request path raises answered 500 — telling every client that a permanent
 * refusal was worth retrying. Everything here passed throughout.
 *
 * The few properties that only exist in workerd now run there:
 * `vitest.workers.config.ts`, `npm run test:workers`.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'sdk/src/**/*.test.ts'],
    environment: 'node',
  },
});
