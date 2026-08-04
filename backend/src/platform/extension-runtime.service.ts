import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import {
  CapabilityRiskLevel,
  Extension,
  ExtensionContribution,
  ExtensionPhase,
  ExtensionStatus,
  LifecycleOutcome,
  UpgradeOutcome,
} from '@prisma/client';
import { ExtensionRepository } from '../database/repositories/tenant.repositories';
import {
  ExtensionLifecycleRepository,
  ExtensionStateRepository,
  ExtensionUpgradeRepository,
} from '../database/repositories/platform.repositories';
import { EventBusService } from '../events/event-bus.service';
import { BoundedMap } from '../shared/bounded-map';
import { declareProcessState } from '../shared/process-state';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { CryptoService } from '../shared/crypto/crypto.service';
import {
  CAPABILITY_CATALOGUE_VERSION,
  grant as grantCapabilities,
  describe as describeCapability,
  permissionsFor,
} from './capabilities';
import type { CapabilityGrant } from './capabilities';
import {
  analyseUpgrade,
  digestOf,
  resolveLimits,
  secretFields,
  validate,
  validateConfig,
} from './manifest';
import type { ExtensionManifest, ManifestChange, UpgradeAnalysis } from './manifest';
import { ContributionService } from './contribution.service';
import { SandboxService } from './sandbox.service';
import type { SandboxBinding } from './sandbox.service';
import { EXTENSION_LOADER } from './sdk';
import type {
  ExtensionContext,
  ExtensionModule,
  IExtensionLoader,
  MigrationContext,
} from './sdk';

/**
 * The extension lifecycle: install → validate → register → initialize → run →
 * update → disable → uninstall.
 *
 * Every transition passes through `transition`, which writes an
 * ExtensionLifecycleEvent before and after the work. That is not
 * bookkeeping — it is what makes "the extension is FAILED" answerable with
 * *which phase failed and why*, months later, without reproducing it.
 *
 * The security spine is one line, in `install`: the grant is the intersection
 * of what the manifest asked for and what the installing principal already
 * holds. Everything downstream — contributions, the sandbox, the audit log —
 * reads that grant and nothing else, so there is exactly one place where
 * authority is decided and no second path that could disagree with it.
 */
@Injectable()
export class ExtensionRuntimeService implements OnModuleInit {
  private readonly logger = new Logger(ExtensionRuntimeService.name);

  /**
   * Loaded modules, keyed by extension id. Rebuilt on demand after a restart.
   *
   * Bounded rather than a plain Map. One instance serves every organization,
   * and each of them may install extensions; an unbounded cache of loaded
   * modules therefore grows with the size of the customer base and is only
   * ever emptied by a restart. Evicting the least recently used one costs a
   * reload the next time it is called — which is exactly what happens after a
   * deploy anyway, so the path is already exercised.
   */
  private static readonly LOADED_LIMIT = 256;
  private readonly loaded = new BoundedMap<string, ExtensionModule>(
    ExtensionRuntimeService.LOADED_LIMIT,
  );

    // Declared so the readiness review can see it. A miss reloads the module
  // from the loader, so a request served elsewhere is slower, never wrong.
  private readonly declared = declareProcessState({
    name: 'extension-runtime.modules',
    loadBearing: false,
    describe: () =>
      `${this.loaded.size} loaded module(s), ${this.loaded.evicted} evicted, ` +
      `cap ${ExtensionRuntimeService.LOADED_LIMIT}`,
  });

  constructor(
    private readonly extensions: ExtensionRepository,
    private readonly lifecycle: ExtensionLifecycleRepository,
    private readonly upgrades: ExtensionUpgradeRepository,
    private readonly state: ExtensionStateRepository,
    private readonly contributions: ContributionService,
    private readonly sandbox: SandboxService,
    private readonly events: EventBusService,
    private readonly crypto: CryptoService,
    @Inject(EXTENSION_LOADER) private readonly loader: IExtensionLoader,
  ) {}

  onModuleInit(): void {
    // Contributed tools and workers are invoked through the sandbox, under the
    // contribution's attenuated grant rather than the extension's full one.
    this.contributions.onInvoke((contribution, invocation) =>
      this.invokeContribution(contribution, invocation),
    );
  }

  // ============================================================ install

