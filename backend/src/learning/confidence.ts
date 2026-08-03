/**
 * How much a claim should be believed.
 *
 * Every recommendation, pattern and profile the Learning Engine produces
 * carries a confidence score, and they all compute it here. That matters more
 * than the specific formula: a system that learns will produce a claim from
 * three missions and a claim from five hundred, and if both arrive looking
 * alike, the weak one is indistinguishable from established knowledge. One
 * shared scale is what keeps "PRISM-X noticed something" from being read as
 * "PRISM-X knows something".
 *
 * The score is the product of three factors rather than their average:
 *
 *     confidence = volume × quality × recency
 *
 * Multiplicative because any one of them being near zero should sink the
 * claim on its own. Three data points are not rescued by being recent and
 * perfectly consistent — three consistent points are exactly what coincidence
 * looks like. Averaging would let two strong factors carry a fatal one.
 */

export type ConfidenceBand = 'ANECDOTAL' | 'EMERGING' | 'ESTABLISHED' | 'STRONG';

export interface ConfidenceInput {
  /** Number of independent observations behind the claim. */
  samples: number;
  /**
   * 0..1 agreement between those observations. Omit when it cannot be
   * measured — the default is deliberately short of certain.
   */
  consistency?: number;
  /** Age of the evidence in days. Omit for evidence gathered now. */
  ageDays?: number;
  /** Overrides the default 30-day half-life for domains that move faster. */
  halfLifeDays?: number;
}

export interface ConfidenceResult {
  /** 0..1. */
  value: number;
  /** 0..100, for display. */
  percent: number;
  band: ConfidenceBand;
  /** One sentence a human can act on. */
  rationale: string;
  factors: { volume: number; quality: number; recency: number };
  samples: number;
}

/**
 * Observations needed before volume alone stops being the limiting factor.
 *
 * At n = K the volume term is exactly 0.5, so twelve observations is the
 * point where evidence starts carrying a claim rather than merely hinting at
 * one. It is a judgement, not a derivation, and it is a constant here so that
 * judgement is made once and visibly.
 */
export const EVIDENCE_SATURATION = 12;

/** Evidence half-life. Beyond this, the world has probably moved on some. */
export const DEFAULT_HALF_LIFE_DAYS = 30;

/**
 * Old evidence decays but never vanishes. Five hundred missions from last
 * quarter still mean something; treating them as worthless would make the
 * system forget everything it has ever learned on a rolling basis.
 */
export const RECENCY_FLOOR = 0.4;

/** Used when consistency cannot be measured: plausible, but not verified. */
export const ASSUMED_CONSISTENCY = 0.8;

export const BAND_THRESHOLDS: Array<{ band: ConfidenceBand; min: number }> = [
  { band: 'STRONG', min: 0.85 },
  { band: 'ESTABLISHED', min: 0.65 },
  { band: 'EMERGING', min: 0.4 },
  { band: 'ANECDOTAL', min: 0 },
];

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Diminishing returns on sample count: n / (n + K).
 *
 * Chosen over a hard threshold because evidence does not become adequate at
 * a particular observation — the eleventh datum should not be worth nothing
 * and the twelfth everything. The curve is steep where it matters (0 to ~20)
 * and flat beyond, so the difference between 300 and 500 samples is
 * correctly negligible.
 */
export function volumeWeight(samples: number, saturation = EVIDENCE_SATURATION): number {
  const n = Math.max(0, Math.floor(samples));
  if (n === 0) return 0;
  return clamp01(n / (n + saturation));
}

/** Exponential decay to a floor, so age discounts evidence without erasing it. */
export function recencyWeight(
  ageDays = 0,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
): number {
  if (ageDays <= 0) return 1;
  if (halfLifeDays <= 0) return 1;
  const decayed = 0.5 ** (ageDays / halfLifeDays);
  return clamp01(RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decayed);
}

/**
 * How much a set of measurements agree, as 1 − coefficient of variation.
 *
 * Scale-free on purpose: a spread of ±200ms means something very different
 * for a 300ms operation than for a 30-second one, and a raw standard
 * deviation would rate the second as far worse when it is in fact far
 * steadier.
 */
export function consistencyOf(values: number[]): number {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length < 2) return ASSUMED_CONSISTENCY;

  const mean = usable.reduce((sum, v) => sum + v, 0) / usable.length;
  if (mean === 0) {
    // Every observation is zero. That is perfect agreement, not a division
    // by zero — and it is a real case for costs and error counts.
    return usable.every((v) => v === 0) ? 1 : ASSUMED_CONSISTENCY;
  }

  const variance =
    usable.reduce((sum, v) => sum + (v - mean) ** 2, 0) / usable.length;
  const coefficient = Math.sqrt(variance) / Math.abs(mean);
  return clamp01(1 - coefficient);
}

/**
 * Lower bound of the Wilson score interval for a proportion.
 *
 * The honest way to rank rates. A worker that succeeded 3 times out of 3 has
 * an observed rate of 100% and a Wilson lower bound of about 44%; one that
 * succeeded 480 times out of 500 observes 96% and bounds at about 94%. Sorted
 * by observed rate the first looks better, which is wrong in a way that
 * compounds — it is exactly the mistake that makes a system chase noise.
 */
