import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type {
  ExtensionContext,
  ExtensionModule,
  HostEvent,
  IExtensionLoader,
  LoaderIsolation,
  MigrationContext,
  ToolInvocation,
  WorkerInvocation,
} from './sdk';
import type { ExtensionManifest } from './manifest';
import { synthesiseSource } from './extension-source';
import { declareIsolation } from '../shared/isolation-registry';

/**
 * The bootstrap that runs inside every extension thread.
 *
 * Kept as a string and started with `eval: true` so there is no build-time
 * asset to copy, no path to resolve differently in dist than in src, and
 * nothing that can silently go missing from a container image.
 *
 * Two properties matter. The extension body is evaluated in a `vm` context
 * that is given exactly one binding — `__host` — so `require`, `process` and
 * the thread's own globals are not in scope; reaching for them throws instead
 * of resolving. And every host call is a message back to the main thread,
 * where the capability sandbox decides whether it is allowed. The extension
 * cannot call the host directly because, inside its context, there is no host
 * to call.
 */
const BOOTSTRAP = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const crypto = require('node:crypto');

let pending = 0;
const waiting = new Map();

function hostCall(method, payload) {
  const id = ++pending;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'host', id, method, payload });
  });
}

const exportsObject = {};
const sandboxGlobals = {
  __exports: exportsObject,
  __host: {
    call: hostCall,
    // Hashing is pure and needs no host round trip, but it must not arrive by
    // way of a module the extension could then reach for anything else.
    digest: (input) => crypto.createHash('sha256').update(String(input)).digest('hex'),
  },
  // A minimal, deliberate surface. Anything absent from this object is absent
  // from the extension's world.
  console: { log: () => {}, warn: () => {}, error: () => {} },
  JSON,
  Math,
  Date,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  Promise,
  Map,
  Set,
  isNaN,
  parseInt,
  parseFloat,
};

try {
  vm.createContext(sandboxGlobals);
  vm.runInContext(workerData.source, sandboxGlobals, {
    filename: workerData.slug + '.extension.js',
    timeout: workerData.compileTimeoutMs,
  });
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({ type: 'fatal', error: String((error && error.message) || error) });
}

