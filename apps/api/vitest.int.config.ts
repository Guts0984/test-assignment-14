import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  // Share the repo-root .env (copied from .env.example) with the global setup and the test workers.
  const fileEnv = loadEnv(mode, resolve(__dirname, '../..'), '');
  for (const [key, value] of Object.entries(fileEnv)) process.env[key] ??= value;
  return {
    plugins: [swc.vite({ module: { type: 'es6' }, jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
    test: {
      include: ['src/**/*.int.test.ts', 'test/integration/**/*.int.test.ts', 'test/adversarial/**/*.adv.test.ts'],
      globalSetup: ['../../packages/testkit/src/global-setup.ts'],
      testTimeout: 60_000,
      hookTimeout: 120_000,
    },
  };
});
