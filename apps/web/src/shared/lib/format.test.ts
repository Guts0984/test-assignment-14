import { describe, expect, it } from 'vitest';
import { formatCountdown, formatDateTime, formatMoney, formatTime } from './format';

const plain = (s: string): string => s.replace(new RegExp(`[${String.fromCharCode(0xa0)}${String.fromCharCode(0x202f)}]`, 'g'), ' ');

describe('money', () => {
  it('uk: 1 234,50 ₴', () => expect(plain(formatMoney(123_450, 'uk'))).toBe('1 234,50 ₴'));
  it('pl: 1 234,50 ₴', () => expect(plain(formatMoney(123_450, 'pl'))).toBe('1 234,50 ₴'));
  it('en: ₴1,234.50', () => expect(plain(formatMoney(123_450, 'en'))).toBe('₴1,234.50'));
  it('keeps kopecks exact, never floats', () => {
    expect(plain(formatMoney(5, 'uk'))).toBe('0,05 ₴');
    expect(plain(formatMoney(100_000_000, 'uk'))).toBe('1 000 000,00 ₴');
    expect(plain(formatMoney(99, 'en'))).toBe('₴0.99');
    expect(plain(formatMoney(-12_345, 'uk'))).toBe('-123,45 ₴');
  });
});

describe('dates are shown in Kyiv time, per locale', () => {
  const iso = '2027-03-04T16:30:00Z'; // 18:30 in Kyiv (winter)
  it('uk', () => expect(formatDateTime(iso, 'uk')).toContain('18:30'));
  it('en', () => expect(formatDateTime(iso, 'en')).toMatch(/March 4, 2027/));
  it('pl', () => expect(formatDateTime(iso, 'pl')).toMatch(/marca 2027/));
  it('time only', () => expect(formatTime(iso, 'en')).toMatch(/6:30\s?PM/));
  it('summer time moves the offset', () => expect(formatDateTime('2027-07-04T16:30:00Z', 'uk')).toContain('19:30'));
});

describe('countdown', () => {
  it('formats mm:ss and never goes negative', () => {
    expect(formatCountdown(600_000)).toBe('10:00');
    expect(formatCountdown(61_001)).toBe('01:02');
    expect(formatCountdown(-5)).toBe('00:00');
  });
});
