import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ApiKey } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { ApiKeyRepository } from '../database/repositories/automation.repositories';
import { CacheService } from '../shared/cache/cache.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { AuthService } from '../auth/auth.service';

export interface IssuedApiKey {
  id: string;
  name: string;
  /** The full key. Returned once, at creation, and never again. */
  key: string;
  prefix: string;
  scopes: string[];
  expiresAt: Date | null;
}

export interface ResolvedApiKey {
  apiKeyId: string;
  organizationId: string;
  scopes: string[];
  rateLimitPerMinute: number;
}

/**
 * API keys for programmatic access.
 *
 * Only a SHA-256 hash is stored. A stolen database therefore yields nothing
 * usable, and the plaintext exists exactly once — in the creation response.
 * That is a deliberate trade: a key that can be re-read is a key that can be
 * leaked twice.
 *
 * Scopes are `resource:action` strings drawn from the same catalogue as user
 * permissions, so a key can never do something the permission model does not
 * already describe.
 */
@Injectable()
export class ApiKeyService implements OnModuleInit {
  private readonly logger = new Logger(ApiKeyService.name);
  private static readonly PREFIX = 'px';
  private static readonly CACHE_TTL = 60;

  constructor(
    private readonly keys: ApiKeyRepository,
    private readonly cache: CacheService,
    private readonly events: EventBusService,
    private readonly auth: AuthService,
  ) {}

  onModuleInit(): void {
    // Hands the auth guard a way to turn a presented key into a principal,
    // without the guard needing to know this service exists.
    this.auth.onApiKeyResolver((presented) => this.resolve(presented));
  }

  async issue(input: {
    name: string;
    scopes?: string[];
    rateLimitPerMinute?: number;
    expiresInDays?: number;
  }): Promise<IssuedApiKey> {
    const ctx = RequestContextStore.require();

    // 32 random bytes: far beyond guessing, and base64url so it survives
    // headers, query strings and shell copy-paste intact.
    const secret = randomBytes(32).toString('base64url');
    const key = `${ApiKeyService.PREFIX}_${secret}`;
    const keyHash = ApiKeyService.hash(key);

    const record = await this.keys.create({
      name: input.name,
      keyHash,
      prefix: key.slice(0, 10),
      scopes: input.scopes ?? [],
      rateLimitPerMinute: input.rateLimitPerMinute ?? 120,
      createdById: ctx.userId,
      expiresAt: input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null,
    });

    await this.events.publish(DomainEvent.ApiKeyCreated, {
      apiKeyId: record.id,
      name: record.name,
      scopes: record.scopes,
    });

    return {
      id: record.id,
      name: record.name,
      key,
      prefix: record.prefix,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Resolves a presented key to its organization and scopes.
   *
   * Cached briefly: an API caller may make many requests a second, and hitting
   * the database for each one to re-derive the same answer is waste. The TTL is
   * short so a revoked key stops working promptly.
   */
  async resolve(presented: string): Promise<ResolvedApiKey> {
    const keyHash = ApiKeyService.hash(presented);

    const cached = await this.cache.get<ResolvedApiKey>(`apikey:${keyHash}`);
    if (cached) {
      void this.keys
        .recordUse(cached.apiKeyId, cached.organizationId)
        .catch(() => undefined);
      return cached;
    }

    const record = await this.keys.findByHashUnscoped(keyHash);
    if (!record) throw new UnauthorizedException('Invalid API key');

    if (record.expiresAt && record.expiresAt <= new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    const resolved: ResolvedApiKey = {
      apiKeyId: record.id,
      organizationId: record.organizationId,
      scopes: record.scopes,
      rateLimitPerMinute: record.rateLimitPerMinute,
    };

    await this.cache.set(`apikey:${keyHash}`, resolved, ApiKeyService.CACHE_TTL);
    await this.keys.recordUse(record.id, record.organizationId);
    return resolved;
  }

  /**
   * Fixed-window rate limit per key.
   *
   * Fails open when Redis is unavailable: losing the cache should slow the
   * system, not lock every API client out.
   */
  async withinRateLimit(resolved: ResolvedApiKey): Promise<boolean> {
    if (!this.cache.isAvailable) return true;

    const window = Math.floor(Date.now() / 60_000);
    const key = `ratelimit:apikey:${resolved.apiKeyId}:${window}`;
    const used = (await this.cache.get<number>(key)) ?? 0;

    if (used >= resolved.rateLimitPerMinute) return false;
    await this.cache.set(key, used + 1, 120);
    return true;
  }

  list(): Promise<ApiKey[]> {
    return this.keys.findMany({}, { orderBy: { createdAt: 'desc' } });
  }

  /** Revokes a key immediately, including its cached resolution. */
  async revoke(id: string): Promise<{ revoked: true }> {
    const record = await this.keys.findByIdOrFail(id);
    await this.keys.update(id, { revokedAt: new Date() });
    await this.cache.delete(`apikey:${record.keyHash}`);

    await this.events.publish(DomainEvent.ApiKeyRevoked, { apiKeyId: id, name: record.name });
    return { revoked: true };
  }

  async statistics() {
    const keys = await this.keys.findMany({}, { take: 200 });
    const active = keys.filter((k) => !k.revokedAt && (!k.expiresAt || k.expiresAt > new Date()));

    return {
      total: keys.length,
      active: active.length,
      revoked: keys.filter((k) => k.revokedAt).length,
      totalRequests: keys.reduce((sum, k) => sum + k.requestCount, 0),
      byKey: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        requests: k.requestCount,
        lastUsedAt: k.lastUsedAt,
        revoked: Boolean(k.revokedAt),
      })),
    };
  }

  static hash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
}
