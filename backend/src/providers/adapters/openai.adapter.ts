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
import { DEFAULT_MODEL } from '../model-catalogue';

interface ChatCompletionResponse {
  model: string;
  choices: { message: { content: string | null }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * OpenAI Chat Completions.
 *
 * Also serves any OpenAI-compatible endpoint (vLLM, LM Studio, OpenRouter,
 * Together, …) via the CUSTOM kind — the wire format is identical, only the
 * base URL differs.
 */
export class OpenAiAdapter extends HttpIntelligenceAdapter {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities = {
    completion: true,
    streaming: true,
    embeddings: true,
    toolCalling: true,
    vision: true,
    maxContextTokens: 128_000,
  };

  private readonly baseUrl: string;

  constructor(config: ProviderRuntimeConfig, kind: ProviderKind = ProviderKind.OPENAI) {
    super(config);
    this.kind = kind;
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.config.defaultModel ?? DEFAULT_MODEL[this.kind];

    const payload = await this.postJson<ChatCompletionResponse>(
      `${this.baseUrl}/chat/completions`,
      {
        model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        ...(request.options ?? {}),
      },
      { authorization: `Bearer ${this.requireKey()}` },
    );

    const choice = payload.choices?.[0];
    if (!choice) {
      throw new ProviderCallError('OpenAI returned no choices', undefined, true);
    }

    return {
      content: choice.message?.content ?? '',
      model: payload.model ?? model,
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        completionTokens: payload.usage?.completion_tokens ?? 0,
        totalTokens: payload.usage?.total_tokens ?? 0,
      },
      finishReason: OpenAiAdapter.mapFinish(choice.finish_reason),
      raw: payload,
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model ?? 'text-embedding-3-small';
    const payload = await this.postJson<{
      model: string;
      data: { embedding: number[] }[];
      usage?: { prompt_tokens: number; total_tokens: number };
    }>(
      `${this.baseUrl}/embeddings`,
      { model, input: request.input },
      { authorization: `Bearer ${this.requireKey()}` },
    );

    return {
      embeddings: payload.data.map((d) => d.embedding),
      model: payload.model ?? model,
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        totalTokens: payload.usage?.total_tokens ?? 0,
      },
    };
  }

  private static mapFinish(reason: string): CompletionResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }
}

export const openAiFactory: ProviderAdapterFactory = {
  kind: ProviderKind.OPENAI,
  create: (config) => new OpenAiAdapter(config, ProviderKind.OPENAI),
};

/** Any OpenAI-compatible endpoint. Requires `config.baseUrl`. */
export const customOpenAiFactory: ProviderAdapterFactory = {
  kind: ProviderKind.CUSTOM,
  create: (config) => new OpenAiAdapter(config, ProviderKind.CUSTOM),
};
