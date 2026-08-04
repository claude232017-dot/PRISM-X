import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppConfigModule } from './config/config.module';
import { SharedModule } from './shared/shared.module';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { WorkersModule } from './workers/workers.module';
import { MissionsModule } from './missions/missions.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { ProvidersModule } from './providers/providers.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { ExtensionsModule } from './extensions/extensions.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StorageModule } from './storage/storage.module';
import { QueuesModule } from './queues/queues.module';
import { HealthModule } from './health/health.module';

// Phase 2 — intelligence and execution
import { KnowledgeRetrievalModule } from './knowledge/retrieval/knowledge-retrieval.module';
import { MemoryModule } from './memory/memory.module';
import { ToolsModule } from './tools/tools.module';
import { WorkerRuntimeModule } from './workers/runtime/worker-runtime.module';
import { UsageModule } from './usage/usage.module';

// Phase 3 — automation and integration platform
import { AutomationModule } from './automation/automation.module';

// Phase 4 — distributed intelligence
import { NodesModule } from './nodes/nodes.module';
import { DistributedModule } from './distributed/distributed.module';

// Phase 5 — learning and optimization
import { LearningModule } from './learning/learning.module';

// Phase 6 — evolution
import { EvolutionModule } from './evolution/evolution.module';
import { PlatformModule } from './platform/platform.module';
import { ProductionModule } from './production/production.module';

import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter';
import { AuditInterceptor } from './shared/interceptors/audit.interceptor';
import { RequestContextMiddleware } from './shared/context/request-context.middleware';

@Module({
  imports: [
    // Infrastructure
    AppConfigModule,
    SharedModule,
    DatabaseModule,
    EventsModule,
    AuthModule,

    // Domain
    OrganizationsModule,
    WorkersModule,
    KnowledgeModule,
    ProvidersModule,
    IntegrationsModule,
    ExtensionsModule,
    AnalyticsModule,
    NotificationsModule,

    // Platform
    StorageModule,
    QueuesModule,
    HealthModule,

    // Phase 2 — order matters: retrieval and memory are dependencies of the
    // worker runtime, which the mission orchestrator in turn depends on.
    KnowledgeRetrievalModule,
    MemoryModule,
    ToolsModule,
    WorkerRuntimeModule,
    MissionsModule,
    UsageModule,

    // Phase 3 depends on missions, workers and integrations being present.
    AutomationModule,

    // Phase 4 sits above the execution layer: the fleet first, then the
    // scheduling and replication that operate on it.
    NodesModule,
    DistributedModule,

    // Phase 5 observes everything below it and depends on nothing above.
    LearningModule,

    // Phase 6 acts on what Phase 5 concluded, behind the Constitution.
    EvolutionModule,

    // Phase 7 hosts what other people build. It imports the domain modules;
    // nothing below it imports the platform, so an extension can never require
    // a change to the engine it extends.
    PlatformModule,

    // Phase 8 runs the platform: instances, observability, recovery, billing
    // and administration. It imports the domain; the domain never imports it.
    ProductionModule,
  ],
  providers: [
    // Order matters: authentication runs before permission checks.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },

    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  /**
   * The request context scope must be open before guards run, which is only
   * possible from middleware — see RequestContextMiddleware for why an
   * interceptor cannot do this.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
