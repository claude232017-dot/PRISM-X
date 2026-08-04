import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis-backed cache.
 *
 * Every method degrades to a miss when Redis is unreachable rather than
 * throwing: the cache is an optimization, and losing it should slow the system
 * down, not take it offline. Connection failures are logged once, not per call.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private client: Redis | null = null;
  private available = false;
  private warned = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const { host, port, password } = this.config.get('redis') as {
      host: string;
      port: number;
      password?: string;
    };

    this.client = new Redis({
      host,
      port,
      password,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
    });

    this.client.on('ready', () => {
      this.available = true;
      this.warned = false;
      this.logger.log(`Cache connected (${host}:${port})`);
    });
    this.client.on('error', (error) => {
      this.available = false;
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(`Cache unavailable, operating without it: ${error.message}`);
      }
    });

    void this.client.connect().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  get isAvailable(): boolean {
    return this.available;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.available || !this.client) return null;
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    if (!this.available || !this.client) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      /* cache writes are best-effort */
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.available || !this.client) return;
    try {
      await this.client.del(key);
    } catch {
      /* ignore */
    }
  }

  /**
   * Deletes every key under a prefix using SCAN rather than KEYS — KEYS blocks
   * the Redis event loop and is unsafe against a production-sized keyspace.
   */
  async deleteByPrefix(prefix: string): Promise<void> {
    if (!this.available || !this.client) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.client.scan(
          cursor,
          'MATCH',
          `${prefix}*`,
          'COUNT',
          100,
        );
        cursor = next;
        if (keys.length) await this.client.del(...keys);
      } while (cursor !== '0');
    } catch {
      /* ignore */
    }
  }

  /**
   * Atomically increments a counter, setting its expiry on first use.
   *
   * Returns null — rather than a number — when Redis is unavailable, because
   * the caller needs to be able to tell "the count is 1" from "there is no
   * shared counter right now". A rate limiter that cannot tell those apart
   * fails open, which is the one failure mode a rate limiter must not have;
   * the null lets the caller fall back to a local count instead.
   */
  async increment(key: string, ttlSeconds: number): Promise<number | null> {
    if (!this.available || !this.client) return null;
    try {
      const value = await this.client.incr(key);
      if (value === 1) await this.client.expire(key, ttlSeconds);
      return value;
    } catch {
      return null;
    }
  }

  /** Read-through helper: returns the cached value or computes and stores it. */
  async remember<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