  /**
   * Installs an extension from a manifest.
   *
   * `dryRun` runs validation and the grant without writing anything, which is
   * what the consent screen calls to show an operator exactly what they are
   * about to agree to — including which capabilities they personally cannot
   * pass on.
   */
  async install(input: {
    manifest: unknown;
    config?: Record<string, unknown>;
    listingId?: string;
    publisherId?: string;
    signature?: string;
    signatureVerified?: boolean;
    dryRun?: boolean;
  }): Promise<{
    extension?: Extension;
    grant: CapabilityGrant;
    validation: ReturnType<typeof validate>;
    contributions?: { registered: number; skipped: Array<{ key: string; reason: string }> };
    consentRequired: boolean;
  }> {
    // --- validate
    const validation = validate(input.manifest);
    if (!validation.ok || !validation.manifest) {
      throw new BadRequestException({
        message: 'The manifest is not valid',
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }
    const manifest = validation.manifest;

    const existing = await this.extensions.findBySlug(manifest.slug);
    if (existing && !input.dryRun) {
      throw new ConflictException(
        `"${manifest.slug}" is already installed at version ${existing.version}`,
      );
    }

    // --- grant: the intersection rule
    const context = RequestContextStore.require();
    const capabilityGrant = grantCapabilities({
      requested: manifest.capabilities,
      holderPermissions: context.permissions,
    });

    // --- config
    const configCheck = validateConfig(manifest, input.config ?? {});
    if (!configCheck.ok) {
      throw new BadRequestException({
        message: 'The supplied settings are not valid',
        errors: configCheck.errors,
      });
    }
    const { config, secrets } = this.splitSecrets(manifest, configCheck.values);

    const consentRequired = capabilityGrant.reviewRequired;

    if (input.dryRun) {
      return { grant: capabilityGrant, validation, consentRequired };
    }

    // --- create
    const extension = await this.extensions.create({
      name: manifest.name,
      slug: manifest.slug,
      version: manifest.version,
      // A grant that needs a human decision does not get one by being written
      // down. The extension exists, holds its capabilities, and stays inert
      // until someone with authority says otherwise.
      status: consentRequired ? ExtensionStatus.PENDING_REVIEW : ExtensionStatus.INSTALLED,
      manifest: manifest as never,
      subscribes: manifest.subscribes ?? [],
      description: manifest.description ?? null,
      author: manifest.author ?? null,
      license: manifest.license ?? null,
      homepage: manifest.homepage ?? null,
      publisherId: input.publisherId ?? null,
      listingId: input.listingId ?? null,
      requestedCapabilities: manifest.capabilities,
      capabilities: capabilityGrant.granted,
      withheldCapabilities: capabilityGrant.withheld as never,
      capabilityVersion: capabilityGrant.catalogueVersion,
      riskLevel: capabilityGrant.risk as CapabilityRiskLevel,
      config: config as never,
      secrets: secrets as never,
      limits: (manifest.limits ?? resolveLimits()) as never,
      engine: manifest.engine ?? null,
      dependencies: (manifest.dependencies ?? {}) as never,
      manifestDigest: validation.digest || digestOf(manifest),
      signature: input.signature ?? null,
      signatureVerified: input.signatureVerified ?? false,
      installedById: context.userId ?? null,
    });

    await this.record(extension, ExtensionPhase.INSTALL, LifecycleOutcome.SUCCEEDED, {
      version: manifest.version,
      toStatus: extension.status,
      detail: {
        granted: capabilityGrant.granted,
        withheld: capabilityGrant.withheld,
        warnings: validation.warnings,
      },
    });

    await this.events.publish(DomainEvent.ExtensionInstalled, {
      extensionId: extension.id,
      slug: extension.slug,
      version: extension.version,
    });
    await this.events.publish(DomainEvent.ExtensionCapabilitiesGranted, {
      extensionId: extension.id,
      granted: capabilityGrant.granted,
      risk: capabilityGrant.risk,
    });
    if (capabilityGrant.withheld.length) {
      await this.events.publish(DomainEvent.ExtensionCapabilitiesWithheld, {
        extensionId: extension.id,
        withheld: capabilityGrant.withheld,
      });
    }

    // --- register contributions
    const registration = await this.transition(
      extension,
      ExtensionPhase.REGISTER,
      async () => this.contributions.register(extension, manifest, capabilityGrant.granted),
    );

    if (registration.registered.length) {
      await this.events.publish(DomainEvent.ContributionRegistered, {
        extensionId: extension.id,
        keys: registration.registered.map((row) => row.key),
      });
    }

    // --- initialize
    if (!consentRequired) {
      await this.initialize(extension);
    }

    const fresh = await this.extensions.findByIdOrFail(extension.id);
    return {
      extension: fresh,
      grant: capabilityGrant,
      validation,
      contributions: {
        registered: registration.registered.length,
        skipped: registration.skipped,
      },
      consentRequired,
    };
  }

  /** Runs the extension's own `initialize`, once, under its grant. */
  private async initialize(extension: Extension): Promise<void> {
    try {
      await this.transition(extension, ExtensionPhase.INITIALIZE, async () => {
        const module = await this.moduleFor(extension);
        await module.initialize?.(await this.contextFor(extension));
      });
      await this.extensions.update(extension.id, {
        initializedAt: new Date(),
        lastError: null,
      });
      await this.events.publish(DomainEvent.ExtensionInitialized, {
        extensionId: extension.id,
        slug: extension.slug,
      });
    } catch (error) {
      // A failed initialize is not a failed install: the extension exists, its
      // grant is recorded, and it is inert. Marking it FAILED says exactly
      // that, and leaves it repairable rather than requiring a reinstall.
      await this.extensions.update(extension.id, {
        status: ExtensionStatus.FAILED,
        lastError: (error as Error).message.slice(0, 500),
      });
    }
  }

  /** Approves a grant that needed a human decision, and initializes. */
  async approveCapabilities(id: string): Promise<Extension> {
    const extension = await this.extensions.findByIdOrFail(id);
    if (extension.status !== ExtensionStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        `"${extension.slug}" is ${extension.status}, not awaiting a capability decision`,
      );
    }
    const approved = await this.extensions.update(id, { status: ExtensionStatus.INSTALLED });
    await this.record(approved, ExtensionPhase.INSTALL, LifecycleOutcome.SUCCEEDED, {
      fromStatus: ExtensionStatus.PENDING_REVIEW,
      toStatus: ExtensionStatus.INSTALLED,
      detail: { capabilities: approved.capabilities },
    });
    await this.initialize(approved);
    return this.extensions.findByIdOrFail(id);
  }

  /** Refuses a pending grant. The extension is removed, not left half-installed. */
  async rejectCapabilities(id: string, reason: string): Promise<void> {
    const extension = await this.extensions.findByIdOrFail(id);
    await this.record(extension, ExtensionPhase.INSTALL, LifecycleOutcome.REFUSED, {
      detail: { reason, capabilities: extension.requestedCapabilities },
      message: reason,
    });
    await this.uninstall(id);
  }

  // ============================================================ run state

  async enable(id: string): Promise<Extension> {
    const extension = await this.extensions.findByIdOrFail(id);

    if (extension.status === ExtensionStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        `"${extension.slug}" requests ${extension.riskLevel.toLowerCase()}-risk capabilities and must be approved before it runs`,
      );
    }
    if (extension.status === ExtensionStatus.QUARANTINED) {
      throw new BadRequestException(
        `"${extension.slug}" is quarantined${extension.lastError ? `: ${extension.lastError}` : ''}`,
      );
    }

    await this.transition(extension, ExtensionPhase.ENABLE, async () => {
      const module = await this.moduleFor(extension);
      await module.activate?.(await this.contextFor(extension));
    });

    const enabled = await this.extensions.update(id, {
      status: ExtensionStatus.ENABLED,
      lastError: null,
    });
    await this.contributions.setEnabled(id, true);
    await this.events.publish(DomainEvent.ExtensionEnabled, { extensionId: id, slug: enabled.slug });
    return enabled;
  }

