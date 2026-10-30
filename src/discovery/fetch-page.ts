import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import net, { type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from 'undici';

/**
 * Fetches public web pages for email discovery. Creator-supplied links are untrusted, so this
 * only allows http(s), refuses private/loopback addresses (SSRF), follows a few redirects by
 * hand (re-checking each hop), and caps time and size.
 */

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export interface Page {
  url: string;
  status: number;
  html: string;
}

/** Only global unicast is allowed; everything listed here is internal, reserved or a tunnel. */
const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) BLOCKED.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(prefix, bits, 'ipv6');

/** "::ffff:7f00:1" or "::ffff:127.0.0.1" → "127.0.0.1"; anything else unchanged. */
function unmapIPv4(ip: string): string {
  const m = ip.toLowerCase().match(/^(?:0{0,4}:){0,5}:?ffff:(.+)$/);
  if (!m) return ip;
  if (net.isIPv4(m[1])) return m[1];
  const hex = m[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return ip;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPrivateAddress(raw: string): boolean {
  const ip = unmapIPv4(raw.replace(/^\[|\]$/g, ''));
  if (net.isIPv4(ip)) return BLOCKED.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return BLOCKED.check(ip, 'ipv6');
  return true;
}

/**
 * DNS lookup used at connect time, so the address we vet is the address we connect to
 * (defeats DNS rebinding between a pre-check and the real request).
 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || list.length === 0) {
      return callback(new Error(`Blocked non-public host: ${hostname}`), '', 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

const dispatcher = new Agent({ connect: { lookup: safeLookup } });

function assertPublicUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Blocked scheme: ${url.protocol}`);
  if (url.username || url.password) throw new Error('Blocked URL with credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // IP literals skip DNS, so the connect-time lookup never sees them — check them here.
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error(`Blocked non-public host: ${host}`);
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Blocked localhost');
  return url;
}

async function readCapped(res: UndiciResponse): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

export type PageFetcher = (url: string) => Promise<Page>;

export const fetchPage: PageFetcher = async (startUrl) => {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = assertPublicUrl(current);
    const res = await undiciFetch(url, {
      dispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US' },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, url).toString();
      continue;
    }
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html') && !type.includes('text')) {
      await res.body?.cancel();
      return { url: url.toString(), status: res.status, html: '' };
    }
    return { url: url.toString(), status: res.status, html: await readCapped(res) };
  }
  throw new Error(`Too many redirects from ${startUrl}`);
};
