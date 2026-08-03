import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ExecutionStatus, Worker } from '@prisma/client';
import {
  WorkerExecutionRequest,
  WorkerExecutionResult,
  WorkerRuntimeService,
} from '../workers/runtime/worker-runtime.service';
import { WorkerRepository } from '../database/repositories/tenant.repositories';
import { NodeRepository } from '../database/repositories/distributed.repositories';
import { NodeRequirements, capabilityKey } from '../nodes/node.contract';
import { TaskHandlerRegistry } from '../nodes/task-handler.registry';
import { ToolRegistry } from '../tools/tool-registry.service';
import { NodeScheduler } from './node-scheduler.service';
import { DistributedExecutionService } from './distributed-execution.service';

/**
 * Makes worker execution fleet-aware without any caller knowing.
 *
 * Everything that runs workers today — the mission orchestrator, the
 * workflow engine's `worker` step, the manual run endpoint — keeps calling
 * `WorkerRuntimeService.execute` exactly as before. This service installs
 * itself as that method's router at startup and answers one question:
 * should this run here, or somewhere else?
 *
 * When the answer is "here" it returns null and the original in-process path
 * runs untouched. That is deliberate: the common case must not acquire a
 * network round trip, a serialization step, or a new failure mode just
 * because the system is *capable* of distribution.
 */
@Injectable()
export class DistributedWorkerRouter implements OnModuleInit {
  private readonly logger = new Logger(DistributedWorkerRouter.name);

  constructor(
    private readonly runtime: WorkerRuntimeService,
    private readonly workers: WorkerRepository,
    private readonly nodes: NodeRepository,
    private readonly scheduler: NodeScheduler,
    private readonly execution: DistributedExecutionService,
    private readonly handlers: TaskHandlerRegistry,
    private readonly tools: ToolRegistry,
  ) {}

  onModuleInit(): void {
    this.runtime.onRemoteRoute((request) => this.route(request));

    // What a node advertises it can run. Registered here rather than in the
    // runtime module so the runtime stays unaware of the fleet entirely.
    this.handlers.register('worker.execute', async (dispatch) => {
      const payload = dispatch.payload as unknown as WorkerExecutionRequest;
      const result = await this.runtime.execute({ ...payload, forceLocal: true });
      return {
        result: result as unknown as Record<string, unknown>,
        costUsd: result.costUsd,
        totalTokens: result.totalTokens,
      };
    });

    this.handlers.register('tool.invoke', async (dispatch) => {
      const { workerId, tool, input, missionId, taskId } = dispatch.payload as {
        workerId: string;
        tool: string;
        input: Record<string, unknown>;
        missionId?: string;
        taskId?: string;
      };
      const worker = await this.workers.findByIdOrFail(workerId);
      // The worker's own tool permissions still gate the call: arriving over
      // the fleet transport confers no authority the worker did not have.
      const result = await this.tools.invoke(tool, input, worker, { missionId, taskId });
      return { result: result as unknown as Record<string, unknown> };
    });

    // A no-op handler, so the fleet can be exercised end to end — placement,
    // dispatch, lease, failover — without needing a provider key.
    this.handlers.register('echo', async (dispatch) => ({
      result: { echoed: dispatch.payload, at: new Date().toISOString() },
    }));
  }

