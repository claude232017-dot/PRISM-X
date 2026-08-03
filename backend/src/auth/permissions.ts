/**
 * The permission catalogue — `resource:action` pairs checked by
 * PermissionsGuard and seeded into the `permissions` table.
 *
 * Roles are bundles of these. Adding a permission means adding it here, to
 * the seed, and to whichever role bundles should carry it.
 */
export const Permissions = {
  // Organization
  OrganizationRead: 'organization:read',
  OrganizationUpdate: 'organization:update',
  OrganizationDelete: 'organization:delete',

  // Members
  MemberRead: 'member:read',
  MemberInvite: 'member:invite',
  MemberUpdate: 'member:update',
  MemberRemove: 'member:remove',

  // Workers
  WorkerRead: 'worker:read',
  WorkerCreate: 'worker:create',
  WorkerUpdate: 'worker:update',
  WorkerDelete: 'worker:delete',

  // Missions
  MissionRead: 'mission:read',
  MissionCreate: 'mission:create',
  MissionUpdate: 'mission:update',
  MissionDelete: 'mission:delete',
  MissionExecute: 'mission:execute',

  // Knowledge
  KnowledgeRead: 'knowledge:read',
  KnowledgeCreate: 'knowledge:create',
  KnowledgeUpdate: 'knowledge:update',
  KnowledgeDelete: 'knowledge:delete',

  // Providers
  ProviderRead: 'provider:read',
  ProviderCreate: 'provider:create',
  ProviderUpdate: 'provider:update',
  ProviderDelete: 'provider:delete',

  // Integrations
  IntegrationRead: 'integration:read',
  IntegrationCreate: 'integration:create',
  IntegrationUpdate: 'integration:update',
  IntegrationDelete: 'integration:delete',

  // Extensions
  ExtensionRead: 'extension:read',
  ExtensionInstall: 'extension:install',
  ExtensionUpdate: 'extension:update',
  ExtensionDelete: 'extension:delete',

  // Observability
  EventRead: 'event:read',
  AuditRead: 'audit:read',
  AnalyticsRead: 'analytics:read',

  // Storage
  StorageRead: 'storage:read',
  StorageWrite: 'storage:write',
  StorageDelete: 'storage:delete',

  // Infrastructure — the fleet of machines PRISM-X executes on
  NodeRead: 'node:read',
  NodeRegister: 'node:register',
  NodeUpdate: 'node:update',
  NodeDelete: 'node:delete',
  /** Placing, migrating and cancelling work across nodes. */
  NodeExecute: 'node:execute',

  // Federation — lending resources to another organization is its own
  // permission, never implied by node administration, because the blast
  // radius is a different organization's data rather than this one's uptime.
  FederationRead: 'federation:read',
  FederationGrant: 'federation:grant',
  FederationRevoke: 'federation:revoke',

  // Learning — split four ways because reading what the system concluded,
  // deciding whether it is right, and letting it touch production are
  // genuinely different levels of trust.
  LearningRead: 'learning:read',
  /** Trigger analysis: rollups, audits, profiling, pattern detection. */
  LearningRun: 'learning:run',
  /** Accept or reject a proposal, dismiss a pattern, resolve a finding. */
  LearningApprove: 'learning:approve',
  /** Write an approved change to production, or roll one back. */
  LearningApply: 'learning:apply',

  // Evolution — the system changing itself. Separated from learning because
  // concluding something and acting on it are different acts, and the second
  // one is the one that can break production.
  EvolutionRead: 'evolution:read',
  /** Create candidates, start experiments, run benchmarks. */
  EvolutionRun: 'evolution:run',
  /** Approve a validated candidate for deployment. */
  EvolutionApprove: 'evolution:approve',
  /** Deploy to production, and roll back. */
  EvolutionDeploy: 'evolution:deploy',
  /** Amend the organization's evolution policy. */
  EvolutionPolicyManage: 'evolution:policy',
} as const;

export type PermissionKey = (typeof Permissions)[keyof typeof Permissions];

export const ALL_PERMISSIONS = Object.values(Permissions) as PermissionKey[];

export const SystemRole = {
  Owner: 'OWNER',
  Admin: 'ADMIN',
  Operator: 'OPERATOR',
  Viewer: 'VIEWER',
} as const;

export type SystemRoleKey = (typeof SystemRole)[keyof typeof SystemRole];

const readOnly = ALL_PERMISSIONS.filter((p) => p.endsWith(':read'));

/**
 * Role → permission bundles.
 *
 *  OWNER    — everything, including deleting the organization.
 *  ADMIN    — everything except destroying the org itself.
 *  OPERATOR — runs the system day to day: full CRUD on workers/missions/
 *             knowledge, but cannot manage members, providers or billing.
 *  VIEWER   — read-only across the board.
 */
export const ROLE_PERMISSIONS: Record<SystemRoleKey, PermissionKey[]> = {
  [SystemRole.Owner]: ALL_PERMISSIONS,

  [SystemRole.Admin]: ALL_PERMISSIONS.filter(
    (p) => p !== Permissions.OrganizationDelete,
  ),

  [SystemRole.Operator]: [
    Permissions.OrganizationRead,
    Permissions.MemberRead,
    Permissions.WorkerRead,
    Permissions.WorkerCreate,
    Permissions.WorkerUpdate,
    Permissions.WorkerDelete,
    Permissions.MissionRead,
    Permissions.MissionCreate,
    Permissions.MissionUpdate,
    Permissions.MissionDelete,
    Permissions.MissionExecute,
    Permissions.KnowledgeRead,
    Permissions.KnowledgeCreate,
    Permissions.KnowledgeUpdate,
    Permissions.KnowledgeDelete,
    Permissions.ProviderRead,
    Permissions.IntegrationRead,
    Permissions.ExtensionRead,
    Permissions.EventRead,
    Permissions.AnalyticsRead,
    Permissions.StorageRead,
    Permissions.StorageWrite,
    // An operator may see the fleet and run work on it, but registering or
    // decommissioning machines — and lending them to another organization —
    // stays with administrators.
    Permissions.NodeRead,
    Permissions.NodeExecute,
    Permissions.FederationRead,
    // An operator may read what the system has concluded and re-run the
    // analysis, but deciding whether a conclusion is right — and letting it
    // reach production — stays with an administrator.
    Permissions.LearningRead,
    Permissions.LearningRun,
    // An operator may watch the system evolve and run experiments, which
    // touch nothing. Approving and deploying stay with administrators.
    Permissions.EvolutionRead,
    Permissions.EvolutionRun,
  ],

  [SystemRole.Viewer]: readOnly,
};

export const ROLE_DESCRIPTIONS: Record<SystemRoleKey, string> = {
  [SystemRole.Owner]: 'Full control, including deleting the organization.',
  [SystemRole.Admin]: 'Full control over resources and members.',
  [SystemRole.Operator]: 'Runs workers, missions and knowledge day to day.',
  [SystemRole.Viewer]: 'Read-only access to every resource.',
};
