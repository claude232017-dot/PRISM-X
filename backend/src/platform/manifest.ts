import { createHash } from 'node:crypto';
import {
  CapabilityRisk,
  atLeast,
  describe as describeCapability,
  highestRisk,
  isCapability,
} from './capabilities';
import * as semver from './semver';

/**
 * The extension manifest: everything the platform needs to decide whether to
 * host a piece of third-party code, expressed as data rather than as running
 * code.
 *
 * The manifest is read *before* anything is executed. Every gate in Phase 7 —
 * the consent screen, the capability grant, the governance review, the
 * compatibility check, the breaking-change detector — reads this structure and
 * nothing else, which is what makes "breaking changes must be detected before
 * installation" achievable: detection is a comparison of two manifests, not an
 * observation of two running versions.
 */

/** The version of the SDK contract the platform currently implements. */
export const PLATFORM_API_VERSION = '1.0.0';

// ------------------------------------------------------------------- limits

export interface SandboxLimits {
  /** Wall-clock ceiling for a single host invocation or hook run. */
  timeoutMs: number;
  /** Host calls per minute, across the whole surface. */
  callsPerMinute: number;
  /** Outbound HTTP requests per minute. */
  httpRequestsPerMinute: number;
  /** Bytes the extension may keep in its private keyspace. */
  storageBytes: number;
  /** Rows the extension may hold in its private keyspace. */
  storageKeys: number;
}

/**
 * The ceiling. A manifest may request less than this and get it; a manifest
 * requesting more is clamped rather than rejected, because a greedy default in
 * someone else's code should cost them throughput, not cost the operator an
 * install they wanted.
 */
export const PLATFORM_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  timeoutMs: 30_000,
  callsPerMinute: 600,
  httpRequestsPerMinute: 120,
  storageBytes: 5_000_000,
  storageKeys: 5_000,
});

export const DEFAULT_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  timeoutMs: 10_000,
  callsPerMinute: 120,
  httpRequestsPerMinute: 30,
  storageBytes: 1_000_000,
  storageKeys: 1_000,
});

export function resolveLimits(requested?: Partial<SandboxLimits> | null): SandboxLimits {
  const merged = { ...DEFAULT_LIMITS, ...(requested ?? {}) };
  const clamp = (value: unknown, fallback: number, ceiling: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(1, Math.min(n, ceiling));
  };
  return {
    timeoutMs: clamp(merged.timeoutMs, DEFAULT_LIMITS.timeoutMs, PLATFORM_LIMITS.timeoutMs),
    callsPerMinute: clamp(
      merged.callsPerMinute,
      DEFAULT_LIMITS.callsPerMinute,
      PLATFORM_LIMITS.callsPerMinute,
    ),
    httpRequestsPerMinute: clamp(
      merged.httpRequestsPerMinute,
      DEFAULT_LIMITS.httpRequestsPerMinute,
      PLATFORM_LIMITS.httpRequestsPerMinute,
    ),
    storageBytes: clamp(
      merged.storageBytes,
      DEFAULT_LIMITS.storageBytes,
      PLATFORM_LIMITS.storageBytes,
    ),
    storageKeys: clamp(
      merged.storageKeys,
      DEFAULT_LIMITS.storageKeys,
      PLATFORM_LIMITS.storageKeys,
    ),
  };
}

// ----------------------------------------------------------------- manifest

export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'secret' | 'enum';

export interface ConfigField {
  type: ConfigFieldType;
  label?: string;
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  /** Allowed values when `type` is `enum`. */
  options?: string[];
}

export interface WorkerContribution {
  key: string;
  name: string;
  description?: string;
  /** Prompt the contributed worker runs under. */
  systemPrompt?: string;
  /** Tool keys this worker type expects to be able to call. */
  tools?: string[];
  /** Subset of the extension's grant this worker runs under. */
  capabilities?: string[];
}

export interface ToolContribution {
  key: string;
  name: string;
  description: string;
  /** JSON-schema-ish input description, shown to the model. */
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  /** True when the tool changes state. */
  mutates?: boolean;
  /** Capability the caller must hold for this tool to run. */
  capability?: string;
  rateLimitPerMinute?: number;
}

export interface TriggerContribution {
  key: string;
  name: string;
  description?: string;
  /** `EVENT`, `SCHEDULE` or `WEBHOOK`, matching the trigger engine. */
  kind?: string;
}

