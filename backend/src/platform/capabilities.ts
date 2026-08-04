import { createHash } from 'node:crypto';
import type { PermissionKey } from '../auth/permissions';
import { Permissions } from '../auth/permissions';

/**
 * The capability catalogue — PRISM-X's answer to "what is this thing allowed
 * to do?"
 *
 * Everything the platform hosts (extensions, third-party workers, contributed
 * tools, public API keys) is described by the same vocabulary. The platform
 * never asks *what kind of component is this*; it asks *which capabilities
 * does it hold*. A worker contributed by an extension and a worker written by
 * the organization are subject to the identical check, because the check reads
 * a capability set rather than a type.
 *
 * Three properties make this worth the indirection:
 *
 *  1. **Capabilities are the only authority.** There is no ambient access and
 *     no wildcard for hosted code. A host method that no capability names is
 *     unreachable — `capabilityForSurface` returns undefined and the sandbox
 *     denies. Adding a host method without adding it to a capability's
 *     `surface` therefore fails closed rather than opening a hole.
 *
 *  2. **Grants intersect, never union.** An extension's effective authority is
 *     what it requested *and* what the installing principal already holds. An
 *     operator who cannot delete workers cannot install an extension that
 *     deletes workers — the capability is withheld at install time, recorded,
 *     and the extension runs with the smaller set. Privilege cannot be
 *     laundered through an install.
 *
 *  3. **Capabilities carry risk, and risk drives review.** The install screen
 *     and the governance queue both read the same numbers, so what a reviewer
 *     approves is exactly what the sandbox enforces.
 *
 * The catalogue is frozen code rather than data for the same reason the
 * Constitution is: a row in a table can be updated by anything holding a
 * connection, and the set of things a stranger's code may do is not something
 * that should be editable at runtime.
 */

export type CapabilityRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

const RISK_ORDER: Record<CapabilityRisk, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** HIGH and above always reaches a human before it is granted. */
export const REVIEW_THRESHOLD: CapabilityRisk = 'HIGH';

/**
 * The identifiers themselves, named so application code refers to a constant
 * rather than repeating a string — the same shape as `Permissions`.
 */
export const Capability = {
  ReadOrganization: 'can_read_organization',
  ReadMissions: 'can_read_missions',
  ReadAnalytics: 'can_read_analytics',
  ReadEvents: 'can_read_events',

  AccessKnowledge: 'can_access_knowledge',
  WriteKnowledge: 'can_write_knowledge',
  PersistState: 'can_persist_state',
  ManageStorage: 'can_manage_storage',

  ExecuteMissions: 'can_execute_missions',
  ManageWorkers: 'can_manage_workers',
  RegisterWorkers: 'can_register_workers',
  RegisterTools: 'can_register_tools',
  RegisterTriggers: 'can_register_triggers',

  SendNotifications: 'can_send_notifications',
  InvokeExternalApis: 'can_invoke_external_apis',
  UseCredentials: 'can_use_credentials',
} as const;

export type CapabilityId = (typeof Capability)[keyof typeof Capability];

export interface CapabilityDefinition {
  /** Stable wire identifier. Appears in manifests and in the audit log. */
  id: CapabilityId;
  title: string;
  /**
   * One sentence, written for the person clicking Install rather than for the
   * developer who requested it. This is the text on the consent screen.
   */
  description: string;
  risk: CapabilityRisk;
  /**
   * The RBAC permissions this capability draws on. A capability is grantable
   * only to a principal holding *every* permission listed here — capabilities
   * are a lens onto existing authority, never a source of new authority.
   */
  implies: readonly PermissionKey[];
  /**
   * SDK host methods this capability unlocks. The sandbox derives its
   * method → capability table from these, so the catalogue is the single
   * description of the guarded surface.
   */
  surface: readonly string[];
}

