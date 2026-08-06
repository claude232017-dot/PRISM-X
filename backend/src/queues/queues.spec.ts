import { QueueService, QueueUnavailableError } from './queues.module';

/**
 * The queue's behaviour when Redis is not there.
 *
 * These exist because of a measured failure, not a hypothetical one. With
 * ioredis defaults — retry forever, `enableOfflineQueue: true` — a producer
 * command issued while Redis was unreachable neither resolved nor rejected:
 * `POST /missions/:id/execute` returned nothing after 45 seconds and
 * `GET /queues/statistics` nothing after 30, each holding a request handler
 * for the duration. A queue that is down has to fail, and fail quickly.
 */

const target = { host: '127.0.0.1', port: 6379 };

describe('producer connection', () => {
  const options = QueueService.producerConnection(target);

  it('refuses to buffer commands while disconnected', () => {
    // The single most important line. With the offline queue enabled, `add()`
    // is accepted into a buffer that is flushed on reconnect — which, if the
    // reconnect never happens, is a promise that never settles.
    expect(options.enableOfflineQueue).toBe(false);
  });

  it('bounds both the per-command retries and the reconnect loop', () => {
    expect(options.maxRetriesPerRequest).toBe(1);
    expect(options.connectTimeout).toBeLessThanOrEqual(10_000);

    // A retry strategy that always returns a delay reconnects forever. This
    // one has to give up, and the test walks it far enough to prove it does.
    expect(options.retryStrategy(1)).not.toBeNull();
    expect(options.retryStrategy(6)).toBeNull();
    expect(options.retryStrategy(100)).toBeNull();
  });

  it('caps the backoff so a long outage does not sleep for minutes', () => {
    const delays = [1, 2, 3, 4, 5].map((n) => options.retryStrategy(n) ?? 0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(2_000);
  });

  it('carries the target through unchanged', () => {
    expect(options.host).toBe('127.0.0.1');
    expect(options.port).toBe(6379);
  });
});

describe('worker connection', () => {
  it('keeps the retrying connection BullMQ requires', () => {
    // Not an oversight and not a copy-paste miss. A Worker issues blocking
    // commands (BRPOPLPUSH) and BullMQ throws at construction if given
    // anything but null here. With Redis down the worker consumes nothing,
    // which is harmless — the failure that reaches a user is the producer's.
    expect(QueueService.workerConnection(target).maxRetriesPerRequest).toBeNull();
  });

  it('differs from the producer on exactly that point', () => {
    const producer = QueueService.producerConnection(target);
    const worker = QueueService.workerConnection(target);
    expect(worker.maxRetriesPerRequest).not.toBe(producer.maxRetriesPerRequest);
    expect(worker.host).toBe(producer.host);
    expect(worker.port).toBe(producer.port);
  });
});

describe('QueueUnavailableError', () => {
  it('names the dependency and the variables to check', () => {
    // The message is the whole value of the error. An operator reading it at
    // 3am should not have to open the mission code to learn that the thing
    // that is down is Redis.
    const error = new QueueUnavailableError('connect ECONNREFUSED 127.0.0.1:6379');
    expect(error.message).toContain('Redis');
    expect(error.message).toContain('REDIS_HOST');
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.name).toBe('QueueUnavailableError');
  });

  it('is identifiable by instance, so the 503 mapping cannot catch too much', () => {
    // `mission-queue.service.ts` rethrows anything that is not this type. A
    // bug in the orchestrator must not be reported as "the queue is down".
    expect(new QueueUnavailableError('x')).toBeInstanceOf(QueueUnavailableError);
    expect(new Error('x')).not.toBeInstanceOf(QueueUnavailableError);
  });
});
