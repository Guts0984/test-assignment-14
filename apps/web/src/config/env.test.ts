import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPublicEnv, loadServerEnv, publicEnvSchema, serverEnvSchema } from './env.schema';

const example = Object.fromEntries(
  readFileSync(resolve(__dirname, '../../../../.env.example'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

describe('web env', () => {
  it('.env.example satisfies both schemas and lists every variable', () => {
    expect(loadServerEnv(example).ok).toBe(true);
    expect(loadPublicEnv(example).ok).toBe(true);
    for (const key of [...Object.keys(serverEnvSchema.shape), ...Object.keys(publicEnvSchema.shape)]) {
      expect(example, key).toHaveProperty(key);
    }
  });

  it('only NEXT_PUBLIC_* (and DEFAULT_LOCALE) are public; no secrets in public schema', () => {
    for (const key of Object.keys(publicEnvSchema.shape)) {
      expect(key.startsWith('NEXT_PUBLIC_')).toBe(true);
      expect(key).not.toMatch(/SECRET|PASSWORD|PEPPER|KEY/);
    }
  });

  it('rejects an unsupported default locale', () => {
    expect(loadPublicEnv({ ...example, NEXT_PUBLIC_DEFAULT_LOCALE: 'de' }).ok).toBe(false);
  });
});
