import type { CapabilityId } from './capabilities';
import type { ExtensionManifest, SandboxLimits } from './manifest';

/**
 * The Plugin SDK — the entire surface a PRISM-X extension may program against.
 *
 * Nothing in this file imports a service, a repository or a Prisma type, and
 * that is the point: an extension author can read this file and know exactly
 * what they get, while the platform can rewrite everything behind it without
 * breaking a single extension. The internals of PRISM-X — the orchestrator,
 * the memory engine, the node scheduler, the evolution pipeline — are not
 * reachable from here, by construction rather than by convention.
 *
 * Two rules govern every addition to this file:
 *
 *  1. **Every host method is guarded by exactly one capability.** The mapping
 *     lives in the capability catalogue's `surface`, not here, so a method
 *     added without a capability is unreachable rather than unguarded.
 *
 *  2. **The contract is versioned.** `PLATFORM_API_VERSION` moves under
 *     semver, and a manifest declares the range it supports. Removing or
 *     narrowing anything below is a major bump.
 */

// ------------------------------------------------------------------ context

export interface ExtensionIdentity {
  id: string;
  slug: string;
  name: string;
  version: string;
}

/** What an extension is told about itself. Read-only in every direction. */
export interface ExtensionContext {
  readonly extension: ExtensionIdentity;
  /** Effective capabilities — already intersected with the installer's own. */
  readonly capabilities: readonly CapabilityId[];
  /** Non-secret config the operator supplied. Secrets are never included. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly limits: Readonly<SandboxLimits>;
  /** True when this run is a dry run; writes are simulated and discarded. */
  readonly dryRun: boolean;
  readonly host: HostApi;
  readonly logger: ExtensionLogger;
}