  async disable(id: string): Promise<Extension> {
    const extension = await this.extensions.findByIdOrFail(id);

    // `deactivate` must not be able to keep an extension running by throwing.
    await this.transition(
      extension,
      ExtensionPhase.DISABLE,
      async () => {
        const module = await this.moduleFor(extension);
        await module.deactivate?.(await this.contextFor(extension));
      },
      { tolerateFailure: true },
    );

    const disabled = await this.extensions.update(id, { status: ExtensionStatus.DISABLED });
    await this.contributions.setEnabled(id, false);
    this.loaded.delete(id);
    await this.events.publish(DomainEvent.ExtensionDisabled, { extensionId: id, slug: disabled.slug });
    return disabled;
  }

  /**
   * Stops an extension for a reason that is not the operator's choice — a
   * security advisory, a suspended publisher, a signature that no longer
   * verifies. Kept distinct from `disable` so that re-enabling requires
   * addressing the reason rather than clicking the same button again.
   */
  async quarantine(id: string, reason: string): Promise<Extension> {
    const extension = await this.extensions.findByIdOrFail(id);
    await this.transition(
      extension,
      ExtensionPhase.QUARANTINE,
      async () => {
        const module = await this.moduleFor(extension);
        await module.deactivate?.(await this.contextFor(extension));
      },
      { tolerateFailure: true },
    );

    const quarantined = await this.extensions.update(id, {
      status: ExtensionStatus.QUARANTINED,
      lastError: reason.slice(0, 500),
    });
    await this.contributions.setEnabled(id, false);
    this.loaded.delete(id);
    await this.events.publish(DomainEvent.ExtensionQuarantined, {
      extensionId: id,
      slug: quarantined.slug,
      reason,
    });
    return quarantined;
  }

