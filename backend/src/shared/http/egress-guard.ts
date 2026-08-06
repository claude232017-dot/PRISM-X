import { isIP } from 'node:net';

/**
 * Address classification for outbound HTTP.
 *
 * This module is pure: it takes a string and says whether it may be reached.
 * No DNS, no sockets, no configuration. That is deliberate — the decision of
 * *what is forbidden* is the part that has to be exhaustively testable, and a
 * function that also performs I/O is a function whose edge cases get tested
 * with mocks instead of with values.
 *
 * The threat is server-side request forgery: a tenant supplies a URL, the
 * platform fetches it from inside its own network, and the response comes back
 * to the tenant. Everything reachable from the application — the cloud
 * metadata service holding the platform's IAM credentials, Postgres, Redis, the
 * admin API on loopback, anything else in the VPC — becomes readable by anyone
 * who can create a webhook.
 *
 * Blocking hostnames is not enough and never was. `evil.com` can resolve to
 * `127.0.0.1`; that is why `OutboundHttpService` resolves first and passes the
 * *resolved address* through here. Hostname checks remain as a cheap first
 * pass and to catch the cases DNS would not (a literal `localhost`, a `.internal`
 * suffix), but the address check is the one that decides.
 */

export type BlockReason =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'cloud-metadata'
  | 'carrier-nat'
  | 'multicast'
  | 'broadcast'
  | 'unspecified'
  | 'reserved'
  | 'documentation'
  | 'benchmarking'
  | 'unique-local'
  | 'unroutable';

export interface AddressVerdict {
  /** True when the address may be reached. */
  allowed: boolean;
  reason?: BlockReason;
  /** The address as classified, after unwrapping any IPv4-in-IPv6 form. */
  canonical: string;
  family: 4 | 6 | 0;
}

// ============================================================ IPv4

/** `a.b.c.d` → a 32-bit integer, or null when it is not a dotted quad. */
function toIPv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  // Unsigned: `<<` in JS is signed, so 255.x.x.x would come out negative.
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

interface Range {
  /** Network address as a number. */
  readonly base: number;
  /** Prefix length in bits. */
  readonly bits: number;
  readonly reason: BlockReason;
}

function cidr(network: string, bits: number, reason: BlockReason): Range {
  const base = toIPv4Number(network);
  if (base === null) throw new Error(`"${network}" is not an IPv4 address`);
  return { base, bits, reason };
}

/**
 * Every IPv4 range that must never be reached from a tenant-supplied URL.
 *
 * Wider than the obvious three private blocks on purpose. 100.64/10 is carrier
 * NAT and is routable inside many cloud VPCs; 192.0.0.0/24 and the TEST-NET
 * blocks are not internet-routable and reaching them means something is
 * misconfigured; 0.0.0.0/8 reaches the local host on Linux. Each of these has
 * been used to bypass a naive "block 10/8, 172.16/12, 192.168/16" filter.
 */
const BLOCKED_IPV4: readonly Range[] = Object.freeze([
  cidr('0.0.0.0', 8, 'unspecified'),
  cidr('10.0.0.0', 8, 'private'),
  cidr('100.64.0.0', 10, 'carrier-nat'),
  cidr('127.0.0.0', 8, 'loopback'),
  // Contains 169.254.169.254 — AWS, Azure, DigitalOcean and Oracle metadata.
  cidr('169.254.0.0', 16, 'link-local'),
  cidr('172.16.0.0', 12, 'private'),
  cidr('192.0.0.0', 24, 'reserved'),
  cidr('192.0.2.0', 24, 'documentation'),
  cidr('192.88.99.0', 24, 'reserved'),
  cidr('192.168.0.0', 16, 'private'),
  cidr('198.18.0.0', 15, 'benchmarking'),
  cidr('198.51.100.0', 24, 'documentation'),
  cidr('203.0.113.0', 24, 'documentation'),
  cidr('224.0.0.0', 4, 'multicast'),
  cidr('240.0.0.0', 4, 'reserved'),
  cidr('255.255.255.255', 32, 'broadcast'),
]);

function classifyIPv4(address: string): AddressVerdict {
  const value = toIPv4Number(address);
  if (value === null) {
    return { allowed: false, reason: 'unroutable', canonical: address, family: 0 };
  }

  for (const range of BLOCKED_IPV4) {
    // A /0 mask would shift by 32, which is a no-op in JS — handled explicitly.
    const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
    if ((value & mask) === (range.base & mask)) {
      // The metadata address is called out by name so an operator reading a
      // log sees what was actually attempted rather than "link-local".
      const reason: BlockReason =
        address === '169.254.169.254' ? 'cloud-metadata' : range.reason;
      return { allowed: false, reason, canonical: address, family: 4 };
    }
  }
  return { allowed: true, canonical: address, family: 4 };
}

