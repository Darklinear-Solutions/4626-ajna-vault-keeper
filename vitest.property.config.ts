import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/property/**/*.{test,spec}.{ts,tsx,js}'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    sequence: {
      concurrent: false,
      shuffle: false,
    },
    exclude: ['**/test/mocks/**/*', 'node_modules/**', 'dist/**'],
  },
});