  async uninstall(id: string): Promise<void> {
    const extension = await this.extensions.findByIdOrFail(id);

    await this.transition(
      extension,
      ExtensionPhase.UNINSTALL,
      async () => {
        const module = await this.moduleFor(extension);
        await module.deactivate?.(await this.contextFor(extension));
      },
      { tolerateFailure: true },
    );

    await this.contributions.unregister(id);
    // The private keyspace goes with the extension: keeping it would leave an
    // organization holding data it can no longer see, read or delete.
    await this.state.dropAll(id);
    await this.loader.unload?.(extension.slug);
    this.loaded.delete(id);

    await this.extensions.remove(id);
    await this.events.publish(DomainEvent.ExtensionUninstalled, {
      extensionId: id,
      slug: extension.slug,
    });
  }

  // ============================================================ upgrades

  /**
   * Analyses an upgrade without performing it.
   *
   * This is what "breaking changes must be detected before installation"
   * means concretely: the answer comes from comparing two manifests, so it is
   * available before a byte of the new version has been trusted.
   */
  async analyse(id: string, candidateManifest: unknown): Promise<{
    analysis: UpgradeAnalysis;
    grant: CapabilityGrant;
    validation: ReturnType<typeof validate>;
  }> {
    const extension = await this.extensions.findByIdOrFail(id);
    const validation = validate(candidateManifest);
    if (!validation.ok || !validation.manifest) {
      throw new BadRequestException({
        message: 'The candidate manifest is not valid',
        errors: validation.errors,
      });
    }

    const current = extension.manifest as unknown as ExtensionManifest;
    const analysis = analyseUpgrade(
      { ...current, version: extension.version, slug: extension.slug },
      validation.manifest,
    );

    const context = RequestContextStore.require();
    const capabilityGrant = grantCapabilities({
      requested: validation.manifest.capabilities,
      holderPermissions: context.permissions,
    });

    return { analysis, grant: capabilityGrant, validation };
  }

  /**
   * Proposes an upgrade. Applies it immediately when nothing about the deal
   * changed; otherwise records it and waits.
   */
  async proposeUpgrade(
    id: string,
    candidateManifest: unknown,
    options: { consent?: boolean } = {},
  ): Promise<{ upgrade: unknown; applied: boolean; analysis: UpgradeAnalysis }> {
    const extension = await this.extensions.findByIdOrFail(id);
    const { analysis, grant: capabilityGrant, validation } = await this.analyse(
      id,
      candidateManifest,
    );
    const manifest = validation.manifest!;
    const context = RequestContextStore.require();

    const upgrade = await this.upgrades.create({
      extensionId: id,
      fromVersion: extension.version,
      toVersion: manifest.version,
      release: analysis.release,
      outcome: analysis.blocked
        ? UpgradeOutcome.BLOCKED
        : analysis.breaking && !options.consent
          ? UpgradeOutcome.AWAITING_CONSENT
          : UpgradeOutcome.PENDING,
      breaking: analysis.breaking,
      blocked: analysis.blocked,
      changes: analysis.changes as never,
      addedCapabilities: analysis.addedCapabilities,
      removedCapabilities: analysis.removedCapabilities,
      migrations: analysis.migrations as never,
      // The candidate travels with the snapshot: consent may be given days
      // later, and re-deriving the manifest then would risk applying something
      // other than what was analysed and shown.
      snapshot: {
        ...ExtensionRuntimeService.snapshot(extension),
        candidateManifest: manifest,
      } as never,
      ...(analysis.breaking && options.consent
        ? { consentedById: context.userId ?? null, consentedAt: new Date() }
        : {}),
    });

    if (analysis.blocked) {
      await this.record(extension, ExtensionPhase.UPDATE, LifecycleOutcome.REFUSED, {
        version: manifest.version,
        detail: { changes: analysis.changes.filter((c) => c.severity === 'BLOCKING') },
        message: ExtensionRuntimeService.firstBlocking(analysis.changes),
      });
      await this.events.publish(DomainEvent.ExtensionUpgradeBlocked, {
        extensionId: id,
        toVersion: manifest.version,
        reason: ExtensionRuntimeService.firstBlocking(analysis.changes),
      });
      return { upgrade, applied: false, analysis };
    }

    if (analysis.breaking && !options.consent) {
      await this.extensions.update(id, { pendingVersion: manifest.version });
      await this.events.publish(DomainEvent.ExtensionUpgradeProposed, {
        extensionId: id,
        toVersion: manifest.version,
        breaking: true,
        addedCapabilities: analysis.addedCapabilities,
      });
      return { upgrade, applied: false, analysis };
    }

    await this.applyUpgrade(extension, (upgrade as { id: string }).id, manifest, analysis, capabilityGrant);
    return { upgrade, applied: true, analysis };
  }

