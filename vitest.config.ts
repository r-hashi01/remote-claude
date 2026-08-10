import { defineConfig } from 'vitest/config';

/**
 * One runner for both halves of the repository.
 *
 * The Worker and the SDK are separate packages that must not import each
 * other's code, but their tests exercise the same kind of thing — pure domain
 * rules and use cases wired to fakes — and there is no reason to run them with
 * two different tools. Nothing here needs workerd: anything that would is in
 * the infrastructure layer, which is deliberately thin enough to read.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'sdk/src/**/*.test.ts'],
    environment: 'node',
  },
});
