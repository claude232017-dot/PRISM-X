import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Integration, IntegrationStatus } from '@prisma/client';
import {
  ConnectorError,
  ConnectorFactory,
  ConnectorResult,
  IConnector,
} from './connectors/connector.contract';
import { BUILT_IN_CONNECTORS } from './connectors/catalogue';
import { simulatedConnectorFactory } from './connectors/simulated.connector';
import {
  CredentialRepository,
  IntegrationRepository,
} from '../database/repositories/tenant.repositories';
import { CryptoService } from '../shared/crypto/crypto.service';
import { CacheService } from '../shared/cache/cache.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';

export interface IntegrationCallResult extends ConnectorResult {
  integrationId: string;
  action: string;
  attempts: number;
  durationMs: number;
}

/**
 * The single gateway to every external service.
 *
 * Nothing else in PRISM-X calls a third-party API. Workflows, tools and
 * missions all go through `execute()`, which means retries, circuit breaking,
 * rate limiting, credential handling and usage accounting behave identically
 * for Slack, Stripe and a bespoke REST endpoint alike — and adding a service
 * cannot accidentally introduce a variant of any of them.
 */
@Injectable()
export class IntegrationManager implements OnModuleInit {
  private readonly logger = new Logger(IntegrationManager.name);
  private readonly factories = new Map<string, ConnectorFactory>();

  private static readonly MAX_ATTEMPTS = 3;
  private static readonly BASE_BACKOFF_MS = 300;
  private static readonly COOLDOWN_MS = 60_000;
  private static readonly FAILURES_BEFORE_COOLDOWN = 5;

  constructor(
    private readonly integrations: IntegrationRepository,
    private readonly credentials: CredentialRepository,
    private readonly crypto: CryptoService,
    private readonly cache: CacheService,
    private readonly events: EventBusService,
  ) {}

  onModuleInit(): void {
    [...BUILT_IN_CONNECTORS, simulatedConnectorFactory].forEach((f) => this.register(f));
    this.logger.log(
      `Registered ${this.factories.size} connectors: ${[...this.factories.keys()].join(', ')}`,
    );
  }

  register(factory: ConnectorFactory): void {
    if (this.factories.has(factory.kind)) {
      this.logger.warn(`Replacing existing connector "${factory.kind}"`);
    }
    this.factories.set(factory.kind, factory);
  }

  isRegistered(kind: string): boolean {
    return this.factories.has(kind);
  }

  /** The connector catalogue, for the UI and for workflow authoring. */
  catalogue() {
    return [...this.factories.values()].map((f) => ({
      kind: f.kind,
      displayName: f.displayName,
      category: f.category,
      authMethod: f.authMethod,
      actions: f.actions,
    }));
  }

  /** Builds a live connector for a stored integration, decrypting its secret. */
  async resolve(integrationId: string): Promise<IConnector> {
    const integration = await this.integrations.findByIdOrFail(integrationId);
    return this.build(integration);
  }

  private async build(integration: Integration): Promise<IConnector> {
    const factory = this.factories.get(integration.kind);
    if (!factory) {
      throw new BadRequestException(
        `No connector is registered for "${integration.kind}". Available: ` +
          [...this.factories.keys()].join(', '),
      );
    }

    let secret: string | undefined;
    if (integration.credentialId) {
      const credential = await this.credentials.findById(integration.credentialId);
      if (credential) {
        // Decryption happens here and nowhere else.
        secret = this.crypto.open({
          value: credential.value,
          iv: credential.iv,
          authTag: credential.authTag,
        });
        await this.credentials.touch(credential.id);
      }
    }

    return factory.create({
      integrationId: integration.id,
      secret,
      options: (integration.config ?? {}) as Record<string, unknown>,
      permissions: integration.permissions,
    });
  }

