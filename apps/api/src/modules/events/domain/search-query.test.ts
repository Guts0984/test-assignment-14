import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildSearch, escapeLike } from './search-query.js';

const base = { sort: 'date', order: 'asc', page: 1, pageSize: 20 } as const;

describe('buildSearch', () => {
  it('puts every user value into parameters, never into the SQL text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.string({ maxLength: 60 }), (q, city) => {
        const built = buildSearch({ ...base, q, city, category: q });
        for (const text of [q, city]) {
          if (text.length >= 3) expect(built.where).not.toContain(text);
        }
        expect(built.where).not.toMatch(/\$\d+\$/);
        expect(built.params.length).toBeLessThanOrEqual(3);
      }),
    );
  });
  it('orders only by whitelisted columns', () => {
    expect(buildSearch({ ...base, sort: 'price', order: 'desc' }).orderBy).toBe('e.min_price DESC NULLS LAST, e.id');
    expect(buildSearch({ ...base, sort: 'title' }).orderBy).toContain('lower(e.title)');
  });
  it('computes limit and offset from the page', () => {
    const built = buildSearch({ ...base, page: 3, pageSize: 25 });
    expect(built).toMatchObject({ limit: 25, offset: 50 });
  });
  it('always restricts to upcoming, on-sale statuses (drafts never leak)', () => {
    expect(buildSearch(base).where).toContain(`'on_sale', 'sold_out', 'rescheduled'`);
    expect(buildSearch(base).where).not.toContain('draft');
  });
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});
