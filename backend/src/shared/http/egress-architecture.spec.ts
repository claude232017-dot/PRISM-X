import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..');

/**
 * The invariant this file enforces:
 *
 * > No tenant-controlled network destination may bypass a centralized,
 * > security-reviewed outbound network policy.
 *
 * Note what it is *not*: "do not call `fetch`". A rule about a function name is
 * satisfied by installing `undici`. The rule is about the destination — if a
 * tenant can influence where a connection goes, the decision to open it is made
 * by a named policy in `egress-policies.ts` and the socket is opened by
 * `OutboundHttpService`. The pattern list below is how that rule is *detected*
 * in a static check; it is not the rule itself, which is why it covers `axios`,
 * `got` and `node-fetch` even though none of them are installed. The check is
 * there for the day one of them is.
 *
 * ## There is exactly one entry, and it is not an exemption
 *
 * `outbound-http.service.ts` does not call `fetch` at all — it uses
 * `node:http`, because pinning a socket to a pre-approved address requires the
 * `lookup` hook that `fetch` does not expose. It is listed because it is the
 * module the rule exists to protect, so a future change inside it does not trip
 * the check on itself.
 *
 * ## Why `node-transports.ts` is *not* listed
 *
 * An earlier version of this file exempted it, with the residual risk written
 * out honestly: `node.endpointUrl` is tenant-influenced (an organization
 * administrator sets it at registration), but a self-hosted PRISM-X node
 * legitimately lives at `10.0.4.7`, and a guard that refuses RFC1918 refuses
 * every real node.
 *
 * That exemption was the wrong shape. It made the node transport a *second*
 * implementation of egress — which is precisely the condition that produced the
 * original vulnerability, where `SandboxService` held a correct blocklist that
 * nobody else reused. So the transport was migrated instead: it calls
 * `OutboundHttpService` like everything else, and passes
 * `internalNodeTransport()` as its policy. One code path, two policies:
 *
 *  - `TENANT_PUBLIC` — webhooks, workflow steps, connectors, extension
 *    `host.fetch`, provider `baseUrl`. Public internet only.
 *  - `INTERNAL_NODE_TRANSPORT` — dispatch to a registered node. Permits the
 *    operator's `NODE_ENDPOINT_ALLOWED_CIDRS` and the ports a node agent
 *    listens on, and nothing else. Empty in production until configured, so a
 *    deployment must declare its node network before it can dispatch to it.
 *
 * Neither policy can reach cloud metadata, link-local, multicast, broadcast or
 * the unspecified address: `ALWAYS_DENIED` is consulted before any policy
 * allowance, and `egress-policies.spec.ts` asserts that property against every
 * registered policy rather than against the ones somebody remembered.
 *
 * A future internal transport does the same thing — a new policy in
 * `egress-policies.ts`, automatically covered by that spec — rather than a new
 * line in `ALLOWED`. Adding a line here should feel like the wrong move,
 * because it usually is.
 *
 * The suites under `test/` are outside `src/` and are not scanned.
 */
const ALLOWED = new Set<string>(['shared/http/outbound-http.service.ts']);

/**
 * Call shapes that reach the network without going through the guard.
 *
 * Written to match a *call* and not a declaration or a member access. An
 * interface may declare `fetch(args: {...})` — the SDK's host surface does —
 * and `this.config.http.request(...)` is the guard being used correctly. A
 * check that flagged either would be turned off within a week, so it flags
 * neither: the global forms are preceded by `await`, `return`, `=`, `(` or a
 * comma, and the module forms are not preceded by a dot.
 */
