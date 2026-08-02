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

interface GenerateContentResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Google Gemini `generateContent`.
 *
 * Gemini's shape diverges most from the others: messages are `contents` with
 * `parts`, the assistant role is called `model`, system instructions are a
 * separate top-level field, and generation settings live under
 * `generationConfig`. All of that is normalised here.
 */
export class GeminiAdapter extends HttpIntelligenceAdapter {
  readonly kind = ProviderKind.GEMINI;
  readonly capabilities: ProviderCapabilities = {
    completion: true,
    streaming: true,
    embeddings: true,
    toolCalling: true,
    vision: true,
    maxContextTokens: 1_000_000,
  };

  private readonly baseUrl: string;

  constructor(config: ProviderRuntimeConfig) {
    super(config);
    this.baseUrl = (
      config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/+$/, '');
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.config.defaultModel ?? DEFAULT_MODEL.GEMINI;

    const systemText = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const payload = await this.postJson<GenerateContentResponse>(
      // The key goes in the query string; Gemini has no bearer scheme here.
      `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.requireKey())}`,
      {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        generationConfig: {
          ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
        ...(request.options ?? {}),
      },
      {},
    );

    const candidate = payload.candidates?.[0];
    if (!candidate) {
      throw new ProviderCallError('Gemini returned no candidates', undefined, true);
    }

    const text = (candidate.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const promptTokens = payload.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = payload.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      content: text,
      model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: payload.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens,
      },
      finishReason: GeminiAdapter.mapFinish(candidate.finishReason),
      raw: payload,
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model ?? 'text-embedding-004';
    const inputs = Array.isArray(request.input) ? request.input : [request.input];

    const payload = await this.postJson<{ embeddings?: { values: number[] }[] }>(
      `${this.baseUrl}/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(this.requireKey())}`,
      {
        requests: inputs.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        })),
      },
      {},
    );

    return {
      embeddings: (payload.embeddings ?? []).map((e) => e.values),
      model,
      // Gemini's embedding endpoint does not report token usage.
      usage: { promptTokens: 0, totalTokens: 0 },
    };
  }

  private static mapFinish(reason?: string): CompletionResponse['finishReason'] {
    switch (reason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
      case 'RECITATION':
        return 'content_filter';
      default:
        return 'stop';
    }
  }
}

export const geminiFactory: ProviderAdapterFactory = {
  kind: ProviderKind.GEMINI,
  create: (config) => new GeminiAdapter(config),
};
