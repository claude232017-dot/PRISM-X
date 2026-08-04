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
 * `EXTENSION_LOADER` is the seam for how extension code is resolved. PRISM-X
 * binds it to the deterministic in-process loader; an isolate, a container or
 * a remote runtime is a different binding here and no change anywhere else.
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
    { provide: EXTENSION_LOADER, useExisting: LocalExtensionLoader },
  ],
  exports: [ExtensionRuntimeService, ContributionService, SandboxService, DeveloperPortalService],
})
export class PlatformModule {}