const DEFINITIONS: CapabilityDefinition[] = [
  // ---------------------------------------------------------------- reading
  {
    id: 'can_read_organization',
    title: 'Read organization profile',
    description: 'See the organization name, plan and settings.',
    risk: 'LOW',
    implies: [Permissions.OrganizationRead],
    surface: ['org.describe'],
  },
  {
    id: 'can_read_missions',
    title: 'Read missions',
    description: 'See missions, their tasks and their outcomes.',
    risk: 'LOW',
    implies: [Permissions.MissionRead],
    surface: ['missions.get', 'missions.list'],
  },
  {
    id: 'can_read_analytics',
    title: 'Read analytics',
    description: 'See aggregate performance and usage figures.',
    risk: 'LOW',
    implies: [Permissions.AnalyticsRead],
    surface: ['analytics.summary'],
  },
  {
    id: 'can_read_events',
    title: 'Observe platform events',
    description:
      'Receive domain events as they happen. Event payloads can contain the ' +
      'names and contents of your work.',
    risk: 'MEDIUM',
    implies: [Permissions.EventRead],
    surface: ['events.subscribe', 'events.recent'],
  },

  // -------------------------------------------------------------- knowledge
  {
    id: 'can_access_knowledge',
    title: 'Read knowledge',
    description:
      'Search and read everything in your knowledge base, including anything ' +
      'workers have remembered.',
    risk: 'MEDIUM',
    implies: [Permissions.KnowledgeRead],
    surface: ['knowledge.search', 'knowledge.get'],
  },
  {
    id: 'can_write_knowledge',
    title: 'Write knowledge',
    description: 'Add and edit knowledge entries.',
    risk: 'MEDIUM',
    implies: [Permissions.KnowledgeCreate, Permissions.KnowledgeUpdate],
    surface: ['knowledge.store', 'knowledge.update'],
  },
  {
    id: 'can_persist_state',
    title: 'Keep private state',
    description:
      'Store its own settings and progress. This storage is private to the ' +
      'extension and readable by nothing else.',
    risk: 'LOW',
    // Deliberately empty: the keyspace is the extension's own, partitioned by
    // the sandbox, so no organization-level permission is being borrowed.
    implies: [],
    surface: ['state.get', 'state.set', 'state.delete', 'state.keys'],
  },
  {
    id: 'can_manage_storage',
    title: 'Read and write files',
    description: 'Read and write files in your organization storage.',
    risk: 'MEDIUM',
    implies: [Permissions.StorageRead, Permissions.StorageWrite],
    surface: ['storage.get', 'storage.put', 'storage.list'],
  },

  // -------------------------------------------------------------- execution
  {
    id: 'can_execute_missions',
    title: 'Run missions',
    description:
      'Create missions and set them running. Missions consume provider credit ' +
      'and can act on your behalf.',
    risk: 'HIGH',
    implies: [
      Permissions.MissionRead,
      Permissions.MissionCreate,
      Permissions.MissionExecute,
    ],
    surface: ['missions.create', 'missions.start', 'missions.plan'],
  },
  {
    id: 'can_manage_workers',
    title: 'Manage workers',
    description:
      'Create, reconfigure and delete workers — including changing which ' +
      'tools an existing worker may use.',
    risk: 'HIGH',
    implies: [
      Permissions.WorkerRead,
      Permissions.WorkerCreate,
      Permissions.WorkerUpdate,
      Permissions.WorkerDelete,
    ],
    surface: ['workers.create', 'workers.update', 'workers.delete', 'workers.list'],
  },
  {
    id: 'can_register_workers',
    title: 'Contribute worker types',
    description:
      'Install new kinds of worker that you can then run. Contributed workers ' +
      'execute under this extension’s capabilities, never more.',
    risk: 'HIGH',
    implies: [Permissions.WorkerRead, Permissions.WorkerCreate],
    surface: ['workers.register', 'workers.unregister'],
  },
  {
    id: 'can_register_tools',
    title: 'Contribute tools',
    description:
      'Add tools that your workers can call during a mission. A tool runs ' +
      'inside worker execution and sees whatever the worker passes it.',
    risk: 'CRITICAL',
    implies: [Permissions.ExtensionInstall, Permissions.WorkerUpdate],
    surface: ['tools.register', 'tools.unregister'],
  },
  {
    id: 'can_register_triggers',
    title: 'Register triggers',
    description:
      'Start work automatically — on a schedule, on an event, or when an ' +
      'external system calls in.',
    risk: 'HIGH',
    implies: [Permissions.IntegrationRead, Permissions.IntegrationCreate],
    surface: ['triggers.register', 'triggers.unregister', 'triggers.list'],
  },

  // ------------------------------------------------------------- outbound
  {
    id: 'can_send_notifications',
    title: 'Send notifications',
    description: 'Send you notifications through your configured channels.',
    risk: 'MEDIUM',
    implies: [Permissions.IntegrationRead],
    surface: ['notify.send'],
  },
  {
    id: 'can_invoke_external_apis',
    title: 'Call external services',
    description:
      'Make network requests to services outside PRISM-X. Anything it can ' +
      'read, it can send.',
    risk: 'HIGH',
    implies: [Permissions.IntegrationRead],
    surface: ['http.fetch'],
  },
  {
    id: 'can_use_credentials',
    title: 'Use stored credentials',
    description:
      'Authenticate outbound calls with credentials you have already stored. ' +
      'The credential value itself is never handed to the extension.',
    risk: 'CRITICAL',
    implies: [Permissions.IntegrationRead, Permissions.ProviderRead],
    surface: ['http.fetchAs', 'credentials.list'],
  },
];