  /** Consents to a proposed upgrade and applies it. */
  async consentToUpgrade(upgradeId: string): Promise<Extension> {
    const upgrade = await this.upgrades.findByIdOrFail(upgradeId);
    if (upgrade.outcome !== UpgradeOutcome.AWAITING_CONSENT) {
      throw new BadRequestException(`This upgrade is ${upgrade.outcome}, not awaiting consent`);
    }

    const extension = await this.extensions.findByIdOrFail(upgrade.extensionId);
    const candidate = (upgrade.snapshot as Record<string, unknown>).candidateManifest;
    const manifest = candidate
      ? (candidate as ExtensionManifest)
      : ((extension.manifest as unknown as ExtensionManifest) ?? null);

    if (!manifest || manifest.version !== upgrade.toVersion) {
      throw new BadRequestException(
        'The candidate manifest is no longer available; re-propose the upgrade',
      );
    }

    const context = RequestContextStore.require();
    await this.upgrades.update(upgradeId, {
      consentedById: context.userId ?? null,
      consentedAt: new Date(),
    });

    const analysis = analyseUpgrade(
      { ...(extension.manifest as unknown as ExtensionManifest), version: extension.version },
      manifest,
    );
    const capabilityGrant = grantCapabilities({
      requested: manifest.capabilities,
      holderPermissions: context.permissions,
    });

    await this.applyUpgrade(extension, upgradeId, manifest, analysis, capabilityGrant);
    return this.extensions.findByIdOrFail(extension.id);
  }

  private async applyUpgrade(
    extension: Extension,
    upgradeId: string,
    manifest: ExtensionManifest,
    analysis: UpgradeAnalysis,
    capabilityGrant: CapabilityGrant,
  ): Promise<void> {
    try {
      // Contributions are re-registered from the new manifest rather than
      // patched, so a removed contribution actually disappears instead of
      // lingering as a row nothing updates.
      await this.contributions.unregister(extension.id);

      await this.extensions.update(extension.id, {
        name: manifest.name,
        version: manifest.version,
        manifest: manifest as never,
        subscribes: manifest.subscribes ?? [],
        requestedCapabilities: manifest.capabilities,
        capabilities: capabilityGrant.granted,
        withheldCapabilities: capabilityGrant.withheld as never,
        capabilityVersion: capabilityGrant.catalogueVersion,
        riskLevel: capabilityGrant.risk as CapabilityRiskLevel,
        limits: (manifest.limits ?? resolveLimits()) as never,
        engine: manifest.engine ?? null,
        dependencies: (manifest.dependencies ?? {}) as never,
        manifestDigest: digestOf(manifest),
        pendingVersion: null,
        lastError: null,
      });

      const updated = await this.extensions.findByIdOrFail(extension.id);
      this.loaded.delete(extension.id);

      await this.contributions.register(updated, manifest, capabilityGrant.granted);

      // Migrations run after the row is updated and before the extension is
      // considered upgraded: a migration that fails leaves a FAILED extension
      // on the new version, which is recoverable, rather than a live extension
      // on new code with old data, which is not.
      for (const step of analysis.migrations) {
        await this.transition(updated, ExtensionPhase.MIGRATE, async () => {
          const module = await this.moduleFor(updated);
          const migrationContext: MigrationContext = {
            ...(await this.contextFor(updated)),
            fromVersion: analysis.from,
            toVersion: analysis.to,
          };
          await module.migrate?.(migrationContext, step);
        });
      }

      await this.upgrades.update(upgradeId, {
        outcome: UpgradeOutcome.APPLIED,
        appliedAt: new Date(),
      });
      await this.record(updated, ExtensionPhase.UPDATE, LifecycleOutcome.SUCCEEDED, {
        version: manifest.version,
        detail: { from: analysis.from, to: analysis.to, migrations: analysis.migrations.length },
      });
      await this.events.publish(DomainEvent.ExtensionUpgraded, {
        extensionId: extension.id,
        from: analysis.from,
        to: analysis.to,
        breaking: analysis.breaking,
      });
    } catch (error) {
      const message = (error as Error).message;
      await this.upgrades.update(upgradeId, {
        outcome: UpgradeOutcome.FAILED,
        error: message.slice(0, 500),
      });
      await this.extensions.update(extension.id, {
        status: ExtensionStatus.FAILED,
        lastError: message.slice(0, 500),
      });
      await this.record(extension, ExtensionPhase.UPDATE, LifecycleOutcome.FAILED, {
        version: manifest.version,
        message,
      });
      throw error;
    }
  }

