import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { DeveloperApp } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import {
  DeveloperApiUsageRepository,
  DeveloperAppRepository,
} from '../database/repositories/platform.repositories';
import { ApiKeyRepository } from '../database/repositories/automation.repositories';
import { ApiKeyService } from '../public-api/api-key.service';
import { CryptoService } from '../shared/crypto/crypto.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import {
  CAPABILITIES,
  CAPABILITY_CATALOGUE_VERSION,
  REVIEW_THRESHOLD,
  catalogue,
  guardedSurface,
} from './capabilities';
import {
  DEFAULT_LIMITS,
  PLATFORM_API_VERSION,
  PLATFORM_LIMITS,
  validate,
} from './manifest';

/**
 * The developer portal: registering an integration, getting keys, seeing what
 * those keys did, and reading documentation that is derived rather than
 * written.
 *
 * The documentation half matters more than it looks. Every reference this
 * service produces — the capability catalogue, the guarded host surface, the
 * manifest schema, the limits — is generated from the same constants the
 * runtime enforces. A developer reading "these are the capabilities" is
 * reading the actual catalogue, so the docs cannot drift from the platform the
 * way a hand-written page does. When they disagree, the docs are wrong by
 * construction, which is a bug nobody has to notice.
 */
@Injectable()
export class DeveloperPortalService {
  private readonly logger = new Logger(DeveloperPortalService.name);

  constructor(
    private readonly apps: DeveloperAppRepository,
    private readonly usage: DeveloperApiUsageRepository,
    private readonly apiKeys: ApiKeyRepository,
    private readonly keyService: ApiKeyService,
    private readonly crypto: CryptoService,
    private readonly events: EventBusService,
  ) {}

  // ============================================================ apps

  async createApp(input: {
    name: string;
    slug: string;
    description?: string;
    homepage?: string;
    publisherId?: string;
    webhookUrl?: string;
  }): Promise<{ app: DeveloperApp; webhookSecret?: string }> {
    if (await this.apps.findBySlug(input.slug)) {
      throw new ConflictException(`An app with slug "${input.slug}" already exists`);
    }

    // Generated here rather than supplied, so a weak secret is not something a
    // developer can choose. Shown once; stored sealed.
    const webhookSecret = input.webhookUrl ? randomBytes(24).toString('hex') : undefined;

    const app = await this.apps.create({
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      homepage: input.homepage ?? null,
      publisherId: input.publisherId ?? null,
      webhookUrl: input.webhookUrl ?? null,
      webhookSecret: webhookSecret ? JSON.stringify(this.crypto.seal(webhookSecret)) : null,
      createdById: RequestContextStore.get()?.userId ?? null,
    });

    await this.events.publish(DomainEvent.DeveloperAppCreated, { appId: app.id, slug: app.slug });
    return { app: DeveloperPortalService.redact(app), webhookSecret };
  }

  async listApps(): Promise<DeveloperApp[]> {
    const rows = await this.apps.findMany({}, { orderBy: { createdAt: 'desc' } });
    return rows.map((row) => DeveloperPortalService.redact(row));
  }

