/**
 * What the running process isolates, declared by whoever does the isolating.
 *
 * The readiness review has to report how extension code is contained, and the
 * loader that knows sits *below* the production layer that asks — the same
 * shape as `process-state`, and the same answer: a module-level registry rather
 * than an injected dependency, so the edge does not have to point upward.
 *
 * A loader declares itself when it is constructed. Nothing else may write here,
 * and a review that finds nothing declared reports UNKNOWN rather than a pass —
 * "no loader said anything" and "the loader said it is safe" are different
 * claims and must not share an answer.
 */
export interface DeclaredIsolation {
  readonly loader: string;
  readonly level: 'none' | 'thread' | 'process';
  readonly executesPublisherCode: boolean;
}

let active: DeclaredIsolation | null = null;

/** Called by the bound loader. The last one bound wins, as it should. */
export function declareIsolation(declaration: DeclaredIsolation): void {
  active = declaration;
}

/** What the active loader declared, or null if none has. */
export function activeIsolation(): DeclaredIsolation | null {
  return active;
}

/** Test seam. Never called in the running application. */
export function resetIsolation(): void {
  active = null;
}
