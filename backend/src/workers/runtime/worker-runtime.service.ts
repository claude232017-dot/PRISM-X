import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ExecutionStatus, ProviderKind, Worker } from '@prisma/client';
import { ProviderManager } from '../../providers/provider-manager.service';
import { MemoryService } from '../../memory/memory.service';
import { KnowledgeRetrievalService } from '../../knowledge/retrieval/knowledge-retrieval.service';
import { ToolRegistry } from '../../tools/tool-registry.service';
import { ToolResult } from '../../tools/tool.contract';
import {
  ExecutionLogRepository,
  UsageDailyRepository,
} from '../../database/repositories/execution.repositories';
import {
  ProviderRepository,
  WorkerRepository,
} from '../../database/repositories/tenant.repositories';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEvent } from '../../events/domain-events';
import { CompletionMessage } from '../../providers/contracts/intelligence-provider.interface';

export interface WorkerExecutionRequest {
  workerId: string;
  /** What the worker is being asked to do. */
  instruction: string;
  missionId?: string;
  taskId?: string;
  /** Extra context, e.g. outputs of upstream tasks. */
  context?: string;
  /** Override the worker's configured provider. */
  providerId?: string;
  /** Skip retrieval — used when the caller has already assembled context. */
  skipRetrieval?: boolean;
  /**
   * Run here, on this process, without consulting the fleet.
   *
   * Set by the node agent when work arrives from the control plane: that
   * work has already been placed, and re-entering the router would bounce it
   * onward forever.
   */
  forceLocal?: boolean;
}

export interface WorkerExecutionResult {
  executionLogId: string;
  workerId: string;
  status: ExecutionStatus;
  output: string;
  model: string;
  providerId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  iterations: number;
  toolCalls: ToolResult[];
  error?: string;
}

/**
 * Turns a stored Worker record into something that actually runs.
 *
 * The work here is assembling *context*, not calling a model — that part is
 * one line. What determines whether a worker is useful is what it is told:
 * its standing instructions, what it remembers, what the organization knows,
 * and what it is allowed to do. This service composes those four things,
 * enforces the worker's limits, runs the tool loop, and records exactly what
 * happened.
 */
@Injectable()
export class WorkerRuntimeService {
  private readonly logger = new Logger(WorkerRuntimeService.name);

  /**
   * Tool-call protocol.
   *
   * A single text protocol is used across every provider rather than each
   * vendor's native tool-calling format. That keeps worker behaviour
   * identical no matter who serves the request — a worker that works on
   * Anthropic behaves the same on Gemini — and keeps vendor-specific parsing
   * out of the runtime. Native tool calling can be adopted per-adapter later
   * without changing this contract.
   */
  private static readonly TOOL_CALL_PATTERN = /TOOL_CALL:\s*(\{[\s\S]*?\})\s*(?:\n|$)/g;

  /** providerId → kind. Immutable per provider, so safe to memoize. */
  private readonly providerKindCache = new Map<string, ProviderKind | null>();

  constructor(
    private readonly workers: WorkerRepository,
    private readonly providers: ProviderRepository,
    private readonly providerManager: ProviderManager,
    private readonly memory: MemoryService,
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly tools: ToolRegistry,
    private readonly executionLogs: ExecutionLogRepository,
    private readonly usage: UsageDailyRepository,
    private readonly events: EventBusService,
  ) {}

  /**
   * Optional fleet router, installed by the distributed layer at startup.
   *
   * A callback rather than an injected dependency because the distributed
   * layer already depends on this service to *do* the executing — injecting
   * it back would be a cycle. Returning `null` means "the fleet chose this
   * machine", which drops straight through to the local path below, so a
   * single-machine install behaves exactly as it did before nodes existed.
   */
  private router?: (
    request: WorkerExecutionRequest,
  ) => Promise<WorkerExecutionResult | null>;

  onRemoteRoute(
    router: (request: WorkerExecutionRequest) => Promise<WorkerExecutionResult | null>,
  ): void {
    this.router = router;
  }

