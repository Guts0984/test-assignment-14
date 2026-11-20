import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, resolve(__dirname, '../..'), '');
  for (const [key, value] of Object.entries(fileEnv)) process.env[key] ??= value;
  return {
    plugins: [swc.vite({ module: { type: 'es6' }, jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
    test: {
      include: ['test/**/*.int.test.ts', 'src/**/*.int.test.ts'],
      globalSetup: ['../../packages/testkit/src/global-setup.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
      maxWorkers: 2,
    },
  };
});