  /**
   * Restores the version captured before the last applied upgrade.
   *
   * The snapshot is what makes this a restore rather than a reinstall: the
   * previous manifest, grant, config and limits all come back together, so the
   * extension returns to a state that was actually consented to once.
   */
  async rollback(id: string): Promise<Extension> {
    const extension = await this.extensions.findByIdOrFail(id);
    const last = await this.upgrades.lastApplied(id);
    if (!last) {
      throw new BadRequestException(`"${extension.slug}" has no applied upgrade to roll back`);
    }

    const snapshot = last.snapshot as Record<string, unknown>;
    const manifest = snapshot.manifest as ExtensionManifest | undefined;
    if (!manifest) {
      throw new BadRequestException('The stored snapshot is incomplete; rollback is not possible');
    }

    await this.transition(extension, ExtensionPhase.ROLLBACK, async () => {
      await this.contributions.unregister(id);
      await this.extensions.update(id, {
        name: (snapshot.name as string) ?? extension.name,
        version: last.fromVersion,
        manifest: manifest as never,
        subscribes: (snapshot.subscribes as string[]) ?? [],
        requestedCapabilities: (snapshot.requestedCapabilities as string[]) ?? [],
        capabilities: (snapshot.capabilities as string[]) ?? [],
        withheldCapabilities: (snapshot.withheldCapabilities ?? []) as never,
        capabilityVersion: (snapshot.capabilityVersion as string) ?? '',
        riskLevel: (snapshot.riskLevel as CapabilityRiskLevel) ?? 'LOW',
        limits: (snapshot.limits ?? resolveLimits()) as never,
        engine: (snapshot.engine as string | null) ?? null,
        dependencies: (snapshot.dependencies ?? {}) as never,
        manifestDigest: digestOf(manifest),
        pendingVersion: null,
        lastError: null,
      });

      const restored = await this.extensions.findByIdOrFail(id);
      this.loaded.delete(id);
      await this.contributions.register(restored, manifest, restored.capabilities);
    });

    await this.upgrades.update(last.id, {
      outcome: UpgradeOutcome.ROLLED_BACK,
      rolledBackAt: new Date(),
    });
    await this.events.publish(DomainEvent.ExtensionRolledBack, {
      extensionId: id,
      to: last.fromVersion,
    });
    return this.extensions.findByIdOrFail(id);
  }

  /** Everything needed to put this version back. */
  private static snapshot(extension: Extension): Record<string, unknown> {
    return {
      name: extension.name,
      version: extension.version,
      manifest: extension.manifest,
      subscribes: extension.subscribes,
      requestedCapabilities: extension.requestedCapabilities,
      capabilities: extension.capabilities,
      withheldCapabilities: extension.withheldCapabilities,
      capabilityVersion: extension.capabilityVersion,
      riskLevel: extension.riskLevel,
      limits: extension.limits,
      engine: extension.engine,
      dependencies: extension.dependencies,
      config: extension.config,
    };
  }

  private static firstBlocking(changes: ManifestChange[]): string {
    return changes.find((change) => change.severity === 'BLOCKING')?.message ?? 'Upgrade blocked';
  }

  // ============================================================ execution

  /** Delivers a domain event to one enabled, subscribed extension. */
  async deliver(extension: Extension, event: { name: string; payload: Record<string, unknown> }): Promise<void> {
    if (extension.status !== ExtensionStatus.ENABLED) return;

    try {
      const module = await this.moduleFor(extension);
      if (!module.onEvent) return;
      await module.onEvent(await this.contextFor(extension), {
        name: event.name,
        payload: event.payload,
        occurredAt: new Date().toISOString(),
      });
      await this.extensions.update(extension.id, { lastRunAt: new Date() });
    } catch (error) {
      // One extension failing on one event must not stop the others, and must
      // not be silent either.
      this.logger.warn(
        `${extension.slug} failed handling "${event.name}": ${(error as Error).message}`,
      );
      await this.record(extension, ExtensionPhase.RUN, LifecycleOutcome.FAILED, {
        message: (error as Error).message,
        detail: { event: event.name },
      });
    }
  }

