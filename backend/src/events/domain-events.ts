/**
 * The domain event catalogue.
 *
 * Event names are the contract between the core and everything that observes
 * it — extensions, analytics, notifications, future services. They are frozen
 * strings rather than an enum so that an extension author can subscribe to
 * `"mission.completed"` without importing backend types.
 */
export const DomainEvent = {
  // Identity
  UserRegistered: 'user.registered',
  UserInvited: 'user.invited',
  UserLoggedIn: 'user.logged_in',
  UserRemoved: 'user.removed',
  /**
   * A member's authorization changed. Anything that alters what a principal
   * may do publishes this, and the auth layer drops their cached permission
   * set on it — so revocation does not depend on every call site remembering
   * to invalidate.
   */
  MemberAccessChanged: 'member.access_changed',

  // Organization
  OrganizationCreated: 'organization.created',
  OrganizationUpdated: 'organization.updated',
  OrganizationDeleted: 'organization.deleted',

  // Workers
  WorkerCreated: 'worker.created',
  WorkerUpdated: 'worker.updated',
  WorkerActivated: 'worker.activated',
  WorkerArchived: 'worker.archived',
  WorkerDeleted: 'worker.deleted',

  // Missions & tasks
  MissionCreated: 'mission.created',
  MissionStarted: 'mission.started',
  MissionPaused: 'mission.paused',
  MissionCompleted: 'mission.completed',
  MissionFailed: 'mission.failed',
  MissionCancelled: 'mission.cancelled',
  TaskCreated: 'task.created',
  TaskStarted: 'task.started',
  TaskCompleted: 'task.completed',
  TaskFailed: 'task.failed',

  // Knowledge
  KnowledgeStored: 'knowledge.stored',
  KnowledgeUpdated: 'knowledge.updated',
  KnowledgeDeleted: 'knowledge.deleted',

  // Providers & integrations
  ProviderConnected: 'provider.connected',
  ProviderDisconnected: 'provider.disconnected',
  ProviderFailed: 'provider.failed',
  IntegrationCreated: 'integration.created',
  IntegrationActivated: 'integration.activated',
  IntegrationFailed: 'integration.failed',

  // Extensions
  ExtensionInstalled: 'extension.installed',
  ExtensionEnabled: 'extension.enabled',
  ExtensionDisabled: 'extension.disabled',

  // --- Phase 2: execution, memory, retrieval, cost -----------------
  MissionPlanned: 'mission.planned',
  MissionResumed: 'mission.resumed',
  MissionWaiting: 'mission.waiting',
  MissionArchived: 'mission.archived',
  MissionRetried: 'mission.retried',

  TaskScheduled: 'task.scheduled',
  TaskRetried: 'task.retried',
  TaskSkipped: 'task.skipped',

  /// A worker finished one execution, successfully or not.
  WorkerFinished: 'worker.finished',
  WorkerExecutionStarted: 'worker.execution_started',
  WorkerBudgetExceeded: 'worker.budget_exceeded',

  MemoryUpdated: 'memory.updated',
  MemoryConsolidated: 'memory.consolidated',
  KnowledgeRetrieved: 'knowledge.retrieved',

  ToolInvoked: 'tool.invoked',
  ToolDenied: 'tool.denied',

  ProviderRecovered: 'provider.recovered',
  ProviderRateLimited: 'provider.rate_limited',

  UsageRecorded: 'usage.recorded',
  CostThresholdReached: 'cost.threshold_reached',

  // --- Phase 3: automation platform --------------------------------
  IntegrationCallSucceeded: 'integration.call_succeeded',
  IntegrationCallFailed: 'integration.call_failed',
  IntegrationConnected: 'integration.connected',

  WorkflowCreated: 'workflow.created',
  WorkflowPublished: 'workflow.published',
  WorkflowRunStarted: 'workflow.run_started',
  WorkflowRunCompleted: 'workflow.run_completed',
  WorkflowRunFailed: 'workflow.run_failed',
  WorkflowRunSuspended: 'workflow.run_suspended',
  WorkflowRunResumed: 'workflow.run_resumed',
  WorkflowStepCompleted: 'workflow.step_completed',
  WorkflowStepFailed: 'workflow.step_failed',

  TriggerFired: 'trigger.fired',
  TriggerFailed: 'trigger.failed',
  WebhookReceived: 'webhook.received',
  WebhookDelivered: 'webhook.delivered',
  WebhookDeliveryFailed: 'webhook.delivery_failed',

  ApprovalRequested: 'approval.requested',
  ApprovalGranted: 'approval.granted',
  ApprovalRejected: 'approval.rejected',
  ApprovalChangesRequested: 'approval.changes_requested',
  ApprovalDelegated: 'approval.delegated',
  ApprovalExpired: 'approval.expired',

  AiDecisionMade: 'ai.decision_made',
  AiDecisionEscalated: 'ai.decision_escalated',

  NotificationSent: 'notification.sent',
  DeadLetterRecorded: 'deadletter.recorded',
  ApiKeyCreated: 'apikey.created',
  ApiKeyRevoked: 'apikey.revoked',

  // --- Phase 4: distributed intelligence ---------------------------
  NodeRegistered: 'node.registered',
  NodeOnline: 'node.online',
  NodeOffline: 'node.offline',
  NodeDegraded: 'node.degraded',
  NodeQuarantined: 'node.quarantined',
  NodeRecovered: 'node.recovered',
  NodeDraining: 'node.draining',
  NodeDecommissioned: 'node.decommissioned',
  NodeHeartbeatReceived: 'node.heartbeat',
  NodeCapabilitiesDiscovered: 'node.capabilities_discovered',
  NodeKeyRotated: 'node.key_rotated',
  NodeTrustChanged: 'node.trust_changed',
  NodeAuthFailed: 'node.auth_failed',

  DistributedTaskQueued: 'distributed.task_queued',
  DistributedTaskAssigned: 'distributed.task_assigned',
  DistributedTaskStarted: 'distributed.task_started',
  DistributedTaskCompleted: 'distributed.task_completed',
  DistributedTaskFailed: 'distributed.task_failed',
  DistributedTaskMigrated: 'distributed.task_migrated',
  DistributedTaskDeadLettered: 'distributed.task_dead_lettered',
  ClusterRebalanced: 'cluster.rebalanced',

  MemoryShardWritten: 'memory.shard_written',
  MemoryShardDeleted: 'memory.shard_deleted',
  MemorySyncCompleted: 'memory.sync_completed',
  MemorySyncConflict: 'memory.sync_conflict',
  MemorySyncRecovered: 'memory.sync_recovered',

  FederationGranted: 'federation.granted',
  FederationAccepted: 'federation.accepted',
  FederationRevoked: 'federation.revoked',
  FederationAccessDenied: 'federation.access_denied',
  FederationTaskBorrowed: 'federation.task_borrowed',

  // --- Phase 5: learning and optimization --------------------------
  MissionReviewed: 'learning.mission_reviewed',
  PerformanceSnapshotTaken: 'learning.snapshot_taken',
  RecommendationProposed: 'learning.recommendation_proposed',
  RecommendationAccepted: 'learning.recommendation_accepted',
  RecommendationRejected: 'learning.recommendation_rejected',
  RecommendationApplied: 'learning.recommendation_applied',
  RecommendationRolledBack: 'learning.recommendation_rolled_back',
  PatternDetected: 'learning.pattern_detected',
  PatternReinforced: 'learning.pattern_reinforced',
  PatternDismissed: 'learning.pattern_dismissed',
  WorkerProfileUpdated: 'learning.worker_profile_updated',
  KnowledgeAudited: 'learning.knowledge_audited',
  ExperimentStarted: 'learning.experiment_started',
  ExperimentConcluded: 'learning.experiment_concluded',
  LessonRecorded: 'learning.lesson_recorded',

  // --- Phase 6: evolution ------------------------------------------
  EvolutionCandidateCreated: 'evolution.candidate_created',
  EvolutionCandidateQueued: 'evolution.candidate_queued',
  EvolutionCandidateValidated: 'evolution.candidate_validated',
  EvolutionCandidateRejected: 'evolution.candidate_rejected',
  EvolutionExperimentStarted: 'evolution.experiment_started',
  EvolutionExperimentConcluded: 'evolution.experiment_concluded',
  EvolutionBenchmarkRecorded: 'evolution.benchmark_recorded',
  EvolutionVersionCreated: 'evolution.version_created',
  EvolutionVersionActivated: 'evolution.version_activated',
  EvolutionDeployed: 'evolution.deployed',
  EvolutionDeploymentRefused: 'evolution.deployment_refused',
  EvolutionDeploymentSettled: 'evolution.deployment_settled',
  EvolutionRolledBack: 'evolution.rolled_back',
  EvolutionPolicyUpdated: 'evolution.policy_updated',
  ConstitutionViolated: 'evolution.constitution_violated',
  PlanningStrategyCreated: 'evolution.planning_strategy_created',
  PlanningStrategyActivated: 'evolution.planning_strategy_activated',

  // Phase 7 — platform & extensibility
  ExtensionCapabilitiesGranted: 'extension.capabilities_granted',
  ExtensionCapabilitiesWithheld: 'extension.capabilities_withheld',
  ExtensionInitialized: 'extension.initialized',
  ExtensionUpgradeProposed: 'extension.upgrade_proposed',
  ExtensionUpgraded: 'extension.upgraded',
  ExtensionUpgradeBlocked: 'extension.upgrade_blocked',
  ExtensionRolledBack: 'extension.rolled_back',
  ExtensionQuarantined: 'extension.quarantined',
  ExtensionUninstalled: 'extension.uninstalled',
  ExtensionCallDenied: 'extension.call_denied',
  ContributionRegistered: 'platform.contribution_registered',
  MarketplaceListingPublished: 'marketplace.listing_published',
  MarketplaceVersionPublished: 'marketplace.version_published',
  MarketplaceListingInstalled: 'marketplace.listing_installed',
  MarketplaceListingSuspended: 'marketplace.listing_suspended',
  MarketplaceVersionYanked: 'marketplace.version_yanked',
  PublisherVerified: 'marketplace.publisher_verified',
  SecurityAdvisoryPublished: 'marketplace.advisory_published',
  GovernanceReviewOpened: 'governance.review_opened',
  GovernanceReviewDecided: 'governance.review_decided',
  DeveloperAppCreated: 'developer.app_created',

  // Phase 8 — production operations
  InstanceRegistered: 'ops.instance_registered',
  LeadershipChanged: 'ops.leadership_changed',
  BackupCompleted: 'ops.backup_completed',
  BackupFailed: 'ops.backup_failed',
  BackupVerified: 'ops.backup_verified',
  BackupRestored: 'ops.backup_restored',
  AlertFired: 'ops.alert_fired',
  AlertResolved: 'ops.alert_resolved',
  SecretRotated: 'ops.secret_rotated',
  ReleaseStarted: 'ops.release_started',
  ReleaseSucceeded: 'ops.release_succeeded',
  ReleaseRolledBack: 'ops.release_rolled_back',
  ReadinessReviewed: 'ops.readiness_reviewed',
  SubscriptionChanged: 'billing.subscription_changed',
  InvoiceIssued: 'billing.invoice_issued',
  UsageLimitReached: 'billing.usage_limit_reached',
  MfaEnrolled: 'security.mfa_enrolled',
  MfaDisabled: 'security.mfa_disabled',
  SessionRevoked: 'security.session_revoked',
  AccessDeniedByIp: 'security.access_denied_by_ip',
  ComplianceReportGenerated: 'compliance.report_generated',
} as const;

export type DomainEventName = (typeof DomainEvent)[keyof typeof DomainEvent];

export interface DomainEventEnvelope<T = Record<string, unknown>> {
  /** Event name from the catalogue above. */
  name: DomainEventName | string;
  /** Tenant the event belongs to. */
  organizationId: string;
  /** Event-specific data. Must be JSON-serializable. */
  payload: T;
  /** User who caused it, when there is one. */
  actorId?: string;
  /** Ties related events together across a request or mission run. */
  correlationId?: string;
  occurredAt: Date;
}

export type DomainEventHandler = (
  event: DomainEventEnvelope,
) => void | Promise<void>;
