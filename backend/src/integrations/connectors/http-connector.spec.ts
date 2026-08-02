import { interpolate, readPath, resolveTemplate } from './http-connector';
import { TriggerEngine } from '../../triggers/trigger-engine.service';
import { WebhookDispatcher } from '../../public-api/webhook-dispatcher.service';

describe('template resolution', () => {
  const input = {
    name: 'Ada',
    count: 5,
    nested: { id: 'abc', deep: { value: true } },
    list: ['x', 'y'],
  };

  it('interpolates path segments and URL-encodes them', () => {
    expect(interpolate('/repos/{{name}}/issues', input)).toBe('/repos/Ada/issues');
    expect(interpolate('/q/{{name}} test', { name: 'a b' })).toBe('/q/a%20b test');
  });

  it('substitutes an empty string for a missing value rather than "undefined"', () => {
    expect(interpolate('/x/{{missing}}', input)).toBe('/x/');
  });

  it('preserves type when a placeholder is the entire value', () => {
    const resolved = resolveTemplate({ n: '{{count}}', flag: '{{nested.deep.value}}' }, input);
    expect(resolved.n).toBe(5);
    expect(resolved.flag).toBe(true);
  });

  it('interpolates textually when a placeholder is embedded in a string', () => {
    expect(resolveTemplate({ greeting: 'Hi {{name}}!' }, input).greeting).toBe('Hi Ada!');
  });

  it('resolves recursively through objects and arrays', () => {
    const resolved = resolveTemplate(
      { outer: { inner: '{{name}}' }, items: ['{{count}}', 'literal'] },
      input,
    );
    expect((resolved.outer as Record<string, unknown>).inner).toBe('Ada');
    expect((resolved.items as unknown[])[0]).toBe(5);
    expect((resolved.items as unknown[])[1]).toBe('literal');
  });

  it('leaves non-template values untouched', () => {
    const resolved = resolveTemplate({ a: 1, b: null, c: true }, input);
    expect(resolved).toEqual({ a: 1, b: null, c: true });
  });

  it('reads dotted paths and returns undefined for a miss', () => {
    expect(readPath(input, 'nested.deep.value')).toBe(true);
    expect(readPath(input, 'nested.nope.value')).toBeUndefined();
  });
});

describe('inbound webhook signatures', () => {
  const secret = 'shhh-this-is-the-secret';
  const body = JSON.stringify({ hello: 'world' });

  it('accepts a correct signature', () => {
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(TriggerEngine.verifySignature(secret, body, sig)).toBe(true);
  });

  it('accepts the sha256= prefixed form', () => {
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(TriggerEngine.verifySignature(secret, body, `sha256=${sig}`)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    expect(TriggerEngine.verifySignature(secret, body, 'a'.repeat(64))).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', 'other-secret').update(body).digest('hex');
    expect(TriggerEngine.verifySignature(secret, body, sig)).toBe(false);
  });

  it('rejects a missing signature rather than defaulting to trust', () => {
    expect(TriggerEngine.verifySignature(secret, body, undefined)).toBe(false);
  });

  it('rejects when the body has been altered', () => {
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(TriggerEngine.verifySignature(secret, `${body} `, sig)).toBe(false);
  });

  it('generates paths long enough not to be guessable', () => {
    const path = TriggerEngine.generateWebhookPath();
    expect(path.length).toBeGreaterThanOrEqual(30);
    expect(path).not.toEqual(TriggerEngine.generateWebhookPath());
  });
});

describe('outbound webhook signatures', () => {
  const secret = 'endpoint-signing-secret';
  const body = JSON.stringify({ event: 'mission.completed' });

  it('round-trips sign and verify', () => {
    const header = WebhookDispatcher.sign(secret, Math.floor(Date.now() / 1000), body);
    expect(WebhookDispatcher.verify(secret, header, body)).toBe(true);
  });

  it('produces the documented t=,v1= format', () => {
    const header = WebhookDispatcher.sign(secret, 1_700_000_000, body);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it('rejects a stale signature, so a captured delivery cannot be replayed', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const header = WebhookDispatcher.sign(secret, old, body);
    expect(WebhookDispatcher.verify(secret, header, body, 300)).toBe(false);
  });

  it('rejects a signature over a different body', () => {
    const header = WebhookDispatcher.sign(secret, Math.floor(Date.now() / 1000), body);
    expect(WebhookDispatcher.verify(secret, header, '{"tampered":true}')).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(WebhookDispatcher.verify(secret, 'garbage', body)).toBe(false);
  });
});

describe('cron scheduling', () => {
  const at = (iso: string) => new Date(iso);

  it('uses an exact interval when one is set', () => {
    const next = TriggerEngine.nextRun(
      { cron: null, intervalSeconds: 300 },
      at('2026-08-02T10:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-02T10:05:00.000Z');
  });

  it('prefers the interval over a cron expression when both are set', () => {
    const next = TriggerEngine.nextRun(
      { cron: '0 0 * * *', intervalSeconds: 60 },
      at('2026-08-02T10:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-02T10:01:00.000Z');
  });

  it('resolves a daily cron to the next matching time', () => {
    const next = TriggerEngine.nextRun(
      { cron: '0 6 * * *', intervalSeconds: null },
      at('2026-08-02T10:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-03T06:00:00.000Z');
  });

  it('resolves an hourly cron', () => {
    const next = TriggerEngine.nextRun(
      { cron: '0 * * * *', intervalSeconds: null },
      at('2026-08-02T10:17:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-02T11:00:00.000Z');
  });

  it('supports step expressions', () => {
    const next = TriggerEngine.nextRun(
      { cron: '*/15 * * * *', intervalSeconds: null },
      at('2026-08-02T10:02:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-02T10:15:00.000Z');
  });

  it('falls back to hourly for an unparseable expression rather than never firing', () => {
    const from = at('2026-08-02T10:00:00Z');
    const next = TriggerEngine.nextRun({ cron: 'not a cron', intervalSeconds: null }, from);
    expect(next.getTime() - from.getTime()).toBe(3_600_000);
  });
});
