import { ProviderKind } from '@prisma/client';
import {
  approximateTokens,
  estimateCost,
  findModelSpec,
  MODEL_CATALOGUE,
} from './model-catalogue';

describe('model catalogue', () => {
  it('prices a call from token counts', () => {
    // 1M input at $3 + 1M output at $15 = $18
    const cost = estimateCost(ProviderKind.ANTHROPIC, 'claude-sonnet-4-5', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18, 6);
  });

  it('scales linearly with tokens', () => {
    const small = estimateCost(ProviderKind.OPENAI, 'gpt-4o-mini', 1000, 1000);
    const large = estimateCost(ProviderKind.OPENAI, 'gpt-4o-mini', 10_000, 10_000);
    expect(large).toBeCloseTo(small * 10, 8);
  });

  it('returns zero for an unknown model rather than guessing', () => {
    // A fabricated price in a cost dashboard is worse than a visible zero —
    // the token counts remain recorded either way.
    expect(estimateCost(ProviderKind.OPENAI, 'gpt-does-not-exist', 5000, 5000)).toBe(0);
  });

  it('lets an operator override the catalogue rate', () => {
    const overridden = estimateCost(
      ProviderKind.OPENAI,
      'gpt-4o',
      1_000_000,
      0,
      { 'gpt-4o': { input: 99, output: 0 } },
    );
    expect(overridden).toBeCloseTo(99, 6);
  });

  it('prices self-hosted models at zero', () => {
    expect(estimateCost(ProviderKind.OLLAMA, 'llama3.1', 500_000, 500_000)).toBe(0);
  });

  it('charges output tokens at a higher rate than input for hosted models', () => {
    const spec = findModelSpec(ProviderKind.ANTHROPIC, 'claude-sonnet-4-5')!;
    expect(spec.outputPerMillion).toBeGreaterThan(spec.inputPerMillion);
  });

  it('covers every provider kind', () => {
    const kinds = Object.values(ProviderKind);
    expect(Object.keys(MODEL_CATALOGUE).sort()).toEqual([...kinds].sort());
  });

  it('approximates tokens at roughly four characters each', () => {
    expect(approximateTokens('a'.repeat(400))).toBe(100);
    expect(approximateTokens('')).toBe(0);
  });
});
