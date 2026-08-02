import { ProviderKind } from '@prisma/client';

/**
 * Model metadata used for cost estimation and context-budget checks.
 *
 * IMPORTANT — these rates are a *reporting* default, not a billing source of
 * truth. Vendor pricing changes without notice, so:
 *
 *   - Token counts are recorded exactly on every execution log; cost is always
 *     recomputable from them if a rate here turns out to be stale.
 *   - An operator can override rates per provider via
 *     `provider.config.pricing = { "<model>": { "input": 3, "output": 15 } }`
 *     (USD per million tokens), which takes precedence over this table.
 *
 * Treat the numbers below as "reasonable defaults to configure over", and
 * verify them against the vendor's current price list before relying on the
 * cost dashboard for anything financial.
 */
export interface ModelSpec {
  id: string;
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

const openAiModels: ModelSpec[] = [
  { id: 'gpt-4o', inputPerMillion: 2.5, outputPerMillion: 10, contextWindow: 128_000, supportsTools: true, supportsVision: true },
  { id: 'gpt-4o-mini', inputPerMillion: 0.15, outputPerMillion: 0.6, contextWindow: 128_000, supportsTools: true, supportsVision: true },
  { id: 'gpt-4.1', inputPerMillion: 2, outputPerMillion: 8, contextWindow: 1_000_000, supportsTools: true, supportsVision: true },
  { id: 'gpt-4.1-mini', inputPerMillion: 0.4, outputPerMillion: 1.6, contextWindow: 1_000_000, supportsTools: true, supportsVision: true },
  { id: 'o3-mini', inputPerMillion: 1.1, outputPerMillion: 4.4, contextWindow: 200_000, supportsTools: true, supportsVision: false },
];

const anthropicModels: ModelSpec[] = [
  { id: 'claude-opus-4-5', inputPerMillion: 5, outputPerMillion: 25, contextWindow: 200_000, supportsTools: true, supportsVision: true },
  { id: 'claude-sonnet-4-5', inputPerMillion: 3, outputPerMillion: 15, contextWindow: 200_000, supportsTools: true, supportsVision: true },
  { id: 'claude-haiku-4-5', inputPerMillion: 1, outputPerMillion: 5, contextWindow: 200_000, supportsTools: true, supportsVision: true },
];

const geminiModels: ModelSpec[] = [
  { id: 'gemini-2.5-pro', inputPerMillion: 1.25, outputPerMillion: 10, contextWindow: 1_000_000, supportsTools: true, supportsVision: true },
  { id: 'gemini-2.5-flash', inputPerMillion: 0.3, outputPerMillion: 2.5, contextWindow: 1_000_000, supportsTools: true, supportsVision: true },
];

const hermesModels: ModelSpec[] = [
  { id: 'hermes-3-llama-3.1-70b', inputPerMillion: 0.4, outputPerMillion: 0.4, contextWindow: 128_000, supportsTools: true, supportsVision: false },
  { id: 'hermes-3-llama-3.1-405b', inputPerMillion: 1.5, outputPerMillion: 1.5, contextWindow: 128_000, supportsTools: true, supportsVision: false },
];

/** Self-hosted: no per-token charge, so cost is reported as zero. */
const ollamaModels: ModelSpec[] = [
  { id: 'llama3.1', inputPerMillion: 0, outputPerMillion: 0, contextWindow: 128_000, supportsTools: true, supportsVision: false },
  { id: 'mistral', inputPerMillion: 0, outputPerMillion: 0, contextWindow: 32_000, supportsTools: false, supportsVision: false },
  { id: 'qwen2.5', inputPerMillion: 0, outputPerMillion: 0, contextWindow: 128_000, supportsTools: true, supportsVision: false },
];

const localModels: ModelSpec[] = [
  { id: 'prism-sim-1', inputPerMillion: 0, outputPerMillion: 0, contextWindow: 128_000, supportsTools: true, supportsVision: false },
];

export const MODEL_CATALOGUE: Record<ProviderKind, ModelSpec[]> = {
  OPENAI: openAiModels,
  ANTHROPIC: anthropicModels,
  GEMINI: geminiModels,
  HERMES: hermesModels,
  OLLAMA: ollamaModels,
  LOCAL: localModels,
  CUSTOM: [],
};

export const DEFAULT_MODEL: Record<ProviderKind, string> = {
  OPENAI: 'gpt-4o-mini',
  ANTHROPIC: 'claude-sonnet-4-5',
  GEMINI: 'gemini-2.5-flash',
  HERMES: 'hermes-3-llama-3.1-70b',
  OLLAMA: 'llama3.1',
  LOCAL: 'prism-sim-1',
  CUSTOM: 'default',
};

export function findModelSpec(kind: ProviderKind, model: string): ModelSpec | undefined {
  return MODEL_CATALOGUE[kind]?.find((m) => m.id === model);
}

export interface PricingOverride {
  input: number;
  output: number;
}

/**
 * Cost for one call, in USD.
 *
 * Falls back to zero for an unknown model rather than guessing — a wrong
 * number in a cost dashboard is worse than a visible zero, and the token
 * counts remain recorded either way.
 */
export function estimateCost(
  kind: ProviderKind,
  model: string,
  promptTokens: number,
  completionTokens: number,
  overrides?: Record<string, PricingOverride>,
): number {
  const override = overrides?.[model];
  const spec = findModelSpec(kind, model);

  const inputRate = override?.input ?? spec?.inputPerMillion;
  const outputRate = override?.output ?? spec?.outputPerMillion;
  if (inputRate === undefined || outputRate === undefined) return 0;

  const cost =
    (promptTokens / 1_000_000) * inputRate +
    (completionTokens / 1_000_000) * outputRate;

  // Round to 8 decimals: sub-cent precision without float noise in the tail.
  return Math.round(cost * 1e8) / 1e8;
}

/**
 * Rough token estimate for budget checks made *before* a call, when the real
 * count is not yet known. ~4 characters per token is the usual English
 * approximation; it is deliberately not used for billing.
 */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