export const CAPABILITIES: readonly CapabilityDefinition[] = Object.freeze(
  DEFINITIONS.map((definition) =>
    Object.freeze({
      ...definition,
      implies: Object.freeze([...definition.implies]),
      surface: Object.freeze([...definition.surface]),
    }),
  ),
);

export const CAPABILITY_IDS: readonly CapabilityId[] = Object.freeze(
  CAPABILITIES.map((capability) => capability.id),
);

/**
 * A fingerprint of the catalogue's security-relevant shape: identifiers, risk
 * levels, implied permissions and guarded surface. Stamped onto every grant so
 * that a grant issued under an older catalogue is recognisable as such.
 */
export const CAPABILITY_CATALOGUE_VERSION: string = createHash('sha256')
  .update(
    CAPABILITIES.map(
      (c) => `${c.id}:${c.risk}:${[...c.implies].sort().join(',')}:${[...c.surface].sort().join(',')}`,
    ).join('|'),
  )
  .digest('hex')
  .slice(0, 16);

const BY_ID = new Map<string, CapabilityDefinition>(
  CAPABILITIES.map((capability) => [capability.id, capability]),
);

const BY_SURFACE = new Map<string, CapabilityDefinition>();
for (const capability of CAPABILITIES) {
  for (const method of capability.surface) {
    const existing = BY_SURFACE.get(method);
    if (existing) {
      // Two capabilities guarding one method would make the weaker one a
      // bypass of the stronger. Fail at load rather than at runtime.
      throw new Error(
        `Host method "${method}" is claimed by both "${existing.id}" and "${capability.id}"`,
      );
    }
    BY_SURFACE.set(method, capability);
  }
}

export function isCapability(value: unknown): value is CapabilityId {
  return typeof value === 'string' && BY_ID.has(value);
}

export function describe(id: string): CapabilityDefinition | undefined {
  return BY_ID.get(id);
}

/** The capability guarding a host method, or undefined if the method is unguarded. */
export function capabilityForSurface(method: string): CapabilityDefinition | undefined {
  return BY_SURFACE.get(method);
}

/** Every guarded host method, for the SDK reference and the portal. */
export function guardedSurface(): string[] {
  return [...BY_SURFACE.keys()].sort();
}

/** The union of permissions a capability set draws on, deduplicated. */
export function permissionsFor(ids: readonly string[]): PermissionKey[] {
  const permissions = new Set<PermissionKey>();
  for (const id of ids) {
    for (const permission of BY_ID.get(id)?.implies ?? []) permissions.add(permission);
  }
  return [...permissions].sort();
}

export function highestRisk(ids: readonly string[]): CapabilityRisk {
  let highest: CapabilityRisk = 'LOW';
  for (const id of ids) {
    const risk = BY_ID.get(id)?.risk;
    if (risk && RISK_ORDER[risk] > RISK_ORDER[highest]) highest = risk;
  }
  return highest;
}