  /**
   * Decides where a worker execution runs.
   *
   * Returns null for "run it here", which covers three cases that all
   * genuinely mean the same thing: there is no fleet, the fleet chose this
   * machine, or the fleet could not choose at all. The last one is the
   * interesting choice — falling back to local execution rather than
   * queueing means a scheduling problem degrades to the behaviour the system
   * had before Phase 4, instead of stalling work that could have run.
   */
  async route(request: WorkerExecutionRequest): Promise<WorkerExecutionResult | null> {
    const worker = await this.workers.findByIdOrFail(request.workerId);
    const requirements = await this.requirementsFor(worker, request);

    const local = await this.nodes.findLocal();

    // No fleet at all: nothing to distribute to, so do not pay for deciding.
    const fleet = await this.nodes.schedulable();
    if (fleet.length === 0) return null;

    const placement = await this.scheduler.place(requirements);

    if (!placement.node) {
      this.logger.debug(`No remote placement for worker ${worker.id}: ${placement.explanation}`);
      // A pin that cannot be honoured is an error the caller should see,
      // not something to quietly paper over by running somewhere else.
      if (requirements.nodeId && requirements.nodeId !== local?.id) {
        throw new Error(
          `Worker "${worker.name}" is pinned to a node that cannot take work: ${placement.explanation}`,
        );
      }
      return null;
    }

    if (local && placement.node.id === local.id) {
      // The fleet picked this machine. Fall through to the in-process path
      // rather than dispatching to ourselves over a transport.
      return null;
    }

    this.logger.log(
      `Routing worker ${worker.name} to ${placement.node.slug}: ${placement.explanation}`,
    );

    const outcome = await this.execution.run({
      kind: 'worker.execute',
      payload: { ...request, forceLocal: true } as unknown as Record<string, unknown>,
      requirements,
      workerId: worker.id,
      missionId: request.missionId,
      taskId: request.taskId,
      timeoutMs: worker.timeoutMs,
      metadata: { routedFrom: local?.slug ?? 'control-plane' },
    });

    return DistributedWorkerRouter.toResult(outcome, worker, placement.node.id);
  }

  /**
   * Turns a worker's configuration into scheduling constraints.
   *
   * The worker's declared provider becomes a required capability, which is
   * what stops the scheduler placing an OpenAI-backed worker on a node that
   * only has Ollama installed — a placement that would fail at the last
   * possible moment, after the dispatch and the lease.
   */
  private async requirementsFor(
    worker: Worker,
    request: WorkerExecutionRequest,
  ): Promise<NodeRequirements> {
    const declared = (worker.nodeRequirements ?? {}) as NodeRequirements;
    const capabilities = [...(declared.capabilities ?? [])];

    for (const key of worker.toolPermissions) {
      capabilities.push(capabilityKey('TOOL', key));
    }

    return {
      ...declared,
      capabilities: [...new Set(capabilities)],
      nodeId: declared.nodeId ?? worker.preferredNodeId ?? undefined,
    };
  }

  /**
   * Maps a fleet outcome back onto the shape callers already expect.
   *
   * A remote failure is reported as a failed execution rather than thrown,
   * matching what the local path does when a provider call fails — callers
   * handle one failure shape, not two.
   */
  static toResult(
    outcome: { task: { id: string; status: string; result: unknown; error: string | null; costUsd: number; totalTokens: number; durationMs: number | null } },
    worker: Worker,
    nodeId: string,
  ): WorkerExecutionResult {
    const task = outcome.task;
    const remote = (task.result ?? {}) as Partial<WorkerExecutionResult>;

    if (task.status === 'SUCCEEDED' && remote.executionLogId) {
      // The node recorded its own execution log, so its identifiers are the
      // authoritative ones; only the placement is added on top.
      return { ...(remote as WorkerExecutionResult) };
    }

    return {
      executionLogId: remote.executionLogId ?? '',
      workerId: worker.id,
      status:
        task.status === 'SUCCEEDED' ? ExecutionStatus.SUCCEEDED : ExecutionStatus.FAILED,
      output: remote.output ?? '',
      model: remote.model ?? worker.defaultModel ?? '',
      providerId: remote.providerId ?? worker.providerId ?? '',
      promptTokens: remote.promptTokens ?? 0,
      completionTokens: remote.completionTokens ?? 0,
      totalTokens: remote.totalTokens ?? task.totalTokens ?? 0,
      costUsd: remote.costUsd ?? task.costUsd ?? 0,
      latencyMs: remote.latencyMs ?? task.durationMs ?? 0,
      iterations: remote.iterations ?? 0,
      toolCalls: remote.toolCalls ?? [],
      error: task.error ?? remote.error ?? `Distributed task ${task.id} did not succeed`,
    };
  }
}