export interface MigrationStep {
  /** Version this step migrates *to*. */
  to: string;
  description: string;
  /** Named handler the extension exports; absent means data-only. */
  handler?: string;
}

export interface ExtensionManifest {
  slug: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  publisher?: string;
  license?: string;
  homepage?: string;
  /** Capabilities the extension asks for. The consent screen renders these. */
  capabilities: string[];
  /** Domain events the extension reacts to. */
  subscribes?: string[];
  /** Other extensions by slug → semver range. */
  dependencies?: Record<string, string>;
  /** Platform API versions this extension supports, as a semver range. */
  engine?: string;
  config?: Record<string, ConfigField>;
  contributes?: {
    workers?: WorkerContribution[];
    tools?: ToolContribution[];
    triggers?: TriggerContribution[];
  };
  limits?: Partial<SandboxLimits>;
  migrations?: MigrationStep[];
}

// --------------------------------------------------------------- validation

export interface ManifestIssue {
  field: string;
  message: string;
}

export interface ManifestValidation {
  ok: boolean;
  errors: ManifestIssue[];
  warnings: ManifestIssue[];
  /** Normalised manifest, present only when `ok`. */
  manifest?: ExtensionManifest;
  risk: CapabilityRisk;
  /** Stable hash of the security-relevant fields, for signing and diffing. */
  digest: string;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEY = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Validates a manifest without throwing. Errors block an install; warnings are
 * shown to the developer and to the reviewer but do not stop anything.
 */
export function validate(input: unknown): ManifestValidation {
  const errors: ManifestIssue[] = [];
  const warnings: ManifestIssue[] = [];
  const raw = asRecord(input);

  if (!raw) {
    return {
      ok: false,
      errors: [{ field: 'manifest', message: 'Manifest must be an object' }],
      warnings,
      risk: 'LOW',
      digest: '',
    };
  }

  const fail = (field: string, message: string) => errors.push({ field, message });
  const warn = (field: string, message: string) => warnings.push({ field, message });

  // --- identity
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
  if (!SLUG.test(slug)) {
    fail('slug', 'slug must be lower-case words separated by single hyphens');
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 2 || name.length > 120) {
    fail('name', 'name must be between 2 and 120 characters');
  }

  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!semver.isValid(version)) {
    fail('version', `"${version}" is not a valid semantic version`);
  }

  // --- engine compatibility
  const engine = typeof raw.engine === 'string' ? raw.engine.trim() : undefined;
  if (engine !== undefined) {
    if (!semver.isValidRange(engine)) {
      fail('engine', `"${engine}" is not a valid version range`);
    } else if (!semver.satisfies(PLATFORM_API_VERSION, engine)) {
      fail(
        'engine',
        `requires platform API ${engine}, but this platform is ${PLATFORM_API_VERSION}`,
      );
    }
  } else {
    warn('engine', 'No engine range declared; the extension will be pinned to the current major');
  }

  // --- capabilities
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((c): c is string => typeof c === 'string')
    : [];
  if (!Array.isArray(raw.capabilities)) {
    fail('capabilities', 'capabilities must be an array (use [] for none)');
  }
  const unknownCapabilities = capabilities.filter((c) => !isCapability(c));
  for (const unknown of unknownCapabilities) {
    fail('capabilities', `"${unknown}" is not a capability this platform grants`);
  }
  const known = capabilities.filter(isCapability);
  if (new Set(capabilities).size !== capabilities.length) {
    warn('capabilities', 'Duplicate capabilities were requested and have been collapsed');
  }

  // --- dependencies
  const dependencies = asRecord(raw.dependencies) ?? {};
  if (raw.dependencies !== undefined && !asRecord(raw.dependencies)) {
    fail('dependencies', 'dependencies must be an object of slug → range');
  }
  for (const [dependency, range] of Object.entries(dependencies)) {
    if (!SLUG.test(dependency)) {
      fail(`dependencies.${dependency}`, 'dependency name must be a valid slug');
    }
    if (typeof range !== 'string' || !semver.isValidRange(range)) {
      fail(`dependencies.${dependency}`, `"${String(range)}" is not a valid version range`);
    }
    if (dependency === slug) {
      fail(`dependencies.${dependency}`, 'an extension cannot depend on itself');
    }
  }

