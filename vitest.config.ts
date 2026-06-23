import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
    setupFiles: ['tests/vitest.setup.ts'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    testTimeout: 15000,
  },
});
