import { MetricsService } from './metrics.service';
import { SecurityService } from './security.service';

describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('accumulates counters per label set', () => {
    metrics.increment('req', { route: '/a' });
    metrics.increment('req', { route: '/a' });
    metrics.increment('req', { route: '/b' });

    expect(metrics.value('req', { route: '/a' })).toBe(2);
    expect(metrics.value('req', { route: '/b' })).toBe(1);
    expect(metrics.total('req')).toBe(3);
  });

  it('treats label order as insignificant, so the same labels are the same series', () => {
    metrics.increment('req', { a: '1', b: '2' });
    metrics.increment('req', { b: '2', a: '1' });
    expect(metrics.value('req', { a: '1', b: '2' })).toBe(2);
  });

  it('ignores empty label values rather than creating a distinct series', () => {
    metrics.increment('req', { route: '/a', extra: '' });
    metrics.increment('req', { route: '/a' });
    expect(metrics.value('req', { route: '/a' })).toBe(2);
  });

  it('replaces a gauge rather than accumulating it', () => {
    metrics.set('depth', 5);
    metrics.set('depth', 2);
    expect(metrics.value('depth')).toBe(2);
  });

  it('computes exact percentiles over the observations', () => {
    for (let i = 1; i <= 100; i += 1) metrics.observe('latency', i);
    expect(metrics.percentile('latency', 0.5)).toBe(50);
    expect(metrics.percentile('latency', 0.95)).toBe(95);
    expect(metrics.percentile('latency', 0.99)).toBe(99);
    expect(metrics.sampleCount('latency')).toBe(100);
    expect(metrics.mean('latency')).toBeCloseTo(50.5);
  });

  it('returns null rather than zero when there is nothing to measure', () => {
    // A system with no traffic has no p95, and reporting zero would look like
    // excellent performance.
    expect(metrics.percentile('latency', 0.95)).toBeNull();
    expect(metrics.mean('latency')).toBeNull();
    expect(metrics.value('missing')).toBeNull();
  });

  it('bounds the reservoir, keeping the most recent observations', () => {
    for (let i = 0; i < 1500; i += 1) metrics.observe('latency', i);
    // The count reflects every observation; the reservoir holds the newest.
    expect(metrics.value('latency')).toBe(1500);
    expect(metrics.sampleCount('latency')).toBe(1000);
    expect(metrics.percentile('latency', 0.5)!).toBeGreaterThan(900);
  });

  it('separates percentiles by label set when asked', () => {
    for (let i = 0; i < 20; i += 1) metrics.observe('latency', 10, { route: '/fast' });
    for (let i = 0; i < 20; i += 1) metrics.observe('latency', 1000, { route: '/slow' });

    expect(metrics.percentile('latency', 0.95, { route: '/fast' })).toBe(10);
    expect(metrics.percentile('latency', 0.95, { route: '/slow' })).toBe(1000);
    // Unlabelled asks across everything.
    expect(metrics.percentile('latency', 0.95)).toBe(1000);
  });

  it('records both outcomes when timing work', async () => {
    await metrics.time('work', { kind: 'a' }, async () => 'ok');
    await expect(
      metrics.time('work', { kind: 'a' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(metrics.value('work', { kind: 'a', outcome: 'ok' })).toBe(1);
    expect(metrics.value('work', { kind: 'a', outcome: 'error' })).toBe(1);
  });

  it('emits valid Prometheus exposition', () => {
    metrics.increment('prismx_requests_total', { route: '/a' }, 3, 'Requests');
    metrics.set('prismx_depth', 7, {}, 'Queue depth');
    metrics.observe('prismx_latency_ms', 25, { route: '/a' }, 'Latency');

    const text = metrics.prometheus();
    expect(text).toContain('# HELP prismx_requests_total Requests');
    expect(text).toContain('# TYPE prismx_requests_total counter');
    expect(text).toContain('prismx_requests_total{route="/a"} 3');
    expect(text).toContain('# TYPE prismx_depth gauge');
    expect(text).toContain('prismx_depth 7');
    expect(text).toContain('prismx_latency_ms_count{route="/a"} 1');
    expect(text).toContain('prismx_latency_ms_sum{route="/a"} 25');
    expect(text).toContain('quantile="0.95"');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('sanitises metric names for the exposition format', () => {
    metrics.increment('weird.name-here', {}, 1);
    expect(metrics.prometheus()).toContain('weird_name_here');
  });

  it('summarises histograms and counters differently in a snapshot', () => {
    metrics.increment('count_total', {}, 4);
    metrics.observe('duration_ms', 10);
    const snapshot = metrics.snapshot() as {
      metrics: Record<string, Record<string, unknown>>;
    };

    expect(snapshot.metrics.count_total.total).toBe(4);
    expect(snapshot.metrics.duration_ms.p95).toBe(10);
    expect(snapshot.metrics.count_total.p95).toBeUndefined();
  });
});

describe('SecurityService.withinCidr', () => {
  it('matches a single address', () => {
    expect(SecurityService.withinCidr('203.0.113.4', '203.0.113.4')).toBe(true);
    expect(SecurityService.withinCidr('203.0.113.5', '203.0.113.4')).toBe(false);
  });

  it('matches inside a block and rejects outside it', () => {
    expect(SecurityService.withinCidr('203.0.113.4', '203.0.113.0/24')).toBe(true);
    expect(SecurityService.withinCidr('203.0.114.4', '203.0.113.0/24')).toBe(false);
    expect(SecurityService.withinCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(SecurityService.withinCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
  });

  it('handles the boundary prefixes without shifting by 32', () => {
    // `~0 << 32` is undefined behaviour in JavaScript, so /32 and /0 are the
    // two cases a naive mask gets wrong.
    expect(SecurityService.withinCidr('203.0.113.4', '203.0.113.4/32')).toBe(true);
    expect(SecurityService.withinCidr('203.0.113.5', '203.0.113.4/32')).toBe(false);
    expect(SecurityService.withinCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });

  it('rejects a malformed address rather than matching it', () => {
    expect(SecurityService.withinCidr('not-an-address', '0.0.0.0/0')).toBe(false);
  });
});