  async execute(request: WorkerExecutionRequest): Promise<WorkerExecutionResult> {
    if (this.router && !request.forceLocal) {
      const routed = await this.router(request);
      // A result means the work ran somewhere else and is already recorded
      // there; there is nothing left for this process to do.
      if (routed) return routed;
    }

    const worker = await this.workers.findByIdOrFail(request.workerId);

    if (worker.status === 'ARCHIVED') {
      throw new BadRequestException(`Worker "${worker.name}" is archived and cannot run`);
    }

    const log = await this.executionLogs.create({
      workerId: worker.id,
      missionId: request.missionId ?? null,
      taskId: request.taskId ?? null,
      providerId: request.providerId ?? worker.providerId ?? null,
      status: ExecutionStatus.RUNNING,
      startedAt: new Date(),
    });

    await this.events.publish(DomainEvent.WorkerExecutionStarted, {
      workerId: worker.id,
      executionLogId: log.id,
      missionId: request.missionId,
      taskId: request.taskId,
    });

    const startedAt = Date.now();

    try {
      const result = await this.runLoop(worker, request, log.id, startedAt);
      await this.finalize(log.id, worker, request, result);
      return result;
    } catch (error) {
      const failure = await this.handleFailure(log.id, worker, request, error, startedAt);
      return failure;
    }
  }

  /**
   * The execution loop.
   *
   * Iterates while the model asks for tools, up to `worker.maxIterations`.
   * The bound is not a formality: without it a model that keeps requesting
   * tools would loop until the budget or the request timeout ran out, and the
   * failure would look like a hang rather than a limit being reached.
   */
  private async runLoop(
    worker: Worker,
    request: WorkerExecutionRequest,
    executionLogId: string,
    startedAt: number,
  ): Promise<WorkerExecutionResult> {
    const messages = await this.buildMessages(worker, request);
    const toolResults: ToolResult[] = [];

    let promptTokens = 0;
    let completionTokens = 0;
    let costUsd = 0;
    let iterations = 0;
    let providerId = '';
    let model = '';
    let output = '';

    for (let iteration = 1; iteration <= worker.maxIterations; iteration++) {
      iterations = iteration;

      if (Date.now() - startedAt > worker.timeoutMs) {
        throw new ExecutionTimeout(
          `Worker exceeded its ${worker.timeoutMs}ms time limit after ${iteration - 1} iteration(s)`,
        );
      }

      const completion = await this.providerManager.complete({
        messages,
        model: worker.defaultModel ?? undefined,
        temperature: worker.temperature,
        maxTokens: worker.maxTokens,
        providerId: request.providerId ?? worker.providerId ?? undefined,
        allowFailover: worker.allowFailover,
      });

      promptTokens += completion.usage.promptTokens;
      completionTokens += completion.usage.completionTokens;
      costUsd += completion.costUsd;
      providerId = completion.providerId;
      model = completion.model;
      output = completion.content;

      // Budget is checked after each call rather than only at the end, so a
      // runaway worker is stopped mid-flight instead of after it has spent.
      if (worker.costLimitUsd !== null && costUsd > worker.costLimitUsd) {
        await this.events.publish(DomainEvent.WorkerBudgetExceeded, {
          workerId: worker.id,
          costUsd,
          limitUsd: worker.costLimitUsd,
        });
        throw new BudgetExceeded(
          `Worker exceeded its $${worker.costLimitUsd} budget (spent $${costUsd.toFixed(6)})`,
        );
      }

      const requestedTools = WorkerRuntimeService.parseToolCalls(completion.content);
      if (!requestedTools.length) break;

      messages.push({ role: 'assistant', content: completion.content });

      for (const call of requestedTools) {
        const result = await this.tools.invoke(call.tool, call.input, worker, {
          missionId: request.missionId,
          taskId: request.taskId,
          executionLogId,
        });
        toolResults.push(result);

        messages.push({
          role: 'user',
          content:
            `TOOL_RESULT ${call.tool}: ` +
            (result.ok
              ? JSON.stringify(result.output).slice(0, 4000)
              : `ERROR — ${result.error}`),
        });
      }
    }

    return {
      executionLogId,
      workerId: worker.id,
      status: ExecutionStatus.SUCCEEDED,
      output,
      model,
      providerId,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: Math.round(costUsd * 1e8) / 1e8,
      latencyMs: Date.now() - startedAt,
      iterations,
      toolCalls: toolResults,
    };
  }

