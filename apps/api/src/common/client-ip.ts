import { BlockList, isIP } from 'node:net';

/** Canonical bucket key: IPv4-mapped IPv6 becomes IPv4, other IPv6 addresses collapse to their /64. */
export const normalizeIp = (raw: string): string => {
  const ip = raw.trim().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) === 6) {
    const groups = expandIpv6(ip);
    return `${groups.slice(0, 4).join(':')}::/64`;
  }
  return 'unknown';
};

const expandIpv6 = (ip: string): string[] => {
  const [head = '', tail = ''] = ip.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === '' ? [] : tail.split(':');
  const missing = ip.includes('::') ? 8 - h.length - t.length : 0;
  return [...h, ...Array<string>(Math.max(0, missing)).fill('0'), ...t].map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
};

export const createTrustedProxyMatcher = (cidrs: string): ((peer: string) => boolean) => {
  const list = new BlockList();
  for (const entry of cidrs.split(',').map((c) => c.trim()).filter(Boolean)) {
    const [addr = '', prefix] = entry.split('/');
    const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (isIP(addr) === 0) continue;
    if (prefix === undefined) list.addAddress(addr, family);
    else list.addSubnet(addr, Number(prefix), family);
  }
  return (peer) => {
    const normalized = normalizeIp(peer);
    if (normalized === 'unknown') return false;
    return isIP(normalized) === 4 ? list.check(normalized, 'ipv4') : false;
  };
};

export interface IpRequestLike {
  readonly socketAddress: string;
  readonly forwardedFor: string | undefined;
}

/**
 * Real client address. X-Forwarded-For is honoured only when the direct peer is a trusted proxy (nginx), and
 * then only the last hop (the one nginx itself appended): the client cannot choose it.
 */
export const resolveClientIp = (req: IpRequestLike, isTrustedProxy: (peer: string) => boolean): string => {
  if (isTrustedProxy(req.socketAddress) && req.forwardedFor) {
    const hops = req.forwardedFor.split(',').map((h) => h.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return normalizeIp(last);
  }
  return normalizeIp(req.socketAddress);
};
