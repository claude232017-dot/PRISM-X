import { Injectable, Logger, Optional } from '@nestjs/common';
import { lookup as systemLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import type { LookupAddress, LookupOptions } from 'node:dns';
import {
  EgressBlockedError,
  assertResolvedAddresses,
  validateUrl,
} from './egress-guard';
import type { EgressPolicy } from './egress-guard';

/**
 * The process-wide egress client, for construction sites Nest does not reach.
 *
 * Never a convenience. Injecting is the norm; this exists so that a factory
 * function has a guarded path available and therefore no excuse.
 */
let registered: OutboundHttpService | null = null;

export function registerEgressClient(client: OutboundHttpService): void {
  registered = client;
}

export function egress(): OutboundHttpService {
  if (!registered) {
    throw new Error(
      'Outbound HTTP was used before HttpEgressModule initialised. Inject ' +
        'OutboundHttpService instead of calling egress() where you can.',
    );
  }
  return registered;
}

export interface OutboundRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Whole-request deadline, redirects included. */
  timeoutMs?: number;
  /** Redirect hops permitted. 0 refuses to follow any. */
  maxRedirects?: number;
  /** Response bytes read before the connection is destroyed. */
  maxResponseBytes?: number;
  /** Ports and private-address policy. Never derived from tenant input. */
  policy?: EgressPolicy;
}

export interface OutboundResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Every URL actually contacted, starting with the requested one. */
  chain: string[];
  /** The address the final hop connected to. */
  peer: string;
  /** True when the body was cut off at `maxResponseBytes`. */
  truncated: boolean;
}

const DEFAULTS = {
  timeoutMs: 30_000,
  maxRedirects: 3,
  maxResponseBytes: 1024 * 1024,
} as const;

/**
 * The only sanctioned way to make an HTTP request to a URL the platform did
 * not choose itself.
 *
 * Every tenant-controlled destination in the codebase goes through here:
 * webhook endpoints, workflow `http` steps, HTTP connectors, extension
 * `host.fetch`, and provider `baseUrl` overrides. `egress-architecture.spec.ts`
 * fails the build if a new caller reaches for `fetch` directly.
 *
 * Three properties, and the middle one is the one usually missing:
 *
 * **The address is validated, not the name.** A hostname blocklist is defeated
 * by `attacker.com A 127.0.0.1`. This resolves the name first and checks every
 * address it returns.
 *
 * **The connection is pinned to the address that was checked.** Validating a
 * resolution and then handing the *hostname* to the HTTP client leaves a gap
 * between the check and the connect, and DNS rebinding is the attack that lives
 * in that gap: the first lookup answers with a public address, the TTL expires
 * in milliseconds, and the client's own lookup answers with `169.254.169.254`.
 * Node's `http.request` accepts a `lookup` function, so this supplies one that
 * ignores DNS entirely and returns the already-approved address. There is no
 * second resolution to poison. The `Host` header and TLS `servername` still
 * carry the original hostname, so virtual hosting and certificate validation
 * work exactly as they would have.
 *
 * **Redirects are followed by us, one hop at a time.** `node:http` does not
 * follow redirects at all, which is the behaviour we want: each `Location` is
 * resolved, re-validated from scratch — scheme, port, hostname, DNS, address —
 * and only then followed. A 302 to `http://169.254.169.254/` is refused at the
 * same gate as a direct request to it, because it *is* one.
 */
@Injectable()
export class OutboundHttpService {
  private readonly logger = new Logger(OutboundHttpService.name);

