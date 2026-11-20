import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULES } from '@ticketing/shared';

describe('rules duplicated in SQL stay equal to packages/shared', () => {
  const migrations = resolve(__dirname, '../../../apps/api/prisma/migrations');
  const sql = readdirSync(migrations).map((d) => readFileSync(resolve(migrations, d, 'migration.sql'), 'utf8')).join('\n');

  it('the waitlist offer lasts as long as RULES.waitlistOfferTtlMs', () => {
    const minutes = [...sql.matchAll(/interval '(\d+) minutes'\)?[^\n]*\n[^\n]*waitlist|app_now\(\) \+ interval '(\d+) minutes'/g)].map((m) => Number(m[1] ?? m[2]));
    expect(RULES.waitlistOfferTtlMs).toBe(30 * 60_000);
    expect(sql).toContain(`interval '${RULES.waitlistOfferTtlMs / 60_000} minutes'`);
    expect(minutes.every((m) => m === 30)).toBe(true);
  });
});
