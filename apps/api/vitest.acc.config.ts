import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Long-running acceptance scenarios against the deployed stack (`pnpm stack:up` first). One file at a time.
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, resolve(__dirname, '../..'), '');
  for (const [key, value] of Object.entries(fileEnv)) process.env[key] ??= value;
  return {
    plugins: [swc.vite({ module: { type: 'es6' }, jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
    test: { include: ['test/stack/acceptance/**/*.acc.test.ts'], fileParallelism: false, testTimeout: 90 * 60_000, hookTimeout: 5 * 60_000 },
  };
});
