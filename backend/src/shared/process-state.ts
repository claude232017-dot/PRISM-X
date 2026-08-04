/**
 * The register of what this process keeps in memory.
 *
 * "Is the application stateless?" is a question the readiness review has to
 * answer, and until now it answered by returning `true` next to a paragraph
 * explaining why. That is a claim, not a check: it stayed true after somebody
 * added a Map of password reset tokens, and it would have stayed true after the
 * next one.
 *
 * So components declare what they hold, and the review reports the register
 * rather than the paragraph. The important field is `loadBearing`: a cache that
 * costs a reload on a miss is not a statelessness problem, and a token that
 * only exists on the instance that issued it is. Only the latter makes the
 * process stateful.
 *
 * A module-level registry rather than an injected service, deliberately. The
 * things that hold state — the extension runtime, the worker runtime, the local
 * auth driver — sit *below* the production layer that asks the question, and an
 * injected dependency would point the wrong way. This is the same seam the
 * platform uses everywhere else it needs an upward edge, reduced to its
 * smallest form.
 */
export interface ProcessHolding {
  /** Stable identifier, e.g. `extension-runtime.modules`. */
  name: string;
  /**
   * True when a request landing on a different instance would get a *wrong*
   * answer rather than a slower one.
   */
  loadBearing: boolean;
  /** Current size or contents, evaluated when the register is read. */
  describe: () => string;
}

const holdings = new Map<string, ProcessHolding>();

/** Declares something this process holds in memory. */
export function declareProcessState(holding: ProcessHolding): void {
  holdings.set(holding.name, holding);
}

/** Everything declared, with each description evaluated now. */
export function processHoldings(): Array<{
  name: string;
  loadBearing: boolean;
  detail: string;
}> {
  return [...holdings.values()]
    .map((holding) => ({
      name: holding.name,
      loadBearing: holding.loadBearing,
      detail: (() => {
        try {
          return holding.describe();
        } catch (error) {
          return `unreadable: ${(error as Error).message}`;
        }
      })(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Test seam. Never called in the running application. */
export function resetProcessState(): void {
  holdings.clear();
}
