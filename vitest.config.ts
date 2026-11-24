import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // A temp folder of the run's own, removed when it ends (see the file).
    globalSetup: ['./scripts/vitest-temp.ts'],
    // Half the cores: agents run several checks at once on one machine, and a run that takes
    // every core starves the others until their tests pass 5 seconds (16 cores, three runs).
    maxWorkers: '50%',
  },
});
