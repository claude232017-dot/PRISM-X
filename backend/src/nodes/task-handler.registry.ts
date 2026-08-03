import { Injectable, Logger } from '@nestjs/common';
import { NodeDispatch } from './node.contract';

export interface TaskHandlerResult {
  result?: Record<string, unknown>;
  costUsd?: number;
  totalTokens?: number;
}

export type TaskHandler = (dispatch: NodeDispatch) => Promise<TaskHandlerResult>;

/**
 * What a node knows how to run, keyed by task kind.
 *
 * This registry is the reason a node is a general-purpose executor rather
 * than a worker-running special case. `worker.execute` is registered by the
 * worker runtime, `tool.invoke` by the tool registry, and anything added
 * later registers itself the same way — the transports, the scheduler and
 * the coordinator never learn what a kind means.
 *
 * It also breaks what would otherwise be a dependency cycle. The distributed
 * layer needs to run worker executions, and worker execution needs to be
 * routable across the fleet; both sides depend on this registry instead of
 * on each other.
 */
@Injectable()
export class TaskHandlerRegistry {
  private readonly logger = new Logger(TaskHandlerRegistry.name);
  private readonly handlers = new Map<string, TaskHandler>();

  register(kind: string, handler: TaskHandler): void {
    if (this.handlers.has(kind)) {
      this.logger.warn(`Task handler "${kind}" was replaced`);
    }
    this.handlers.set(kind, handler);
  }

  has(kind: string): boolean {
    return this.handlers.has(kind);
  }

  kinds(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /**
   * Runs a dispatch.
   *
   * An unknown kind throws rather than silently succeeding: a node that
   * quietly accepts work it cannot do is worse than one that refuses, because
   * the coordinator would record a success that never happened.
   */
  async invoke(dispatch: NodeDispatch): Promise<TaskHandlerResult> {
    const handler = this.handlers.get(dispatch.kind);
    if (!handler) {
      throw new Error(`No handler registered for task kind "${dispatch.kind}"`);
    }
    return handler(dispatch);
  }
}
