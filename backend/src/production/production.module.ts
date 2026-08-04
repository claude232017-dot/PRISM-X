import { Module, OnModuleInit } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { StorageModule } from '../storage/storage.module';
import { AutomationModule } from '../automation/automation.module';
import { TriggerEngine } from '../triggers/trigger-engine.service';
import { InstanceService } from './instance.service';
import { MetricsService } from './metrics.service';
import { AlertingService } from './alerting.service';
import { BackupService } from './backup.service';
import { BillingService } from './billing.service';
import { SecurityService } from './security.service';
import { AdminService } from './admin.service';
import { ReadinessService } from './readiness.service';
import { ObservabilityInterceptor } from './observability.interceptor';
import { RateLimitGuard } from './rate-limit.guard';
import {
  AdminController,
  BackupController,
  BillingController,
  ObservabilityController,
  ProbeController,
  ReadinessController,
  SecurityController,
} from './production.controllers';

/**
 * Phase 8 — the production layer.
 *
 * Everything here is about running PRISM-X rather than about what PRISM-X
 * does, and the dependency direction reflects that: this module imports the
 * domain, and nothing in the domain imports it. A deployment that strips Phase
 * 8 out loses observability, billing and disaster recovery, and keeps working.
 *
 * The one edge that would otherwise point the wrong way is scheduled work.
 * `TriggerEngine` lives below this module and must run without it — a single
 * instance needs no leader — so leadership arrives as a callback rather than an
 * injected dependency, following the same seam pattern as
 * `runtime.onRemoteRoute` in Phase 4 and `contributions.onInvoke` in Phase 7.
 *
 * Two providers are registered globally, and the order matters. The rate limit
 * guard runs before authentication so that an unauthenticated flood is stopped
 * before it costs a database round trip; the observability interceptor wraps
 * everything so a request rejected by the limiter still shows up in the metrics
 * that would explain why.
 */
@Module({
  imports: [
    StorageModule,
    // For NotificationService, ApiKeyService and the webhook/dead-letter
    // repositories the security and readiness layers read.
    AutomationModule,
  ],
  controllers: [
    ProbeController,
    ObservabilityController,
    BackupController,
    BillingController,
    SecurityController,
    AdminController,
    ReadinessController,
  ],
  providers: [
    InstanceService,
    MetricsService,
    AlertingService,
    BackupService,
    BillingService,
    SecurityService,
    AdminService,
    ReadinessService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: ObservabilityInterceptor },
  ],
  exports: [
    InstanceService,
    MetricsService,
    BillingService,
    SecurityService,
    BackupService,
    ReadinessService,
  ],
})
export class ProductionModule implements OnModuleInit {
  constructor(
    private readonly instances: InstanceService,
    private readonly triggers: TriggerEngine,
    private readonly backups: BackupService,
    private readonly billing: BillingService,
  ) {}

  private maintenance?: NodeJS.Timeout;

  onModuleInit(): void {
    // Scheduled triggers become cluster-wide rather than per-instance work.
    this.triggers.onScheduleGuard(() => this.instances.isLeader);

    // Housekeeping the deployment needs and nobody would remember to run:
    // expiring backups past retention, and advancing subscriptions whose
    // period has ended. Leader-only, so N instances do it once.
    this.maintenance = setInterval(
      () => {
        void this.instances.runIfLeader('backup-prune', () => this.backups.prune());
        void this.instances.runIfLeader('billing-renew', () => this.billing.renewDue());
      },
      // Hourly. Both tasks are idempotent and neither is urgent; running them
      // more often would cost queries without changing any outcome.
      3_600_000,
    );
    this.maintenance.unref?.();
  }
}
