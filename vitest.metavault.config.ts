import base from './vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        'test/metavault/**/*.{test,spec}.{ts,tsx,js}',
        'test/keepers/metavaultKeeper.test.ts',
        'test/ark/utils/selectBuckets.test.ts',
        'test/integration/metavaultKeeper.integration.test.ts',
      ],
      exclude: ['node_modules/**', 'dist/**'],
    },
  }),
);
