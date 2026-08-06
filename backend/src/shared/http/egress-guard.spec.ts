import {
  EgressBlockedError,
  assertResolvedAddresses,
  classifyAddress,
  validateUrl,
} from './egress-guard';

describe('classifyAddress', () => {
  describe('IPv4 that must never be reached', () => {
    const blocked: Array<[string, string]> = [
      ['127.0.0.1', 'loopback'],
      ['127.1.2.3', 'loopback — the whole /8, not just .0.1'],
      ['0.0.0.0', 'unspecified, which reaches the local host on Linux'],
      ['10.0.0.1', 'RFC1918'],
      ['10.255.255.255', 'RFC1918 upper bound'],
      ['172.16.0.1', 'RFC1918'],
      ['172.31.255.254', 'RFC1918 upper bound'],
      ['192.168.1.1', 'RFC1918'],
      ['169.254.1.1', 'link-local'],
      ['169.254.169.254', 'cloud metadata'],
      ['100.64.0.1', 'carrier NAT, routable inside many VPCs'],
      ['224.0.0.1', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['255.255.255.255', 'broadcast'],
      ['192.0.2.1', 'TEST-NET-1'],
      ['198.18.0.1', 'benchmarking'],
    ];

    it.each(blocked)('refuses %s (%s)', (address) => {
      expect(classifyAddress(address).allowed).toBe(false);
    });

    it('names the metadata address specifically, so a log is actionable', () => {
      expect(classifyAddress('169.254.169.254').reason).toBe('cloud-metadata');
    });

    it('reports the narrowest matching range when ranges overlap', () => {
      // Not cosmetic. `broadcast` is in ALWAYS_DENIED and `reserved` is not,
      // so labelling 255.255.255.255 by the enclosing 240.0.0.0/4 would let a
      // policy allowlist reach an address no policy may reach.
      expect(classifyAddress('255.255.255.255').reason).toBe('broadcast');
      expect(classifyAddress('240.0.0.1').reason).toBe('reserved');
    });
  });

  describe('IPv4 that is legitimately reachable', () => {
    // Addresses adjacent to blocked ranges, to prove the masks are exact
    // rather than approximately right.
    const allowed = [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.255.255', // just below 172.16/12
      '172.32.0.1', // just above 172.16/12
      '100.63.255.255', // just below 100.64/10
      '100.128.0.1', // just above 100.64/10
      '11.0.0.1', // just above 10/8
      '9.255.255.255', // just below 10/8
      '169.253.255.255', // just below 169.254/16
      '223.255.255.255', // just below multicast
    ];

    it.each(allowed)('permits %s', (address) => {
      expect(classifyAddress(address).allowed).toBe(true);
    });
  });

  describe('IPv6', () => {
    it('refuses loopback, link-local, unique-local and multicast', () => {
      expect(classifyAddress('::1').allowed).toBe(false);
      expect(classifyAddress('fe80::1').allowed).toBe(false);
      expect(classifyAddress('fc00::1').allowed).toBe(false);
      expect(classifyAddress('fd12:3456::1').allowed).toBe(false);
      expect(classifyAddress('ff02::1').allowed).toBe(false);
      expect(classifyAddress('::').allowed).toBe(false);
    });

    it('unwraps an IPv4-mapped address and judges the IPv4 inside it', () => {
      // ::ffff:169.254.169.254 reaches the metadata service exactly as well
      // as the bare form. Checking only the IPv6 prefix would let it through.
      const verdict = classifyAddress('::ffff:169.254.169.254');
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe('cloud-metadata');
      expect(verdict.canonical).toBe('169.254.169.254');
    });

    it('unwraps an IPv4-mapped loopback', () => {
      expect(classifyAddress('::ffff:127.0.0.1').allowed).toBe(false);
    });

    it('unwraps NAT64', () => {
      expect(classifyAddress('64:ff9b::a00:1').allowed).toBe(false); // 10.0.0.1
    });

    it('permits a public IPv6 address', () => {
      expect(classifyAddress('2606:4700:4700::1111').allowed).toBe(true);
    });

    it('ignores a zone index rather than failing to parse', () => {
      expect(classifyAddress('fe80::1%eth0').allowed).toBe(false);
    });
  });

  it('refuses anything that is not an IP address at all', () => {
    expect(classifyAddress('not-an-ip').allowed).toBe(false);
    expect(classifyAddress('').allowed).toBe(false);
  });
});

describe('validateUrl', () => {
  it('refuses a non-HTTP scheme', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(EgressBlockedError);
    expect(() => validateUrl('gopher://example.com/')).toThrow(/scheme/);
    expect(() => validateUrl('ftp://example.com/')).toThrow(/scheme/);
  });

  it('refuses localhost by name', () => {
    expect(() => validateUrl('http://localhost/')).toThrow(/local or metadata/);
    expect(() => validateUrl('http://LOCALHOST:8080/')).toThrow(/local or metadata/);
    expect(() => validateUrl('http://foo.localhost/')).toThrow(/internal host/);
  });

  it('refuses the cloud metadata hostnames', () => {
    // Refused by name before any policy is consulted, so the message says
    // "metadata host" rather than "local or metadata host" — these names are
    // rejected under every policy, not merely under the default one.
    expect(() => validateUrl('http://metadata.google.internal/')).toThrow(
      /cloud metadata host/,
    );
    expect(() => validateUrl('http://metadata/')).toThrow(/cloud metadata host/);
    expect(() => validateUrl('http://instance-data/')).toThrow(/cloud metadata host/);
  });

  it('refuses internal DNS suffixes', () => {
    expect(() => validateUrl('http://db.internal/')).toThrow(/internal host/);
    expect(() => validateUrl('http://printer.local/')).toThrow(/internal host/);
    expect(() => validateUrl('http://svc.private/')).toThrow(/internal host/);
  });

  it('refuses a private address written as a literal', () => {
    expect(() => validateUrl('http://127.0.0.1:3000/')).toThrow(/loopback/);
    expect(() => validateUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      /cloud-metadata/,
    );
    expect(() => validateUrl('http://192.168.0.1/')).toThrow(/private/);
    expect(() => validateUrl('http://[::1]/')).toThrow(/loopback/);
  });

  it('refuses credentials embedded in the URL', () => {
    // `http://expected.com@169.254.169.254/` is the classic parser-confusion
    // payload; the host is the part after the @.
    expect(() => validateUrl('http://user:pass@example.com/')).toThrow(/credentials/);
  });

  it('refuses a port that is not a web port', () => {
    expect(() => validateUrl('http://example.com:5432/')).toThrow(/port 5432/);
    expect(() => validateUrl('http://example.com:6379/')).toThrow(/port 6379/);
    expect(() => validateUrl('http://example.com:22/')).toThrow(/port 22/);
  });

  it('permits an ordinary public URL', () => {
    const verdict = validateUrl('https://hooks.example.com/path?query=1');
    expect(verdict.hostname).toBe('hooks.example.com');
    expect(verdict.port).toBe(443);
    expect(verdict.literalAddress).toBeNull();
  });

  it('permits the common non-default web ports', () => {
    expect(validateUrl('http://example.com:8080/').port).toBe(8080);
    expect(validateUrl('https://example.com:8443/').port).toBe(8443);
  });

  it('permits a public IP literal and reports it as needing no resolution', () => {
    const verdict = validateUrl('https://8.8.8.8/');
    expect(verdict.literalAddress).toBe('8.8.8.8');
  });
});

describe('assertResolvedAddresses', () => {
  it('accepts a name that resolved only to public addresses', () => {
    expect(() =>
      assertResolvedAddresses('example.com', ['93.184.216.34', '2606:2800:220:1::1']),
    ).not.toThrow();
  });

  it('refuses a name that resolved to a private address', () => {
    // The DNS-rebinding and split-horizon case: the name looks innocuous and
    // the answer does not.
    expect(() => assertResolvedAddresses('evil.example', ['127.0.0.1'])).toThrow(
      /resolves to 127\.0\.0\.1/,
    );
  });

  it('refuses when only *one* of several answers is private', () => {
    // Checking the first answer would make this a coin flip that the attacker
    // controlling the zone gets to flip repeatedly.
    expect(() =>
      assertResolvedAddresses('evil.example', ['93.184.216.34', '169.254.169.254']),
    ).toThrow(/cloud-metadata/);
  });

  it('refuses a name that resolved to nothing', () => {
    expect(() => assertResolvedAddresses('void.example', [])).toThrow(/did not resolve/);
  });
});
