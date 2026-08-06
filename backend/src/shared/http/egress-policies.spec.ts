import { ALWAYS_DENIED, classifyAddress, permits, validateUrl } from './egress-guard';
import type { EgressPolicy } from './egress-guard';
import {
  FORBIDDEN_UNDER_EVERY_POLICY,
  TENANT_PUBLIC,
  assertPolicyCannotReachForbidden,
  internalNodeTransport,
  nodeAllowedCidrs,
  nodeAllowedPorts,
  registeredPolicies,
  verifyEgressPolicies,
} from './egress-policies';

/**
 * The policy register's own tests.
 *
 * These assert a property of *every registered policy*, iterating the register
 * rather than naming policies one at a time. A third policy added later is
 * covered on the day it is added, by an author who never read this file — which
 * is the only kind of coverage that survives a team.
 */

const production = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const development = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

describe('every registered policy', () => {
  const policies = registeredPolicies(development);

  it('is registered under a name, so an error can identify it', () => {
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) expect(policy.name).toBeTruthy();
  });

  it('refuses every forbidden destination', () => {
    // Reported as one collection rather than one assertion per address: a
    // failure should name every hole at once, not the first one found.
    const reachable: string[] = [];
    for (const policy of policies) {
      for (const address of FORBIDDEN_UNDER_EVERY_POLICY) {
        if (permits(classifyAddress(address), policy).allowed) {
          reachable.push(`${policy.name ?? 'unnamed'} → ${address}`);
        }
      }
    }
    expect(reachable).toEqual([]);
  });

  it('is covered by the boot-time check', () => {
    expect(() => verifyEgressPolicies(development)).not.toThrow();
    expect(() => verifyEgressPolicies(production)).not.toThrow();
  });

  it('refuses a metadata hostname regardless of the allowlist', () => {
    for (const policy of policies) {
      expect(() =>
        validateUrl('http://metadata.google.internal/computeMetadata/v1/', policy),
      ).toThrow(/metadata/i);
    }
  });
});

describe('an allowlist cannot unblock what it may not unblock', () => {
  /**
   * The single most important test in this file.
   *
   * An operator with a wide brush writes `0.0.0.0/0` or `169.254.0.0/16` into
   * `NODE_ENDPOINT_ALLOWED_CIDRS`, either by accident or because an attacker
   * with configuration access wanted a metadata read. `permits()` consults
   * `ALWAYS_DENIED` before it consults any allowance, so the entry is inert.
   */
  it('ignores an entry naming the link-local block', () => {
    const reckless: EgressPolicy = {
      name: 'reckless',
      allowedCidrs: ['169.254.0.0/16'],
      allowedPorts: [80],
    };
    expect(permits(classifyAddress('169.254.169.254'), reckless).allowed).toBe(false);
    expect(permits(classifyAddress('169.254.170.2'), reckless).allowed).toBe(false);
    expect(() => assertPolicyCannotReachForbidden(reckless)).not.toThrow();
  });

  it('ignores an entry naming the entire address space', () => {
    const everything: EgressPolicy = { name: 'everything', allowedCidrs: ['0.0.0.0/0'] };
    expect(permits(classifyAddress('169.254.169.254'), everything).allowed).toBe(false);
    expect(permits(classifyAddress('224.0.0.1'), everything).allowed).toBe(false);
    expect(permits(classifyAddress('255.255.255.255'), everything).allowed).toBe(false);
    // It does open RFC1918, which is what an operator writing /0 asked for.
    expect(permits(classifyAddress('10.0.4.7'), everything).allowed).toBe(true);
  });

  it('ignores allowPrivate for the same set', () => {
    const wide: EgressPolicy = { name: 'wide', allowPrivate: true };
    expect(permits(classifyAddress('10.0.4.7'), wide).allowed).toBe(true);
    expect(permits(classifyAddress('169.254.169.254'), wide).allowed).toBe(false);
    expect(permits(classifyAddress('::ffff:169.254.169.254'), wide).allowed).toBe(false);
  });

  it('treats a malformed entry as permitting nothing', () => {
    const typo: EgressPolicy = { name: 'typo', allowedCidrs: ['10.0.0/8', 'not-a-cidr'] };
    expect(permits(classifyAddress('10.0.4.7'), typo).allowed).toBe(false);
  });
});

describe('the tenant policy', () => {
  it('permits a public address', () => {
    expect(permits(classifyAddress('93.184.216.34'), TENANT_PUBLIC).allowed).toBe(true);
  });

  it('refuses every private range, with no allowlist to appeal to', () => {
    for (const address of ['127.0.0.1', '10.0.4.7', '192.168.1.1', '172.16.0.5', '100.64.0.1']) {
      expect({ address, ...permits(classifyAddress(address), TENANT_PUBLIC) }).toMatchObject({
        allowed: false,
      });
    }
  });
});

