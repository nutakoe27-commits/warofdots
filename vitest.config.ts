import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // The determinism and headless-match tests deliberately run thousands of ticks.
    testTimeout: 60_000,
  },
});
