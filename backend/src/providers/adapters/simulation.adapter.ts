import { ProviderKind } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  IIntelligenceProvider,
  ProviderAdapterFactory,
  ProviderCapabilities,
  ProviderHealth,
  ProviderRuntimeConfig,
} from '../contracts/intelligence-provider.interface';
import { approximateTokens } from '../model-catalogue';
import { ProviderCallError } from './http-adapter.base';

/**
 * Deterministic in-process provider (`ProviderKind.LOCAL`).
 *
 * This is not a mock in the test-double sense — it is a real, registered
 * adapter that the Provider Manager treats like any other. It exists because
 * the orchestration layer above it (task scheduling, memory retrieval, tool
 * invocation, execution logging, cost accounting, retries and failover) is the
 * substance of this phase, and all of it must be verifiable without depending
 * on a paid third-party endpoint being reachable and funded.
 *
 * Properties that make it useful rather than merely convenient:
 *
 *  - **Deterministic.** Output is derived from a hash of the request, so the
 *    same input always yields the same answer and tests do not flake.
 *  - **Honest accounting.** Token counts come from the actual text, so the
 *    usage and cost pipeline is exercised with real numbers rather than
 *    constants. (Rates for LOCAL are zero, so reported cost is zero — the
 *    arithmetic still runs.)
 *  - **Fault injection.** `config.simulate` can force failures, latency and
 *    truncation, which is how retry, circuit-breaking and failover get tested
 *    without waiting for a real outage.
 */
export interface SimulationOptions {
  /** Fraction of calls that fail, 0..1. */
  failureRate?: number;
  /** Always fail — used to verify failover to a secondary provider. */
  alwaysFail?: boolean;
  /** Whether injected failures are classified as retryable. */
  retryableFailures?: boolean;
  /** Artificial latency in milliseconds. */
  latencyMs?: number;
  /** Return `finishReason: 'length'` to exercise truncation handling. */
  truncate?: boolean;
}

export class SimulationAdapter implements IIntelligenceProvider {
  readonly kind = ProviderKind.LOCAL;
  readonly capabilities: ProviderCapabilities = {
    completion: true,
    streaming: false,
    embeddings: true,
    toolCalling: true,
    vision: false,
    maxContextTokens: 128_000,
  };

  private readonly options: SimulationOptions;
  /** Counts calls so failureRate is applied deterministically, not randomly. */
  private callIndex = 0;

  constructor(private readonly config: ProviderRuntimeConfig) {
    this.options = (config.options?.simulate as SimulationOptions) ?? {};
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const index = this.callIndex++;

    if (this.options.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
    }

    if (this.options.alwaysFail) {
      throw new ProviderCallError(
        'Simulated provider failure (alwaysFail)',
        503,
        this.options.retryableFailures ?? true,
      );
    }

    // Deterministic rather than random: call N either fails or does not,
    // identically on every run.
    const failureRate = this.options.failureRate ?? 0;
    if (failureRate > 0 && (index % Math.max(1, Math.round(1 / failureRate))) === 0) {
      throw new ProviderCallError(
        `Simulated provider failure (call ${index})`,
        503,
        this.options.retryableFailures ?? true,
      );
    }

    const prompt = request.messages.map((m) => `${m.role}:${m.content}`).join('\n');
    const content = this.synthesize(request, prompt);

    const promptTokens = approximateTokens(prompt);
    const completionTokens = approximateTokens(content);

    return {
      content,
      model: request.model ?? this.config.defaultModel ?? 'prism-sim-1',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: this.options.truncate ? 'length' : 'stop',
      raw: { simulated: true, callIndex: index },
    };
  }

  /**
   * Produces a response that reflects its input, so a test can assert the
   * worker actually received the context it was supposed to (system prompt,
   * retrieved memory, retrieved knowledge) rather than just that *something*
   * came back.
   */
  private synthesize(request: CompletionRequest, prompt: string): string {
    const digest = createHash('sha256').update(prompt).digest('hex').slice(0, 8);
    const task = request.messages.filter((m) => m.role === 'user').pop()?.content ?? '';
    const headline = task.split('\n')[0].slice(0, 120) || 'the assigned objective';

    // Tool-loop participation.
    //
    // A deterministic adapter that can never *request* a tool would leave the
    // entire invocation path — permission checks, execution, result feedback —
    // unexercised outside production. So when an instruction contains a
    // literal TOOL_CALL directive, it is echoed back on the first turn, and
    // suppressed once a TOOL_RESULT is present so the loop terminates.
    // Greedy to the last brace on the line: a non-greedy match stops at the
    // first `}`, which truncates any directive whose `input` is a nested
    // object and emits syntactically invalid JSON.
    const directive = /TOOL_CALL:\s*\{.*\}/.exec(task);

    // Must match an actual result message, not the system prompt's own
    // explanation of the protocol — which contains the words "TOOL_RESULT"
    // and would otherwise make every first turn look like a continuation.
    const alreadyRan = request.messages.some(
      (m) => m.role === 'user' && m.content.startsWith('TOOL_RESULT '),
    );

    if (directive && !alreadyRan) {
      return `Requesting a tool to complete this step.\n${directive[0]}`;
    }
    if (alreadyRan) {
      return [
        `Completed: ${headline}`,
        '',
        'The tool result was incorporated into the final answer.',
        '',
        `[simulated response · ref ${digest}]`,
      ].join('\n');
    }

    const sawMemory = /recalled context|memory/i.test(prompt);
    const sawKnowledge = /knowledge base|retrieved documents/i.test(prompt);
    const sawTools = /available tools/i.test(prompt);

    const notes = [
      sawMemory ? 'prior context was taken into account' : null,
      sawKnowledge ? 'organizational knowledge was consulted' : null,
      sawTools ? 'tools were available for this step' : null,
    ].filter(Boolean);

    return [
      `Completed: ${headline}`,
      '',
      `Analysis proceeded in three passes over the supplied context${
        notes.length ? `, where ${notes.join(', ')}` : ''
      }.`,
      '',
      'Findings:',
      `1. The objective was decomposed and each element addressed in turn.`,
      `2. Constraints from the execution context were respected.`,
      `3. The result is reproducible for identical input (ref ${digest}).`,
      '',
      `[simulated response · ref ${digest}]`,
    ].join('\n');
  }

  /**
   * Hash-derived unit vectors. Not semantically meaningful, but stable and
   * correctly shaped, which is enough to exercise the storage and retrieval
   * path before a real embedding model is wired in.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const dimensions = 128;

    const embeddings = inputs.map((text) => {
      const digest = createHash('sha256').update(text).digest();
      const vector = Array.from({ length: dimensions }, (_, i) =>
        (digest[i % digest.length] - 127.5) / 127.5,
      );
      const norm = Math.hypot(...vector) || 1;
      return vector.map((v) => v / norm);
    });

    const tokens = inputs.reduce((sum, t) => sum + approximateTokens(t), 0);
    return {
      embeddings,
      model: request.model ?? 'prism-sim-embed-1',
      usage: { promptTokens: tokens, totalTokens: tokens },
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (this.options.alwaysFail) {
      return {
        healthy: false,
        latencyMs: 0,
        message: 'Simulated provider is configured to always fail',
        checkedAt: new Date(),
      };
    }
    return {
      healthy: true,
      latencyMs: this.options.latencyMs ?? 1,
      message: 'Simulation adapter — no network call performed',
      checkedAt: new Date(),
    };
  }
}

export const simulationFactory: ProviderAdapterFactory = {
  kind: ProviderKind.LOCAL,
  create: (config) => new SimulationAdapter(config),
};
