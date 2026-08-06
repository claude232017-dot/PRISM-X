import { Injectable, Logger } from '@nestjs/common';
import { Node } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  HeartbeatReport,
  INodeTransport,
  NodeDispatch,
  NodeDispatchResult,
} from '../node.contract';
import { TaskHandlerRegistry } from '../task-handler.registry';
import { NodeSecurityService } from '../node-security.service';
import { NodeService } from '../node.service';

/**
 * The node is this process.
 *
 * No serialization, no network, no signature — the work runs on the same
 * event loop that scheduled it. This is the path a single-machine install
 * takes for every task, and it is deliberately the *same* path the fleet
 * takes for locally-placed work, so distribution cannot introduce a
 * behavioural difference that only shows up once a second machine appears.
 */
@Injectable()
export class LocalNodeTransport implements INodeTransport {
  readonly key = 'local';
  private readonly logger = new Logger(LocalNodeTransport.name);

  constructor(private readonly handlers: TaskHandlerRegistry) {}

  async dispatch(node: Node, dispatch: NodeDispatch): Promise<NodeDispatchResult> {
    const startedAt = Date.now();
    try {
      const outcome = await this.withTimeout(
        this.handlers.invoke(dispatch),
        dispatch.timeoutMs,
        dispatch.taskId,
      );
      return {
        taskId: dispatch.taskId,
        status: 'SUCCEEDED',
        result: outcome.result ?? {},
        durationMs: Date.now() - startedAt,
        costUsd: outcome.costUsd ?? 0,
        totalTokens: outcome.totalTokens ?? 0,
        nodeId: node.id,
      };
    } catch (error) {
      const message = (error as Error).message;
      return {
        taskId: dispatch.taskId,
        status: 'FAILED',
        error: message,
        // A local timeout may well succeed elsewhere; a missing handler
        // never will, on this node or any other running this build.
        retryable: !message.includes('No handler registered'),
        durationMs: Date.now() - startedAt,
        nodeId: node.id,
      };
    }
  }