  /** Runs a contributed tool or worker under the contribution's own grant. */
  async invokeContribution(
    contribution: ExtensionContribution,
    invocation: { key: string; input: Record<string, unknown> },
  ): Promise<unknown> {
    const extension = await this.extensions.findByIdOrFail(contribution.extensionId);
    if (extension.status !== ExtensionStatus.ENABLED) {
      throw new Error(`"${extension.slug}" is not enabled`);
    }

    const module = await this.moduleFor(extension);
    const context = await this.contextFor(extension, {
      capabilities: contribution.capabilities,
      contributionId: contribution.id,
    });

    if (contribution.kind === 'WORKER') {
      if (!module.onWorkerRun) throw new Error(`"${contribution.key}" implements no worker handler`);
      return module.onWorkerRun(context, {
        key: contribution.key,
        prompt: String(invocation.input.prompt ?? ''),
        input: invocation.input,
      });
    }

    if (!module.onToolCall) throw new Error(`"${contribution.key}" implements no tool handler`);
    return module.onToolCall(context, invocation);
  }

  // ============================================================ internals

  private async moduleFor(extension: Extension): Promise<ExtensionModule> {
    const cached = this.loaded.get(extension.id);
    if (cached) return cached;
    const module = await this.loader.load(extension.manifest as unknown as ExtensionManifest);
    this.loaded.set(extension.id, module);
    return module;
  }

  /**
   * Builds the context handed to extension code.
   *
   * Secrets are deliberately absent. An extension configured with an API key
   * gets to *use* it through `http.fetchAs`, which injects it host-side; it
   * never gets to read it, because a value an extension can read is a value it
   * can exfiltrate through any capability it holds.
   */
  private async contextFor(
    extension: Extension,
    overrides: { capabilities?: readonly string[]; contributionId?: string } = {},
  ): Promise<ExtensionContext> {
    const binding = this.bindingFor(extension, overrides);
    return {
      extension: {
        id: extension.id,
        slug: extension.slug,
        name: extension.name,
        version: extension.version,
      },
      capabilities: binding.capabilities as ExtensionContext['capabilities'],
      config: binding.config,
      limits: binding.limits,
      dryRun: binding.dryRun ?? false,
      host: this.sandbox.host(binding),
      logger: this.loggerFor(extension),
    };
  }

  private bindingFor(
    extension: Extension,
    overrides: { capabilities?: readonly string[]; contributionId?: string } = {},
  ): SandboxBinding {
    return {
      extensionId: extension.id,
      slug: extension.slug,
      name: extension.name,
      version: extension.version,
      capabilities: overrides.capabilities ?? extension.capabilities,
      config: (extension.config ?? {}) as Record<string, unknown>,
      limits: resolveLimits(extension.limits as Record<string, number>),
      ...(overrides.contributionId ? { contributionId: overrides.contributionId } : {}),
    };
  }