// ============================================================ IPv6

/** Expands an IPv6 address to its sixteen bytes, or null if unparseable. */
function toIPv6Bytes(address: string): Uint8Array | null {
  if (isIP(address) !== 6) return null;

  // Strip a zone index (`fe80::1%eth0`) — it is routing information, not part
  // of the address, and leaving it in defeats the parse.
  const bare = address.split('%')[0];

  // An IPv4-mapped or IPv4-embedded tail (`::ffff:127.0.0.1`) is written in
  // dotted-quad form and has to be converted before the hextet split.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
  let normalised = bare;
  if (dotted) {
    const quad = toIPv4Number(dotted[1]);
    if (quad === null) return null;
    const high = ((quad >>> 16) & 0xffff).toString(16);
    const low = (quad & 0xffff).toString(16);
    normalised = `${bare.slice(0, dotted.index)}${high}:${low}`;
  }

  const [head, tail] = normalised.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;

  const hextets = [
    ...headParts,
    ...(normalised.includes('::') ? new Array<string>(missing).fill('0') : []),
    ...tailParts,
  ];
  if (hextets.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const value = Number.parseInt(hextets[index], 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/** True when the first `bits` bits of `bytes` match `prefix`. */
function hasPrefix(bytes: Uint8Array, prefix: number[], bits: number): boolean {
  for (let index = 0; index < bits; index += 1) {
    const byte = index >> 3;
    const bit = 7 - (index & 7);
    const expected = ((prefix[byte] ?? 0) >> bit) & 1;
    const actual = (bytes[byte] >> bit) & 1;
    if (expected !== actual) return false;
  }
  return true;
}

function classifyIPv6(address: string): AddressVerdict {
  const bytes = toIPv6Bytes(address);
  if (!bytes) {
    return { allowed: false, reason: 'unroutable', canonical: address, family: 0 };
  }

  // ::ffff:0:0/96 — an IPv4 address wearing an IPv6 costume. Unwrapped and
  // classified as IPv4, because `::ffff:169.254.169.254` reaches the metadata
  // service exactly as well as the bare form does.
  const mapped = hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96);
  // 64:ff9b::/96 — NAT64. The embedded IPv4 is what the packet ends up at.
  const nat64 = hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b], 32);
  if (mapped || nat64) {
    const quad = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    const verdict = classifyIPv4(quad);
    return { ...verdict, canonical: quad };
  }

  const checks: Array<{ prefix: number[]; bits: number; reason: BlockReason }> = [
    { prefix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bits: 128, reason: 'unspecified' },
    { prefix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], bits: 128, reason: 'loopback' },
    { prefix: [0x01, 0x00], bits: 64, reason: 'unroutable' }, // 100::/64 discard
    { prefix: [0x20, 0x01, 0x0d, 0xb8], bits: 32, reason: 'documentation' },
    { prefix: [0xfc], bits: 7, reason: 'unique-local' }, // fc00::/7
    { prefix: [0xfe, 0x80], bits: 10, reason: 'link-local' }, // fe80::/10
    { prefix: [0xff], bits: 8, reason: 'multicast' },
  ];

  for (const check of checks) {
    if (hasPrefix(bytes, check.prefix, check.bits)) {
      return { allowed: false, reason: check.reason, canonical: address, family: 6 };
    }
  }

  // AWS IMDS over IPv6. Inside fd00::/8 and so already caught by unique-local,
  // but named explicitly so the log says what it was.
  if (address.toLowerCase().replace(/\s/g, '') === 'fd00:ec2::254') {
    return { allowed: false, reason: 'cloud-metadata', canonical: address, family: 6 };
  }

  return { allowed: true, canonical: address, family: 6 };
}

/**
 * Whether a resolved IP address may be connected to.
 *
 * This is the decision that matters. Everything else in the guard is a cheaper
 * check that runs earlier.
 */
export function classifyAddress(address: string): AddressVerdict {
  const family = isIP(address);
  if (family === 4) return classifyIPv4(address);
  if (family === 6) return classifyIPv6(address);
  return { allowed: false, reason: 'unroutable', canonical: address, family: 0 };
}

// ============================================================ hostnames

