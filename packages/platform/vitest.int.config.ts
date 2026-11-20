import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, resolve(__dirname, '../..'), '');
  for (const [key, value] of Object.entries(fileEnv)) process.env[key] ??= value;
  return {
    test: {
      include: ['src/**/*.int.test.ts', 'test/**/*.int.test.ts'],
      globalSetup: ['../testkit/src/global-setup.ts'],
      testTimeout: 60_000,
      maxWorkers: 4,
      hookTimeout: 120_000,
    },
  };
});