export function atLeast(risk: CapabilityRisk, floor: CapabilityRisk): boolean {
  return RISK_ORDER[risk] >= RISK_ORDER[floor];
}

/** True when any requested capability is HIGH or above. */
export function requiresHumanReview(ids: readonly string[]): boolean {
  return ids.some((id) => {
    const risk = BY_ID.get(id)?.risk;
    return risk !== undefined && atLeast(risk, REVIEW_THRESHOLD);
  });
}

export interface WithheldCapability {
  capability: string;
  /** Permissions the installing principal was missing. */
  missing: PermissionKey[];
}

export interface CapabilityGrant {
  /** What the component may actually do. Never larger than `requested`. */
  granted: CapabilityId[];
  /** Requested but refused, with the reason expressed as missing permissions. */
  withheld: WithheldCapability[];
  /** Requested identifiers that are not in the catalogue at all. */
  unknown: string[];
  risk: CapabilityRisk;
  reviewRequired: boolean;
  catalogueVersion: string;
}

/**
 * The intersection rule.
 *
 * `granted = requested ∩ what the installing principal can already do`.
 *
 * A grant is never a union and never an escalation. Installing something is
 * lending it a subset of your own authority; you cannot lend what you do not
 * have. The withheld set is returned rather than thrown so the caller can
 * install the component in its reduced form and show the operator precisely
 * what was dropped — a partial install with an honest account of the gap is
 * more useful than a refusal with none.
 */
export function grant(input: {
  requested: readonly string[];
  holderPermissions: readonly string[];
}): CapabilityGrant {
  const unrestricted = input.holderPermissions.includes('*');
  const held = new Set(input.holderPermissions);

  const granted = new Set<string>();
  const withheld: WithheldCapability[] = [];
  const unknown: string[] = [];

  // Deduplicated, and the result is re-ordered by catalogue position below, so
  // two grants of the same set serialise identically and are comparable in the
  // audit log regardless of the order the manifest listed them in.
  for (const id of new Set(input.requested)) {
    const definition = BY_ID.get(id);
    if (!definition) {
      unknown.push(id);
      continue;
    }
    const missing = unrestricted
      ? []
      : definition.implies.filter((permission) => !held.has(permission));

    if (missing.length) withheld.push({ capability: id, missing });
    else granted.add(definition.id);
  }

  const ordered = CAPABILITY_IDS.filter((id) => granted.has(id));

  return {
    granted: ordered,
    withheld: withheld.sort((a, b) => a.capability.localeCompare(b.capability)),
    unknown: unknown.sort(),
    risk: highestRisk(ordered),
    reviewRequired: requiresHumanReview(ordered),
    catalogueVersion: CAPABILITY_CATALOGUE_VERSION,
  };
}

/**
 * Checks a host call against a grant. Returns null when permitted, or a
 * sentence naming what is missing — phrased for a developer reading their own
 * extension's logs, since that is who acts on it.
 */
export function authorize(
  granted: readonly string[],
  method: string,
): string | null {
  const capability = BY_SURFACE.get(method);
  if (!capability) {
    return `"${method}" is not part of the extension API`;
  }
  if (!granted.includes(capability.id)) {
    return `"${method}" requires the "${capability.id}" capability, which this extension was not granted`;
  }
  return null;
}

/**
 * Narrows a grant to a subset. Anything not already held is dropped rather
 * than added, so attenuation can only ever reduce authority — this is what
 * lets a contributed worker run under a slice of its extension's grant.
 */
export function attenuate(
  granted: readonly string[],
  subset: readonly string[],
): CapabilityId[] {
  const held = new Set<string>(granted);
  const wanted = new Set<string>(subset);
  return CAPABILITY_IDS.filter((id) => held.has(id) && wanted.has(id));
}

/** Catalogue rendered for the consent screen and the developer portal. */
export function catalogue(): Array<
  CapabilityDefinition & { reviewRequired: boolean }
> {
  return CAPABILITIES.map((capability) => ({
    ...capability,
    reviewRequired: atLeast(capability.risk, REVIEW_THRESHOLD),
  }));
}
