import { Module } from '@nestjs/common';
import { MissionsModule } from '../missions/missions.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { WorkersModule } from '../workers/workers.module';
import { StorageModule } from '../storage/storage.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ToolsModule } from '../tools/tools.module';
import { AutomationModule } from '../automation/automation.module';
import { SandboxService } from './sandbox.service';
import { ContributionService } from './contribution.service';
import { ExtensionRuntimeService } from './extension-runtime.service';
import { MarketplaceService } from './marketplace.service';
import { GovernanceService } from './governance.service';
import { DeveloperPortalService } from './developer-portal.service';
import { LocalExtensionLoader } from './local-extension-loader';
import { EXTENSION_LOADER } from './sdk';
import { WorkerThreadExtensionLoader } from './worker-thread-extension-loader';
import {
  CapabilityController,
  ContributionController,
  DeveloperPortalController,
  GovernanceController,
  MarketplaceController,
  PlatformExtensionController,
  UpgradeController,
} from './platform.controllers';

/**
 * Phase 7 — the platform layer.
 *
 * This module is where PRISM-X stops being an application with features and
 * becomes something other people can build on. The dependency direction is
 * one-way and deliberate: the platform imports the domain modules, and no
 * domain module imports the platform. A feature added as an extension
 * therefore cannot require a change to the engine it extends, which is the
 * whole point.
 *
 * The two edges that would otherwise be cycles are callbacks, following the
 * pattern established in Phases 3 and 4:
 *
 *  - `ToolRegistry.setDynamicResolver` lets the tool registry resolve
 *    contributed tools without importing this module.
 *  - `ContributionService.onInvoke` lets contributions be executed by the
 *    runtime without the contribution registry depending on it.
 *
 * `EXTENSION_LOADER` is the seam for how extension code is resolved, and there
 * are now two implementations of it — which is what makes the seam a claim
 * about the architecture rather than a promise about it.
 *
 * `EXTENSION_ISOLATION` chooses:
 *
 *  - `none`   — the in-process loader. Executes no publisher code; the module
 *               is derived from the manifest and runs on the host's own event
 *               loop. The default, because it is what a deployment with no
 *               third-party extensions actually needs.
 *  - `thread` — a `worker_threads` isolate per extension, with heap and stack
 *               limits and a per-call deadline enforced by terminating the
 *               thread. Genuinely executes code, and genuinely contains a
 *               runaway one.
 *
 * The distinction is reported by the readiness review rather than left to a
 * reader of this comment, because "extensions are sandboxed" is a claim an
 * operator has to be able to check from the running system.
 */
@Module({
  imports: [
    MissionsModule,
    KnowledgeModule,
    WorkersModule,
    StorageModule,
    AnalyticsModule,
    ToolsModule,
    // For NotificationService and ApiKeyService, both of which AutomationModule owns.
    AutomationModule,
  ],
  controllers: [
    CapabilityController,
    PlatformExtensionController,
    UpgradeController,
    ContributionController,
    MarketplaceController,
    GovernanceController,
    DeveloperPortalController,
  ],
  providers: [
    SandboxService,
    ContributionService,
    ExtensionRuntimeService,
    MarketplaceService,
    GovernanceService,
    DeveloperPortalService,
    LocalExtensionLoader,
    WorkerThreadExtensionLoader,
    {
      provide: EXTENSION_LOADER,
      inject: [LocalExtensionLoader, WorkerThreadExtensionLoader],
      useFactory: (
        local: LocalExtensionLoader,
        isolated: WorkerThreadExtensionLoader,
      ) => {
        const selected =
          process.env.EXTENSION_ISOLATION === 'thread' ? isolated : local;
        // Only the bound loader declares itself, so the readiness review
        // reports what is actually in use rather than what is merely present.
        selected.declare();
        return selected;
      },
    },
  ],
  exports: [ExtensionRuntimeService, ContributionService, SandboxService, DeveloperPortalService],
})
export class PlatformModule {}