  async probe(node: Node) {
    return {
      reachable: true,
      latencyMs: 0,
      report: {
        ...NodeService.measureLocalLoad(),
        resources: NodeService.measureLocalResources(),
      } as HeartbeatReport,
    };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, taskId: string): Promise<T> {
    if (!ms || ms <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Task ${taskId} exceeded ${ms}ms on the local node`)),
        ms,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

/**
 * The node is another machine running PRISM-X.
 *
 * The wire protocol is deliberately small: one POST carrying the dispatch,
 * signed with the node's shared secret, answered with the verdict. The
 * remote end is the agent controller in this same codebase, so the two
 * halves cannot drift apart — a node is not a separate product with its own
 * release cycle, it is this server told to act as capacity.
 */
@Injectable()
export class HttpNodeTransport implements INodeTransport {
  readonly key = 'http';
  private readonly logger = new Logger(HttpNodeTransport.name);

  constructor(private readonly security: NodeSecurityService) {}

  async dispatch(node: Node, dispatch: NodeDispatch): Promise<NodeDispatchResult> {
    const startedAt = Date.now();

    if (!node.endpointUrl) {
      return {
        taskId: dispatch.taskId,
        status: 'FAILED',
        error: `Node ${node.slug} has no endpointUrl`,
        retryable: false,
        durationMs: 0,
        nodeId: node.id,
      };
    }

    try {
      const body = JSON.stringify({
        taskId: dispatch.taskId,
        kind: dispatch.kind,
        payload: dispatch.payload,
        correlationId: dispatch.correlationId,
        timeoutMs: dispatch.timeoutMs,
      });

      const response = await this.signedFetch(node, '/nodes/agent/execute', body, dispatch.timeoutMs);
      const durationMs = Date.now() - startedAt;

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          taskId: dispatch.taskId,
          status: 'FAILED',
          error: `Node responded ${response.status}: ${text.slice(0, 400)}`,
          // 4xx is the node telling us the request is wrong; retrying it
          // somewhere else only spreads the same bad request around.
          retryable: response.status >= 500 || response.status === 429,
          durationMs,
          nodeId: node.id,
        };
      }

      const payload = (await response.json()) as {
        status?: string;
        result?: Record<string, unknown>;
        error?: string;
        costUsd?: number;
        totalTokens?: number;
      };

      return {
        taskId: dispatch.taskId,
        status: payload.status === 'FAILED' ? 'FAILED' : 'SUCCEEDED',
        result: payload.result ?? {},
        error: payload.error,
        retryable: payload.status === 'FAILED',
        durationMs,
        costUsd: payload.costUsd ?? 0,
        totalTokens: payload.totalTokens ?? 0,
        nodeId: node.id,
      };
    } catch (error) {
      return {
        taskId: dispatch.taskId,
        status: 'FAILED',
        error: `Could not reach node ${node.slug}: ${(error as Error).message}`,
        // Unreachable is the canonical retryable failure — it says nothing
        // about the work, only about this node right now.
        retryable: true,
        durationMs: Date.now() - startedAt,
        nodeId: node.id,
      };
    }
  }

  async probe(node: Node) {
    const startedAt = Date.now();
    if (!node.endpointUrl) return { reachable: false, latencyMs: 0 };

    try {
      const response = await this.signedFetch(node, '/nodes/agent/status', '{}', 10_000);
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) return { reachable: false, latencyMs };
      const report = (await response.json()) as HeartbeatReport;
      return { reachable: true, latencyMs, report };
    } catch {
      return { reachable: false, latencyMs: Date.now() - startedAt };
    }
  }

  async cancel(node: Node, taskId: string): Promise<void> {
    if (!node.endpointUrl) return;
    try {
      await this.signedFetch(node, '/nodes/agent/cancel', JSON.stringify({ taskId }), 5_000);
    } catch (error) {
      // Cancellation is advisory. The lease will expire regardless, so a
      // node that cannot be reached to be told to stop is already handled.
      this.logger.warn(`Cancel for ${taskId} on ${node.slug} failed: ${(error as Error).message}`);
    }
  }

  private async signedFetch(
    node: Node,
    path: string,
    body: string,
    timeoutMs: number,
  ): Promise<Response> {
    if (!node.endpointUrl) {
      throw new Error(`Node ${node.slug} has no endpointUrl`);
    }

    const credentials = await this.security.currentSecret(node.id);
    if (!credentials) {
      throw new Error(`Node ${node.slug} has no usable signing key`);
    }

    const headers = this.security.buildHeaders(
      node.id,
      credentials.version,
      credentials.secret,
      body,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs + 5_000));

    try {
      return await fetch(`${node.endpointUrl.replace(/\/$/, '')}/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A stand-in for a machine that is not there.
 *
 * Every distributed behaviour worth having — placement, migration, lease
 * expiry, quarantine, sync lag — is invisible on one machine and expensive to
 * demonstrate on several. This transport makes those behaviours exercisable
 * in-process and deterministically: it simulates latency, and it fails on
 * command via `metadata.simulate`, so a test can assert that a node going
 * bad moves its work somewhere else rather than merely hoping it would.
 *
 * It is registered like any other transport rather than hidden behind a test
 * flag, because the value is in running the *real* coordinator against it.
 */
@Injectable()
export class SimulatedNodeTransport implements INodeTransport {
  readonly key = 'simulated';
  private readonly logger = new Logger(SimulatedNodeTransport.name);

  constructor(private readonly handlers: TaskHandlerRegistry) {}

  async dispatch(node: Node, dispatch: NodeDispatch): Promise<NodeDispatchResult> {
    const startedAt = Date.now();
    const simulate = SimulatedNodeTransport.settings(node);

    if (simulate.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, simulate.latencyMs));
    }

    if (simulate.unreachable) {
      return {
        taskId: dispatch.taskId,
        status: 'FAILED',
        error: `Simulated node ${node.slug} is unreachable`,
        retryable: true,
        durationMs: Date.now() - startedAt,
        nodeId: node.id,
      };
    }

    if (simulate.failEvery > 0) {
      // Deterministic rather than random: the same task id always fails on
      // the same node, so a failing test reproduces exactly.
      const bucket = SimulatedNodeTransport.bucket(dispatch.taskId, simulate.failEvery);
      if (bucket === 0) {
        return {
          taskId: dispatch.taskId,
          status: 'FAILED',
          error: `Simulated failure on ${node.slug}`,
          retryable: true,
          durationMs: Date.now() - startedAt,
          nodeId: node.id,
        };
      }
    }

    // A simulated node runs the same handlers a real one would, so what is
    // being simulated is the machine and the network, never the work.
    if (this.handlers.has(dispatch.kind)) {
      try {
        const outcome = await this.handlers.invoke(dispatch);
        return {
          taskId: dispatch.taskId,
          status: 'SUCCEEDED',
          result: { ...(outcome.result ?? {}), simulatedOn: node.slug },
          durationMs: Date.now() - startedAt,
          costUsd: outcome.costUsd ?? 0,
          totalTokens: outcome.totalTokens ?? 0,
          nodeId: node.id,
        };
      } catch (error) {
        return {
          taskId: dispatch.taskId,
          status: 'FAILED',
          error: (error as Error).message,
          retryable: true,
          durationMs: Date.now() - startedAt,
          nodeId: node.id,
        };
      }
    }

    return {
      taskId: dispatch.taskId,
      status: 'SUCCEEDED',
      result: { echoed: dispatch.payload, simulatedOn: node.slug },
      durationMs: Date.now() - startedAt,
      nodeId: node.id,
    };
  }

  async probe(node: Node) {
    const simulate = SimulatedNodeTransport.settings(node);
    return {
      reachable: !simulate.unreachable,
      latencyMs: simulate.latencyMs,
      report: {
        cpuUsage: simulate.cpuUsage,
        memoryUsage: simulate.memoryUsage,
        activeTasks: node.activeTasks,
        latencyMs: simulate.latencyMs,
      } as HeartbeatReport,
    };
  }

  static settings(node: Node): {
    latencyMs: number;
    unreachable: boolean;
    failEvery: number;
    cpuUsage: number;
    memoryUsage: number;
  } {
    const raw = ((node.metadata ?? {}) as Record<string, unknown>).simulate;
    const simulate = (raw ?? {}) as Record<string, unknown>;
    return {
      latencyMs: Number(simulate.latencyMs ?? 0),
      unreachable: simulate.unreachable === true,
      failEvery: Number(simulate.failEvery ?? 0),
      cpuUsage: Number(simulate.cpuUsage ?? node.cpuUsage ?? 0),
      memoryUsage: Number(simulate.memoryUsage ?? node.memoryUsage ?? 0),
    };
  }

  private static bucket(seed: string, modulo: number): number {
    const digest = createHash('sha256').update(seed).digest();
    return digest.readUInt32BE(0) % Math.max(1, modulo);
  }
}

/**
 * Resolves which transport reaches a given node.
 *
 * The rule is a property of the node, not a configuration switch: the
 * control plane's own node is in-process, a node whose metadata marks it
 * simulated is stood in for, and anything else is a real machine on the
 * other end of HTTP.
 */
@Injectable()
export class NodeTransportRegistry {
  private readonly transports = new Map<string, INodeTransport>();