describe('the internal node transport policy', () => {
  it('is empty in production until the operator declares their network', () => {
    expect(nodeAllowedCidrs(production)).toEqual([]);
    const policy = internalNodeTransport(production);
    expect(permits(classifyAddress('10.0.4.7'), policy).allowed).toBe(false);
  });

  it('permits the declared network and nothing beside it', () => {
    const policy = internalNodeTransport({
      NODE_ENV: 'production',
      NODE_ENDPOINT_ALLOWED_CIDRS: '10.20.0.0/16',
    } as NodeJS.ProcessEnv);

    expect(permits(classifyAddress('10.20.4.7'), policy).allowed).toBe(true);
    // A different RFC1918 block the operator did not name.
    expect(permits(classifyAddress('10.30.4.7'), policy).allowed).toBe(false);
    expect(permits(classifyAddress('192.168.1.1'), policy).allowed).toBe(false);
    // And still not the metadata service.
    expect(permits(classifyAddress('169.254.169.254'), policy).allowed).toBe(false);
  });

  it('parses a comma-separated list with whitespace', () => {
    expect(
      nodeAllowedCidrs({
        NODE_ENDPOINT_ALLOWED_CIDRS: ' 10.0.0.0/8 , 192.168.0.0/16 ,, ',
      } as NodeJS.ProcessEnv),
    ).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('permits only the ports a node agent listens on', () => {
    const policy = internalNodeTransport(development);
    expect(() => validateUrl('http://10.0.4.7:8080/api/v1/x', policy)).not.toThrow();
    // Postgres, Redis, and every other in-VPC service that is not a node.
    for (const port of [5432, 6379, 9200, 11211, 27017]) {
      expect(() => validateUrl(`http://10.0.4.7:${port}/`, policy)).toThrow(
        `port ${port} is not permitted`,
      );
    }
  });

  it('takes an operator-configured port list, since agents listen where they were put', () => {
    const policy = internalNodeTransport({
      NODE_ENV: 'production',
      NODE_ENDPOINT_ALLOWED_CIDRS: '10.20.0.0/16',
      NODE_ENDPOINT_ALLOWED_PORTS: '9101, 9102',
    } as NodeJS.ProcessEnv);

    expect(() => validateUrl('http://10.20.4.7:9101/', policy)).not.toThrow();
    // Configuring a list replaces the default rather than adding to it, so a
    // deployment that names its ports gets exactly those.
    expect(() => validateUrl('http://10.20.4.7:8080/', policy)).toThrow(/port 8080/);
    expect(() => validateUrl('http://10.20.4.7:5432/', policy)).toThrow(/port 5432/);
  });

  it('falls back to the default list when the configured one is nonsense', () => {
    expect(
      nodeAllowedPorts({ NODE_ENDPOINT_ALLOWED_PORTS: 'http, -1, 99999' } as NodeJS.ProcessEnv),
    ).toEqual(nodeAllowedPorts({} as NodeJS.ProcessEnv));
  });

  it('cannot be widened past the deny floor by a port list', () => {
    // Ports are defence in depth behind the CIDR allowlist, never a way around
    // the floor. Naming every port does not make the metadata service a node.
    const policy = internalNodeTransport({
      NODE_ENV: 'production',
      NODE_ENDPOINT_ALLOWED_CIDRS: '169.254.0.0/16',
      NODE_ENDPOINT_ALLOWED_PORTS: '80,443',
    } as NodeJS.ProcessEnv);
    expect(() => validateUrl('http://169.254.169.254/', policy)).toThrow();
    expect(permits(classifyAddress('169.254.169.254'), policy).allowed).toBe(false);
  });

  it('accepts a developer loopback node outside production', () => {
    // The validation suites stand a second instance up on 127.0.0.1.
    const policy = internalNodeTransport(development);
    expect(() => validateUrl('http://127.0.0.1:3100/api/v1/x', policy)).not.toThrow();
  });
});

describe('the deny floor itself', () => {
  it('contains the reasons the policies depend on', () => {
    for (const reason of ['cloud-metadata', 'link-local', 'multicast', 'unspecified'] as const) {
      expect(ALWAYS_DENIED.has(reason)).toBe(true);
    }
  });

  it('can detect a policy that reaches a forbidden address', () => {
    // A check that has never been shown to fail is not a check.
    //
    // `assertPolicyCannotReachForbidden` can only throw if `permits` lets a
    // forbidden address through, and with `ALWAYS_DENIED` intact no policy
    // object can make that happen — which is the point of the design and also
    // what makes the failure path unreachable from the outside. So the
    // regression it guards against is simulated at its source: `permits` is
    // replaced with one that always allows, standing in for a future edit that
    // reorders the checks in `permits()` and consults the allowlist first.
    const guard = require('./egress-guard') as { permits: typeof permits };
    const real = guard.permits;
    guard.permits = (() => ({ allowed: true })) as typeof permits;
    try {
      expect(() => assertPolicyCannotReachForbidden(TENANT_PUBLIC)).toThrow(
        /169\.254\.169\.254/,
      );
      expect(() => verifyEgressPolicies(development)).toThrow(/must be unreachable/);
    } finally {
      guard.permits = real;
    }

    // And with the real implementation back, it passes again — so the throw
    // above came from the injected fault and not from a broken assertion.
    expect(() => assertPolicyCannotReachForbidden(TENANT_PUBLIC)).not.toThrow();
  });
});