  /**
   * Assembles the prompt: identity, memory, knowledge, tools, then the task.
   *
   * Order is deliberate — standing instructions first so they frame
   * everything after, retrieved context in the middle, and the actual
   * instruction last where it is most salient.
   */
  private async buildMessages(
    worker: Worker,
    request: WorkerExecutionRequest,
  ): Promise<CompletionMessage[]> {
    const sections: string[] = [];

    sections.push(
      worker.systemPrompt?.trim() ||
        `You are ${worker.name}, a ${worker.role} operating inside PRISM-X.`,
    );

    if (worker.skills.length) {
      sections.push(`Your skills: ${worker.skills.join(', ')}.`);
    }

    if (!request.skipRetrieval) {
      const recalled = await this.memory.recallAsContext({
        workerId: worker.id,
        query: request.instruction,
        limit: 6,
      });
      if (recalled) {
        sections.push(`Recalled context from your memory:\n${recalled}`);
      }

      const knowledge = await this.retrieval.retrieveAsContext({
        query: request.instruction,
        limit: 4,
        workerId: worker.id,
        missionId: request.missionId,
      });
      if (knowledge) {
        sections.push(
          `Relevant organizational knowledge base entries:\n${knowledge}\n` +
            'Cite these by their bracketed number when you rely on them.',
        );
      }
    }

    const toolCatalogue = this.tools.describeForPrompt(worker);
    if (toolCatalogue) {
      sections.push(
        `Available tools:\n${toolCatalogue}\n\n` +
          'To use a tool, emit a line of exactly this form and then stop:\n' +
          'TOOL_CALL: {"tool": "<key>", "input": { ... }}\n' +
          'You will receive a TOOL_RESULT message and may then continue. ' +
          'Call a tool only when you genuinely need it; otherwise answer directly.',
      );
    }

    const messages: CompletionMessage[] = [
      { role: 'system', content: sections.join('\n\n') },
    ];

    if (request.context) {
      messages.push({
        role: 'user',
        content: `Context from earlier steps:\n${request.context}`,
      });
    }

    messages.push({ role: 'user', content: request.instruction });
    return messages;
  }

