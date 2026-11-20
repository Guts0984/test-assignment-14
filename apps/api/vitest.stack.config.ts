import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, resolve(__dirname, '../..'), '');
  for (const [key, value] of Object.entries(fileEnv)) process.env[key] ??= value;
  return { test: { include: ['test/stack/**/*.stack.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } };
});
