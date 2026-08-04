import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Worker } from '@prisma/client';
import {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionError,
  ToolResult,
} from './tool.contract';
import { BuiltinTools } from './builtin-tools';
import { ToolCallRepository } from '../database/repositories/execution.repositories';
import { RequestContextStore } from '../shared/context/request-context';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';

/**
 * Registry and gatekeeper for worker tool use.
 *
 * Every invocation passes two independent checks before any tool code runs:
 *
 *  1. **The worker's grant.** `worker.toolPermissions` lists what this
 *     specific worker may use. An empty list means no tools — a worker gains
 *     capability only by explicit configuration, never by default.
 *  2. **The organization's permission.** The tool's `requiredPermission` must
 *     be held by the acting principal. A worker can therefore never exceed
 *     the authority of whoever set the mission running.
 *
 * Denials are recorded rather than silently dropped: a worker repeatedly
 * reaching for a tool it lacks is a signal worth surfacing.
 */
@Injectable()
export class ToolRegistry implements OnModuleInit {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly builtins: BuiltinTools,
    private readonly toolCalls: ToolCallRepository,
    private readonly events: EventBusService,
  ) {}

  onModuleInit(): void {
    for (const tool of this.builtins.all()) this.register(tool);
    this.logger.log(`Registered ${this.tools.size} tools: ${this.keys().join(', ')}`);
  }

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.key)) {
      this.logger.warn(`Replacing existing tool "${tool.key}"`);
    }
    this.tools.set(tool.key, tool);
  }

  /**
   * Installs a resolver for tools that are not process-wide singletons.
   *
   * Contributed tools cannot live in `this.tools`: the map is one per process
   * while the set of installed extensions is one per organization, so a static
   * registration would leak one tenant's tools into another's catalogue. The
   * resolver is consulted per key, inside the caller's request context, which
   * is what keeps the lookup tenant-scoped.
   *
   * Kept as a callback rather than an injected dependency: the platform module
   * depends on this registry, and an edge back would be a cycle.
   */
  setDynamicResolver(
    resolver: (key: string) => Promise<ToolDefinition | undefined>,
  ): void {
    this.dynamicResolver = resolver;
  }

  private dynamicResolver?: (key: string) => Promise<ToolDefinition | undefined>;

  /** A built-in tool, or a contributed one resolved for the current tenant. */
  async resolve(key: string): Promise<ToolDefinition | undefined> {
    const builtin = this.tools.get(key);
    if (builtin) return builtin;
    if (!this.dynamicResolver) return undefined;
    try {
      return await this.dynamicResolver(key);
    } catch (error) {
      this.logger.warn(`Dynamic tool resolution failed for "${key}": ${(error as Error).message}`);
      return undefined;
    }
  }

  keys(): string[] {
    return [...this.tools.keys()];
  }

  get(key: string): ToolDefinition | undefined {
    return this.tools.get(key);
  }

  /** Every registered tool, for the catalogue endpoint. */
  describeAll() {
    return [...this.tools.values()].map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      requiredPermission: t.requiredPermission,
      mutates: t.mutates,
      parameters: t.parameters,
    }));
  }

  /** The subset a given worker is both granted and authorized to use. */
  async availableTo(worker: Pick<Worker, 'toolPermissions'>): Promise<ToolDefinition[]> {
    const ctx = RequestContextStore.get();
    const permissions = ctx?.permissions ?? [];
    const unrestricted = permissions.includes('*');

    // Driven by the worker's grant rather than by the registry, so contributed
    // tools — which are not in the map — are reached through the resolver.
    const resolved = await Promise.all(
      worker.toolPermissions.map((key) => this.resolve(key)),
    );

    return resolved.filter(
      (tool): tool is ToolDefinition =>
        tool !== undefined &&
        (unrestricted || permissions.includes(tool.requiredPermission)),
    );
  }

  /** Tool descriptions rendered for a prompt. */
  async describeForPrompt(worker: Pick<Worker, 'toolPermissions'>): Promise<string> {
    const available = await this.availableTo(worker);
    if (!available.length) return '';

    return available
      .map((tool) => {
        const params = Object.entries(tool.parameters)
          .map(([name, p]) => `${name}${p.required ? '' : '?'}: ${p.type}`)
          .join(', ');
        return `- ${tool.key}(${params}) — ${tool.description}`;
      })
      .join('\n');
  }

  /**
   * Runs a tool on a worker's behalf, enforcing both checks and logging the
   * outcome. Never throws: a failed tool is a result the worker should be
   * able to reason about, not an exception that aborts its execution.
   */
  async invoke(
    key: string,
    input: Record<string, unknown>,
    worker: Pick<Worker, 'id' | 'toolPermissions'>,
    context: Omit<ToolExecutionContext, 'workerId' | 'organizationId'>,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const ctx = RequestContextStore.require();
    const fullContext: ToolExecutionContext = {
      ...context,
      workerId: worker.id,
      organizationId: ctx.organizationId,
    };

    const tool = await this.resolve(key);
    if (!tool) {
      return this.deny(key, input, worker.id, fullContext, `Unknown tool "${key}"`, startedAt);
    }

    if (!worker.toolPermissions.includes(key)) {
      return this.deny(
        key,
        input,
        worker.id,
        fullContext,
        `Worker is not granted "${key}"`,
        startedAt,
      );
    }

    const permissions = ctx.permissions;
    if (!permissions.includes('*') && !permissions.includes(tool.requiredPermission)) {
      return this.deny(
        key,
        input,
        worker.id,
        fullContext,
        `Caller lacks "${tool.requiredPermission}"`,
        startedAt,
      );
    }

    try {
      const output = await tool.execute(input, fullContext);
      const durationMs = Date.now() - startedAt;

      await this.record({
        tool: key,
        input,
        output,
        status: 'SUCCESS',
        denied: false,
        durationMs,
        workerId: worker.id,
        executionLogId: context.executionLogId,
      });

      await this.events.publish(DomainEvent.ToolInvoked, {
        tool: key,
        workerId: worker.id,
        missionId: context.missionId,
        durationMs,
      });

      return { tool: key, ok: true, output, durationMs };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message =
        error instanceof ToolExecutionError
          ? error.message
          : `Tool failed: ${(error as Error).message}`;

      await this.record({
        tool: key,
        input,
        output: null,
        status: 'FAILED',
        denied: false,
        durationMs,
        workerId: worker.id,
        executionLogId: context.executionLogId,
        error: message,
      });

      this.logger.warn(`Tool "${key}" failed for worker ${worker.id}: ${message}`);
      return { tool: key, ok: false, error: message, durationMs };
    }
  }

  private async deny(
    key: string,
    input: Record<string, unknown>,
    workerId: string,
    context: ToolExecutionContext,
    reason: string,
    startedAt: number,
  ): Promise<ToolResult> {
    const durationMs = Date.now() - startedAt;

    await this.record({
      tool: key,
      input,
      output: null,
      status: 'DENIED',
      denied: true,
      durationMs,
      workerId,
      executionLogId: context.executionLogId,
      error: reason,
    });

    await this.events.publish(DomainEvent.ToolDenied, {
      tool: key,
      workerId,
      missionId: context.missionId,
      reason,
    });

    this.logger.warn(`Tool "${key}" denied for worker ${workerId}: ${reason}`);
    return { tool: key, ok: false, denied: true, error: reason, durationMs };
  }

  private async record(entry: {
    tool: string;
    input: Record<string, unknown>;
    output: unknown;
    status: 'SUCCESS' | 'FAILED' | 'DENIED';
    denied: boolean;
    durationMs: number;
    workerId: string;
    executionLogId?: string;
    error?: string;
  }): Promise<void> {
    try {
      await this.toolCalls.create({
        tool: entry.tool,
        // Bounded: a tool argument could otherwise be megabytes.
        input: ToolRegistry.truncate(entry.input) as never,
        output: (entry.output ? ToolRegistry.truncate(entry.output) : null) as never,
        status: entry.status,
        denied: entry.denied,
        durationMs: entry.durationMs,
        workerId: entry.workerId,
        executionLogId: entry.executionLogId ?? null,
        error: entry.error ?? null,
      });
    } catch (error) {
      // Logging a tool call must never break the tool call.
      this.logger.error(`Failed to record tool call: ${(error as Error).message}`);
    }
  }

  private static truncate(value: unknown, maxChars = 4000): unknown {
    const json = JSON.stringify(value);
    if (!json || json.length <= maxChars) return value;
    return { truncated: true, preview: json.slice(0, maxChars) };
  }
}
