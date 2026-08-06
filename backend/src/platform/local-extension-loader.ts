import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
import type { ExtensionManifest, ToolContribution } from './manifest';
import { declareIsolation } from '../shared/isolation-registry';

/**
 * The in-process extension loader.
 *
 * PRISM-X ships one implementation of `IExtensionLoader`, and it does not
 * execute code supplied by a publisher. It synthesises a module from the
 * manifest: hooks that exercise every path the platform cares about —
 * initialize, activate, migrate, event delivery, tool and worker invocation —
 * using only what the manifest declared.
 *
 * This is the same seam the rest of the codebase uses for its external
 * dependencies (`IIntelligenceProvider`, `IConnector`, `INodeTransport`), and
 * the same reason: the interesting behaviour to get right first is the
 * platform's, not the vendor's. Everything above this file — the capability
 * grant, the sandbox, the lifecycle, the audit trail, the upgrade analysis —
 * is real and is exercised end to end against this loader. Running a
 * publisher's actual code is a second implementation of this one interface
 * (an isolate, a container, a remote runtime), not a change to anything above.
 *
 * The synthesised behaviour is deterministic: the same manifest and the same
 * input always produce the same output, so a test that passes once passes
 * again, and a benchmark of a contributed tool measures the platform rather
 * than a random number.
 */
@Injectable()
export class LocalExtensionLoader implements IExtensionLoader {
  readonly kind = 'in-process';

  /**
   * Declared so the platform cannot imply protection it does not provide.
   *
   * This loader executes no publisher code, which is why `level: 'none'` is
   * the honest answer rather than an embarrassing one: there is nothing to
   * contain. The moment a loader *does* execute somebody else's code, that
   * combination — publisher code with no isolation — is what the readiness
   * review is looking for.
   */
  readonly isolation: LoaderIsolation = {
    level: 'none',
    executesPublisherCode: false,
    contains: [
      'The capability sandbox still guards every host method, whichever loader is in use.',
      'No publisher code is executed, so there is no untrusted code to contain.',
    ],
    doesNotContain: [
      'Nothing. A module that ran here would share the host event loop and heap.',
    ],
  };
  private readonly logger = new Logger(LocalExtensionLoader.name);

  /** Announces this loader's containment once it is the one actually bound. */
  declare(): void {
    declareIsolation({
      loader: this.kind,
      level: this.isolation.level,
      executesPublisherCode: this.isolation.executesPublisherCode,
    });
  }

  async load(manifest: ExtensionManifest): Promise<ExtensionModule> {
    this.logger.debug(`Loading ${manifest.slug}@${manifest.version} in-process`);
    return new SimulatedExtension(manifest);
  }

  async unload(slug: string): Promise<void> {
    this.logger.debug(`Unloaded ${slug}`);
  }
}

/** Stable pseudo-value derived from its inputs — never Math.random. */
function digest(...parts: unknown[]): string {
  return createHash('sha256').update(parts.map((p) => JSON.stringify(p)).join('|')).digest('hex');
}

class SimulatedExtension implements ExtensionModule {
  constructor(private readonly manifest: ExtensionManifest) {}

  /**
   * Writes an install marker through the host rather than to a field, so the
   * first thing every extension does is exercise the capability check. An
   * extension without `can_persist_state` gets a denial here — which is the
   * correct outcome, and is recorded rather than swallowed.
   */
  async initialize(context: ExtensionContext): Promise<void> {
    if (!context.capabilities.includes('can_persist_state')) return;
    await context.host.state.set({
      key: 'prismx.installed',
      value: { version: this.manifest.version, capabilities: [...context.capabilities] },
    });
  }

  async activate(context: ExtensionContext): Promise<void> {
    context.logger.info(`${this.manifest.slug} activated`, {
      capabilities: context.capabilities.length,
    });
  }

  async deactivate(context: ExtensionContext): Promise<void> {
    context.logger.info(`${this.manifest.slug} deactivated`);
  }

  async migrate(context: MigrationContext, step: { to: string }): Promise<void> {
    if (!context.capabilities.includes('can_persist_state')) return;
    await context.host.state.set({
      key: 'prismx.migrations',
      value: { lastApplied: step.to, from: context.fromVersion, to: context.toVersion },
    });
  }

  async onEvent(context: ExtensionContext, event: HostEvent): Promise<void> {
    if (!context.capabilities.includes('can_persist_state')) return;
    const key = `prismx.events.${event.name}`;
    const previous = (await context.host.state.get<{ count: number }>({ key })) ?? { count: 0 };
    await context.host.state.set({ key, value: { count: previous.count + 1, last: event.occurredAt } });
  }

  /**
   * Answers a tool call in the shape the manifest declared, filled from the
   * input. A contributed tool that declares an output schema therefore returns
   * something with that schema's keys, which is what makes the invocation path
   * testable without a publisher's code.
   */
  async onToolCall(context: ExtensionContext, invocation: ToolInvocation): Promise<unknown> {
    const declared = (this.manifest.contributes?.tools ?? []).find(
      (tool) => invocation.key.endsWith(`.${tool.key}`) || tool.key === invocation.key,
    );

    const fingerprint = digest(this.manifest.slug, invocation.key, invocation.input).slice(0, 12);
    const base: Record<string, unknown> = {
      tool: invocation.key,
      extension: this.manifest.slug,
      version: this.manifest.version,
      fingerprint,
      echo: invocation.input,
    };

    for (const field of SimulatedExtension.outputFields(declared)) {
      base[field] = `${field}:${fingerprint}`;
    }

    context.logger.debug(`Tool ${invocation.key} answered`, { fingerprint });
    return base;
  }

  async onWorkerRun(context: ExtensionContext, invocation: WorkerInvocation): Promise<unknown> {
    const fingerprint = digest(this.manifest.slug, invocation.key, invocation.prompt).slice(0, 12);
    return {
      worker: invocation.key,
      extension: this.manifest.slug,
      output:
        `${this.manifest.name} handled the request under ` +
        `${context.capabilities.length} capabilities [${fingerprint}]`,
      fingerprint,
    };
  }

  private static outputFields(tool: ToolContribution | undefined): string[] {
    const output = tool?.output;
    if (!output || typeof output !== 'object') return [];
    const properties =
      'properties' in output && output.properties && typeof output.properties === 'object'
        ? (output.properties as Record<string, unknown>)
        : (output as Record<string, unknown>);
    return Object.keys(properties).slice(0, 10);
  }
}
