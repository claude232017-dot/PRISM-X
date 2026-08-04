import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ContributionKind, ExtensionContribution } from '@prisma/client';
import { ExtensionContributionRepository } from '../database/repositories/platform.repositories';
import { WorkerRepository } from '../database/repositories/tenant.repositories';
import { ToolRegistry } from '../tools/tool-registry.service';
import { ToolExecutionError } from '../tools/tool.contract';
import type { ToolDefinition, ToolParameter } from '../tools/tool.contract';
import { Permissions } from '../auth/permissions';
import type { PermissionKey } from '../auth/permissions';
import {
  attenuate,
  describe as describeCapability,
  permissionsFor,
} from './capabilities';
import type {
  ExtensionManifest,
  ToolContribution,
  TriggerContribution,
  WorkerContribution,
} from './manifest';

/**
 * Registers what extensions contribute to the platform: worker types, tools
 * and triggers.
 *
 * The registration is deliberately data-first. A contributed tool becomes a
 * row and a registry entry at *install* time, before any extension code has
 * run, so the catalogue of what exists is knowable without executing a
 * stranger's module. Invoking it later goes back through the sandbox.
 *
 * Two properties are enforced here rather than trusted:
 *
 *  - **Namespacing.** Every contributed key becomes `<extension-slug>.<key>`.
 *    Two extensions can both contribute `search` and neither can shadow a
 *    built-in tool, because a built-in key contains no dot.
 *
 *  - **Attenuation.** A contribution runs under a subset of its extension's
 *    grant, never a superset. `attenuate` can only narrow, so a contribution
 *    is not a route to authority the extension itself was refused.
 */
@Injectable()
export class ContributionService implements OnModuleInit {
  private readonly logger = new Logger(ContributionService.name);

  /**
   * Set by the extension runtime. Kept as a callback rather than an injected
   * dependency because the runtime depends on the sandbox, the sandbox depends
   * on this service, and a third edge back would be a cycle.
   */
  private invoker?: (
    contribution: ExtensionContribution,
    invocation: { key: string; input: Record<string, unknown> },
  ) => Promise<unknown>;

  constructor(
    private readonly contributions: ExtensionContributionRepository,
    private readonly workers: WorkerRepository,
    private readonly tools: ToolRegistry,
  ) {}

  onModuleInit(): void {
    // Contributed tools are resolved per invocation rather than registered as
    // static definitions: the set is tenant-scoped and changes whenever an
    // extension is enabled, and the registry is a process-wide singleton.
    this.tools.setDynamicResolver((key) => this.resolveTool(key));
  }

  onInvoke(
    invoker: (
      contribution: ExtensionContribution,
      invocation: { key: string; input: Record<string, unknown> },
    ) => Promise<unknown>,
  ): void {
    this.invoker = invoker;
  }

  /** `<slug>.<key>`, the only form a contributed key ever takes. */
  static namespaced(slug: string, key: string): string {
    return `${slug}.${key}`;
  }

  // ------------------------------------------------------------ registration

  /**
   * Registers everything a manifest contributes, under the grant the extension
   * actually holds.
   *
   * Contributions whose required capability was withheld are skipped rather
   * than registered inert: a tool that exists but always denies is worse than
   * a tool that is honestly absent, because the model will keep reaching for it.
   */
  async register(
    extension: { id: string; slug: string },
    manifest: ExtensionManifest,
    granted: readonly string[],
  ): Promise<{ registered: ExtensionContribution[]; skipped: Array<{ key: string; reason: string }> }> {
    const registered: ExtensionContribution[] = [];
    const skipped: Array<{ key: string; reason: string }> = [];
    const held = new Set(granted);

    const contributes = manifest.contributes ?? {};

    for (const worker of contributes.workers ?? []) {
      if (!held.has('can_register_workers')) {
        skipped.push({ key: worker.key, reason: 'can_register_workers was not granted' });
        continue;
      }
      registered.push(await this.registerWorker(extension, worker, granted));
    }

    for (const tool of contributes.tools ?? []) {
      if (!held.has('can_register_tools')) {
        skipped.push({ key: tool.key, reason: 'can_register_tools was not granted' });
        continue;
      }
      if (tool.capability && !held.has(tool.capability)) {
        skipped.push({
          key: tool.key,
          reason: `requires "${tool.capability}", which was withheld`,
        });
        continue;
      }
      registered.push(await this.registerTool(extension, tool, granted));
    }

    for (const trigger of contributes.triggers ?? []) {
      if (!held.has('can_register_triggers')) {
        skipped.push({ key: trigger.key, reason: 'can_register_triggers was not granted' });
        continue;
      }
      registered.push(await this.registerTrigger(extension, trigger, granted));
    }

    if (registered.length || skipped.length) {
      this.logger.log(
        `${extension.slug}: registered ${registered.length} contribution(s)` +
          (skipped.length ? `, skipped ${skipped.length}` : ''),
      );
    }
    return { registered, skipped };
  }

