import base from './vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        'test/integration/arkKeeperFailure.test.ts',
        'test/integration/arkKeeperSuccess.test.ts',
      ],
      exclude: ['node_modules/**', 'dist/**'],
    },
  }),
);