  /** Extracts TOOL_CALL directives, ignoring malformed ones. */
  private static parseToolCalls(
    content: string,
  ): { tool: string; input: Record<string, unknown> }[] {
    const calls: { tool: string; input: Record<string, unknown> }[] = [];
    // The regex is stateful (`g`), so it must be reset between uses.
    WorkerRuntimeService.TOOL_CALL_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = WorkerRuntimeService.TOOL_CALL_PATTERN.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]) as {
          tool?: string;
          input?: Record<string, unknown>;
        };
        if (parsed.tool) {
          calls.push({ tool: parsed.tool, input: parsed.input ?? {} });
        }
      } catch {
        // A model emitting invalid JSON is not an error worth aborting on;
        // the turn simply yields no tool call.
      }
    }
    return calls;
  }

  private async finalize(
    executionLogId: string,
    worker: Worker,
    request: WorkerExecutionRequest,
    result: WorkerExecutionResult,
  ): Promise<void> {
    await this.executionLogs.update(executionLogId, {
      status: ExecutionStatus.SUCCEEDED,
      providerId: result.providerId || null,
      providerKind: await this.providerKind(result.providerId),
      model: result.model,
      prompt: request.instruction.slice(0, 4000),
      outputSummary: result.output.slice(0, 4000),
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      attempts: result.iterations,
      finishedAt: new Date(),
      metadata: {
        toolCalls: result.toolCalls.length,
        toolsDenied: result.toolCalls.filter((t) => t.denied).length,
      } as never,
    });

    await this.recordUsage(worker, result, false);

    await this.memory.rememberExecution({
      workerId: worker.id,
      missionId: request.missionId,
      taskId: request.taskId,
      summary:
        `Task: ${request.instruction.slice(0, 200)}\n` +
        `Result: ${result.output.slice(0, 400)}`,
      succeeded: true,
    });

    await this.events.publish(DomainEvent.WorkerFinished, {
      workerId: worker.id,
      executionLogId,
      missionId: request.missionId,
      taskId: request.taskId,
      status: 'SUCCEEDED',
      costUsd: result.costUsd,
      totalTokens: result.totalTokens,
      latencyMs: result.latencyMs,
    });
  }

  private async handleFailure(
    executionLogId: string,
    worker: Worker,
    request: WorkerExecutionRequest,
    error: unknown,
    startedAt: number,
  ): Promise<WorkerExecutionResult> {
    const message = (error as Error).message;
    const status =
      error instanceof ExecutionTimeout
        ? ExecutionStatus.TIMEOUT
        : error instanceof BudgetExceeded
          ? ExecutionStatus.BUDGET_EXCEEDED
          : ExecutionStatus.FAILED;

    const latencyMs = Date.now() - startedAt;

    await this.executionLogs.update(executionLogId, {
      status,
      error: message.slice(0, 1000),
      prompt: request.instruction.slice(0, 4000),
      latencyMs,
      finishedAt: new Date(),
    });

    // A failure is worth remembering — it is what stops the worker making the
    // same attempt next time.
    await this.memory.rememberExecution({
      workerId: worker.id,
      missionId: request.missionId,
      taskId: request.taskId,
      summary: `Task: ${request.instruction.slice(0, 200)}\nFailed: ${message.slice(0, 300)}`,
      succeeded: false,
    });

    // Zeros rather than omissions: a consumer of worker.finished should not
    // have to special-case the failure shape to read telemetry off it.
    await this.events.publish(DomainEvent.WorkerFinished, {
      workerId: worker.id,
      executionLogId,
      missionId: request.missionId,
      taskId: request.taskId,
      status,
      costUsd: 0,
      totalTokens: 0,
      latencyMs,
      error: message.slice(0, 300),
    });

    this.logger.warn(`Worker ${worker.name} execution failed: ${message}`);

    return {
      executionLogId,
      workerId: worker.id,
      status,
      output: '',
      model: '',
      providerId: '',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      latencyMs,
      iterations: 0,
      toolCalls: [],
      error: message,
    };
  }

  private async recordUsage(
    worker: Worker,
    result: WorkerExecutionResult,
    failed: boolean,
  ): Promise<void> {
    // Midnight UTC — the bucket key for the daily rollup.
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);

    try {
      await this.usage.accumulate({
        day,
        providerId: result.providerId || null,
        providerKind: await this.providerKind(result.providerId),
        model: result.model || null,
        workerId: worker.id,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        failed,
      });

      await this.events.publish(DomainEvent.UsageRecorded, {
        workerId: worker.id,
        costUsd: result.costUsd,
        totalTokens: result.totalTokens,
      });
    } catch (error) {
      this.logger.error(`Usage rollup failed: ${(error as Error).message}`);
    }
  }

  /**
   * Resolves a provider's kind for telemetry, cached for the life of the
   * request. Kind never changes for a given provider, so re-reading it on
   * every log write would be pure overhead.
   */
  private async providerKind(providerId: string): Promise<ProviderKind | null> {
    if (!providerId) return null;

    const cached = this.providerKindCache.get(providerId);
    if (cached !== undefined) return cached;

    const provider = await this.providers.findById(providerId);
    const kind = provider?.kind ?? null;
    this.providerKindCache.set(providerId, kind);
    return kind;
  }
}

/** Worker ran past its wall-clock limit. */
export class ExecutionTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionTimeout';
  }
}

/** Worker spent past its configured cost ceiling. */
export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceeded';
  }
}
