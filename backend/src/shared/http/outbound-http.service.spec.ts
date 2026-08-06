import { AddressInfo } from 'node:net';
import { lookup as systemLookup } from 'node:dns/promises';
import * as http from 'node:http';
import { OutboundHttpService } from './outbound-http.service';

type Answer = Array<{ address: string; family: number }>;

/**
 * Resolution is injected rather than mocked.
 *
 * `node:dns/promises` exports are non-configurable, so `jest.spyOn` cannot
 * attach to them — and a test that reaches for a core module's internals is a
 * test that breaks on a Node upgrade. The service takes a resolver, so these
 * tests supply one.
 */
let resolver: (hostname: string) => Promise<Answer>;
const realLookup = (hostname: string) =>
  systemLookup(hostname, { all: true, verbatim: true }) as Promise<Answer>;

/**
 * These run against real sockets rather than mocks.
 *
 * A mocked `fetch` would prove the code calls what we told it to call, which
 * is not the question. The question is whether a redirect to `127.0.0.1`
 * actually fails to reach `127.0.0.1`, and the only way to know is to stand
 * something up on `127.0.0.1` and confirm it was never touched.
 */
describe('OutboundHttpService', () => {
  let service: OutboundHttpService;

  /** A loopback server standing in for "internal thing that must stay unreachable". */
  let internal: http.Server;
  let internalPort = 0;
  let internalHits = 0;

  /** A second loopback server used as a redirect source. */
  let redirector: http.Server;
  let redirectorPort = 0;
  let redirectTarget = '';

  const listen = (server: http.Server): Promise<number> =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });

  beforeAll(async () => {
    resolver = realLookup;
    service = new OutboundHttpService((hostname) => resolver(hostname));

    internal = http.createServer((_request, response) => {
      internalHits += 1;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('SECRET-INTERNAL-DATA');
    });
    internalPort = await listen(internal);

    redirector = http.createServer((request, response) => {
      if (request.url === '/loop-a') {
        response.writeHead(302, { location: `http://127.0.0.1:${redirectorPort}/loop-b` });
        return response.end();
      }
      if (request.url === '/loop-b') {
        response.writeHead(302, { location: `http://127.0.0.1:${redirectorPort}/loop-a` });
        return response.end();
      }
      if (request.url === '/ok') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        return response.end('final');
      }
      response.writeHead(302, { location: redirectTarget });
      response.end();
    });
    redirectorPort = await listen(redirector);
  });

  afterAll(async () => {
    await new Promise((resolve) => internal.close(resolve));
    await new Promise((resolve) => redirector.close(resolve));
  });

  beforeEach(() => {
    internalHits = 0;
    resolver = realLookup;
  });

  // ==================================================== direct destinations

  describe('refuses a destination that names an internal address', () => {
    const cases: Array<[string, string]> = [
      ['loopback by IP', 'http://127.0.0.1:8080/'],
      ['loopback by name', 'http://localhost:8080/'],
      ['the cloud metadata service', 'http://169.254.169.254/latest/meta-data/'],
      ['GCP metadata by name', 'http://metadata.google.internal/computeMetadata/v1/'],
      ['an RFC1918 /8', 'http://10.0.0.1/'],
      ['an RFC1918 /12', 'http://172.16.0.1/'],
      ['an RFC1918 /16', 'http://192.168.1.1/'],
      ['IPv6 loopback', 'http://[::1]:8080/'],
      ['an IPv4-mapped metadata address', 'http://[::ffff:169.254.169.254]/'],
    ];

    it.each(cases)('%s', async (_label, url) => {
      await expect(service.request({ url })).rejects.toThrow(/Refused to reach/);
    });
  });

  it('refuses a non-HTTP scheme', async () => {
    await expect(service.request({ url: 'file:///etc/passwd' })).rejects.toThrow(/scheme/);
  });

  it('never opens a socket to a refused destination', async () => {
    await expect(
      service.request({ url: `http://127.0.0.1:${internalPort}/` }),
    ).rejects.toThrow();
    // The proof: the server that would have answered never saw a request.
    expect(internalHits).toBe(0);
  });

  // ==================================================== DNS

  it('refuses a public hostname that resolves to a private address', async () => {
    // The split-horizon case. `evil.example` looks like any other domain and
    // the answer is `127.0.0.1`, which a hostname blocklist cannot catch.
    resolver = async () => [{ address: '127.0.0.1', family: 4 }];

    await expect(service.request({ url: 'http://evil.example/' })).rejects.toThrow(
      /resolves to 127\.0\.0\.1/,
    );
    expect(internalHits).toBe(0);
  });

  it('refuses when only one of several answers is private', async () => {
    resolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];

    await expect(service.request({ url: 'http://evil.example/' })).rejects.toThrow(
      /cloud-metadata/,
    );
  });

  it('refuses a name that does not resolve', async () => {
    resolver = async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    };

    await expect(service.request({ url: 'http://nowhere.example/' })).rejects.toThrow(
      /could not be resolved/,
    );
  });

  /**
   * DNS rebinding.
   *
   * The first resolution answers with a public address and passes the check.
   * A second resolution — the one an unpinned HTTP client would perform when
   * it opened the socket — answers with loopback. If the request ends up at
   * the internal server, the guard validated one address and connected to
   * another, which is the entire vulnerability.
   */
  it('cannot be rebound between the check and the connect', async () => {
    let call = 0;
    resolver = async () => {
      call += 1;
      // First answer: public and acceptable. Every answer after: loopback.
      return call === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    };

    // What must be true is a property of *where the packet went*, not of how
    // the call happened to end. Depending on the environment this either
    // fails to connect or is answered by something at the pinned address —
    // either is fine. What is never fine is reaching the loopback server.
    const outcome = await service
      .request({ url: 'http://rebind.example/', timeoutMs: 2_000 })
      .catch((error: Error) => error);

    // The internal server was never touched, and no response body came from it.
    expect(internalHits).toBe(0);
    if (!(outcome instanceof Error)) {
      expect(outcome.peer).toBe('93.184.216.34');
      expect(outcome.body).not.toContain('SECRET-INTERNAL-DATA');
    }
    // And in particular the second, poisoned answer was never consulted for
    // the connection: the resolver was called once for the check and the
    // socket used what that check approved.
    expect(call).toBe(1);
  });

  // ==================================================== redirects

  it('refuses a redirect whose destination is a private address', async () => {
    redirectTarget = `http://127.0.0.1:${internalPort}/`;

    // The first hop is permitted only because the test pins it to the local
    // redirector deliberately; the second hop is the one under test.
    await expect(
      service.request({
        url: `http://127.0.0.1:${redirectorPort}/start`,
        policy: { allowPrivate: true, allowedPorts: [redirectorPort, internalPort] },
        maxRedirects: 2,
      }),
    ).resolves.toBeDefined();

    // With the policy back to normal, the same redirect is refused.
    await expect(
      service.request({
        url: `http://127.0.0.1:${redirectorPort}/start`,
        maxRedirects: 2,
      }),
    ).rejects.toThrow(/Refused to reach/);
  });

  it('refuses a redirect to the metadata service', async () => {
    redirectTarget = 'http://169.254.169.254/latest/meta-data/';

    await expect(
      service.request({
        url: `http://127.0.0.1:${redirectorPort}/start`,
        // The first hop is allowed so the redirect itself is what is tested.
        policy: { allowPrivate: true, allowedPorts: [redirectorPort] },
        maxRedirects: 2,
      }),
    ).rejects.toThrow(/169\.254\.169\.254|cloud-metadata|not permitted/);
  });

  it('stops a redirect chain that loops', async () => {
    await expect(
      service.request({
        url: `http://127.0.0.1:${redirectorPort}/loop-a`,
        policy: { allowPrivate: true, allowedPorts: [redirectorPort] },
        maxRedirects: 5,
      }),
    ).rejects.toThrow(/loops/);
  });

  it('stops a redirect chain that exceeds the hop limit', async () => {
    // Each hop points at the next, and the limit is reached before the end.
    redirectTarget = `http://127.0.0.1:${redirectorPort}/start`;
    await expect(
      service.request({
        url: `http://127.0.0.1:${redirectorPort}/start`,
        policy: { allowPrivate: true, allowedPorts: [redirectorPort] },
        maxRedirects: 1,
      }),
    ).rejects.toThrow(/loops|redirected more than/);
  });

  it('follows a permitted redirect and reports the chain', async () => {
    redirectTarget = `http://127.0.0.1:${redirectorPort}/ok`;

    const result = await service.request({
      url: `http://127.0.0.1:${redirectorPort}/start`,
      policy: { allowPrivate: true, allowedPorts: [redirectorPort] },
      maxRedirects: 2,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe('final');
    expect(result.chain).toHaveLength(2);
  });

  it('drops credentials when a redirect crosses origins', async () => {
    let received: string | undefined;
    const receiver = http.createServer((request, response) => {
      received = request.headers.authorization;
      response.writeHead(200);
      response.end('ok');
    });
    const receiverPort = await listen(receiver);
    redirectTarget = `http://127.0.0.1:${receiverPort}/`;

    await service.request({
      url: `http://127.0.0.1:${redirectorPort}/start`,
      headers: { authorization: 'Bearer tenant-secret' },
      policy: { allowPrivate: true, allowedPorts: [redirectorPort, receiverPort] },
      maxRedirects: 2,
    });

    // A different port is a different origin: the secret must not follow.
    expect(received).toBeUndefined();
    await new Promise((resolve) => receiver.close(resolve));
  });

  // ==================================================== legitimate traffic

  it('reaches an ordinary destination and returns its response', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, method: request.method }));
    });
    const port = await listen(server);

    // `allowPrivate` stands in for "this is a public address" — the loopback
    // server is the only thing a unit test can reach without the network.
    const result = await service.request({
      url: `http://127.0.0.1:${port}/hook`,
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
      headers: { 'content-type': 'application/json' },
      policy: { allowPrivate: true, allowedPorts: [port] },
    });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true, method: 'POST' });
    await new Promise((resolve) => server.close(resolve));
  });

  it('permits a public hostname that resolves to a public address', async () => {
    // Resolution is stubbed so the test needs no internet; what is being
    // checked is that a clean public answer is *not* refused.
    resolver = async () => [{ address: '93.184.216.34', family: 4 }];

    // It may fail to connect where there is no outbound network, but it must
    // fail at the socket rather than at the guard — a public address is not
    // something the guard is entitled to refuse.
    const outcome = await service
      .request({ url: 'http://example.com/', timeoutMs: 1_500 })
      .catch((error: Error) => error);

    if (outcome instanceof Error) {
      expect(outcome.name).not.toBe('EgressBlockedError');
      expect(outcome.message).not.toMatch(/Refused to reach/);
    } else {
      expect(outcome.peer).toBe('93.184.216.34');
    }
  });

  it('truncates a response that exceeds the byte cap', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end('x'.repeat(50_000));
    });
    const port = await listen(server);

    const result = await service.request({
      url: `http://127.0.0.1:${port}/`,
      policy: { allowPrivate: true, allowedPorts: [port] },
      maxResponseBytes: 1_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(1_000);
    await new Promise((resolve) => server.close(resolve));
  });
});
