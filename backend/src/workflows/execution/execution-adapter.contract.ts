/**
 * Execution adapters — the seam between deciding *what* should happen and
 * deciding *how* it happens.
 *
 * PRISM-X owns intelligence, missions, workers and business rules. It does not
 * try to be a better n8n. A workflow step therefore names an adapter, and the
 * adapter is responsible for actually performing the work:
 *
 *     Workflow Engine
 *          │
 *          ▼
 *     Execution Adapter
 *          ├── internal   — run a worker, call an integration, branch, wait
 *          ├── n8n        — trigger an n8n workflow and collect its result
 *          ├── make       — trigger a Make.com scenario
 *          ├── rest       — call an arbitrary HTTP endpoint
 *          └── future runtimes
 *
 * The consequence that matters: adopting n8n or Make later does not mean
 * rewriting orchestration. PRISM-X remains the single source of truth for what
 * should run and why, and delegates execution to whichever runtime the
 * operator prefers — including several at once, step by step.
 */
export interface AdapterExecutionContext {
  runId: string;
  stepId: string;
  organizationId: string;
  workflowId: string;
  /** Accumulated outputs of previous steps, keyed by step id. */
  context: Record<string, unknown>;
  /** The run's original input. */
  input: Record<string, unknown>;
}

export interface AdapterResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  /** Cost attributable to this step, when the adapter knows it. */
  costUsd?: number;
  totalTokens?: number;
  /** Set when the step cannot finish now and the run should suspend. */
  suspend?: {
    reason: 'approval' | 'delay';
    until?: Date;
    approvalId?: string;
  };
  /** Identifier in the external runtime, for tracing across systems. */
  externalRunId?: string;
}

export interface IExecutionAdapter {
  /** Adapter key referenced by `step.adapter`. */
  readonly key: string;
  readonly displayName: string;
  /** Step types this adapter can execute. */
  readonly supports: string[];

  execute(
    step: WorkflowStep,
    context: AdapterExecutionContext,
  ): Promise<AdapterResult>;

  /** Whether the adapter's dependencies are reachable. Must not throw. */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}

/**
 * One node in a workflow.
 *
 * The shape is deliberately flat and JSON-serializable: a version is an
 * immutable snapshot stored in a `Json` column, and anything clever in the
 * representation would make versions hard to diff and harder to audit.
 */
export interface WorkflowStep {
  id: string;
  name?: string;
  /**
   * What this step does:
   *   worker      — run a PRISM-X worker
   *   integration — call an external service through the Integration Manager
   *   mission     — start a PRISM-X mission
   *   condition   — branch on a predicate
   *   parallel    — run child steps concurrently
   *   loop        — repeat child steps over a collection
   *   delay       — sleep
   *   approval    — suspend for a human decision
   *   ai_decision — let a worker choose among allowed options
   *   workflow    — invoke another workflow (nesting)
   *   http        — call an arbitrary endpoint
   *   n8n / make  — delegate to an external automation runtime
   */
  type: string;
  /** Overrides the adapter inferred from `type`. */
  adapter?: string;
  /** Step-specific configuration. `{{...}}` placeholders resolve at run time. */
  config: Record<string, unknown>;
  /** Steps that must complete first. Empty means it may run in the first wave. */
  dependsOn?: string[];
  /** Predicate gating execution; a false result marks the step SKIPPED. */
  condition?: WorkflowCondition;
  /** Child steps, for parallel / loop / condition branches. */
  steps?: WorkflowStep[];
  onTrue?: WorkflowStep[];
  onFalse?: WorkflowStep[];

  // Per-step reliability, overriding the workflow envelope.
  retries?: number;
  timeoutMs?: number;
  /** What to do when this step fails: fail the run, continue, or run a fallback. */
  onError?: 'fail' | 'continue' | 'fallback';
  fallback?: WorkflowStep;
}

export interface WorkflowCondition {
  /** Left-hand value, usually a `{{...}}` reference into the run context. */
  left: unknown;
  operator:
    | 'eq'
    | 'neq'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'contains'
    | 'not_contains'
    | 'exists'
    | 'not_exists'
    | 'in'
    | 'truthy'
    | 'falsy';
  right?: unknown;
}

/** Raised when a step's configuration is invalid. Never retried. */
export class WorkflowStepError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'WorkflowStepError';
  }
}
