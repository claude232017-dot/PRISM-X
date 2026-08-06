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
import { egress } from '../../shared/http/outbound-http.service';

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
    try {
      // `baseUrl` is provider configuration a tenant can edit, so this URL is
      // tenant-controlled even though the adapter looks like platform code —
      // and the request carries the tenant's decrypted API key. Without the
      // guard, a CUSTOM provider pointed at the metadata endpoint would fetch
      // the platform's own cloud credentials and hand back the response.
      const response = await egress().request({
        url,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        timeoutMs,
        // Model APIs do not redirect; following one would only ever move a
        // credential somewhere it was not addressed to.
        maxRedirects: 0,
        maxResponseBytes: 8 * 1024 * 1024,
      });

      const text = response.body;
      const ok = response.status >= 200 && response.status < 300;

      if (!ok) {
        throw new ProviderCallError(
          `${this.kind} returned ${response.status}: ${text.slice(0, 400)}`,
          response.status,
          HttpIntelligenceAdapter.isRetryable(response.status),
        );
      }

      return text ? (JSON.parse(text) as T) : ({} as T);
    } catch (error) {
      if (error instanceof ProviderCallError) throw error;
      if (
        (error as Error).name === 'AbortError' ||
        /timed out/i.test((error as Error).message)
      ) {
        throw new ProviderCallError(
          `${this.kind} timed out after ${timeoutMs}ms`,
          undefined,
          true,
        );
      }
      // A destination the egress guard refused is a configuration error, not
      // a transient one — retrying a blocked address just blocks again.
      if ((error as Error).name === 'EgressBlockedError') {
        throw new ProviderCallError((error as Error).message, undefined, false);
      }
      // Network-level failures (DNS, connection reset) are worth retrying.
      throw new ProviderCallError(
        `${this.kind} request failed: ${(error as Error).message}`,
        undefined,
        true,
      );
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