  /**
   * Name resolution, as a seam.
   *
   * Defaults to the system resolver. It is a constructor parameter because
   * `node:dns/promises` exports are non-configurable and cannot be spied on —
   * and a DNS check that can only be tested by monkey-patching a core module
   * is a DNS check whose tests will quietly stop running one Node release from
   * now. Overridden only by tests.
   */
  private readonly lookup: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: number }>>;

  constructor(
    @Optional()
    resolver?: (hostname: string) => Promise<Array<{ address: string; family: number }>>,
  ) {
    this.lookup =
      resolver ?? ((hostname) => systemLookup(hostname, { all: true, verbatim: true }));

    // Registered for the few callers that cannot be injected into: provider
    // adapters are built by a registry factory rather than by Nest, and a
    // factory-built object that could not reach the guard would simply be
    // written with `fetch` instead. Same seam as `process-state` and
    // `isolation-registry` — a module-level accessor, set once, never a
    // second implementation.
    registerEgressClient(this);
  }

  async request(input: OutboundRequest): Promise<OutboundResponse> {
    const deadline = Date.now() + (input.timeoutMs ?? DEFAULTS.timeoutMs);
    const maxRedirects = input.maxRedirects ?? DEFAULTS.maxRedirects;
    const maxBytes = input.maxResponseBytes ?? DEFAULTS.maxResponseBytes;

    let target = input.url;
    let method = (input.method ?? 'GET').toUpperCase();
    let body = input.body;
    let headers = { ...(input.headers ?? {}) };
    const chain: string[] = [];

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new EgressBlockedError(target, 'the request deadline elapsed');
      }

      // Full revalidation on every hop. A redirect is a new destination and
      // gets exactly the scrutiny the first one did.
      const verdict = validateUrl(target, input.policy);
      const address = await this.resolve(verdict.hostname, verdict.literalAddress, input.policy);
      chain.push(verdict.url.toString());

      const response = await this.send({
        url: verdict.url,
        address,
        method,
        headers,
        body,
        timeoutMs: remaining,
        maxBytes,
      });

      const location = response.headers.location;
      const isRedirect = response.status >= 300 && response.status < 400 && location;

      if (!isRedirect) {
        return {
          status: response.status,
          headers: response.headers,
          body: response.body,
          chain,
          peer: address,
          truncated: response.truncated,
        };
      }

      if (hop === maxRedirects) {
        throw new EgressBlockedError(
          target,
          `it redirected more than ${maxRedirects} time(s)`,
        );
      }

      const next = new URL(location, verdict.url);
      if (chain.includes(next.toString())) {
        throw new EgressBlockedError(next.toString(), 'the redirect chain loops');
      }

      // Credentials must not follow a redirect to a different origin. A
      // webhook endpoint that 302s to somebody else's server would otherwise
      // hand them the signing header.
      if (next.origin !== verdict.url.origin) {
        headers = OutboundHttpService.withoutCredentials(headers);
      }

      // 303, and 301/302 on a POST, become a GET without a body — the same
      // rule browsers follow, and it stops a body being replayed at a new host.
      if (response.status === 303 || (method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
        delete headers['content-type'];
        delete headers['content-length'];
      }

      target = next.toString();
    }

    throw new EgressBlockedError(input.url, 'the redirect limit was exhausted');
  }

  /**
   * Resolves a hostname and approves every address it answers with.
   *
   * An IP literal skips DNS but not the check — `validateUrl` has already
   * classified it, and it is returned as the pinned address.
   */
  private async resolve(
    hostname: string,
    literal: string | null,
    policy?: EgressPolicy,
  ): Promise<string> {
    if (literal) return literal;

    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await this.lookup(hostname);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'DNS error';
      throw new EgressBlockedError(hostname, `it could not be resolved (${code})`);
    }

    const addresses = resolved.map((entry) => entry.address);
    assertResolvedAddresses(hostname, addresses, policy);

    // The first is used and the rest are only validated. Connecting to one
    // address while having approved a set is fine precisely because the whole
    // set was approved — there is no address in it we would have refused.
    return addresses[0];
  }

  /** Headers that must not survive a cross-origin redirect. */
  private static withoutCredentials(headers: Record<string, string>): Record<string, string> {
    const stripped: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (lower === 'authorization' || lower === 'cookie' || lower === 'proxy-authorization') {
        continue;
      }
      if (lower.startsWith('x-prismx-')) continue;
      stripped[name] = value;
    }
    return stripped;
  }

  /** One hop, connected to `address` and nothing else. */
  private send(input: {
    url: URL;
    address: string;
    method: string;
    headers: Record<string, string>;
    body?: string | Buffer;
    timeoutMs: number;
    maxBytes: number;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
    truncated: boolean;
  }> {
    const secure = input.url.protocol === 'https:';
    const transport = secure ? https : http;

    /**
     * The pin. Node calls this instead of resolving, and it answers with the
     * address already approved — so the socket connects where the check was
     * made, and a DNS answer that changed in between is never consulted.
     */
    const pinnedLookup = (
      _hostname: string,
      options: LookupOptions,
      callback: (
        error: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ): void => {
      const family = input.address.includes(':') ? 6 : 4;
      if (options && options.all) {
        callback(null, [{ address: input.address, family }]);
      } else {
        callback(null, input.address, family);
      }
    };

    return new Promise((resolve, reject) => {
      const request = transport.request(
        {
          protocol: input.url.protocol,
          // The hostname is still sent — it is what the Host header and the
          // certificate are checked against. Only the *connect* is pinned.
          host: input.url.hostname,
          port: input.url.port || (secure ? 443 : 80),
          path: `${input.url.pathname}${input.url.search}`,
          method: input.method,
          headers: {
            host: input.url.host,
            'accept-encoding': 'identity',
            ...input.headers,
          },
          lookup: pinnedLookup as never,
          // SNI and certificate validation against the real hostname, not the
          // pinned address — pinning must not weaken TLS.
          ...(secure ? { servername: input.url.hostname } : {}),
          timeout: input.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;

          response.on('data', (chunk: Buffer) => {
            if (truncated) return;
            size += chunk.length;
            if (size > input.maxBytes) {
              truncated = true;
              chunks.push(chunk.subarray(0, chunk.length - (size - input.maxBytes)));
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });

          const settle = () => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (value === undefined) continue;
              headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
            }
            resolve({
              status: response.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
              truncated,
            });
          };

          response.on('end', settle);
          // A destroy triggered by the size cap ends here rather than at `end`.
          response.on('close', () => {
            if (truncated) settle();
          });
          response.on('error', (error) => {
            if (truncated) settle();
            else reject(error);
          });
        },
      );

      request.on('timeout', () => {
        request.destroy(new Error(`Request to ${input.url.hostname} timed out`));
      });
      request.on('error', (error) => reject(error));

      if (input.body !== undefined) request.write(input.body);
      request.end();
    });
  }

  /**
   * Convenience for callers that want the familiar shape.
   *
   * Returns a real `Response`, so a call site can move onto the guard by
   * changing `fetch(url, init)` to `outbound.fetch(url, init)` without
   * rewriting how it reads the result.
   */
  async fetch(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Buffer;
      timeoutMs?: number;
      maxRedirects?: number;
      maxResponseBytes?: number;
      policy?: EgressPolicy;
    } = {},
  ): Promise<Response> {
    const result = await this.request({ url, ...init });
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }
}