  // --- config
  const config = asRecord(raw.config) ?? {};
  if (raw.config !== undefined && !asRecord(raw.config)) {
    fail('config', 'config must be an object of field name → definition');
  }
  for (const [field, definition] of Object.entries(config)) {
    const shape = asRecord(definition);
    if (!shape) {
      fail(`config.${field}`, 'field definition must be an object');
      continue;
    }
    const type = shape.type;
    if (
      typeof type !== 'string' ||
      !['string', 'number', 'boolean', 'secret', 'enum'].includes(type)
    ) {
      fail(`config.${field}`, `type must be one of string, number, boolean, secret, enum`);
    }
    if (type === 'enum' && (!Array.isArray(shape.options) || !shape.options.length)) {
      fail(`config.${field}`, 'enum fields must list their options');
    }
    if (type === 'secret' && shape.default !== undefined) {
      fail(`config.${field}`, 'secret fields must not carry a default value');
    }
  }

  // --- contributions
  const contributes = asRecord(raw.contributes) ?? {};
  const contributionKeys = new Set<string>();
  const readContributions = (
    section: 'workers' | 'tools' | 'triggers',
    requireDescription: boolean,
  ): Record<string, unknown>[] => {
    const value = contributes[section];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      fail(`contributes.${section}`, `${section} must be an array`);
      return [];
    }
    const rows: Record<string, unknown>[] = [];
    for (const [index, entry] of value.entries()) {
      const shape = asRecord(entry);
      if (!shape) {
        fail(`contributes.${section}[${index}]`, 'contribution must be an object');
        continue;
      }
      const key = typeof shape.key === 'string' ? shape.key : '';
      if (!KEY.test(key)) {
        fail(`contributes.${section}[${index}].key`, 'key must be lower-case alphanumeric');
      }
      const qualified = `${section}:${key}`;
      if (contributionKeys.has(qualified)) {
        fail(`contributes.${section}[${index}].key`, `duplicate contribution key "${key}"`);
      }
      contributionKeys.add(qualified);
      if (typeof shape.name !== 'string' || !shape.name.trim()) {
        fail(`contributes.${section}[${index}].name`, 'name is required');
      }
      if (requireDescription && (typeof shape.description !== 'string' || !shape.description.trim())) {
        fail(
          `contributes.${section}[${index}].description`,
          'description is required — it is what the model reads to decide when to call this',
        );
      }
      rows.push(shape);
    }
    return rows;
  };

  const workers = readContributions('workers', false);
  const tools = readContributions('tools', true);
  readContributions('triggers', false);

  // A contribution can never widen the extension's own grant: a worker running
  // under a capability the extension was refused would be an escalation
  // laundered through a contribution.
  const requested = new Set(known);
  for (const [index, worker] of workers.entries()) {
    const wanted = Array.isArray(worker.capabilities) ? worker.capabilities : [];
    for (const capability of wanted) {
      if (typeof capability !== 'string' || !isCapability(capability)) {
        fail(`contributes.workers[${index}].capabilities`, `"${String(capability)}" is not a capability`);
      } else if (!requested.has(capability)) {
        fail(
          `contributes.workers[${index}].capabilities`,
          `"${capability}" is not requested by the extension, so a contributed worker cannot hold it`,
        );
      }
    }
  }
  for (const [index, tool] of tools.entries()) {
    const capability = tool.capability;
    if (capability === undefined) continue;
    if (typeof capability !== 'string' || !isCapability(capability)) {
      fail(`contributes.tools[${index}].capability`, `"${String(capability)}" is not a capability`);
    } else if (!requested.has(capability)) {
      fail(
        `contributes.tools[${index}].capability`,
        `"${capability}" is not requested by the extension, so its tool cannot require it`,
      );
    }
  }

  // --- migrations
  const migrations = Array.isArray(raw.migrations) ? raw.migrations : [];
  if (raw.migrations !== undefined && !Array.isArray(raw.migrations)) {
    fail('migrations', 'migrations must be an array');
  }
  for (const [index, entry] of migrations.entries()) {
    const shape = asRecord(entry);
    if (!shape) {
      fail(`migrations[${index}]`, 'migration must be an object');
      continue;
    }
    if (typeof shape.to !== 'string' || !semver.isValid(shape.to)) {
      fail(`migrations[${index}].to`, 'to must be a semantic version');
    } else if (version && semver.isValid(version) && semver.gt(shape.to, version)) {
      fail(
        `migrations[${index}].to`,
        `migrates to ${shape.to}, which is ahead of this release (${version})`,
      );
    }
    if (typeof shape.description !== 'string' || !shape.description.trim()) {
      fail(`migrations[${index}].description`, 'description is required');
    }
  }

  // --- advisory checks
  const subscribes = Array.isArray(raw.subscribes)
    ? raw.subscribes.filter((s): s is string => typeof s === 'string')
    : [];
  if (subscribes.length && !known.includes('can_read_events')) {
    warn(
      'subscribes',
      'Events are subscribed to but "can_read_events" was not requested; delivery will be denied',
    );
  }
  if (tools.length && !known.includes('can_register_tools')) {
    warn(
      'contributes.tools',
      'Tools are contributed but "can_register_tools" was not requested; they will not be registered',
    );
  }
  if (workers.length && !known.includes('can_register_workers')) {
    warn(
      'contributes.workers',
      'Workers are contributed but "can_register_workers" was not requested; they will not be registered',
    );
  }
  for (const capability of known) {
    const definition = describeCapability(capability);
    if (definition && atLeast(definition.risk, 'CRITICAL')) {
      warn('capabilities', `"${capability}" is a critical capability and will require review`);
    }
  }

  const risk = highestRisk(known);
  if (errors.length) {
    return { ok: false, errors, warnings, risk, digest: '' };
  }

  const manifest: ExtensionManifest = {
    slug,
    name,
    version,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    author: typeof raw.author === 'string' ? raw.author : undefined,
    publisher: typeof raw.publisher === 'string' ? raw.publisher : undefined,
    license: typeof raw.license === 'string' ? raw.license : undefined,
    homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined,
    capabilities: [...new Set(known)],
    subscribes,
    dependencies: dependencies as Record<string, string>,
    engine,
    config: config as Record<string, ConfigField>,
    contributes: {
      workers: (contributes.workers as WorkerContribution[]) ?? [],
      tools: (contributes.tools as ToolContribution[]) ?? [],
      triggers: (contributes.triggers as TriggerContribution[]) ?? [],
    },
    limits: resolveLimits(asRecord(raw.limits) as Partial<SandboxLimits> | null),
    migrations: migrations as MigrationStep[],
  };

  return { ok: true, errors, warnings, manifest, risk, digest: digestOf(manifest) };
}

