import { ALWAYS_DENIED, classifyAddress, permits } from './egress-guard';
import type { EgressPolicy } from './egress-guard';

/**
 * The outbound network policy register.
 *
 * ## The invariant
 *
 * > No tenant-controlled network destination may bypass a centralized,
 * > security-reviewed outbound network policy.
 *
 * Not "may not use `fetch`" — that would be a rule about a function name, and
 * the next SSRF arrives through `undici`, or an SDK, or a `net.connect` in a
 * transport nobody thought of as HTTP. The rule is about the *destination*: if
 * a tenant can influence where a connection goes, the decision to open it is
 * made here, by a named policy, and the connection is opened by
 * `OutboundHttpService` and nothing else.
 *
 * ## Two policies, one code path
 *
 * The earlier version of this fix exempted `node-transports.ts` from the guard,
 * because a self-hosted PRISM-X node legitimately lives at `10.0.4.7` and a
 * guard that refuses RFC1918 refuses every real node. That exemption was
 * honest but wrong in shape: it made the node transport a *second*
 * implementation of egress, which is precisely the condition that produced the
 * vulnerability in the first place — `SandboxService` had a correct blocklist
 * that nobody else reused.
 *
 * So there is no code exemption. There are two policies:
 *
 *  - `TENANT_PUBLIC` — webhooks, workflow steps, connectors, extension
 *    `host.fetch`, provider `baseUrl`. Public internet only.
 *  - `INTERNAL_NODE_TRANSPORT` — dispatch to a registered node. Permits the
 *    operator's configured CIDR blocks and nothing else.
 *
 * Both run through the same resolver, the same address classifier, the same
 * connection pinning and the same redirect revalidation. What differs is one
 * allowlist.
 *
 * ## What a policy can never do
 *
 * `ALWAYS_DENIED` is checked before any policy allowance. Cloud metadata,
 * link-local, multicast, broadcast and the unspecified address are refused
 * under every policy, and `egress-policies.spec.ts` asserts that property for
 * every registered policy rather than for the ones somebody remembered. An
 * operator who writes `169.254.0.0/16` into the node allowlist gets a
 * configuration that does nothing, not a metadata exfiltration path.
 */

/** Ports a PRISM-X node agent may listen on, absent configuration. */
const DEFAULT_NODE_PORTS: readonly number[] = Object.freeze([
  80, 443, 8080, 8443, 3000, 3100,
]);

/**
 * Which ports a node endpoint may name.
 *
 * Defence in depth behind the CIDR allowlist rather than the primary control.
 * The allowlist decides which *hosts* are reachable; this decides what may be
 * spoken to on them, and its job is to stop a "node" registered at
 * `10.20.0.5:5432` from turning node dispatch into a Postgres probe against the
 * operator's own network.
 *
 * Configurable because a self-hosted node agent listens wherever its operator
 * put it, and a fixed list would be a fixed list of ports *we* guessed. The
 * default is narrow; widening it is a deliberate act with a name attached.
 */
export function nodeAllowedPorts(
  env: NodeJS.ProcessEnv = process.env,
): readonly number[] {
  const configured = (env.NODE_ENDPOINT_ALLOWED_PORTS ?? '')
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535);

  return configured.length ? Object.freeze(configured) : DEFAULT_NODE_PORTS;
}

/**
 * Where the operator says their nodes live.
 *
 * Fail-closed in production: with nothing configured, no remote node can be
 * reached at a private address, and the error names the variable to set. That
 * is a deliberate trade — a deployment with remote nodes must declare its
 * network before it can dispatch to it, and the alternative is a default that
 * silently permits the entire RFC1918 space on every install.
 *
 * Outside production the RFC1918 blocks and loopback are permitted by default,
 * because the validation suites stand a second instance up on 127.0.0.1 and
 * requiring every developer to set an environment variable to run the tests
 * would mean the variable gets set to something permissive and forgotten.
 */
export function nodeAllowedCidrs(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const configured = (env.NODE_ENDPOINT_ALLOWED_CIDRS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (configured.length) return configured;
  if ((env.NODE_ENV ?? 'development') === 'production') return [];
  return ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
}

/**
 * The default policy: a destination a tenant chose, on the public internet.
 *
 * No CIDR allowance at all, so every private range stays refused.
 */
export const TENANT_PUBLIC: EgressPolicy = Object.freeze({
  name: 'tenant-public',
});

/**
 * Dispatch to a registered PRISM-X node.
 *
 * The destination is still tenant-influenced — `node.endpointUrl` is set at
 * registration by an organization administrator — so it is *not* exempt from
 * review. It is subject to a narrower policy that says: the address must be
 * inside the network the operator declared, on a port a node agent uses, and
 * never a metadata or link-local address whatever the allowlist claims.
 *
 * Enforced twice: at registration, so a bad endpoint is rejected while the
 * administrator is watching, and at dispatch, so an endpoint that was valid
 * when it was registered cannot be dispatched to after the allowlist narrows.
 */
export function internalNodeTransport(
  env: NodeJS.ProcessEnv = process.env,
): EgressPolicy {
  return Object.freeze({
    name: 'internal-node-transport',
    allowedPorts: nodeAllowedPorts(env),
    allowedCidrs: nodeAllowedCidrs(env),
  });
}

/** Every policy in the system, for the register and for the tests. */
export function registeredPolicies(
  env: NodeJS.ProcessEnv = process.env,
): readonly EgressPolicy[] {
  return [TENANT_PUBLIC, internalNodeTransport(env)];
}

/**
 * Addresses that must be refused under every policy, forever.
 *
 * Used by `egress-policies.spec.ts` to assert the property against each
 * registered policy, so adding a third policy without re-reading this file
 * still cannot open a hole.
 */
export const FORBIDDEN_UNDER_EVERY_POLICY: readonly string[] = Object.freeze([
  '169.254.169.254', // AWS / Azure / DigitalOcean / Oracle IMDS
  '169.254.170.2', // ECS task metadata
  '169.254.1.1', // link-local generally
  '::ffff:169.254.169.254', // the IPv4-mapped form
  '224.0.0.1', // multicast
  '255.255.255.255', // broadcast
  '0.0.0.0', // unspecified
]);

/**
 * Asserts a policy cannot reach anything in the forbidden set.
 *
 * Exported rather than kept in the spec so the check can also run at boot: a
 * misconfigured allowlist should be a startup failure, not a finding in a
 * penetration test.
 */
export function assertPolicyCannotReachForbidden(policy: EgressPolicy): void {
  for (const address of FORBIDDEN_UNDER_EVERY_POLICY) {
    const decision = permits(classifyAddress(address), policy);
    if (decision.allowed) {
      throw new Error(
        `Egress policy "${policy.name ?? 'unnamed'}" would permit ${address}, ` +
          'which must be unreachable under every policy. This is a bug in the ' +
          'guard, not a configuration problem — check ALWAYS_DENIED.',
      );
    }
  }
}

/** Boot-time verification of every registered policy. */
export function verifyEgressPolicies(env: NodeJS.ProcessEnv = process.env): void {
  for (const policy of registeredPolicies(env)) {
    assertPolicyCannotReachForbidden(policy);
  }
  // A sanity check on the floor itself: a shrinking ALWAYS_DENIED would make
  // every assertion above pass vacuously.
  for (const reason of ['cloud-metadata', 'link-local'] as const) {
    if (!ALWAYS_DENIED.has(reason)) {
      throw new Error(`"${reason}" was removed from ALWAYS_DENIED`);
    }
  }
}
