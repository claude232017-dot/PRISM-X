import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..');

/**
 * Files permitted to call `fetch` directly.
 *
 * Deliberately short, and every entry is a decision rather than an exemption:
 *
 *  - `outbound-http.service.ts` does not call `fetch` at all — it uses
 *    `node:http` — but it is the module the rule exists to protect and is
 *    listed so that a future change there does not trip the check.
 *  - `node-transports.ts` is exempt with a *known residual risk*, stated here
 *    rather than hidden. `node.endpointUrl` is set at registration by an
 *    organization administrator (`node:register`), so it is tenant-controlled —
 *    but a self-hosted node legitimately lives at a private address inside a
 *    VPC, and routing this through the guard would refuse every real node. The
 *    exposure is narrower than the paths that were fixed: the transport POSTs
 *    a signed body to a fixed `/api/v1/nodes/agent/execute` path and surfaces
 *    at most 400 characters of the response in a failure message, so it is a
 *    slow, POST-only read of services that answer POST. The right control is a
 *    registration-time policy — an operator-configured CIDR allowlist plus an
 *    absolute refusal of metadata addresses — not this guard. Tracked, not
 *    closed.
 *  - The suites under `test/` are outside `src/` and are not scanned.
 *
 * Anything else that needs to make an HTTP request to a URL the platform did
 * not choose injects `OutboundHttpService`.
 */
const ALLOWED = new Set<string>([
  'shared/http/outbound-http.service.ts',
  'nodes/transport/node-transports.ts',
]);

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
