import { afterEach, describe, expect, it } from 'vitest';
import { observeServerTime, remainingMs, resetServerClock, serverNow } from './server-clock';

afterEach(resetServerClock);

describe('server clock', () => {
  it('a browser clock that is 5 minutes fast still shows the right time left', () => {
    const clientNow = Date.parse('2027-01-01T12:05:00Z'); // the real time is 12:00:00
    observeServerTime('2027-01-01T12:00:00Z', clientNow);
    expect(remainingMs('2027-01-01T12:10:00Z', clientNow)).toBe(600_000);
    expect(remainingMs('2027-01-01T12:10:00Z', clientNow + 30_000)).toBe(570_000);
  });
  it('a browser clock that is 5 minutes slow is corrected too', () => {
    const clientNow = Date.parse('2027-01-01T11:55:00Z');
    observeServerTime('2027-01-01T12:00:00Z', clientNow);
    expect(serverNow(clientNow)).toBe(Date.parse('2027-01-01T12:00:00Z'));
  });
  it('without any server time the client clock is used; garbage is ignored', () => {
    observeServerTime('not a date');
    expect(serverNow(1_000)).toBe(1_000);
  });
});
