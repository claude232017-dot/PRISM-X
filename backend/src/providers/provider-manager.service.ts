import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Provider, ProviderKind, ProviderStatus } from '@prisma/client';
import {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderNotImplementedError,
} from './contracts/intelligence-provider.interface';
import { ProviderRegistry } from './provider-registry.service';
import { ProviderCallError } from './adapters/http-adapter.base';
import { openAiFactory, customOpenAiFactory } from './adapters/openai.adapter';
import { anthropicFactory } from './adapters/anthropic.adapter';
import { geminiFactory } from './adapters/gemini.adapter';
import { hermesFactory, ollamaFactory } from './adapters/hermes-ollama.adapter';
import { simulationFactory } from './adapters/simulation.adapter';
import { DEFAULT_MODEL, PricingOverride, estimateCost } from './model-catalogue';
import { ProviderRepository } from '../database/repositories/tenant.repositories';
import { CacheService } from '../shared/cache/cache.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';

export interface ManagedCompletionRequest extends CompletionRequest {
  /** Explicit provider. Omit to use the organization's default. */
  providerId?: string;
  /** Allow falling back to another healthy provider if this one fails. */
  allowFailover?: boolean;
}

export interface ManagedCompletionResult extends CompletionResponse {
  providerId: string;
  providerKind: ProviderKind;
  costUsd: number;
  latencyMs: number;
  /** Provider attempts consumed, including retries and any failover. */
  attempts: number;
  /** Set when the request was served by a provider other than the one asked for. */
  failedOverFrom?: string;
}

/**
 * The single gateway through which every AI call passes.
 *
 * Nothing above this class knows which vendor served a request. That is the
 * point: worker runtime, mission orchestration and tools all call
 * `complete()`, and this class decides which provider to use, enforces its
 * rate limits, retries transient failures, fails over when a provider is down,
 * and records what it cost.
 *
 * Concentrating those concerns here is what makes them uniform. If retries
 * lived in the adapters, each vendor would retry slightly differently and
 * nobody would be able to say what the system's actual behaviour was.
 */
@Injectable()
export class ProviderManager implements OnModuleInit {
  private readonly logger = new Logger(ProviderManager.name);