/**
 * Hostnames refused before DNS is even consulted.
 *
 * Cheap, and it catches names whose resolution would be locally special —
 * `localhost` may map to whatever `/etc/hosts` says, and `.internal` is the
 * suffix cloud providers use for names that only resolve inside the VPC.
 */
const BLOCKED_HOSTNAMES: readonly string[] = Object.freeze([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

/** Suffixes that only ever name something inside the deployment's network. */
const BLOCKED_SUFFIXES: readonly string[] = Object.freeze([
  '.localhost',
  '.local', // mDNS
  '.internal',
  '.intranet',
  '.private',
  '.home.arpa',
]);

export class EgressBlockedError extends Error {
  constructor(
    readonly target: string,
    readonly reason: string,
  ) {
    super(`Refused to reach "${target}": ${reason}`);
    this.name = 'EgressBlockedError';
  }
}

export interface UrlVerdict {
  url: URL;
  hostname: string;
  port: number;
  /** Set when the hostname is already an IP literal and needs no resolution. */
  literalAddress: string | null;
}

/** Ports we will connect to. Anything else is a service, not a web endpoint. */
const DEFAULT_ALLOWED_PORTS: readonly number[] = Object.freeze([80, 443, 8080, 8443]);

export interface EgressPolicy {
  /** Ports permitted on the destination. */
  allowedPorts?: readonly number[];
  /**
   * Allows loopback and private destinations.
   *
   * For tests and for the deliberate in-cluster caller only. Never set from
   * tenant input, and never plumbed to a request parameter — a flag that a
   * request can set is not a policy.
   */
  allowPrivate?: boolean;
}

/**
 * Validates a URL's shape, scheme, port and hostname.
 *
 * Returns the parsed URL and, when the hostname is an IP literal, that address
 * — so the caller knows there is nothing to resolve and can classify it
 * directly. A literal is *not* trusted here: the caller still runs it through
 * `classifyAddress`, and this function refuses the obviously bad ones early so
 * the error names the actual problem.
 */
export function validateUrl(raw: string, policy: EgressPolicy = {}): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressBlockedError(raw, 'it is not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressBlockedError(raw, `the scheme "${url.protocol}" is not permitted`);
  }

  // Credentials in the URL are a redirect-laundering trick and are never
  // needed for a legitimate destination.
  if (url.username || url.password) {
    throw new EgressBlockedError(raw, 'credentials in the URL are not permitted');
  }

  // `new URL` lowercases the host and strips the brackets from an IPv6
  // literal, which is the form `classifyAddress` expects.
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) throw new EgressBlockedError(raw, 'it has no host');

  // The destination is judged before the port, so an operator reading the
  // error sees the worst thing about the request. `http://127.0.0.1:3000`
  // refused for "port 3000" would be true and would bury the lede.
  if (!policy.allowPrivate) {
    if (BLOCKED_HOSTNAMES.includes(hostname)) {
      throw new EgressBlockedError(hostname, 'it names a local or metadata host');
    }
    for (const suffix of BLOCKED_SUFFIXES) {
      if (hostname.endsWith(suffix)) {
        throw new EgressBlockedError(hostname, `"${suffix}" names an internal host`);
      }
    }
  }

  const literalAddress = isIP(hostname) ? hostname : null;
  if (literalAddress && !policy.allowPrivate) {
    const verdict = classifyAddress(literalAddress);
    if (!verdict.allowed) {
      throw new EgressBlockedError(literalAddress, `it is a ${verdict.reason} address`);
    }
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const allowedPorts = policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (!allowedPorts.includes(port)) {
    throw new EgressBlockedError(raw, `port ${port} is not permitted`);
  }

  return { url, hostname, port, literalAddress };
}

/**
 * Asserts every address a hostname resolved to is reachable.
 *
 * *Every* one, not the first. A name with an A record for a public address and
 * a second for `127.0.0.1` would otherwise be a coin flip, and an attacker
 * controlling the zone gets to flip it as often as they like.
 */
export function assertResolvedAddresses(
  hostname: string,
  addresses: readonly string[],
  policy: EgressPolicy = {},
): void {
  if (!addresses.length) {
    throw new EgressBlockedError(hostname, 'it did not resolve to any address');
  }
  if (policy.allowPrivate) return;

  for (const address of addresses) {
    const verdict = classifyAddress(address);
    if (!verdict.allowed) {
      throw new EgressBlockedError(
        hostname,
        `it resolves to ${verdict.canonical}, which is a ${verdict.reason} address`,
      );
    }
  }
}