/**
 * Deterministic JSON: object keys sorted, recursively.
 *
 * `JSON.stringify` follows insertion order, and a manifest that has been
 * through Postgres `jsonb` comes back with its keys reordered — jsonb stores a
 * normalised form rather than the original text. Hashing raw `stringify`
 * output therefore produces one digest at publish time and a different one
 * when the same manifest is read back, which would make every signature fail
 * to verify and every compatibility check report tampering. Sorting first is
 * what makes the digest a property of the content rather than of the path the
 * content took to get here.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * A hash over the fields that determine what the extension may do. Two
 * manifests with the same digest are interchangeable from a security point of
 * view, which is what a signature actually needs to attest.
 */
export function digestOf(manifest: ExtensionManifest): string {
  const material = {
    slug: manifest.slug,
    version: manifest.version,
    capabilities: [...manifest.capabilities].sort(),
    dependencies: Object.entries(manifest.dependencies ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    engine: manifest.engine ?? '',
    contributes: {
      workers: (manifest.contributes?.workers ?? []).map((w) => w.key).sort(),
      tools: (manifest.contributes?.tools ?? []).map((t) => t.key).sort(),
      triggers: (manifest.contributes?.triggers ?? []).map((t) => t.key).sort(),
    },
    limits: manifest.limits ?? {},
  };
  return createHash('sha256').update(canonical(material)).digest('hex');
}

// ------------------------------------------------------- change detection

export type ChangeSeverity = 'BLOCKING' | 'BREAKING' | 'NOTICE';

export interface ManifestChange {
  severity: ChangeSeverity;
  code: string;
  message: string;
}

export interface UpgradeAnalysis {
  from: string;
  to: string;
  release: semver.ReleaseKind;
  changes: ManifestChange[];
  /** Nothing may proceed while true. */
  blocked: boolean;
  /** Proceeds only with fresh consent. */
  breaking: boolean;
  /** Capabilities the new version wants that the old one did not. */
  addedCapabilities: string[];
  removedCapabilities: string[];
  /** Migration steps between the two versions, in order. */
  migrations: MigrationStep[];
}

/**
 * Compares an installed manifest with a candidate one and reports what would
 * change — before anything is written.
 *
 * The distinction that matters is between BLOCKING and BREAKING. Blocking
 * means the upgrade is impossible or incoherent and must not proceed at all.
 * Breaking means the upgrade is possible but changes the deal the operator
 * agreed to, so it needs their consent again rather than a silent apply. Only
 * the second is negotiable, and keeping them apart is what stops "detect
 * breaking changes" from collapsing into "refuse to ever upgrade".
 */
export function analyseUpgrade(
  current: ExtensionManifest,
  candidate: ExtensionManifest,
): UpgradeAnalysis {
  const changes: ManifestChange[] = [];
  const add = (severity: ChangeSeverity, code: string, message: string) =>
    changes.push({ severity, code, message });

  if (current.slug !== candidate.slug) {
    add(
      'BLOCKING',
      'slug_mismatch',
      `Candidate is "${candidate.slug}" but "${current.slug}" is installed`,
    );
  }

  const bothValid = semver.isValid(current.version) && semver.isValid(candidate.version);
  const release: semver.ReleaseKind = bothValid
    ? semver.classify(current.version, candidate.version)
    : 'NONE';

  if (!bothValid) {
    add('BLOCKING', 'invalid_version', 'One of the versions is not a valid semantic version');
  } else if (semver.lt(candidate.version, current.version)) {
    add(
      'BLOCKING',
      'downgrade',
      `${candidate.version} is older than the installed ${current.version}; use rollback rather than upgrade`,
    );
  } else if (semver.eq(candidate.version, current.version)) {
    add('BLOCKING', 'same_version', `${candidate.version} is already installed`);
  }

  if (candidate.engine && !semver.satisfies(PLATFORM_API_VERSION, candidate.engine)) {
    add(
      'BLOCKING',
      'engine_incompatible',
      `Requires platform API ${candidate.engine}; this platform is ${PLATFORM_API_VERSION}`,
    );
  }

  // --- capabilities
  const before = new Set(current.capabilities);
  const after = new Set(candidate.capabilities);
  const addedCapabilities = [...after].filter((c) => !before.has(c)).sort();
  const removedCapabilities = [...before].filter((c) => !after.has(c)).sort();

  for (const capability of addedCapabilities) {
    const definition = describeCapability(capability);
    add(
      'BREAKING',
      'capability_added',
      `Now asks for "${capability}"${definition ? ` — ${definition.description}` : ''}`,
    );
  }
  for (const capability of removedCapabilities) {
    add('NOTICE', 'capability_removed', `No longer asks for "${capability}"`);
  }

  // --- contributions removed out from under whatever references them
  const keysOf = (manifest: ExtensionManifest, section: 'workers' | 'tools' | 'triggers') =>
    new Set((manifest.contributes?.[section] ?? []).map((entry) => entry.key));

  for (const section of ['workers', 'tools', 'triggers'] as const) {
    const currentKeys = keysOf(current, section);
    const candidateKeys = keysOf(candidate, section);
    for (const key of currentKeys) {
      if (!candidateKeys.has(key)) {
        add(
          'BREAKING',
          'contribution_removed',
          `Removes the ${section.slice(0, -1)} "${key}"; anything configured to use it will stop working`,
        );
      }
    }
    for (const key of candidateKeys) {
      if (!currentKeys.has(key)) {
        add('NOTICE', 'contribution_added', `Adds the ${section.slice(0, -1)} "${key}"`);
      }
    }
  }

  // --- config
  const currentConfig = current.config ?? {};
  const candidateConfig = candidate.config ?? {};
  for (const [field, definition] of Object.entries(candidateConfig)) {
    const existing = currentConfig[field];
    if (!existing) {
      if (definition.required && definition.default === undefined) {
        add(
          'BREAKING',
          'config_required_added',
          `Adds a required setting "${field}" with no default; it must be supplied before the upgrade completes`,
        );
      } else {
        add('NOTICE', 'config_added', `Adds the optional setting "${field}"`);
      }
    } else if (existing.type !== definition.type) {
      add(
        'BREAKING',
        'config_type_changed',
        `Setting "${field}" changes from ${existing.type} to ${definition.type}; the stored value will not carry over`,
      );
    } else if (!existing.required && definition.required) {
      add('BREAKING', 'config_now_required', `Setting "${field}" is now required`);
    }
  }
  for (const field of Object.keys(currentConfig)) {
    if (!candidateConfig[field]) {
      add('NOTICE', 'config_removed', `Drops the setting "${field}"; its stored value will be discarded`);
    }
  }

  // --- dependencies
  const currentDeps = current.dependencies ?? {};
  const candidateDeps = candidate.dependencies ?? {};
  for (const [dependency, range] of Object.entries(candidateDeps)) {
    if (!currentDeps[dependency]) {
      add('BREAKING', 'dependency_added', `Now depends on "${dependency}" ${range}`);
    } else if (currentDeps[dependency] !== range) {
      add(
        'NOTICE',
        'dependency_changed',
        `Dependency "${dependency}" moves from ${currentDeps[dependency]} to ${range}`,
      );
    }
  }
  for (const dependency of Object.keys(currentDeps)) {
    if (!candidateDeps[dependency]) {
      add('NOTICE', 'dependency_removed', `No longer depends on "${dependency}"`);
    }
  }

  // --- the publisher's own declaration
  if (bothValid && semver.isBreakingUpgrade(current.version, candidate.version)) {
    add(
      'BREAKING',
      'major_release',
      `${current.version} → ${candidate.version} is a breaking release by the publisher's own versioning`,
    );
  }

  // A silent capability grab in a patch release is the exact shape of a supply
  // chain attack, so it is called out separately from the grant itself.
  if (bothValid && addedCapabilities.length && (release === 'PATCH' || release === 'PRERELEASE')) {
    add(
      'BREAKING',
      'undeclared_capability_change',
      `A ${release.toLowerCase()} release should not change capabilities, but this one adds ${addedCapabilities.join(', ')}`,
    );
  }

  const migrations = (candidate.migrations ?? [])
    .filter(
      (step) =>
        semver.isValid(step.to) &&
        bothValid &&
        semver.gt(step.to, current.version) &&
        semver.gte(candidate.version, step.to),
    )
    .sort((a, b) => semver.compare(a.to, b.to));

  return {
    from: current.version,
    to: candidate.version,
    release,
    changes,
    blocked: changes.some((change) => change.severity === 'BLOCKING'),
    breaking: changes.some((change) => change.severity === 'BREAKING'),
    addedCapabilities,
    removedCapabilities,
    migrations,
  };
}

/**
 * Checks supplied config against the manifest's declared fields. Returns the
 * coerced values, so a numeric field arriving as a string from a form is
 * stored as a number rather than failing later inside the extension.
 */
export function validateConfig(
  manifest: ExtensionManifest,
  supplied: Record<string, unknown>,
): { ok: boolean; errors: ManifestIssue[]; values: Record<string, unknown> } {
  const errors: ManifestIssue[] = [];
  const values: Record<string, unknown> = {};
  const fields = manifest.config ?? {};

  for (const [field, definition] of Object.entries(fields)) {
    const raw = supplied[field] ?? definition.default;

    if (raw === undefined || raw === null || raw === '') {
      if (definition.required) errors.push({ field, message: `"${field}" is required` });
      continue;
    }

    switch (definition.type) {
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) errors.push({ field, message: `"${field}" must be a number` });
        else values[field] = n;
        break;
      }
      case 'boolean': {
        if (typeof raw === 'boolean') values[field] = raw;
        else if (raw === 'true' || raw === 'false') values[field] = raw === 'true';
        else errors.push({ field, message: `"${field}" must be true or false` });
        break;
      }
      case 'enum': {
        const options = definition.options ?? [];
        if (!options.includes(String(raw))) {
          errors.push({ field, message: `"${field}" must be one of ${options.join(', ')}` });
        } else values[field] = String(raw);
        break;
      }
      default: {
        values[field] = String(raw);
      }
    }
  }

  for (const field of Object.keys(supplied)) {
    if (!fields[field]) {
      errors.push({ field, message: `"${field}" is not a setting this extension declares` });
    }
  }

  return { ok: errors.length === 0, errors, values };
}

/** Field names the manifest marks as secret — never returned to a caller. */
export function secretFields(manifest: ExtensionManifest): string[] {
  return Object.entries(manifest.config ?? {})
    .filter(([, definition]) => definition.type === 'secret')
    .map(([field]) => field);
}