  private static readonly MAX_ATTEMPTS = 3;
  private static readonly BASE_BACKOFF_MS = 400;
  /** How long a provider is benched after repeated failures. */
  private static readonly COOLDOWN_MS = 60_000;
  private static readonly FAILURES_BEFORE_COOLDOWN = 3;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly providers: ProviderRepository,
    private readonly cache: CacheService,
    private readonly events: EventBusService,
  ) {}

  /**
   * Registers every vendor adapter at boot.
   *
   * Phase 1 shipped this registry empty by design; Phase 2 fills it. Because
   * registration is the only coupling point, adding a vendor later is one
   * factory and one line here.
   */
  onModuleInit(): void {
    [
      openAiFactory,
      anthropicFactory,
      geminiFactory,
      hermesFactory,
      ollamaFactory,
      customOpenAiFactory,
      simulationFactory,
    ].forEach((factory) => this.registry.register(factory));
  }

  // ----------------------------------------------------------------
  // Completion
  // ----------------------------------------------------------------

  async complete(request: ManagedCompletionRequest): Promise<ManagedCompletionResult> {
    const primary = await this.selectProvider(request.providerId);
    const startedAt = Date.now();

    try {
      return await this.callWithRetries(primary, request, startedAt, 0);
    } catch (error) {
      if (!request.allowFailover) throw error;

      const alternate = await this.selectFailover(primary.id);
      if (!alternate) throw error;

      this.logger.warn(
        `Failing over from ${primary.name} to ${alternate.name}: ${(error as Error).message}`,
      );
      const result = await this.callWithRetries(alternate, request, startedAt, 0);
      return { ...result, failedOverFrom: primary.id };
    }
  }

  /**
   * One provider, up to MAX_ATTEMPTS times with exponential backoff.
   *
   * Only failures the adapter classified as retryable are retried — a 401 or a
   * malformed request will fail identically on a second attempt, and retrying
   * it just delays the error the caller needs to see.
   */
  private async callWithRetries(
    provider: Provider,
    request: ManagedCompletionRequest,
    startedAt: number,
    attemptOffset: number,
  ): Promise<ManagedCompletionResult> {
    const adapter = await this.registry.resolve(provider.id);
    const model = this.resolveModel(provider, request.model);
    let lastError: unknown;

    for (let attempt = 1; attempt <= ProviderManager.MAX_ATTEMPTS; attempt++) {
      await this.enforceRateLimit(provider);

      try {
        const response = await adapter.complete({ ...request, model });
        const latencyMs = Date.now() - startedAt;
        const costUsd = estimateCost(
          provider.kind,
          response.model || model,
          response.usage.promptTokens,
          response.usage.completionTokens,
          this.pricingOverrides(provider),
        );

        await this.recordSuccess(provider, latencyMs, response.usage.totalTokens, costUsd);

        return {
          ...response,
          providerId: provider.id,
          providerKind: provider.kind,
          costUsd,
          latencyMs,
          attempts: attemptOffset + attempt,
        };
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ProviderCallError ? error.retryable : false;

        if (!retryable || attempt === ProviderManager.MAX_ATTEMPTS) break;

        const backoff = ProviderManager.BASE_BACKOFF_MS * 2 ** (attempt - 1);
        this.logger.warn(
          `${provider.name} attempt ${attempt} failed (${(error as Error).message}); ` +
            `retrying in ${backoff}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    await this.recordFailure(provider, lastError as Error);
    throw lastError;
  }

  async embed(request: EmbeddingRequest & { providerId?: string }): Promise<
    EmbeddingResponse & { providerId: string }
  > {
    const provider = await this.selectProvider(request.providerId);
    const adapter = await this.registry.resolve(provider.id);

    if (!adapter.capabilities.embeddings) {
      throw new BadRequestException(
        `Provider "${provider.name}" (${provider.kind}) does not support embeddings`,
      );
    }

    const response = await adapter.embed(request);
    return { ...response, providerId: provider.id };
  }

  // ----------------------------------------------------------------
  // Selection
  // ----------------------------------------------------------------

  /** Named provider, or the org default. Refuses one that is cooling down. */
  private async selectProvider(providerId?: string): Promise<Provider> {
    const provider = providerId
      ? await this.providers.findByIdOrFail(providerId)
      : await this.providers.findDefault();

    if (!provider) {
      throw new BadRequestException(
        'No intelligence provider is configured for this organization. ' +
          'Register one via POST /providers and mark it default.',
      );
    }

    if (!this.registry.isRegistered(provider.kind)) {
      throw new ProviderNotImplementedError(provider.kind);
    }

    if (provider.cooldownUntil && provider.cooldownUntil > new Date()) {
      throw new BadRequestException(
        `Provider "${provider.name}" is in cooldown until ` +
          `${provider.cooldownUntil.toISOString()} after repeated failures`,
      );
    }

    return provider;
  }

  /** Any other connected, non-cooling provider in the organization. */
  private async selectFailover(excludeId: string): Promise<Provider | null> {
    const candidates = await this.providers.findMany(
      { status: ProviderStatus.CONNECTED },
      { orderBy: { isDefault: 'desc' } },
    );

    const now = new Date();
    return (
      candidates.find(
        (p) =>
          p.id !== excludeId &&
          this.registry.isRegistered(p.kind) &&
          (!p.cooldownUntil || p.cooldownUntil <= now),
      ) ?? null
    );
  }

  private resolveModel(provider: Provider, requested?: string): string {
    const model =
      requested ?? provider.defaultModel ?? DEFAULT_MODEL[provider.kind] ?? 'default';

    // An explicit allow-list means exactly that: a caller may not reach a
    // model the operator did not sanction for this provider.
    if (provider.models.length > 0 && !provider.models.includes(model)) {
      throw new BadRequestException(
        `Model "${model}" is not enabled for provider "${provider.name}". ` +
          `Allowed: ${provider.models.join(', ')}`,
      );
    }
    return model;
  }

  private pricingOverrides(provider: Provider): Record<string, PricingOverride> | undefined {
    const config = (provider.config ?? {}) as { pricing?: Record<string, PricingOverride> };
    return config.pricing;
  }

  // ----------------------------------------------------------------
  // Rate limiting
  // ----------------------------------------------------------------

  /**
   * Fixed-window limiter in Redis, keyed per provider per minute.
   *
   * Deliberately simple: the goal is to stay under a vendor's ceiling, and a
   * fixed window does that with one INCR. It permits a burst across a window
   * boundary, which is acceptable here because the vendor's own 429 plus our
   * retry logic is the real backstop — this exists to avoid provoking it.
   *
   * When Redis is unavailable the limiter yields rather than blocking: losing
   * the cache should slow the system down, not stop it.
   */
  private async enforceRateLimit(provider: Provider): Promise<void> {
    if (!provider.rateLimitRpm || !this.cache.isAvailable) return;

    const window = Math.floor(Date.now() / 60_000);
    const key = `ratelimit:provider:${provider.id}:${window}`;
    const used = (await this.cache.get<number>(key)) ?? 0;

    if (used >= provider.rateLimitRpm) {
      throw new ProviderCallError(
        `Rate limit reached for "${provider.name}" (${provider.rateLimitRpm} req/min)`,
        429,
        true,
      );
    }
    await this.cache.set(key, used + 1, 120);
  }

  // ----------------------------------------------------------------
  // Health accounting
  // ----------------------------------------------------------------

  private async recordSuccess(
    provider: Provider,
    latencyMs: number,
    tokens: number,
    costUsd: number,
  ): Promise<void> {
    // Exponential moving average: recent latency matters more than a mean
    // over all time, which would take days to reflect a degradation.
    const previous = provider.avgLatencyMs ?? latencyMs;
    const avgLatencyMs = Math.round(previous * 0.8 + latencyMs * 0.2);

    const wasDown = provider.status !== ProviderStatus.CONNECTED;

    await this.providers.update(provider.id, {
      status: ProviderStatus.CONNECTED,
      avgLatencyMs,
      totalRequests: provider.totalRequests + 1,
      totalTokens: provider.totalTokens + tokens,
      totalCostUsd: Math.round((provider.totalCostUsd + costUsd) * 1e8) / 1e8,
      lastCheckedAt: new Date(),
      cooldownUntil: null,
    });

    if (wasDown) {
      await this.events.publish(DomainEvent.ProviderRecovered, {
        providerId: provider.id,
        name: provider.name,
      });
    }
  }

  private async recordFailure(provider: Provider, error: Error): Promise<void> {
    const failedRequests = provider.failedRequests + 1;

    // Consecutive-failure bookkeeping lives in Redis so a burst of failures
    // does not require a write per call to detect.
    const streakKey = `provider:failstreak:${provider.id}`;
    const streak = ((await this.cache.get<number>(streakKey)) ?? 0) + 1;
    await this.cache.set(streakKey, streak, 300);

    const shouldCool = streak >= ProviderManager.FAILURES_BEFORE_COOLDOWN;

    await this.providers.update(provider.id, {
      status: ProviderStatus.ERROR,
      failedRequests,
      totalRequests: provider.totalRequests + 1,
      lastErrorAt: new Date(),
      lastError: error.message.slice(0, 500),
      ...(shouldCool
        ? { cooldownUntil: new Date(Date.now() + ProviderManager.COOLDOWN_MS) }
        : {}),
    });

    await this.events.publish(DomainEvent.ProviderFailed, {
      providerId: provider.id,
      name: provider.name,
      error: error.message.slice(0, 300),
      consecutiveFailures: streak,
      cooldown: shouldCool,
    });

    if (shouldCool) {
      this.logger.error(
        `Provider "${provider.name}" benched for ${ProviderManager.COOLDOWN_MS}ms ` +
          `after ${streak} consecutive failures`,
      );
    }
  }

  /** Clears the failure streak — used after a manual health check succeeds. */
  async clearFailureStreak(providerId: string): Promise<void> {
    await this.cache.delete(`provider:failstreak:${providerId}`);
  }
}
