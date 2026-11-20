import { describe, expect, it } from 'vitest';
import { loadSeedEnv } from './seed-env.schema.js';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', SEED_USER_PASSWORD: 'Passw0rd-dev-seed' };

describe('seed env', () => {
  it('accepts the example values and defaults to the full seed', () => {
    const r = loadSeedEnv(base);
    expect(r.ok && r.env.SEED_SCALE).toBe('full');
    expect(r.ok && r.env.SEED_ON_START).toBe(true);
  });
  it('requires the password and the database url (no defaults for secrets)', () => {
    expect(loadSeedEnv({ DATABASE_URL: base.DATABASE_URL }).ok).toBe(false);
    expect(loadSeedEnv({ SEED_USER_PASSWORD: base.SEED_USER_PASSWORD }).ok).toBe(false);
    expect(loadSeedEnv({ ...base, SEED_USER_PASSWORD: 'short' }).ok).toBe(false);
  });
  it('rejects an unknown scale', () => {
    expect(loadSeedEnv({ ...base, SEED_SCALE: 'huge' }).ok).toBe(false);
  });
});