  constructor(
    local: LocalNodeTransport,
    http: HttpNodeTransport,
    simulated: SimulatedNodeTransport,
  ) {
    for (const transport of [local, http, simulated]) {
      this.transports.set(transport.key, transport);
    }
  }

  keys(): string[] {
    return [...this.transports.keys()].sort();
  }

  resolve(node: Node): INodeTransport {
    return this.transports.get(NodeTransportRegistry.transportKeyFor(node))!;
  }

  /**
   * Whether standing in for a remote machine is permitted at all.
   *
   * Off in production, and not overridable there. The simulated transport is
   * selected by a node's `metadata` — which is tenant-supplied — and it runs
   * the dispatch *in the control plane's own process*. That is exactly right
   * for a test and exactly wrong for a live deployment: a tenant could mark a
   * node simulated and have work they believe is running on their own machine
   * execute here instead, on the control plane's event loop, with the control
   * plane's reach. Tenant input must never be able to choose which side of an
   * isolation boundary code runs on.
   *
   * So the environment decides, and production decides no.
   */
  static simulationPermitted(
    environment = process.env.NODE_ENV ?? 'development',
  ): boolean {
    if (environment === 'production') return false;
    // Anywhere else it is opt-out rather than opt-in, so the distributed test
    // suites keep working without every developer setting a variable.
    return process.env.ALLOW_SIMULATED_NODES !== 'false';
  }

  static transportKeyFor(node: Node): string {
    if (node.isLocal) return 'local';
    const metadata = (node.metadata ?? {}) as Record<string, unknown>;
    const asksForSimulation =
      metadata.simulate !== undefined || metadata.simulated === true;

    // A node that asked to be simulated where simulation is not permitted is
    // treated as the real remote machine it claims to be. It will fail to be
    // reached, which is the safe outcome: the work does not silently run here.
    if (asksForSimulation && NodeTransportRegistry.simulationPermitted()) {
      return 'simulated';
    }
    return 'http';
  }
}
