import { ProviderKind } from '@prisma/client';
import {
  CompletionRequest,
  CompletionResponse,
  ProviderAdapterFactory,
  ProviderCapabilities,
  ProviderRuntimeConfig,
} from '../contracts/intelligence-provider.interface';
import { HttpIntelligenceAdapter, ProviderCallError } from './http-adapter.base';
import { DEFAULT_MODEL } from '../model-catalogue';

interface MessagesResponse {
  model: string;
  content: { type: string; text?: string }[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * Anthropic Messages API.
 *
 * Two shape differences from OpenAI are handled here rather than leaking
 * upward: the system prompt is a top-level field rather than a message, and
 * `max_tokens` is required rather than optional.
 */
export class AnthropicAdapter extends HttpIntelligenceAdapter {
  readonly kind = ProviderKind.ANTHROPIC;
  readonly capabilities: ProviderCapabilities = {
    completion: true,
    streaming: true,
    embeddings: false,
    toolCalling: true,
    vision: true,
    maxContextTokens: 200_000,
  };

  private static readonly API_VERSION = '2023-06-01';
  private static readonly DEFAULT_MAX_TOKENS = 4096;
  private readonly baseUrl: string;

  constructor(config: ProviderRuntimeConfig) {
    super(config);
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.config.defaultModel ?? DEFAULT_MODEL.ANTHROPIC;

    // System messages are hoisted out of the conversation; several may be
    // merged, since the API accepts only one.
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const payload = await this.postJson<MessagesResponse>(
      `${this.baseUrl}/messages`,
      {
        model,
        max_tokens: request.maxTokens ?? AnthropicAdapter.DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.options ?? {}),
      },
      {
        'x-api-key': this.requireKey(),
        'anthropic-version': AnthropicAdapter.API_VERSION,
      },
    );

    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    if (!payload.content) {
      throw new ProviderCallError('Anthropic returned no content', undefined, true);
    }

    const promptTokens = payload.usage?.input_tokens ?? 0;
    const completionTokens = payload.usage?.output_tokens ?? 0;

    return {
      content: text,
      model: payload.model ?? model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: AnthropicAdapter.mapFinish(payload.stop_reason),
      raw: payload,
    };
  }

  private static mapFinish(reason: string): CompletionResponse['finishReason'] {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
      case 'tool_use':
        return 'stop';
      case 'max_tokens':
        return 'length';
      default:
        return 'stop';
    }
  }
}

export const anthropicFactory: ProviderAdapterFactory = {
  kind: ProviderKind.ANTHROPIC,
  create: (config) => new AnthropicAdapter(config),
};