  /**
   * Runs one connector action with the full reliability envelope.
   *
   * Retries only failures the connector marked retryable — a 401 or a missing
   * required field will fail identically on a second attempt, and retrying it
   * just delays the error the caller needs.
   */
  async execute(
    integrationId: string,
    action: string,
    input: Record<string, unknown> = {},
  ): Promise<IntegrationCallResult> {
    const integration = await this.integrations.findByIdOrFail(integrationId);
    const startedAt = Date.now();

    if (integration.cooldownUntil && integration.cooldownUntil > new Date()) {
      throw new BadRequestException(
        `Integration "${integration.name}" is in cooldown until ` +
          `${integration.cooldownUntil.toISOString()} after repeated failures`,
      );
    }
    if (integration.status !== IntegrationStatus.ACTIVE) {
      throw new BadRequestException(
        `Integration "${integration.name}" is ${integration.status}; activate it first`,
      );
    }

    await this.enforceRateLimit(integration);

    const connector = await this.build(integration);
    await connector.connect();

    let lastError: unknown;
    try {
      for (let attempt = 1; attempt <= IntegrationManager.MAX_ATTEMPTS; attempt++) {
        try {
          const result = await connector.execute(action, input);
          const durationMs = Date.now() - startedAt;

          await this.recordSuccess(integration, durationMs);
          await this.events.publish(DomainEvent.IntegrationCallSucceeded, {
            integrationId,
            kind: integration.kind,
            action,
            durationMs,
            attempts: attempt,
          });

          return { ...result, integrationId, action, attempts: attempt, durationMs };
        } catch (error) {
          lastError = error;
          const retryable = error instanceof ConnectorError ? error.retryable : false;
          if (!retryable || attempt === IntegrationManager.MAX_ATTEMPTS) break;

          const backoff = IntegrationManager.BASE_BACKOFF_MS * 2 ** (attempt - 1);
          this.logger.warn(
            `${integration.name}.${action} attempt ${attempt} failed ` +
              `(${(error as Error).message}); retrying in ${backoff}ms`,
          );
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    } finally {
      await connector.disconnect().catch(() => undefined);
    }

    await this.recordFailure(integration, lastError as Error);
    const durationMs = Date.now() - startedAt;

    await this.events.publish(DomainEvent.IntegrationCallFailed, {
      integrationId,
      kind: integration.kind,
      action,
      error: (lastError as Error).message.slice(0, 300),
    });

    return {
      ok: false,
      error: (lastError as Error).message,
      integrationId,
      action,
      attempts: IntegrationManager.MAX_ATTEMPTS,
      durationMs,
    };
  }

  /** Probes an integration and records the verdict. */
  async healthCheck(integrationId: string) {
    const integration = await this.integrations.findByIdOrFail(integrationId);

    if (!this.factories.has(integration.kind)) {
      return {
        integrationId,
        healthy: false,
        message: `No connector registered for "${integration.kind}"`,
        checkedAt: new Date(),
      };
    }

    const connector = await this.build(integration);
    const health = await connector.healthCheck();

    await this.integrations.update(integrationId, {
      healthy: health.healthy,
      lastHealthAt: health.checkedAt,
      lastError: health.healthy ? null : (health.message ?? null),
      ...(health.healthy ? { cooldownUntil: null } : {}),
    });

    if (health.healthy) await this.cache.delete(`integration:failstreak:${integrationId}`);

    return { integrationId, ...health };
  }

  /** Configuration check that contacts nothing. */
  async validate(integrationId: string) {
    const integration = await this.integrations.findByIdOrFail(integrationId);
    if (!this.factories.has(integration.kind)) {
      return { valid: false, errors: [`No connector registered for "${integration.kind}"`] };
    }
    const connector = await this.build(integration);
    return connector.validate();
  }

  /** Actions this integration's connector supports. */
  async actions(integrationId: string) {
    const integration = await this.integrations.findByIdOrFail(integrationId);
    const factory = this.factories.get(integration.kind);
    if (!factory) return [];

    const granted = integration.permissions;
    return factory.actions.map((a) => ({
      ...a,
      permitted: granted.length === 0 || granted.includes(a.requires),
    }));
  }

  // ----------------------------------------------------------------
  // Reliability bookkeeping
  // ----------------------------------------------------------------

  private async enforceRateLimit(integration: Integration): Promise<void> {
    const config = (integration.config ?? {}) as { rateLimitPerMinute?: number };
    const limit = config.rateLimitPerMinute;
    if (!limit || !this.cache.isAvailable) return;

    const window = Math.floor(Date.now() / 60_000);
    const key = `ratelimit:integration:${integration.id}:${window}`;
    const used = (await this.cache.get<number>(key)) ?? 0;

    if (used >= limit) {
      throw new BadRequestException(
        `Rate limit reached for "${integration.name}" (${limit} calls/min)`,
      );
    }
    await this.cache.set(key, used + 1, 120);
  }

  private async recordSuccess(integration: Integration, durationMs: number): Promise<void> {
    const previous = integration.avgLatencyMs ?? durationMs;
    await this.integrations.update(integration.id, {
      callCount: integration.callCount + 1,
      // EMA: a recent slowdown should show up in minutes, not be diluted by
      // an all-time mean.
      avgLatencyMs: Math.round(previous * 0.8 + durationMs * 0.2),
      healthy: true,
      lastSyncAt: new Date(),
      cooldownUntil: null,
      lastError: null,
    });
    await this.cache.delete(`integration:failstreak:${integration.id}`);
  }

  private async recordFailure(integration: Integration, error: Error): Promise<void> {
    const key = `integration:failstreak:${integration.id}`;
    const streak = ((await this.cache.get<number>(key)) ?? 0) + 1;
    await this.cache.set(key, streak, 300);

    const trip = streak >= IntegrationManager.FAILURES_BEFORE_COOLDOWN;

    await this.integrations.update(integration.id, {
      callCount: integration.callCount + 1,
      failureCount: integration.failureCount + 1,
      healthy: false,
      lastError: error.message.slice(0, 500),
      ...(trip
        ? {
            status: IntegrationStatus.ERROR,
            cooldownUntil: new Date(Date.now() + IntegrationManager.COOLDOWN_MS),
          }
        : {}),
    });

    if (trip) {
      this.logger.error(
        `Integration "${integration.name}" benched for ${IntegrationManager.COOLDOWN_MS}ms ` +
          `after ${streak} consecutive failures`,
      );
      await this.events.publish(DomainEvent.IntegrationFailed, {
        integrationId: integration.id,
        name: integration.name,
        consecutiveFailures: streak,
        error: error.message.slice(0, 300),
      });
    }
  }
}