  async getApp(id: string): Promise<Record<string, unknown>> {
    const app = await this.apps.findByIdOrFail(id);
    const keys = await this.apiKeys.findMany({ developerAppId: id }, { orderBy: { createdAt: 'desc' } });

    return {
      ...DeveloperPortalService.redact(app),
      keys: keys.map((key) => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        scopes: key.scopes,
        rateLimitPerMinute: key.rateLimitPerMinute,
        requestCount: key.requestCount,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        revoked: Boolean(key.revokedAt),
      })),
    };
  }

  async updateApp(id: string, patch: Record<string, unknown>): Promise<DeveloperApp> {
    await this.apps.findByIdOrFail(id);
    const { slug: _immutable, webhookSecret: _secret, ...safe } = patch;
    return DeveloperPortalService.redact(await this.apps.update(id, safe));
  }

  async deleteApp(id: string): Promise<void> {
    await this.apps.findByIdOrFail(id);
    // Keys outlive the app row only if nothing revokes them, which would leave
    // credentials working for an integration that no longer exists.
    const keys = await this.apiKeys.findMany({ developerAppId: id, revokedAt: null });
    for (const key of keys) await this.keyService.revoke(key.id);
    await this.apps.remove(id);
  }

  /** Issues a key bound to an app, so usage is attributable to an integration. */
  async issueKey(
    appId: string,
    input: { name: string; scopes?: string[]; rateLimitPerMinute?: number; expiresInDays?: number },
  ): Promise<unknown> {
    const app = await this.apps.findByIdOrFail(appId);
    const issued = await this.keyService.issue({
      name: `${app.name}: ${input.name}`,
      scopes: input.scopes ?? [],
      rateLimitPerMinute: input.rateLimitPerMinute,
      expiresInDays: input.expiresInDays,
    });

    await this.apiKeys.update(issued.id, { developerAppId: app.id });
    return { ...issued, appId: app.id };
  }

  /** The webhook signing secret, unsealed. Requires the manage permission. */
  async revealWebhookSecret(appId: string): Promise<{ webhookSecret: string | null }> {
    const app = await this.apps.findByIdOrFail(appId);
    if (!app.webhookSecret) return { webhookSecret: null };
    try {
      return { webhookSecret: this.crypto.open(JSON.parse(app.webhookSecret)) };
    } catch (error) {
      this.logger.error(`Could not unseal the webhook secret: ${(error as Error).message}`);
      return { webhookSecret: null };
    }
  }

  private static redact(app: DeveloperApp): DeveloperApp {
    // A sealed secret is still a secret: returning the ciphertext by default
    // invites it into logs and browser caches for no benefit.
    return { ...app, webhookSecret: app.webhookSecret ? '[sealed]' : null };
  }

  // ============================================================ usage

  record(slice: {
    appId?: string | null;
    apiKeyId?: string | null;
    endpoint?: string | null;
    durationMs: number;
    failed?: boolean;
    throttled?: boolean;
  }): Promise<void> {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    return this.usage.record({ ...slice, day });
  }

  async analytics(days = 30): Promise<Record<string, unknown>> {
    const to = new Date();
    to.setUTCHours(0, 0, 0, 0);
    const from = new Date(to.getTime() - days * 86_400_000);

    const rows = await this.usage.between(from, to);
    const totals = rows.reduce(
      (acc, row) => {
        acc.requests += row.requests;
        acc.errors += row.errors;
        acc.throttled += row.throttled;
        acc.durationMs += row.totalDurationMs;
        return acc;
      },
      { requests: 0, errors: 0, throttled: 0, durationMs: 0 },
    );

    const byDay = new Map<string, { requests: number; errors: number }>();
    const byEndpoint = new Map<string, { requests: number; errors: number; durationMs: number }>();
    for (const row of rows) {
      const day = row.day.toISOString().slice(0, 10);
      const dayEntry = byDay.get(day) ?? { requests: 0, errors: 0 };
      dayEntry.requests += row.requests;
      dayEntry.errors += row.errors;
      byDay.set(day, dayEntry);

      const endpoint = row.endpoint || '(unattributed)';
      const endpointEntry = byEndpoint.get(endpoint) ?? { requests: 0, errors: 0, durationMs: 0 };
      endpointEntry.requests += row.requests;
      endpointEntry.errors += row.errors;
      endpointEntry.durationMs += row.totalDurationMs;
      byEndpoint.set(endpoint, endpointEntry);
    }

    return {
      window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), days },
      totals: {
        ...totals,
        // Rate rather than count: 400 errors out of 400 requests and out of
        // 40,000 are different situations that the raw number hides.
        errorRate: totals.requests ? Number((totals.errors / totals.requests).toFixed(4)) : 0,
        averageDurationMs: totals.requests ? Math.round(totals.durationMs / totals.requests) : 0,
      },
      byDay: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, value]) => ({ day, ...value })),
      topEndpoints: [...byEndpoint.entries()]
        .sort((a, b) => b[1].requests - a[1].requests)
        .slice(0, 10)
        .map(([endpoint, value]) => ({
          endpoint,
          requests: value.requests,
          errors: value.errors,
          averageDurationMs: value.requests ? Math.round(value.durationMs / value.requests) : 0,
        })),
    };
  }

  // ============================================================ documentation

  /**
   * The SDK reference, generated from the catalogue rather than transcribed
   * from it. Every capability, its risk, what it implies and which host
   * methods it unlocks — the same values the sandbox enforces at runtime.
   */
  sdkReference(): Record<string, unknown> {
    return {
      apiVersion: PLATFORM_API_VERSION,
      catalogueVersion: CAPABILITY_CATALOGUE_VERSION,
      generatedAt: new Date().toISOString(),
      reviewThreshold: REVIEW_THRESHOLD,
      capabilities: catalogue().map((capability) => ({
        id: capability.id,
        title: capability.title,
        description: capability.description,
        risk: capability.risk,
        reviewRequired: capability.reviewRequired,
        impliedPermissions: capability.implies,
        unlocks: capability.surface,
      })),
      hostSurface: guardedSurface().map((method) => ({
        method,
        capability: CAPABILITIES.find((capability) => capability.surface.includes(method))?.id,
      })),
      limits: { default: DEFAULT_LIMITS, maximum: PLATFORM_LIMITS },
      hooks: [
        { name: 'initialize', when: 'Once after install, before the extension is enabled.' },
        { name: 'activate', when: 'Each time the extension is enabled.' },
        { name: 'deactivate', when: 'On disable and before uninstall. Must not throw.' },
        { name: 'migrate', when: 'Once per declared migration step during an upgrade.' },
        { name: 'onEvent', when: 'For each subscribed domain event.' },
        { name: 'onToolCall', when: 'When a contributed tool is invoked by a worker.' },
        { name: 'onWorkerRun', when: 'When a contributed worker type runs.' },
      ],
    };
  }

  /** The manifest schema, with an example that actually validates. */
  manifestReference(): Record<string, unknown> {
    const example = {
      slug: 'daily-digest',
      name: 'Daily Digest',
      version: '1.2.0',
      description: 'Summarises yesterday and posts it where your team reads.',
      author: 'Prism Labs',
      license: 'MIT',
      engine: `^${PLATFORM_API_VERSION}`,
      capabilities: ['can_read_missions', 'can_persist_state', 'can_send_notifications'],
      subscribes: ['mission.completed'],
      config: {
        channel: { type: 'string', label: 'Channel', required: true, default: '#general' },
        includeCosts: { type: 'boolean', label: 'Include cost figures', default: false },
      },
      contributes: {
        tools: [
          {
            key: 'summarise',
            name: 'Summarise missions',
            description: 'Produces a short digest of the missions in a window.',
            input: {
              properties: { days: { type: 'number', description: 'How far back to look.' } },
              required: ['days'],
            },
            output: { properties: { digest: { type: 'string' } } },
            mutates: false,
          },
        ],
      },
      limits: { callsPerMinute: 60, httpRequestsPerMinute: 10 },
      migrations: [{ to: '1.2.0', description: 'Moves the stored channel into config.' }],
    };

    // The example is validated on the way out, so a change to the validator
    // that would break it fails here rather than in a developer's editor.
    const validation = validate(example);

    return {
      apiVersion: PLATFORM_API_VERSION,
      fields: {
        slug: 'Required. Lower-case words separated by single hyphens. Immutable.',
        name: 'Required. 2–120 characters.',
        version: 'Required. Semantic version. Immutable once published.',
        engine: 'Semver range of platform API versions supported. Omitting it pins you to the current major.',
        capabilities: 'Required (use [] for none). Everything the extension may do.',
        subscribes: 'Domain events to receive. Needs "can_read_events".',
        dependencies: 'Map of extension slug to semver range.',
        config: 'Settings the operator supplies. Fields of type "secret" are sealed and never returned.',
        contributes: 'Workers, tools and triggers this extension adds.',
        limits: 'Requested resource ceiling. Clamped to the platform maximum, never rejected.',
        migrations: 'Ordered steps applied when upgrading past each version.',
      },
      configFieldTypes: ['string', 'number', 'boolean', 'secret', 'enum'],
      example,
      exampleIsValid: validation.ok,
      exampleWarnings: validation.warnings,
    };
  }

  /** Everything a developer needs on one page. */
  portal(): Record<string, unknown> {
    return {
      apiVersion: PLATFORM_API_VERSION,
      documentation: {
        openapi: '/api/docs-json',
        interactive: '/api/docs',
        sdk: '/api/v1/platform/developer/sdk',
        manifest: '/api/v1/platform/developer/manifest',
        capabilities: '/api/v1/platform/capabilities',
      },
      guides: [
        {
          title: 'Build your first extension',
          steps: [
            'Write a manifest declaring the capabilities you need — and only those.',
            'POST it to /platform/extensions/validate to see the grant before installing.',
            'POST to /platform/extensions with dryRun to see what an operator would consent to.',
            'Install, then enable. Contributions register at install; nothing runs until enabled.',
          ],
        },
        {
          title: 'Publish to the marketplace',
          steps: [
            'Register a publisher; keep the signing key returned — it is shown once.',
            'Create a listing for the asset kind you are publishing.',
            'Publish a version with your manifest and the signing key.',
            'Anything asking for a HIGH or CRITICAL capability opens a review before it is installable.',
          ],
        },
        {
          title: 'Ship a breaking change',
          steps: [
            'Bump the major (or the minor, below 1.0.0).',
            'Declare a migration step for each version that needs one.',
            'Publish. The platform diffs your manifest against the previous release.',
            'Installers see the analysis and consent again before anything is applied.',
          ],
        },
      ],
      testing: {
        validate: 'POST /platform/extensions/validate — manifest checks and the capability grant, no writes.',
        dryRunInstall: 'POST /platform/extensions with { "dryRun": true } — the full install path, nothing persisted.',
        dryRunUpgrade: 'POST /platform/extensions/:id/upgrade/analyse — the change list, before anything moves.',
        compatibility: 'POST /platform/governance/compatibility — every static check against a chosen API version.',
        debugConsole: 'GET /platform/extensions/:id/calls — every host call the extension made, allowed or denied.',
      },
      releaseNotes: [
        {
          version: PLATFORM_API_VERSION,
          notes: [
            'Capability-based architecture: extensions declare capabilities, the platform grants the intersection with the installer’s own permissions.',
            'Sandboxed host API with per-extension rate limits, timeouts and full call auditing.',
            'Marketplace across ten asset kinds with Ed25519-signed releases and publisher verification.',
            'Semantic version management with breaking-change detection before installation, migrations and rollback.',
          ],
        },
      ],
      migrationGuides: [
        {
          from: 'Phase 1 extension registry',
          to: PLATFORM_API_VERSION,
          notes: [
            'Extensions installed before capabilities existed hold an empty grant and are denied every host call — which is the correct outcome, not a regression.',
            'Reinstall through /platform/extensions with a manifest declaring capabilities to restore function.',
          ],
        },
      ],
    };
  }
}
