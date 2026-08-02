import type { ProviderKind } from '@prisma/client';

/**
 * The contract every AI vendor adapter implements.
 *
 * Phase 1 deliberately ships no vendor SDK. What exists here is the seam:
 * business logic depends on this interface, and adding OpenAI or Anthropic
 * later means writing one adapter and registering it — no changes to missions,
 * workers, or anything else that consumes intelligence.
 *
 * The shapes are intentionally vendor-neutral. Nothing here mirrors a
 * particular provider's request format, because the first adapter written
 * against a leaky abstraction silently becomes the abstraction.
 */

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: CompletionMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Vendor-specific escape hatch. Adapters ignore keys they don't understand. */
  options?: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionResponse {
  content: string;
  model: string;
  usage: TokenUsage;
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
  /** Untouched vendor response, for debugging and cost reconciliation. */
  raw?: unknown;
}

export interface EmbeddingRequest {
  input: string | string[];
  model?: string;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage: Pick<TokenUsage, 'promptTokens' | 'totalTokens'>;
}

export interface ProviderHealth {
  healthy: boolean;
  latencyMs?: number;
  message?: string;
  checkedAt: Date;
}

export interface ProviderCapabilities {
  completion: boolean;
  streaming: boolean;
  embeddings: boolean;
  toolCalling: boolean;
  vision: boolean;
  maxContextTokens: number;
}

/**
 * Resolved, decrypted configuration handed to an adapter at construction.
 * The adapter never reads the database or the credential store itself.
 */
export interface ProviderRuntimeConfig {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  options?: Record<string, unknown>;
}

export interface IIntelligenceProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  complete(request: CompletionRequest): Promise<CompletionResponse>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;

  /** Cheap round trip used to set `providers.status`. Must not throw. */
  healthCheck(): Promise<ProviderHealth>;
}

/**
 * Builds an adapter from resolved configuration. Registered with
 * ProviderRegistry under a ProviderKind.
 */
export interface ProviderAdapterFactory {
  readonly kind: ProviderKind;
  create(config: ProviderRuntimeConfig): IIntelligenceProvider;
}

/** Raised when a provider is referenced but no adapter is registered for it. */
export class ProviderNotImplementedError extends Error {
  constructor(kind: ProviderKind) {
    super(
      `No adapter is registered for provider "${kind}". ` +
        'Vendor adapters arrive in Backend Phase 2; register one with ' +
        'ProviderRegistry.register() to enable it.',
    );
    this.name = 'ProviderNotImplementedError';
  }
}
