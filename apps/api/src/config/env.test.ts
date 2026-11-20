import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envSchema, loadEnv } from './env.schema.js';

const parseExample = (): Record<string, string> =>
  Object.fromEntries(
    readFileSync(resolve(__dirname, '../../../../.env.example'), 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );

const secretKeys = Object.entries(envSchema.shape)
  .filter(([, schema]) => !schema.isOptional() && schema.safeParse(undefined).success === false)
  .map(([key]) => key);

describe('api env', () => {
  it('.env.example satisfies the schema', () => {
    const result = loadEnv(parseExample());
    expect(result.ok).toBe(true);
  });

  it('.env.example lists every variable of the schema', () => {
    const example = parseExample();
    for (const key of Object.keys(envSchema.shape)) expect(example, key).toHaveProperty(key);
  });

  it('required variables have no default and fail fast when missing', () => {
    expect(secretKeys.length).toBeGreaterThan(0);
    for (const key of secretKeys) {
      const { [key]: _removed, ...rest } = parseExample();
      const result = loadEnv(rest);
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.errors.join()).toContain(key);
    }
  });

  it('rejects weak secrets and bad numbers', () => {
    const base = parseExample();
    expect(loadEnv({ ...base, QR_SIGNING_SECRET: 'short' }).ok).toBe(false);
    expect(loadEnv({ ...base, DATABASE_URL: 'not-a-url' }).ok).toBe(false);
  });

  it('returns a frozen config', () => {
    const result = loadEnv(parseExample());
    if (!result.ok) throw new Error('example must parse');
    expect(Object.isFrozen(result.env)).toBe(true);
  });
});

describe('api env specifics', () => {
  it('JWT secrets and webhook secret are required', () => {
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_PEPPER', 'STUB_WEBHOOK_SECRET']) {
      expect(secretKeys).toContain(key);
    }
  });

  it('test clock defaults to disabled', () => {
    const { TEST_CLOCK_ENABLED: _t, ...rest } = parseExample();
    const result = loadEnv(rest);
    expect(result.ok && result.env.TEST_CLOCK_ENABLED).toBe(false);
  });
});
