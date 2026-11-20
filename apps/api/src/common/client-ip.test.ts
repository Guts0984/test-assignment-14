import { describe, expect, it } from 'vitest';
import { createTrustedProxyMatcher, normalizeIp, resolveClientIp } from './client-ip.js';

const trusted = createTrustedProxyMatcher('172.16.0.0/12,127.0.0.1/32');

describe('normalizeIp', () => {
  it('maps IPv4-mapped IPv6 to the IPv4 bucket', () => {
    expect(normalizeIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp('203.0.113.9')).toBe('203.0.113.9');
  });
  it('collapses an IPv6 /64 into one bucket however the address is written', () => {
    const a = normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = normalizeIp('2001:0db8:0001:0002::1');
    const c = normalizeIp('2001:DB8:1:2:ffff:ffff:ffff:ffff');
    expect(new Set([a, b, c]).size).toBe(1);
    expect(normalizeIp('2001:db8:1:3::1')).not.toBe(a);
  });
  it('strips brackets and zone ids; garbage becomes one "unknown" bucket', () => {
    expect(normalizeIp('[2001:db8::1]')).toBe(normalizeIp('2001:db8::1'));
    expect(normalizeIp('fe80::1%eth0')).toBe(normalizeIp('fe80::1'));
    expect(normalizeIp('not an ip')).toBe('unknown');
    expect(normalizeIp('')).toBe('unknown');
  });
});

describe('resolveClientIp', () => {
  it('ignores X-Forwarded-For from untrusted peers (clients cannot choose their address)', () => {
    expect(resolveClientIp({ socketAddress: '203.0.113.9', forwardedFor: '198.51.100.7' }, trusted)).toBe('203.0.113.9');
    expect(resolveClientIp({ socketAddress: '::ffff:203.0.113.9', forwardedFor: '1.2.3.4, 5.6.7.8' }, trusted)).toBe('203.0.113.9');
  });
  it('trusts the last hop appended by our own proxy and nothing before it', () => {
    expect(resolveClientIp({ socketAddress: '172.18.0.5', forwardedFor: '6.6.6.6, 198.51.100.7' }, trusted)).toBe('198.51.100.7');
    expect(resolveClientIp({ socketAddress: '127.0.0.1', forwardedFor: '198.51.100.7' }, trusted)).toBe('198.51.100.7');
    expect(resolveClientIp({ socketAddress: '::ffff:172.18.0.5', forwardedFor: '198.51.100.7' }, trusted)).toBe('198.51.100.7');
  });
  it('falls back to the socket address when the proxy sent nothing', () => {
    expect(resolveClientIp({ socketAddress: '172.18.0.5', forwardedFor: undefined }, trusted)).toBe('172.18.0.5');
  });
  it('a spoofed trusted-looking value is not enough: the peer itself must be in the allow-list', () => {
    expect(resolveClientIp({ socketAddress: '8.8.8.8', forwardedFor: '127.0.0.1' }, trusted)).toBe('8.8.8.8');
  });
});