parentPort.on('message', async (message) => {
  if (message.type === 'host-result') {
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
    return;
  }

  if (message.type !== 'invoke') return;
  try {
    const hook = exportsObject[message.hook];
    if (typeof hook !== 'function') {
      parentPort.postMessage({ type: 'result', id: message.id, result: undefined });
      return;
    }
    const result = await hook(...message.args);
    parentPort.postMessage({ type: 'result', id: message.id, result });
  } catch (error) {
    parentPort.postMessage({
      type: 'result',
      id: message.id,
      error: String((error && error.message) || error),
    });
  }
});
`;

/** Heap, stack and time budgets for one extension thread. */
export interface ThreadLimits {
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  stackSizeMb: number;
  /** Per hook call. A hook that outlives this takes the thread with it. */
  callTimeoutMs: number;
  /** Evaluating the extension body at load time. */
  compileTimeoutMs: number;
}

/** Override token, so a deployment can size the isolate without a fork. */
export const THREAD_LIMITS = Symbol('EXTENSION_THREAD_LIMITS');

export const DEFAULT_THREAD_LIMITS: ThreadLimits = {
  // Small on purpose. An extension that needs more than this is doing work
  // that belongs in a worker, not in a hook, and the ceiling is what stops one
  // tenant's extension from evicting everything else from the host's heap.
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
  callTimeoutMs: 10_000,
  compileTimeoutMs: 5_000,
};

/**
 * Runs extension code in a `worker_threads` isolate.
 *
 * This is the second implementation of `IExtensionLoader`, and the reason it
 * exists is that the first one made the platform's isolation claim untestable.
 * `LocalExtensionLoader` never executes anything: it synthesises an object from
 * the manifest and calls its methods on the host's own event loop. Everything
 * above it — the capability grant, the sandbox, the audit trail — is real, but
 * "an extension cannot take the server down" had never been demonstrated,
 * because nothing had ever tried.
 *
 * What this contains:
 *
 *  - **Runaway CPU.** A hook that never returns is abandoned after
 *    `callTimeoutMs` and its thread terminated. The host's event loop was never
 *    blocked, because the loop it blocked was its own.
 *  - **Runaway memory.** V8 heap limits are set per thread, so an extension
 *    that allocates without bound dies with an OOM in its own isolate instead
 *    of taking the process with it.
 *  - **Crashes.** An uncaught error kills the thread; the host observes an exit
 *    code and reports a failed call.
 *  - **Ambient reach.** The body is evaluated in a `vm` context holding one
 *    binding, so `require` and `process` are not in scope.
 *
 * What this does **not** contain, stated plainly because a sandbox described in
 * marketing terms is worse than no sandbox: a worker thread shares the process.
 * `vm` is not a security boundary — a determined escape via prototype reachback
 * is a known class of attack, and from the worker's own module scope the
 * filesystem and environment remain reachable. Containing a hostile publisher
 * needs a separate process with dropped privileges, or a real isolate runtime.
 * This loader declares `level: 'thread'` and the readiness review reports it,
 * so nobody has to read this comment to find out.
 */
@Injectable()
export class WorkerThreadExtensionLoader
  implements IExtensionLoader, OnApplicationShutdown
{
  readonly kind = 'worker-thread';

  readonly isolation: LoaderIsolation = {
    level: 'thread',
    executesPublisherCode: true,
    contains: [
      'A hook that never returns is terminated without blocking the host loop.',
      'Heap growth is capped per extension by V8 thread limits.',
      'A crash kills the thread, not the process.',
      'The extension body runs in a vm context with no require and no process.',
    ],
    doesNotContain: [
      'A worker thread shares the process; vm is not a security boundary.',
      'Filesystem and environment remain reachable from the worker module scope.',
      'Containing a hostile publisher needs a separate process or a real isolate runtime.',
    ],
  };

  private readonly logger = new Logger(WorkerThreadExtensionLoader.name);
  private readonly threads = new Map<string, ExtensionThread>();

  private readonly limits: ThreadLimits;

  constructor(@Optional() @Inject(THREAD_LIMITS) limits?: Partial<ThreadLimits>) {
    this.limits = { ...DEFAULT_THREAD_LIMITS, ...(limits ?? {}) };
  }

  /**
   * Announces this loader's containment once it is the one actually bound.
   *
   * Declared on init rather than in the constructor because both loaders are
   * instantiated as providers; only the one the factory selects is asked to
   * load anything, and only that one should be what the review reports.
   */
  declare(): void {
    declareIsolation({
      loader: this.kind,
      level: this.isolation.level,
      executesPublisherCode: this.isolation.executesPublisherCode,
    });
  }

  async load(manifest: ExtensionManifest): Promise<ExtensionModule> {
    await this.unload(manifest.slug);

    const thread = new ExtensionThread(manifest, this.limits, this.logger);
    await thread.start();
    this.threads.set(manifest.slug, thread);

    this.logger.log(
      `Loaded ${manifest.slug}@${manifest.version} in an isolated thread ` +
        `(${this.limits.maxOldGenerationSizeMb}MB heap, ${this.limits.callTimeoutMs}ms per call)`,
    );
    return thread.module();
  }

  async unload(slug: string): Promise<void> {
    const thread = this.threads.get(slug);
    if (!thread) return;
    this.threads.delete(slug);
    await thread.stop();
  }

  /** Threads currently running, for the readiness report. */
  loaded(): string[] {
    return [...this.threads.keys()].sort();
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.threads.values()].map((thread) => thread.stop()));
    this.threads.clear();
  }
}

// ==========================================================================

type HostBridge = (method: string, payload: unknown) => Promise<unknown>;

/**
 * One extension's thread, and the RPC across it.
 *
 * The thread is started once and reused across calls, because starting a
 * worker costs tens of milliseconds and a tool invocation should not. It is
 * terminated — not merely abandoned — the moment a call overruns, which is the
 * only way a timeout means anything against code that is not cooperating.
 */
class ExtensionThread {
  private worker?: Worker;
  private nextCall = 0;
  private readonly calls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  /** Set for the duration of a hook so host callbacks reach the right context. */
  private bridge?: HostBridge;
  private dead = false;

  constructor(
    private readonly manifest: ExtensionManifest,
    private readonly limits: ThreadLimits,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const worker = new Worker(BOOTSTRAP, {
      eval: true,
      workerData: {
        source: synthesiseSource(this.manifest),
        slug: this.manifest.slug,
        compileTimeoutMs: this.limits.compileTimeoutMs,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: this.limits.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: this.limits.maxYoungGenerationSizeMb,
        stackSizeMb: this.limits.stackSizeMb,
      },
      // The thread must never be the reason the process stays alive.
      stdout: true,
      stderr: true,
    });
    this.worker = worker;

    const ready = new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => (error ? reject(error) : resolve());

      worker.on('message', (message: Record<string, unknown>) => {
        if (message.type === 'ready') return settle();
        if (message.type === 'fatal') return settle(new Error(String(message.error)));
        void this.onMessage(message);
      });

      worker.on('error', (error) => {
        this.fail(error);
        settle(error);
      });

      worker.on('exit', (code) => {
        // Includes the OOM case: V8 kills the isolate and the thread exits.
        this.fail(new Error(`Extension thread exited with code ${code}`));
      });
    });

    worker.unref();
    await ready;
  }

  async stop(): Promise<void> {
    this.dead = true;
    this.fail(new Error('Extension was unloaded'));
    await this.worker?.terminate().catch(() => undefined);
    this.worker = undefined;
  }

  /** Rejects every in-flight call. Used on crash, timeout and unload. */
  private fail(error: Error): void {
    for (const [, call] of this.calls) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.calls.clear();
  }

  private async onMessage(message: Record<string, unknown>): Promise<void> {
    if (message.type === 'result') {
      const call = this.calls.get(Number(message.id));
      if (!call) return;
      clearTimeout(call.timer);
      this.calls.delete(Number(message.id));
      if (message.error) call.reject(new Error(String(message.error)));
      else call.resolve(message.result);
      return;
    }

    if (message.type === 'host') {
      // A host call from inside the extension. It is answered here, on the main
      // thread, which is where the capability sandbox lives — the extension has
      // no route to the host except through this reply.
      const id = Number(message.id);
      try {
        if (!this.bridge) throw new Error('No host context is active for this call');
        const result = await this.bridge(String(message.method), message.payload);
        this.worker?.postMessage({ type: 'host-result', id, result });
      } catch (error) {
        this.worker?.postMessage({
          type: 'host-result',
          id,
          error: (error as Error).message,
        });
      }
    }
  }

  /**
   * Calls one hook.
   *
   * On overrun the thread is terminated rather than left running: a hook that
   * ignored its deadline is not going to honour a politer request, and a
   * timeout that leaves the offender burning a core is not a timeout.
   */
  private invoke(hook: string, args: unknown[], bridge: HostBridge): Promise<unknown> {
    if (this.dead || !this.worker) {
      return Promise.reject(new Error(`Extension ${this.manifest.slug} is not running`));
    }

    const id = ++this.nextCall;
    this.bridge = bridge;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        this.logger.warn(
          `${this.manifest.slug}.${hook} exceeded ${this.limits.callTimeoutMs}ms — terminating its thread`,
        );
        void this.stop();
        reject(
          new Error(
            `Extension ${this.manifest.slug} exceeded ${this.limits.callTimeoutMs}ms in ${hook}`,
          ),
        );
      }, this.limits.callTimeoutMs);
      timer.unref?.();

      this.calls.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ type: 'invoke', id, hook, args });
    });
  }

  /**
   * The host-facing module.
   *
   * Only the serialisable parts of the context cross the boundary — capability
   * names, versions, the invocation itself. `context.host` stays on this side
   * and is reached by RPC, which is what keeps the capability check on the
   * host's side of the wall rather than inside the thing being checked.
   */
  module(): ExtensionModule {
    const bridgeFor = (context: ExtensionContext): HostBridge => {
      return async (method, payload) => {
        const body = (payload ?? {}) as Record<string, unknown>;
        switch (method) {
          case 'state.set':
            return context.host.state.set(body as never);
          case 'state.get':
            return context.host.state.get({ key: String(body.key) });
          case 'state.delete':
            return context.host.state.delete({ key: String(body.key) });
          case 'state.keys':
            return context.host.state.keys({ prefix: body.prefix as string | undefined });
          case 'logger.info':
            context.logger.info(String(body.message), body.data as never);
            return undefined;
          default:
            // Unknown methods are refused rather than forwarded. The bridge is
            // an allow-list, so a new SDK surface has to be added here on
            // purpose before an extension can reach it.
            throw new Error(`Host method "${method}" is not reachable from an extension thread`);
        }
      };
    };

    const serialisable = (context: ExtensionContext | MigrationContext) => ({
      capabilities: [...context.capabilities],
      ...('fromVersion' in context
        ? { fromVersion: context.fromVersion, toVersion: context.toVersion }
        : {}),
    });

    return {
      initialize: (context) =>
        this.invoke('initialize', [serialisable(context)], bridgeFor(context)) as Promise<void>,
      activate: (context) =>
        this.invoke('activate', [serialisable(context)], bridgeFor(context)) as Promise<void>,
      deactivate: (context) =>
        this.invoke('deactivate', [serialisable(context)], bridgeFor(context)) as Promise<void>,
      migrate: (context, step) =>
        this.invoke(
          'migrate',
          [serialisable(context), step],
          bridgeFor(context as unknown as ExtensionContext),
        ) as Promise<void>,
      onEvent: (context, event: HostEvent) =>
        this.invoke('onEvent', [serialisable(context), event], bridgeFor(context)) as Promise<void>,
      onToolCall: (context, invocation: ToolInvocation) =>
        this.invoke('onToolCall', [serialisable(context), invocation], bridgeFor(context)),
      onWorkerRun: (context, invocation: WorkerInvocation) =>
        this.invoke('onWorkerRun', [serialisable(context), invocation], bridgeFor(context)),
    };
  }
}

/** Stable identity for a manifest, used in logs and tests. */
export function manifestFingerprint(manifest: ExtensionManifest): string {
  return createHash('sha256')
    .update(`${manifest.slug}@${manifest.version}`)
    .digest('hex')
    .slice(0, 12);
}