const FORBIDDEN = [
  {
    pattern: /(?:await|return|=|\(|,|\bvoid)\s*(?<![.\w])fetch\s*\(/,
    name: 'the global fetch()',
  },
  { pattern: /(?<![.\w])https?\.request\s*\(/, name: 'http.request()' },
  { pattern: /(?<![.\w])axios\b/, name: 'axios' },
  { pattern: /(?:await|return|=)\s*(?<![.\w])got\s*\(/, name: 'got()' },
  { pattern: /['"`]node-fetch['"`]/, name: 'node-fetch' },
];

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      found.push(path);
    }
  }
  return found;
}

/** Strips comments and string literals, so a mention is not a call. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\.|[^\\'])*'/g, "''")
    .replace(/"(?:\\.|[^\\"])*"/g, '""');
}

describe('outbound HTTP is centralised', () => {
  /**
   * The rule that keeps the SSRF fix from decaying.
   *
   * A guard is only a guard while it is the only path. Every previous
   * occurrence of this vulnerability in this codebase came from a second call
   * site added later by someone who did not know the first one existed — the
   * blocklist in `SandboxService` was correct and simply was not reused. This
   * check makes reuse the only option that compiles green.
   */
  it('has no direct network call outside the guard', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const name = relative(SRC, file).split('\\').join('/');
      if (ALLOWED.has(name)) continue;

      const body = code(readFileSync(file, 'utf8'));
      for (const { pattern, name: call } of FORBIDDEN) {
        if (pattern.test(body)) {
          const line = body.split('\n').findIndex((text) => pattern.test(text)) + 1;
          offenders.push(`${name}:${line} calls ${call}`);
        }
      }
    }

    expect(
      offenders.length === 0
        ? ''
        : `\n${offenders.join('\n')}\n\n` +
          'Inject OutboundHttpService instead. If the destination is genuinely ' +
          'chosen by the platform and never by a tenant, add the file to ALLOWED ' +
          'in egress-architecture.spec.ts with the reason.',
    ).toBe('');
  });

  it('can detect an offender, so passing means something', () => {
    // A check that has never been shown to fail is not a check.
    const sample = code(`
      export class Leaky {
        async call() {
          return fetch('http://169.254.169.254/latest/meta-data/');
        }
      }
    `);
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample))).toBe(true);
  });

  it('does not mistake a comment or a string for a call', () => {
    const sample = code(`
      // Never call fetch( here.
      const doc = 'use fetch(url) in the docs';
      const template = \`fetch(\${url})\`;
      export const note = "axios";
    `);
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample))).toBe(false);
  });

  it('does not mistake an interface declaration for a call', () => {
    // `HostApi` declares a `fetch` method; declaring one is not calling one.
    const sample = code(`
      export interface HostApi {
        fetch(args: { url: string }): Promise<unknown>;
      }
    `);
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample))).toBe(false);
  });

  /**
   * The absence of `fetch` is not the property we want.
   *
   * A transport could satisfy every pattern above by writing its own socket
   * code, and the check would stay green while the invariant was broken. So the
   * internal transport is asserted *positively*: it goes through the shared
   * service, and it names a policy when it does.
   */
  it('sends node dispatch through the guard under a named policy', () => {
    const source = readFileSync(
      join(SRC, 'nodes', 'transport', 'node-transports.ts'),
      'utf8',
    );
    expect(source).toContain('this.outbound.request(');
    expect(source).toContain('policy: internalNodeTransport()');
    // Following a redirect would carry the request signature to a destination
    // it was not addressed to.
    expect(source).toContain('maxRedirects: 0');
  });

  it('validates a node endpoint when it is registered, not only when used', () => {
    const source = readFileSync(join(SRC, 'nodes', 'node.service.ts'), 'utf8');
    expect(source).toContain('assertEndpointPermitted');
    expect(source).toContain('internalNodeTransport(env)');
  });

  it('does not mistake a method named fetch on an object for the global', () => {
    // `this.outbound.fetch(...)` and `host.fetch(...)` are the guard's own
    // surface and must not trip the rule.
    const sample = code(`
      await this.outbound.fetch(url);
      await context.host.fetch({ url });
      await this.config.http.request({ url });
    `);
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample))).toBe(false);
  });
});
