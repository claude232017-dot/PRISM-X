import type { PermissionKey } from '../auth/permissions';

/**
 * A capability a worker may invoke during execution.
 *
 * Every tool declares the permission it needs. Authorization is therefore not
 * a property of the tool's implementation — which could forget to check — but
 * of its declaration, and the registry enforces it uniformly before any tool
 * code runs.
 */
export interface ToolDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  /** Stable identifier used in `worker.toolPermissions`. */
  key: string;
  name: string;
  description: string;
  /** Organization permission the *caller* must hold. */
  requiredPermission: PermissionKey;
  /** JSON-schema-ish parameter description, shown to the model. */
  parameters: Record<string, ToolParameter>;
  /** True for tools that change state — logged more prominently. */
  mutates: boolean;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface ToolExecutionContext {
  workerId: string;
  organizationId: string;
  missionId?: string;
  taskId?: string;
  executionLogId?: string;
}

export interface ToolResult<T = unknown> {
  tool: string;
  ok: boolean;
  output?: T;
  error?: string;
  denied?: boolean;
  durationMs: number;
}

/** Raised when a tool's own preconditions fail (bad input, missing record). */
export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}
