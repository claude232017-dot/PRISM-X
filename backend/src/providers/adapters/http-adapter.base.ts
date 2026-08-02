import { Logger } from '@nestjs/common';
import {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  IIntelligenceProvider,
  ProviderCapabilities,
  ProviderHealth,
  ProviderRuntimeConfig,
} from '../contracts/intelligence-provider.interface';
import type { ProviderKind } from '@prisma/client';

/**
 * Raised when a vendor call fails. Carries whether a retry is worthwhile, so
 * the Provider Manager does not burn attempts on a malformed request or a bad
 * API key — only on transient conditions.
 */
export class ProviderCallError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderCallError';
  }
}

/**
 * Shared plumbing for HTTP-based vendor adapters: timeouts, error
 * classification, and JSON handling.
 *
 * Adapters below are thin on purpose. Each one maps our vendor-neutral
 * request/response shapes onto one vendor's wire format and nothing more —
 * retries, rate limiting, cost accounting, logging and failover all live in
 * the Provider Manager, so they behave identically no matter which vendor is
 * serving the call.
 */
export abstract class HttpIntelligenceAdapter implements IIntelligenceProvider {
  abstract readonly kind: ProviderKind;
  abstract readonly capabilities: ProviderCapabilities;
  protected readonly logger: Logger;

  constructor(protected readonly config: ProviderRuntimeConfig) {
    this.logger = new Logger(this.constructor.name);
  }

  abstract complete(request: CompletionRequest): Promise<CompletionResponse>;

  async embed(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new ProviderCallError(
      `${this.kind} adapter does not implement embeddings`,
      undefined,
      false,
    );
  }

  /**
   * A minimal completion is the only honest health probe: a reachable host
   * with an invalid key is not healthy for our purposes.
   */
  async healthCheck(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      await this.complete({
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 8,
      });
      return { healthy: true, latencyMs: Date.now() - startedAt, checkedAt: new Date() };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - startedAt,
        message: (error as Error).message,
        checkedAt: new Date(),
      };
    }
  }

  protected async postJson<T>(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    timeoutMs = 120_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        throw new ProviderCallError(
          `${this.kind} returned ${response.status}: ${text.slice(0, 400)}`,
          response.status,
          HttpIntelligenceAdapter.isRetryable(response.status),
        );
      }

      return text ? (JSON.parse(text) as T) : ({} as T);
    } catch (error) {
      if (error instanceof ProviderCallError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new ProviderCallError(
          `${this.kind} timed out after ${timeoutMs}ms`,
          undefined,
          true,
        );
      }
      // Network-level failures (DNS, connection reset) are worth retrying.
      throw new ProviderCallError(
        `${this.kind} request failed: ${(error as Error).message}`,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 429 and 5xx are transient. 4xx otherwise means the request or the
   * credential is wrong, and repeating it will fail identically.
   */
  private static isRetryable(status: number): boolean {
    return status === 429 || status === 408 || status >= 500;
  }

  protected requireKey(): string {
    if (!this.config.apiKey) {
      throw new ProviderCallError(
        `${this.kind} provider has no API key configured`,
        undefined,
        false,
      );
    }
    return this.config.apiKey;
  }
}
