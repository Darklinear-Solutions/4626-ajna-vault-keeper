import base from './vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['test/**/*.{test,spec}.{ts,tsx,js}'],
      exclude: ['test/integration/**', 'test/metavault/**', 'node_modules/**', 'dist/**'],
    },
  }),
);