  private async registerWorker(
    extension: { id: string; slug: string },
    contribution: WorkerContribution,
    granted: readonly string[],
  ): Promise<ExtensionContribution> {
    const key = ContributionService.namespaced(extension.slug, contribution.key);
    const capabilities = attenuate(granted, contribution.capabilities ?? granted);

    // The contributed worker is a real Worker row, so every existing path —
    // the orchestrator, the scheduler, the learning engine — sees it without
    // knowing it came from an extension. That is the capability model paying
    // off: nothing downstream asks what kind of thing this is.
    const worker = await this.workers.create({
      name: contribution.name,
      role: 'SPECIALIST',
      status: 'ACTIVE',
      systemPrompt: contribution.systemPrompt ?? `You are ${contribution.name}.`,
      toolPermissions: (contribution.tools ?? []).map((tool) =>
        tool.includes('.') ? tool : ContributionService.namespaced(extension.slug, tool),
      ),
      // `dna` is Worker's own open field. Stamping provenance there rather
      // than inventing a column keeps a contributed worker structurally
      // identical to a native one, which is the point of the capability model.
      dna: { contributedBy: extension.slug, contributionKey: key } as never,
    });

    return this.upsert({
      extensionId: extension.id,
      kind: ContributionKind.WORKER,
      key,
      name: contribution.name,
      description: contribution.description ?? null,
      definition: contribution as unknown as Record<string, unknown>,
      capabilities,
      workerId: worker.id,
    });
  }

  private registerTool(
    extension: { id: string; slug: string },
    contribution: ToolContribution,
    granted: readonly string[],
  ): Promise<ExtensionContribution> {
    return this.upsert({
      extensionId: extension.id,
      kind: ContributionKind.TOOL,
      key: ContributionService.namespaced(extension.slug, contribution.key),
      name: contribution.name,
      description: contribution.description,
      definition: contribution as unknown as Record<string, unknown>,
      capabilities: attenuate(granted, contribution.capability ? [contribution.capability] : granted),
    });
  }

  private registerTrigger(
    extension: { id: string; slug: string },
    contribution: TriggerContribution,
    granted: readonly string[],
  ): Promise<ExtensionContribution> {
    return this.upsert({
      extensionId: extension.id,
      kind: ContributionKind.TRIGGER,
      key: ContributionService.namespaced(extension.slug, contribution.key),
      name: contribution.name,
      description: contribution.description ?? null,
      definition: contribution as unknown as Record<string, unknown>,
      capabilities: attenuate(granted, ['can_register_triggers', 'can_execute_missions']),
    });
  }

  private async upsert(input: {
    extensionId: string;
    kind: ContributionKind;
    key: string;
    name: string;
    description?: string | null;
    definition: Record<string, unknown>;
    capabilities: string[];
    workerId?: string;
    triggerId?: string;
  }): Promise<ExtensionContribution> {
    const existing = await this.contributions.findByKey(input.kind, input.key);
    const data = {
      extensionId: input.extensionId,
      kind: input.kind,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      definition: input.definition as never,
      capabilities: input.capabilities,
      enabled: true,
      workerId: input.workerId ?? null,
      triggerId: input.triggerId ?? null,
    };
    return existing
      ? this.contributions.update(existing.id, data)
      : this.contributions.create(data);
  }

  /** Removes every contribution an extension made, and the workers it created. */
  async unregister(extensionId: string): Promise<number> {
    const rows = await this.contributions.byExtension(extensionId);
    for (const row of rows) {
      if (row.workerId) {
        // Soft delete: a contributed worker may appear in mission history, and
        // erasing it would rewrite the record of work already done.
        await this.workers.remove(row.workerId).catch(() => undefined);
      }
    }
    return this.contributions.removeForExtension(extensionId);
  }

  setEnabled(extensionId: string, enabled: boolean): Promise<number> {
    return this.contributions.setEnabledForExtension(extensionId, enabled);
  }

