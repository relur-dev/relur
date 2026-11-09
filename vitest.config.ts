import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // Tests must never reach a running app or real settings through inherited variables.
    setupFiles: ['scripts/lib/clean-env.ts'],
    // Tests with git fixtures run dozens of git commands: about 2 s natively, but
    // past the 5 s default under x64 emulation (scripts/linux-check.sh).
    testTimeout: 20_000,
  },
});