export function wilsonLowerBound(successes: number, trials: number, z = 1.96): number {
  if (trials <= 0) return 0;
  const s = Math.max(0, Math.min(successes, trials));
  const p = s / trials;
  const z2 = z * z;

  const denominator = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);

  return clamp01((centre - margin) / denominator);
}

/** Upper bound of the same interval, for deciding whether two rates differ. */
export function wilsonUpperBound(successes: number, trials: number, z = 1.96): number {
  if (trials <= 0) return 1;
  const s = Math.max(0, Math.min(successes, trials));
  const p = s / trials;
  const z2 = z * z;

  const denominator = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);

  return clamp01((centre + margin) / denominator);
}

/** The composite score. Everything in the Learning Engine ends up here. */
export function score(input: ConfidenceInput): ConfidenceResult {
  const volume = volumeWeight(input.samples);
  const quality = clamp01(input.consistency ?? ASSUMED_CONSISTENCY);
  const recency = recencyWeight(input.ageDays, input.halfLifeDays);

  const value = clamp01(volume * quality * recency);
  const band = bandFor(value);

  return {
    value: round(value),
    percent: Math.round(value * 100),
    band,
    rationale: rationaleFor(band, input.samples, { volume, quality, recency }),
    factors: { volume: round(volume), quality: round(quality), recency: round(recency) },
    samples: Math.max(0, Math.floor(input.samples)),
  };
}

/**
 * Confidence that two rates genuinely differ.
 *
 * A claim like "this worker performs 28% better on Sonnet" is worth nothing
 * if the two confidence intervals overlap — the difference is then consistent
 * with chance. Overlapping intervals return 0 rather than a small number,
 * because "we cannot tell these apart" is a different statement from "there
 * is a small effect", and rounding the first into the second is how a
 * learning system talks itself into nonsense.
 */
export function comparisonConfidence(
  a: { successes: number; trials: number },
  b: { successes: number; trials: number },
): ConfidenceResult {
  const aLower = wilsonLowerBound(a.successes, a.trials);
  const aUpper = wilsonUpperBound(a.successes, a.trials);
  const bLower = wilsonLowerBound(b.successes, b.trials);
  const bUpper = wilsonUpperBound(b.successes, b.trials);

  const separated = aLower > bUpper || bLower > aUpper;
  const samples = a.trials + b.trials;

  if (!separated) {
    return {
      value: 0,
      percent: 0,
      band: 'ANECDOTAL',
      rationale:
        `The two results overlap within their margins of error across ${samples} ` +
        'observation(s), so no difference can be claimed yet.',
      factors: { volume: round(volumeWeight(samples)), quality: 0, recency: 1 },
      samples,
    };
  }

  // Separation as a fraction of the combined spread: intervals that clear
  // each other by a wide margin are more convincing than ones that barely do.
  const gap = aLower > bUpper ? aLower - bUpper : bLower - aUpper;
  const spread = Math.max(aUpper - aLower, bUpper - bLower, 1e-6);
  const separation = clamp01(gap / spread);

  const result = score({ samples, consistency: 0.5 + 0.5 * separation });
  return {
    ...result,
    rationale:
      `The results separate cleanly across ${samples} observation(s) ` +
      `(gap ${round(gap)} against a spread of ${round(spread)}). ${result.rationale}`,
  };
}

export function bandFor(value: number): ConfidenceBand {
  return BAND_THRESHOLDS.find((t) => value >= t.min)?.band ?? 'ANECDOTAL';
}

/**
 * Whether a claim is solid enough to act on without a human reading it first.
 *
 * Nothing in Phase 5 applies a change on this basis alone — the human
 * validation layer still gates production. It exists so the interface can
 * sort what is worth someone's attention from what is merely noted.
 */
export function isActionable(value: number): boolean {
  return value >= 0.65;
}

function rationaleFor(
  band: ConfidenceBand,
  samples: number,
  factors: { volume: number; quality: number; recency: number },
): string {
  const n = Math.max(0, Math.floor(samples));
  const plural = n === 1 ? 'observation' : 'observations';

  if (n === 0) return 'No supporting observations — this is a hypothesis, not a finding.';

  // Name the factor actually holding the score back, because "low
  // confidence" without a reason gives a reader nothing to do about it.
  const weakest = (['volume', 'quality', 'recency'] as const).reduce((worst, key) =>
    factors[key] < factors[worst] ? key : worst,
  );

  const limit =
    weakest === 'volume'
      ? `${n} ${plural} is a thin basis`
      : weakest === 'quality'
        ? `the ${n} ${plural} disagree with each other`
        : `the evidence is old enough to have gone stale`;

  switch (band) {
    case 'STRONG':
      return `Backed by ${n} consistent, recent ${plural}.`;
    case 'ESTABLISHED':
      return `Backed by ${n} ${plural}; solid enough to act on.`;
    case 'EMERGING':
      return `Suggested by ${n} ${plural}, but ${limit} — worth watching.`;
    default:
      return `Only a hint: ${limit}. Treat as a question, not a conclusion.`;
  }
}

const round = (n: number): number => Number(n.toFixed(4));
