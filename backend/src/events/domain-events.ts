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
