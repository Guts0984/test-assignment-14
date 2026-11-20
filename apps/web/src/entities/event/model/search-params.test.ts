import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, parseFilters, serializeFilters, toApiQuery } from './search-params';

describe('event filters in the URL', () => {
  it('round-trips every filter', () => {
    const f = { ...DEFAULT_FILTERS, q: 'rock', city: 'Kyiv', category: 'jazz', dateFrom: '2027-03-01', dateTo: '2027-03-31', priceMin: '300', priceMax: '1500.50', hasSeats: true, sort: 'price' as const, order: 'desc' as const, page: 3 };
    expect(parseFilters(new URLSearchParams(serializeFilters(f)))).toEqual(f);
  });
  it('defaults are not written, so a fresh page has a clean URL', () => {
    expect(serializeFilters(DEFAULT_FILTERS)).toBe('');
    expect(parseFilters(new URLSearchParams(''))).toEqual(DEFAULT_FILTERS);
  });
  it('garbage in the URL falls back to safe values instead of breaking the page', () => {
    const f = parseFilters(new URLSearchParams('sort=drop%20table&order=up&page=-4&hasSeats=maybe'));
    expect(f).toMatchObject({ sort: 'date', order: 'asc', page: 1, hasSeats: false });
    expect(parseFilters(new URLSearchParams('page=1e9')).page).toBe(1);
  });
  it('converts money to kopecks and dates to instants for the api', () => {
    const q = toApiQuery({ ...DEFAULT_FILTERS, priceMin: '300', priceMax: '1 500', dateFrom: '2027-03-01' });
    expect(q.priceMin).toBe(30_000);
    expect(q.priceMax).toBeUndefined(); // "1 500" is not a number: ignored rather than guessed
    expect(q.dateFrom).toBe('2027-02-28T22:00:00.000Z');
    expect(toApiQuery({ ...DEFAULT_FILTERS, priceMax: '1500,5' }).priceMax).toBe(150_050);
  });
});
