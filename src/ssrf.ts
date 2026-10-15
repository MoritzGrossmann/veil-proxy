import dns from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

// Verhindert, dass der Proxy Adressen im Heimnetz / auf dem Host selbst erreicht.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

// Explizit per PROXY_ALLOW_HOSTS freigegebene Ziele (Hostnamen, IPs, CIDR-Bereiche).
const allowedNets = new BlockList();
const allowedHosts = new Set<string>();
for (const raw of (process.env.PROXY_ALLOW_HOSTS ?? '').split(',')) {
  const entry = raw.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!entry) continue;
  const [addr, prefix] = entry.split('/');
  const family = isIP(addr);
  if (family === 0) {
    allowedHosts.add(entry);
  } else if (prefix === undefined) {
    allowedNets.addAddress(addr, family === 6 ? 'ipv6' : 'ipv4');
  } else {
    allowedNets.addSubnet(addr, Number(prefix), family === 6 ? 'ipv6' : 'ipv4');
  }
}

export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = mapped ? mapped[1] : ip;
  const fam = mapped || family === 4 ? 'ipv4' : 'ipv6';
  if (allowedNets.check(addr, fam)) return false;
  return blocked.check(addr, fam);
}

/** Prüft Schema und IP-Literale. Hostnamen werden erst in safeLookup aufgelöst und geprüft. */
export function assertUrlAllowed(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('blocked: only http(s) is allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedIp(host)) {
    throw new Error('blocked address');
  }
}

/**
 * DNS-Lookup für den ausgehenden Socket. Die Prüfung passiert auf der tatsächlich
 * verwendeten IP und schützt damit auch gegen DNS-Rebinding.
 */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  const hostAllowed = allowedHosts.has(hostname.toLowerCase());
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    const cb = callback as (err: Error | null, address?: unknown, family?: number) => void;
    if (err) return cb(err);
    const allowed = (addresses as dns.LookupAddress[]).filter((a) => hostAllowed || !isBlockedIp(a.address));
    if (allowed.length === 0) return cb(new Error('blocked address'));
    if (options.all) return cb(null, allowed);
    cb(null, allowed[0].address, allowed[0].family);
  });
};