  list(kind?: ContributionKind): Promise<ExtensionContribution[]> {
    return kind ? this.contributions.active(kind) : this.contributions.findMany({});
  }

  byExtension(extensionId: string): Promise<ExtensionContribution[]> {
    return this.contributions.byExtension(extensionId);
  }

  // -------------------------------------------------------------- invocation

  /**
   * Turns a contributed tool into a ToolDefinition the existing registry can
   * run, with `requiredPermission` derived from the contribution's capability.
   *
   * This is where the capability model meets the permission model: the tool
   * registry already checks that the *caller* holds a permission, so mapping
   * the capability down to its strongest implied permission means a
   * contributed tool is gated twice — once on what the extension may do, once
   * on what the person running the mission may do.
   */
  private async resolveTool(key: string): Promise<ToolDefinition | undefined> {
    if (!key.includes('.')) return undefined;

    const contribution = await this.contributions.findByKey(ContributionKind.TOOL, key);
    if (!contribution || !contribution.enabled) return undefined;

    const definition = contribution.definition as unknown as ToolContribution;
    const capability = definition.capability;
    const implied = capability ? permissionsFor([capability]) : [];
    const requiredPermission: PermissionKey = implied[0] ?? Permissions.ExtensionRead;

    return {
      key: contribution.key,
      name: contribution.name,
      description: contribution.description ?? definition.description ?? contribution.name,
      requiredPermission,
      parameters: ContributionService.parametersOf(definition),
      mutates: definition.mutates ?? false,
      execute: async (input) => {
        if (!this.invoker) {
          throw new ToolExecutionError('The extension runtime is not available');
        }
        try {
          const output = await this.invoker(contribution, {
            key: contribution.key,
            input: input as Record<string, unknown>,
          });
          await this.contributions.recordInvocation(contribution.id, false);
          return output;
        } catch (error) {
          await this.contributions.recordInvocation(contribution.id, true);
          throw error instanceof ToolExecutionError
            ? error
            : new ToolExecutionError((error as Error).message);
        }
      },
    };
  }

  /** Best-effort translation of a declared input schema into tool parameters. */
  private static parametersOf(definition: ToolContribution): Record<string, ToolParameter> {
    const input = definition.input;
    if (!input || typeof input !== 'object') return {};

    // Accepts either a bare `{ field: { type, description } }` map or a
    // JSON-Schema-shaped `{ properties: {...}, required: [...] }`.
    const properties = (
      'properties' in input && input.properties && typeof input.properties === 'object'
        ? input.properties
        : input
    ) as Record<string, unknown>;
    const required = new Set(
      Array.isArray((input as Record<string, unknown>).required)
        ? ((input as Record<string, unknown>).required as string[])
        : [],
    );

    const parameters: Record<string, ToolParameter> = {};
    for (const [name, raw] of Object.entries(properties)) {
      const shape = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const type = typeof shape.type === 'string' ? shape.type : 'string';
      parameters[name] = {
        type: (['string', 'number', 'boolean', 'array', 'object'].includes(type)
          ? type
          : 'string') as ToolParameter['type'],
        description: typeof shape.description === 'string' ? shape.description : name,
        required: required.has(name) || shape.required === true,
        ...(Array.isArray(shape.enum) ? { enum: shape.enum as string[] } : {}),
      };
    }
    return parameters;
  }

  /** Contributed capability summary, for the extension detail view. */
  async summary(extensionId: string): Promise<{
    workers: number;
    tools: number;
    triggers: number;
    invocations: number;
    failures: number;
    capabilities: Array<{ id: string; title: string; risk: string }>;
  }> {
    const rows = await this.contributions.byExtension(extensionId);
    const capabilities = new Set<string>();
    for (const row of rows) for (const capability of row.capabilities) capabilities.add(capability);

    return {
      workers: rows.filter((row) => row.kind === ContributionKind.WORKER).length,
      tools: rows.filter((row) => row.kind === ContributionKind.TOOL).length,
      triggers: rows.filter((row) => row.kind === ContributionKind.TRIGGER).length,
      invocations: rows.reduce((sum, row) => sum + row.invocations, 0),
      failures: rows.reduce((sum, row) => sum + row.failures, 0),
      capabilities: [...capabilities]
        .map((id) => describeCapability(id))
        .filter((definition): definition is NonNullable<typeof definition> => Boolean(definition))
        .map((definition) => ({
          id: definition.id,
          title: definition.title,
          risk: definition.risk,
        })),
    };
  }
}