export interface ExtensionLogger {
  debug(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

// ----------------------------------------------------------------- host API

/**
 * The guarded surface.
 *
 * Method names here must match the `surface` entries in the capability
 * catalogue exactly — `SandboxService` refuses to start if they diverge, so a
 * typo is a boot failure rather than a hole.
 */
export interface HostApi {
  /** Dispatch by method name. Everything below funnels through this. */
  call<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>;

  org: {
    describe(): Promise<{ id: string; name: string; plan: string }>;
  };

  missions: {
    get(args: { id: string }): Promise<unknown>;
    list(args?: { status?: string; limit?: number }): Promise<unknown[]>;
    create(args: { title: string; objective?: string; tasks?: unknown[] }): Promise<unknown>;
    start(args: { id: string }): Promise<unknown>;
    plan(args: { id: string }): Promise<unknown>;
  };

  knowledge: {
    search(args: { query: string; limit?: number }): Promise<unknown[]>;
    get(args: { id: string }): Promise<unknown>;
    store(args: { title: string; content: string; tags?: string[] }): Promise<unknown>;
    update(args: { id: string; content?: string; tags?: string[] }): Promise<unknown>;
  };

  workers: {
    list(args?: { limit?: number }): Promise<unknown[]>;
    create(args: Record<string, unknown>): Promise<unknown>;
    update(args: { id: string } & Record<string, unknown>): Promise<unknown>;
    delete(args: { id: string }): Promise<unknown>;
    register(args: { key: string; name: string } & Record<string, unknown>): Promise<unknown>;
    unregister(args: { key: string }): Promise<unknown>;
  };

  tools: {
    register(args: { key: string; name: string; description: string } & Record<string, unknown>): Promise<unknown>;
    unregister(args: { key: string }): Promise<unknown>;
  };

  triggers: {
    register(args: { key: string; name: string } & Record<string, unknown>): Promise<unknown>;
    unregister(args: { key: string }): Promise<unknown>;
    list(): Promise<unknown[]>;
  };

  events: {
    recent(args?: { name?: string; limit?: number }): Promise<unknown[]>;
    /** Declares interest; delivery arrives through `onEvent`. */
    subscribe(args: { names: string[] }): Promise<{ subscribed: string[] }>;
  };

  /** The extension's private keyspace. Partitioned; nothing else can read it. */
  state: {
    get<T = unknown>(args: { key: string }): Promise<T | null>;
    set(args: { key: string; value: unknown }): Promise<void>;
    delete(args: { key: string }): Promise<boolean>;
    keys(args?: { prefix?: string }): Promise<string[]>;
  };

  storage: {
    get(args: { key: string }): Promise<unknown>;
    put(args: { key: string; content: string; contentType?: string }): Promise<unknown>;
    list(args?: { prefix?: string }): Promise<unknown[]>;
  };

  analytics: {
    summary(args?: { days?: number }): Promise<unknown>;
  };

  notify: {
    send(args: { title: string; body?: string; channel?: string; severity?: string }): Promise<unknown>;
  };

  http: {
    fetch(args: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
    /**
     * The same request, authenticated with a stored credential the extension
     * names but never sees. The value is injected by the host after the
     * extension has finished composing the request.
     */
    fetchAs(args: {
      credential: string;
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  };

  credentials: {
    /** Names and kinds only. Values are never returned to extension code. */
    list(): Promise<Array<{ name: string; kind: string }>>;
  };
}

// ------------------------------------------------------------------- hooks

export interface HostEvent {
  name: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface ToolInvocation {
  key: string;
  input: Record<string, unknown>;
}

export interface WorkerInvocation {
  key: string;
  prompt: string;
  input: Record<string, unknown>;
}

export interface MigrationContext extends ExtensionContext {
  fromVersion: string;
  toVersion: string;
}

/**
 * What an extension implements. Every hook is optional: an extension that only
 * contributes a tool needs none of them, and an extension that only listens to
 * events needs one.
 */
export interface ExtensionModule {
  /** Called once after install, before the extension is enabled. */
  initialize?(context: ExtensionContext): Promise<void> | void;
  /** Called each time the extension is enabled. */
  activate?(context: ExtensionContext): Promise<void> | void;
  /** Called on disable and before uninstall. Must not throw. */
  deactivate?(context: ExtensionContext): Promise<void> | void;
  /** Called for each declared migration step during an upgrade. */
  migrate?(context: MigrationContext, step: { to: string; handler?: string }): Promise<void> | void;
  /** Called for each subscribed domain event. */
  onEvent?(context: ExtensionContext, event: HostEvent): Promise<void> | void;
  /** Called when one of this extension's contributed tools is invoked. */
  onToolCall?(context: ExtensionContext, invocation: ToolInvocation): Promise<unknown>;
  /** Called when one of this extension's contributed worker types runs. */
  onWorkerRun?(context: ExtensionContext, invocation: WorkerInvocation): Promise<unknown>;
}

/** A loaded extension: its manifest and whatever hooks it implements. */
export interface LoadedExtension {
  manifest: ExtensionManifest;
  module: ExtensionModule;
}

/**
 * Resolves an extension's code.
 *
 * PRISM-X ships one implementation of this — a deterministic in-process
 * loader, the same approach the provider, connector and node-transport seams
 * take elsewhere in the codebase. Loading from an isolate, a container or a
 * remote runtime is a second implementation of this interface, not a change to
 * anything above it.
 */
/**
 * What a loader actually isolates.
 *
 * Declared rather than assumed, because "extensions are sandboxed" is a claim
 * the platform makes and a loader either backs or does not. The capability
 * sandbox guards the *host API* — which methods an extension may call — and it
 * does that whichever loader is in use. It says nothing about what the
 * extension's own code can do to the process it runs in, and conflating the two
 * is how a system ends up believing it is protected against something it has
 * never contained.
 *
 * `none`    — the module runs on the host's event loop. An infinite loop stops
 *             the server. Adequate only where no third-party code is executed.
 * `thread`  — a `worker_threads` isolate with heap and stack limits, killable
 *             mid-call. Contains runaway CPU and memory, and a crash. Does *not*
 *             contain a determined escape: a worker shares the process and can
 *             reach the filesystem and the environment.
 * `process` — a separate OS process. Adds kernel-enforced memory separation and
 *             the ability to drop privileges.
 */
export type IsolationLevel = 'none' | 'thread' | 'process';

export interface LoaderIsolation {
  readonly level: IsolationLevel;
  /** True when this loader runs code supplied by a publisher. */
  readonly executesPublisherCode: boolean;
  /** What is contained, in plain terms, for the readiness report. */
  readonly contains: string[];
  /** What is explicitly *not* contained. Never left empty by omission. */
  readonly doesNotContain: string[];
}

export interface IExtensionLoader {
  readonly kind: string;
  /**
   * Required. A loader that will not say what it isolates cannot be reasoned
   * about, and the readiness review treats a missing declaration as a failure
   * rather than as a pass.
   */
  readonly isolation: LoaderIsolation;
  load(manifest: ExtensionManifest): Promise<ExtensionModule>;
  unload?(slug: string): Promise<void>;
}

export const EXTENSION_LOADER = Symbol('EXTENSION_LOADER');

/** Raised by host methods when the extension asked for something it cannot have. */
export class CapabilityDeniedError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityDeniedError';
  }
}

/** Raised when an extension exceeds a limit it was granted. */
export class SandboxLimitError extends Error {
  constructor(
    readonly limit: keyof SandboxLimits,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxLimitError';
  }
}
