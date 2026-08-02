import { Global, Module, OnModuleInit } from '@nestjs/common';

import { IntegrationManager } from '../integrations/integration-manager.service';
import { WorkflowService } from '../workflows/workflow.service';
import { WorkflowEngine } from '../workflows/workflow-engine.service';
import {
  InternalExecutionAdapter,
  MakeExecutionAdapter,
  N8nExecutionAdapter,
} from '../workflows/execution/adapters';
import { TriggerEngine } from '../triggers/trigger-engine.service';
import { ApprovalService } from '../approvals/approval.service';
import { AiDecisionService } from '../decisions/ai-decision.service';
import { NotificationService } from '../notifications/notification.service';
import { ApiKeyService } from '../public-api/api-key.service';
import { WebhookDispatcher } from '../public-api/webhook-dispatcher.service';
import { AutomationAnalyticsService } from './automation-analytics.service';

import {
  ApiKeysController,
  ApprovalsController,
  AutomationAnalyticsController,
  ConnectorsController,
  InboundWebhookController,
  IntegrationOperationsController,
  NotificationsController,
  TriggersController,
  WebhookEndpointsController,
  WorkflowsController,
} from './automation.controllers';

import { MissionsModule } from '../missions/missions.module';
import { WorkerRuntimeModule } from '../workers/runtime/worker-runtime.module';

/**
 * The Phase 3 automation platform, assembled as one module.
 *
 * These services form a cycle by nature — the workflow engine suspends for
 * approvals, an approval resumes a run, a decision creates an approval, a
 * trigger starts a run, and everything notifies. Rather than scattering
 * `forwardRef` across the graph, the two genuine back-edges are wired here at
 * boot through explicit callbacks, which keeps the dependency direction in the
 * constructors one-way and readable.
 */
@Global()
@Module({
  imports: [MissionsModule, WorkerRuntimeModule],
  controllers: [
    WorkflowsController,
    ConnectorsController,
    IntegrationOperationsController,
    TriggersController,
    InboundWebhookController,
    ApprovalsController,
    NotificationsController,
    AutomationAnalyticsController,
    ApiKeysController,
    WebhookEndpointsController,
  ],
  providers: [
    IntegrationManager,
    WorkflowService,
    WorkflowEngine,
    InternalExecutionAdapter,
    N8nExecutionAdapter,
    MakeExecutionAdapter,
    TriggerEngine,
    ApprovalService,
    AiDecisionService,
    NotificationService,
    ApiKeyService,
    WebhookDispatcher,
    AutomationAnalyticsService,
  ],
  exports: [
    IntegrationManager,
    WorkflowService,
    WorkflowEngine,
    TriggerEngine,
    ApprovalService,
    AiDecisionService,
    NotificationService,
    ApiKeyService,
    WebhookDispatcher,
    AutomationAnalyticsService,
  ],
})
export class AutomationModule implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly engine: WorkflowEngine,
    private readonly notifications: NotificationService,
    private readonly integrations: IntegrationManager,
  ) {}

  onModuleInit(): void {
    // Approving a request resumes the run it suspended. Expressing this as a
    // constructor dependency would make ApprovalService and WorkflowEngine
    // mutually dependent.
    this.approvals.onRunResumable((runId) => this.engine.resume(runId));

    // Notifications reach Slack, Telegram and the rest through the Integration
    // Manager, so they inherit its retries and circuit breaking rather than
    // opening their own HTTP calls.
    this.notifications.onExternalDelivery(async (integrationId, action, input) => {
      const result = await this.integrations.execute(integrationId, action, input);
      return { ok: result.ok, error: result.error };
    });
  }
}