  private loggerFor(extension: Extension): ExtensionContext['logger'] {
    const prefix = `[${extension.slug}]`;
    const write = (level: 'debug' | 'log' | 'warn' | 'error') =>
      (message: string, detail?: Record<string, unknown>) =>
        this.logger[level](`${prefix} ${message}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
    return {
      debug: write('debug'),
      info: write('log'),
      warn: write('warn'),
      error: write('error'),
    };
  }

  /** Splits validated config into what is stored plainly and what is sealed. */
  private splitSecrets(
    manifest: ExtensionManifest,
    values: Record<string, unknown>,
  ): { config: Record<string, unknown>; secrets: Record<string, unknown> } {
    const secretNames = new Set(secretFields(manifest));
    const config: Record<string, unknown> = {};
    const secrets: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(values)) {
      if (secretNames.has(field)) secrets[field] = this.crypto.seal(String(value));
      else config[field] = value;
    }
    return { config, secrets };
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Wraps one lifecycle phase: records STARTED, runs the work, records the
   * outcome. `tolerateFailure` is for the teardown phases, where refusing to
   * proceed because an extension's own cleanup threw would leave the operator
   * unable to remove it.
   */
  private async transition<T>(
    extension: Extension,
    phase: ExtensionPhase,
    work: () => Promise<T>,
    options: { tolerateFailure?: boolean } = {},
  ): Promise<T> {
    const startedAt = Date.now();
    await this.record(extension, phase, LifecycleOutcome.STARTED, {});

    try {
      const result = await work();
      await this.record(extension, phase, LifecycleOutcome.SUCCEEDED, {
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const message = (error as Error).message;
      await this.record(extension, phase, LifecycleOutcome.FAILED, {
        durationMs: Date.now() - startedAt,
        message,
      });
      if (options.tolerateFailure) {
        this.logger.warn(`${extension.slug}: ${phase} failed but was tolerated — ${message}`);
        return undefined as T;
      }
      throw error;
    }
  }

  private async record(
    extension: Extension,
    phase: ExtensionPhase,
    outcome: LifecycleOutcome,
    extra: {
      fromStatus?: ExtensionStatus;
      toStatus?: ExtensionStatus;
      version?: string;
      detail?: Record<string, unknown>;
      message?: string;
      durationMs?: number;
    },
  ): Promise<void> {
    try {
      const context = RequestContextStore.get();
      await this.lifecycle.create({
        extensionId: extension.id,
        phase,
        outcome,
        fromStatus: extra.fromStatus ?? extension.status,
        toStatus: extra.toStatus ?? null,
        version: extra.version ?? extension.version,
        detail: ExtensionRuntimeService.bound(extra.detail ?? {}) as never,
        message: extra.message ? extra.message.slice(0, 500) : null,
        durationMs: extra.durationMs ?? null,
        actorId: context?.userId ?? null,
      });
    } catch (error) {
      // Recording a transition must never be what prevents it.
      this.logger.error(`Failed to record lifecycle event: ${(error as Error).message}`);
    }
  }

  private static bound(detail: Record<string, unknown>, maxChars = 4000): Record<string, unknown> {
    const json = JSON.stringify(detail);
    if (!json || json.length <= maxChars) return detail;
    return { truncated: true, preview: json.slice(0, maxChars) };
  }

  // ------------------------------------------------------------- reporting

  /** The consent screen's data: what is being asked for, and what it means. */
  async describeGrant(id: string): Promise<{
    extension: { id: string; slug: string; name: string; version: string; status: string };
    risk: string;
    granted: Array<{ id: string; title: string; description: string; risk: string }>;
    withheld: unknown;
    requested: string[];
    permissions: string[];
    catalogueVersion: string;
    catalogueCurrent: boolean;
  }> {
    const extension = await this.extensions.findByIdOrFail(id);
    const granted = extension.capabilities
      .map((capability) => describeCapability(capability))
      .filter((definition): definition is NonNullable<typeof definition> => Boolean(definition))
      .map((definition) => ({
        id: definition.id,
        title: definition.title,
        description: definition.description,
        risk: definition.risk,
      }));

    return {
      extension: {
        id: extension.id,
        slug: extension.slug,
        name: extension.name,
        version: extension.version,
        status: extension.status,
      },
      risk: extension.riskLevel,
      granted,
      withheld: extension.withheldCapabilities,
      requested: extension.requestedCapabilities,
      permissions: permissionsFor(extension.capabilities),
      catalogueVersion: extension.capabilityVersion,
      catalogueCurrent: extension.capabilityVersion === CAPABILITY_CATALOGUE_VERSION,
    };
  }

  /** Installed extensions with their grants, newest first. */
  async list(): Promise<Array<Record<string, unknown>>> {
    const rows = await this.extensions.findMany({}, { orderBy: { createdAt: 'desc' } });
    return rows.map((extension) => ({
      id: extension.id,
      name: extension.name,
      slug: extension.slug,
      version: extension.version,
      status: extension.status,
      riskLevel: extension.riskLevel,
      capabilities: extension.capabilities,
      withheldCapabilities: extension.withheldCapabilities,
      pendingVersion: extension.pendingVersion,
      signatureVerified: extension.signatureVerified,
      lastError: extension.lastError,
      initializedAt: extension.initializedAt,
      lastRunAt: extension.lastRunAt,
      createdAt: extension.createdAt,
    }));
  }

  /** One extension, with its grant and what it contributed. */
  async describe(id: string): Promise<Record<string, unknown>> {
    const extension = await this.extensions.findByIdOrFail(id);
    const [grantDetail, contributionSummary, pending] = await Promise.all([
      this.describeGrant(id),
      this.contributions.summary(id),
      this.upgrades.pendingConsent(id),
    ]);

    // `secrets` is deliberately absent rather than redacted: a field that is
    // sometimes present and sometimes '[redacted]' invites a caller to check
    // for the wrong one.
    const { secrets: _sealed, ...safe } = extension;

    return {
      ...safe,
      grant: grantDetail,
      contributions: contributionSummary,
      pendingUpgrade: pending
        ? {
            id: pending.id,
            toVersion: pending.toVersion,
            breaking: pending.breaking,
            addedCapabilities: pending.addedCapabilities,
            changes: pending.changes,
          }
        : null,
    };
  }

  history(id: string, take = 100) {
    return this.lifecycle.history(id, take);
  }

  upgradeHistory(id: string, take = 50) {
    return this.upgrades.forExtension(id, take);
  }
}
