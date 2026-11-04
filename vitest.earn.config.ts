import { resolve } from 'path';

import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { defineConfig } from 'vitest/config';

// Earn unit tests run without the anvil global setup, which needs Rainbow RPC keys.
export default defineConfig({
  plugins: [vanillaExtractPlugin()],
  test: {
    environment: 'happy-dom',
    include: ['src/core/earn/**/*.test.ts', 'src/core/state/earn/**/*.test.ts'],
    testTimeout: 15_000,
    setupFiles: './src/test/vitest.setup.ts',
    watch: false,
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, './src'),
      static: resolve(__dirname, './static'),
    },
  },
});
