import { ProviderKind } from '@prisma/client';
import {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderAdapterFactory,
  ProviderCapabilities,
  ProviderRuntimeConfig,
} from '../contracts/intelligence-provider.interface';
import { HttpIntelligenceAdapter, ProviderCallError } from './http-adapter.base';
import { OpenAiAdapter } from './openai.adapter';
import { DEFAULT_MODEL, approximateTokens } from '../model-catalogue';

/**
 * Nous Research Hermes.
 *
 * Hermes is served over an OpenAI-compatible API, so the OpenAI adapter does
 * the work; this subclass exists to carry the correct ProviderKind (which
 * drives pricing and capability lookups) and the right default endpoint.
 */
export class HermesAdapter extends OpenAiAdapter {
  constructor(config: ProviderRuntimeConfig) {
    super(
      { ...config, baseUrl: config.baseUrl ?? 'https://inference-api.nousresearch.com/v1' },
      ProviderKind.HERMES,
    );
  }
}

export const hermesFactory: ProviderAdapterFactory = {
  kind: ProviderKind.HERMES,
  create: (config) => new HermesAdapter(config),
};

interface OllamaChatResponse {
  model: string;
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama, for self-hosted models.
 *
 * Uses Ollama's native `/api/chat` rather than its OpenAI compatibility layer,
 * because the native endpoint reports `prompt_eval_count` / `eval_count` —
 * without those the execution log would record zero tokens and usage tracking
 * would silently under-report every local call.
 *
 * No API key: Ollama is normally unauthenticated on a private network.
 */
export class OllamaAdapter extends HttpIntelligenceAdapter {
  readonly kind = ProviderKind.OLLAMA;
  readonly capabilities: ProviderCapabilities = {
    completion: true,
    streaming: true,
    embeddings: true,
    toolCalling: true,
    vision: false,
    maxContextTokens: 128_000,
  };

  private readonly baseUrl: string;

  constructor(config: ProviderRuntimeConfig) {
    super(config);
    this.baseUrl = (config.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.config.defaultModel ?? DEFAULT_MODEL.OLLAMA;

    const payload = await this.postJson<OllamaChatResponse>(
      `${this.baseUrl}/api/chat`,
      {
        model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        options: {
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens ? { num_predict: request.maxTokens } : {}),
        },
        ...(request.options ?? {}),
      },
      {},
    );

    const content = payload.message?.content;
    if (content === undefined) {
      throw new ProviderCallError('Ollama returned no message content', undefined, true);
    }

    const promptTokens = payload.prompt_eval_count ?? 0;
    const completionTokens = payload.eval_count ?? 0;

    return {
      content,
      model: payload.model ?? model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: payload.done_reason === 'length' ? 'length' : 'stop',
      raw: payload,
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model ?? 'nomic-embed-text';
    const inputs = Array.isArray(request.input) ? request.input : [request.input];

    const payload = await this.postJson<{ embeddings?: number[][] }>(
      `${this.baseUrl}/api/embed`,
      { model, input: inputs },
      {},
    );

    return {
      embeddings: payload.embeddings ?? [],
      model,
      usage: {
        promptTokens: inputs.reduce((n, t) => n + approximateTokens(t), 0),
        totalTokens: inputs.reduce((n, t) => n + approximateTokens(t), 0),
      },
    };
  }

  /** Ollama needs no credential, so the base-class key check is bypassed. */
  protected requireKey(): string {
    return this.config.apiKey ?? '';
  }
}

export const ollamaFactory: ProviderAdapterFactory = {
  kind: ProviderKind.OLLAMA,
  create: (config) => new OllamaAdapter(config),
};
