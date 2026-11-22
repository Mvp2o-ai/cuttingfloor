import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // A temp folder of the run's own, removed when it ends (see the file).
    globalSetup: ['./scripts/vitest-temp.ts'],
  },
});
