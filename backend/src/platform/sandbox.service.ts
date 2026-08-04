import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SandboxDecision } from '@prisma/client';
import { CacheService } from '../shared/cache/cache.service';
import { CryptoService } from '../shared/crypto/crypto.service';
import {
  CredentialRepository,
  EventRepository,
  KnowledgeRepository,
} from '../database/repositories/tenant.repositories';
import { OrganizationRepository } from '../database/repositories/identity.repositories';
import {
  ExtensionContributionRepository,
  ExtensionHostCallRepository,
  ExtensionStateRepository,
} from '../database/repositories/platform.repositories';
import { RequestContextStore } from '../shared/context/request-context';
import { MissionsService } from '../missions/missions.service';
import { MissionOrchestrator } from '../missions/orchestrator/mission-orchestrator.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { WorkersService } from '../workers/workers.service';
import { NotificationService } from '../notifications/notification.service';
import { StorageService } from '../storage/storage.module';
import { AnalyticsService } from '../analytics/analytics.module';
import { authorize, capabilityForSurface, guardedSurface } from './capabilities';
import type { SandboxLimits } from './manifest';
import { CapabilityDeniedError, SandboxLimitError } from './sdk';
import type { HostApi } from './sdk';
import { BoundedMap } from '../shared/bounded-map';
import { declareProcessState } from '../shared/process-state';

/**
 * The sandbox: the one place extension code can reach the platform, and the
 * only place that is allowed to know about everything.
 *
 * Extensions never receive unrestricted system access. There is no object an
 * extension can hold that reaches a repository, a Prisma client, a Nest
 * provider or the request context. What it holds is a `HostApi` whose every
 * method funnels through `invoke`, and `invoke` performs the same five steps
 * regardless of which method was called:
 *
 *   1. **Capability check.** `authorize` maps the method to the one capability
 *      that guards it and refuses if the grant does not include it. A method
 *      no capability claims is refused outright — the surface fails closed, so
 *      adding a handler without a capability makes it unreachable rather than
 *      unguarded, and `onModuleInit` turns that mistake into a boot failure.
 *   2. **Rate limit.** Per extension, per minute, with a separate and tighter
 *      budget for outbound HTTP.
 *   3. **Timeout.** Nothing an extension starts can run longer than its grant.
 *   4. **Dispatch**, through a handler that receives plain data.
 *   5. **Audit.** Every call is recorded — allowed, denied, failed or
 *      throttled. Denials are the interesting ones.
 *
 * Failure to record must never turn a successful call into a failed one, so
 * audit writes are best-effort and logged, in the same spirit as the tool
 * registry's own recording.
 */

export interface SandboxBinding {
  extensionId: string;
  slug: string;
  name: string;
  version: string;
  capabilities: readonly string[];
  config: Readonly<Record<string, unknown>>;
  limits: SandboxLimits;
  /** Simulated writes, discarded. Used by validation and by dry-run installs. */
  dryRun?: boolean;
  /** Set when the call originates from a contributed tool or worker. */
  contributionId?: string;
}

type Handler = (binding: SandboxBinding, args: Record<string, unknown>) => Promise<unknown>;

/** Hosts we refuse to let an extension reach, whatever it claims it needs. */
const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  // The cloud instance metadata endpoint. Reaching it from inside a tenant's
  // extension would hand out the platform's own credentials.
  '169.254.169.254',
  'metadata.google.internal',
];

const PRIVATE_IPV4 =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PREVIEW_CHARS = 1000;

@Injectable()
export class SandboxService implements OnModuleInit {
  private readonly logger = new Logger(SandboxService.name);
  private readonly handlers: Record<string, Handler>;

  /**
   * Local fallback counters, used only while Redis is unreachable. Per
   * process, so a multi-node deployment could allow up to N times the limit
   * in that degraded window — which is still a limit, and is the right trade
   * against a rate limiter that stops limiting the moment the cache blinks.
   */
  private static readonly LOCAL_COUNTER_LIMIT = 5_000;
  private readonly localCounters = new BoundedMap<
    string,
    { count: number; resetAt: number }
  >(SandboxService.LOCAL_COUNTER_LIMIT);

  // Only reached while Redis is unreachable, and deliberately permissive in
  // that window rather than failing open entirely. Not load-bearing: the
  // shared counters are the real limit.
  private readonly declared = declareProcessState({
    name: 'sandbox.fallback-counters',
    loadBearing: false,
    describe: () =>
      `${this.localCounters.size} fallback counter(s) — used only while the cache is unreachable`,
  });

  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly missions: MissionsService,
    private readonly orchestrator: MissionOrchestrator,
    private readonly knowledge: KnowledgeService,
    private readonly workers: WorkersService,
    private readonly events: EventRepository,
    private readonly knowledgeRepo: KnowledgeRepository,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    private readonly analytics: AnalyticsService,
    private readonly credentials: CredentialRepository,
    private readonly crypto: CryptoService,
    private readonly state: ExtensionStateRepository,
    private readonly contributions: ExtensionContributionRepository,
    private readonly hostCalls: ExtensionHostCallRepository,
    private readonly cache: CacheService,
  ) {
    this.handlers = this.buildHandlers();
  }

  /**
   * Proves the guarded surface and the implemented surface are the same set.
   *
   * A handler with no capability would be reachable without a grant; a
   * capability naming a method that does not exist would appear on a consent
   * screen and grant nothing. Both are silent in production and obvious here,
   * so both are boot failures.
   */
  onModuleInit(): void {
    const declared = new Set(guardedSurface());
    const implemented = new Set(Object.keys(this.handlers));

    const unguarded = [...implemented].filter((method) => !declared.has(method));
    const unimplemented = [...declared].filter((method) => !implemented.has(method));

    if (unguarded.length || unimplemented.length) {
      const problems = [
        unguarded.length ? `no capability guards ${unguarded.join(', ')}` : '',
        unimplemented.length ? `no handler implements ${unimplemented.join(', ')}` : '',
      ].filter(Boolean);
      throw new Error(`Sandbox surface is inconsistent: ${problems.join('; ')}`);
    }

    this.logger.log(`Sandbox ready: ${implemented.size} guarded host methods`);
  }

  // ------------------------------------------------------------------ host

  /** Builds the API object handed to one extension, bound to its grant. */
  host(binding: SandboxBinding): HostApi {
    const call = <T>(method: string, args: Record<string, unknown> = {}): Promise<T> =>
      this.invoke(binding, method, args) as Promise<T>;

    const bind =
      <T>(method: string) =>
      (args: Record<string, unknown> = {}): Promise<T> =>
        call<T>(method, args);

    return {
      call,
      org: { describe: bind('org.describe') },
      missions: {
        get: bind('missions.get'),
        list: bind('missions.list'),
        create: bind('missions.create'),
        start: bind('missions.start'),
        plan: bind('missions.plan'),
      },
      knowledge: {
        search: bind('knowledge.search'),
        get: bind('knowledge.get'),
        store: bind('knowledge.store'),
        update: bind('knowledge.update'),
      },
      workers: {
        list: bind('workers.list'),
        create: bind('workers.create'),
        update: bind('workers.update'),
        delete: bind('workers.delete'),
        register: bind('workers.register'),
        unregister: bind('workers.unregister'),
      },
      tools: {
        register: bind('tools.register'),
        unregister: bind('tools.unregister'),
      },
      triggers: {
        register: bind('triggers.register'),
        unregister: bind('triggers.unregister'),
        list: bind('triggers.list'),
      },
      events: { recent: bind('events.recent'), subscribe: bind('events.subscribe') },
      state: {
        get: bind('state.get'),
        set: bind('state.set'),
        delete: bind('state.delete'),
        keys: bind('state.keys'),
      },
      storage: { get: bind('storage.get'), put: bind('storage.put'), list: bind('storage.list') },
      analytics: { summary: bind('analytics.summary') },
      notify: { send: bind('notify.send') },
      http: { fetch: bind('http.fetch'), fetchAs: bind('http.fetchAs') },
      credentials: { list: bind('credentials.list') },
    } as HostApi;
  }

  // ---------------------------------------------------------------- invoke

  async invoke(
    binding: SandboxBinding,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const startedAt = Date.now();
    const capability = capabilityForSurface(method);

    // 1 — capability
    const denial = authorize(binding.capabilities, method);
    if (denial) {
      await this.record(binding, method, capability?.id, SandboxDecision.DENIED, denial, args, startedAt);
      throw new CapabilityDeniedError(method, denial);
    }

    // 2 — rate limit
    const overall = await this.consume(
      `${binding.extensionId}:all`,
      binding.limits.callsPerMinute,
    );
    if (!overall.allowed) {
      const message = `Over the ${binding.limits.callsPerMinute}/minute host call limit`;
      await this.record(binding, method, capability?.id, SandboxDecision.THROTTLED, message, args, startedAt);
      throw new SandboxLimitError('callsPerMinute', message);
    }

    if (method.startsWith('http.')) {
      const egress = await this.consume(
        `${binding.extensionId}:http`,
        binding.limits.httpRequestsPerMinute,
      );
      if (!egress.allowed) {
        const message = `Over the ${binding.limits.httpRequestsPerMinute}/minute outbound request limit`;
        await this.record(binding, method, capability?.id, SandboxDecision.THROTTLED, message, args, startedAt);
        throw new SandboxLimitError('httpRequestsPerMinute', message);
      }
    }

    const handler = this.handlers[method];
    if (!handler) {
      // Unreachable while onModuleInit passes, but a missing handler must fail
      // closed rather than fall through to something permissive.
      const message = `"${method}" is not implemented by this platform`;
      await this.record(binding, method, capability?.id, SandboxDecision.DENIED, message, args, startedAt);
      throw new CapabilityDeniedError(method, message);
    }

    // 3, 4 — timeout and dispatch
    try {
      const output = await this.withTimeout(
        handler(binding, args),
        binding.limits.timeoutMs,
        method,
      );
      await this.record(binding, method, capability?.id, SandboxDecision.ALLOWED, null, args, startedAt);
      return output;
    } catch (error) {
      const message = (error as Error).message;
      const decision =
        error instanceof SandboxLimitError ? SandboxDecision.THROTTLED : SandboxDecision.FAILED;
      await this.record(binding, method, capability?.id, decision, message, args, startedAt);
      throw error;
    }
  }

  private async withTimeout<T>(work: Promise<T>, timeoutMs: number, method: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new SandboxLimitError('timeoutMs', `"${method}" exceeded ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      // Without this the timer keeps the event loop alive for the full window
      // after a fast call has already returned.
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Fixed-window counter. Redis when it is there, local when it is not; never
   * unlimited, which is the point of returning null from `increment` rather
   * than a zero.
   */
  private async consume(key: string, limit: number): Promise<{ allowed: boolean; used: number }> {
    const window = Math.floor(Date.now() / 60_000);
    const cacheKey = `sandbox:rate:${key}:${window}`;

    const shared = await this.cache.increment(cacheKey, 90);
    if (shared !== null) return { allowed: shared <= limit, used: shared };

    const now = Date.now();
    const entry = this.localCounters.get(key);
    if (!entry || entry.resetAt <= now) {
      this.localCounters.set(key, { count: 1, resetAt: now + 60_000 });
      return { allowed: 1 <= limit, used: 1 };
    }
    entry.count += 1;
    return { allowed: entry.count <= limit, used: entry.count };
  }

  private async record(
    binding: SandboxBinding,
    method: string,
    capability: string | undefined,
    decision: SandboxDecision,
    reason: string | null,
    args: Record<string, unknown>,
    startedAt: number,
  ): Promise<void> {
    try {
      await this.hostCalls.create({
        extensionId: binding.extensionId,
        method,
        capability: capability ?? null,
        decision,
        reason: reason ? reason.slice(0, 500) : null,
        durationMs: Date.now() - startedAt,
        argsPreview: SandboxService.preview(args) as never,
        contributionId: binding.contributionId ?? null,
      });
    } catch (error) {
      this.logger.error(`Failed to record host call: ${(error as Error).message}`);
    }
  }

  /**
   * Bounded, redacted snapshot of a call's arguments.
   *
   * Anything that looks like a secret is replaced rather than truncated: a
   * truncated token is still a leaked prefix, and the audit log is read by
   * more people than the data it describes.
   */
  private static preview(args: Record<string, unknown>): Record<string, unknown> {
    const sensitive = /(secret|token|password|authorization|apikey|api_key|credential)/i;
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args ?? {})) {
      if (sensitive.test(key)) {
        redacted[key] = '[redacted]';
        continue;
      }
      if (key === 'headers' && value && typeof value === 'object') {
        redacted[key] = Object.fromEntries(
          Object.keys(value as Record<string, unknown>).map((name) => [
            name,
            sensitive.test(name) ? '[redacted]' : '[present]',
          ]),
        );
        continue;
      }
      const json = JSON.stringify(value) ?? 'null';
      redacted[key] = json.length > MAX_PREVIEW_CHARS ? `${json.slice(0, MAX_PREVIEW_CHARS)}…` : value;
    }
    return redacted;
  }

  // -------------------------------------------------------------- handlers

  private buildHandlers(): Record<string, Handler> {
    const str = (args: Record<string, unknown>, name: string, fallback = ''): string =>
      typeof args[name] === 'string' ? (args[name] as string) : fallback;
    const num = (args: Record<string, unknown>, name: string, fallback: number): number => {
      const value = Number(args[name]);
      return Number.isFinite(value) ? value : fallback;
    };
    const required = (args: Record<string, unknown>, name: string): string => {
      const value = str(args, name);
      if (!value) throw new Error(`"${name}" is required`);
      return value;
    };

    return {
      // ---------------------------------------------------------------- org
      'org.describe': async () => {
        const organizationId = RequestContextStore.require().organizationId;
        const organization = await this.organizations.findById(organizationId);
        if (!organization) throw new Error('The organization is no longer available');
        // Deliberately three fields. `settings` can hold anything an operator
        // put there, and an extension asking who it is working for does not
        // need to be handed that.
        return { id: organization.id, name: organization.name, plan: organization.plan };
      },

      // ----------------------------------------------------------- missions
      'missions.get': (_b, args) => this.missions.findOne(required(args, 'id')),
      'missions.list': (_b, args) =>
        this.missions.findAll({
          page: 1,
          limit: Math.min(num(args, 'limit', 25), 100),
          skip: 0,
          sortBy: 'createdAt',
          sortOrder: 'desc',
          ...(args.status ? { status: args.status } : {}),
        } as never),
      'missions.create': (binding, args) =>
        this.guardWrite(binding, () =>
          this.missions.create({
            title: required(args, 'title'),
            objective: str(args, 'objective', required(args, 'title')),
            tasks: Array.isArray(args.tasks) ? args.tasks : [],
          } as never),
        ),
      'missions.start': (binding, args) =>
        this.guardWrite(binding, () => this.missions.start(required(args, 'id'))),
      'missions.plan': (binding, args) =>
        this.guardWrite(binding, () => this.orchestrator.plan(required(args, 'id'))),

      // ---------------------------------------------------------- knowledge
      'knowledge.search': async (_b, args) => {
        const query = required(args, 'query');
        return this.knowledgeRepo.findMany(
          {
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { content: { contains: query, mode: 'insensitive' } },
            ],
          },
          { take: Math.min(num(args, 'limit', 10), 50), orderBy: { updatedAt: 'desc' } },
        );
      },
      'knowledge.get': (_b, args) => this.knowledge.findOne(required(args, 'id')),
      'knowledge.store': (binding, args) =>
        this.guardWrite(binding, () =>
          this.knowledge.create({
            title: required(args, 'title'),
            content: required(args, 'content'),
            tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
          } as never),
        ),
      'knowledge.update': (binding, args) =>
        this.guardWrite(binding, () =>
          this.knowledge.update(required(args, 'id'), {
            ...(args.content !== undefined ? { content: str(args, 'content') } : {}),
            ...(Array.isArray(args.tags) ? { tags: args.tags as string[] } : {}),
          } as never),
        ),

      // ------------------------------------------------------------ workers
      'workers.list': (_b, args) =>
        this.workers.findAll({
          page: 1,
          limit: Math.min(num(args, 'limit', 25), 100),
          skip: 0,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        } as never),
      'workers.create': (binding, args) =>
        this.guardWrite(binding, () => this.workers.create(args as never)),
      'workers.update': (binding, args) =>
        this.guardWrite(binding, () => {
          const { id, ...patch } = args;
          return this.workers.update(String(id), patch as never);
        }),
      'workers.delete': (binding, args) =>
        this.guardWrite(binding, async () => {
          await this.workers.remove(required(args, 'id'));
          return { deleted: true };
        }),

      // Registration of contributed workers, tools and triggers is performed
      // by the extension runtime from the manifest, not by extension code at
      // runtime: what a component may contribute is part of what an operator
      // consented to, so it cannot be decided after consent was given.
      'workers.register': async () => {
        throw new Error(
          'Worker types are contributed through the manifest, not registered at runtime',
        );
      },
      'workers.unregister': async () => {
        throw new Error('Contributed worker types are removed by uninstalling the extension');
      },
      'tools.register': async () => {
        throw new Error('Tools are contributed through the manifest, not registered at runtime');
      },
      'tools.unregister': async () => {
        throw new Error('Contributed tools are removed by uninstalling the extension');
      },
      'triggers.register': async () => {
        throw new Error('Triggers are contributed through the manifest, not registered at runtime');
      },
      'triggers.unregister': async () => {
        throw new Error('Contributed triggers are removed by uninstalling the extension');
      },
      'triggers.list': async (binding) => {
        const rows = await this.contributions.findMany(
          { extensionId: binding.extensionId, kind: 'TRIGGER' },
          { orderBy: { key: 'asc' } },
        );
        return rows.map((row) => ({ key: row.key, name: row.name, enabled: row.enabled }));
      },

      // ------------------------------------------------------------- events
      'events.recent': (_b, args) =>
        this.events.findMany(args.name ? { name: str(args, 'name') } : {}, {
          take: Math.min(num(args, 'limit', 25), 100),
          orderBy: { createdAt: 'desc' },
        }),
      'events.subscribe': async (_b, args) => ({
        // Subscriptions live on the extension row, set from the manifest at
        // install. Echoing the request keeps the SDK honest about what it did.
        subscribed: Array.isArray(args.names) ? (args.names as string[]) : [],
      }),

      // -------------------------------------------------------------- state
      'state.get': async (binding, args) => {
        const row = await this.state.get(binding.extensionId, required(args, 'key'));
        return row ? row.value : null;
      },
      'state.set': async (binding, args) => {
        const key = required(args, 'key');
        const serialised = JSON.stringify(args.value ?? null) ?? 'null';
        const bytes = Buffer.byteLength(serialised, 'utf8');

        const usage = await this.state.usage(binding.extensionId);
        const existing = await this.state.get(binding.extensionId, key);
        const projectedBytes = usage.bytes - (existing?.bytes ?? 0) + bytes;
        const projectedKeys = usage.keys + (existing ? 0 : 1);

        if (projectedBytes > binding.limits.storageBytes) {
          throw new SandboxLimitError(
            'storageBytes',
            `Storing "${key}" would exceed the ${binding.limits.storageBytes} byte limit`,
          );
        }
        if (projectedKeys > binding.limits.storageKeys) {
          throw new SandboxLimitError(
            'storageKeys',
            `Storing "${key}" would exceed the ${binding.limits.storageKeys} key limit`,
          );
        }

        if (binding.dryRun) return { stored: false, dryRun: true };
        await this.state.put(binding.extensionId, key, args.value ?? null, bytes);
        return { stored: true };
      },
      'state.delete': (binding, args) =>
        binding.dryRun
          ? Promise.resolve(false)
          : this.state.drop(binding.extensionId, required(args, 'key')),
      'state.keys': async (binding, args) => {
        const rows = await this.state.keys(
          binding.extensionId,
          args.prefix ? str(args, 'prefix') : undefined,
        );
        return rows.map((row) => row.key);
      },

      // ------------------------------------------------------------ storage
      'storage.get': async (_b, args) => {
        const buffer = await this.storage.download(required(args, 'key'));
        return { key: args.key, content: buffer.toString('base64'), bytes: buffer.length };
      },
      'storage.put': (binding, args) =>
        this.guardWrite(binding, () => {
          const content = required(args, 'content');
          const buffer = Buffer.from(content, 'utf8');
          return this.storage.upload(
            {
              originalname: required(args, 'key'),
              buffer,
              mimetype: str(args, 'contentType', 'application/octet-stream'),
              size: buffer.length,
            },
            `extensions/${binding.slug}`,
          );
        }),
      'storage.list': (_b, args) => this.storage.list(str(args, 'prefix', 'uploads')),

      // ---------------------------------------------------------- analytics
      'analytics.summary': () => this.analytics.overview(),

      // ------------------------------------------------------- notifications
      'notify.send': (binding, args) =>
        this.guardWrite(binding, () =>
          this.notifications.send({
            category: `extension.${binding.slug}`,
            subject: required(args, 'title'),
            body: str(args, 'body', ''),
            severity: str(args, 'severity', 'INFO'),
            ...(args.channel ? { channels: [str(args, 'channel')] } : {}),
            metadata: { extensionId: binding.extensionId, slug: binding.slug },
          }),
        ),

      // --------------------------------------------------------------- http
      'http.fetch': (binding, args) => this.egress(binding, args, null),
      'http.fetchAs': async (binding, args) => {
        const name = required(args, 'credential');
        const credential = await this.credentials.findMany({ name }, { take: 1 });
        if (!credential.length) {
          throw new Error(`No stored credential named "${name}"`);
        }
        return this.egress(binding, args, credential[0]);
      },
      'credentials.list': async () => {
        const rows = await this.credentials.findMany({}, { take: 100 });
        // Names and types only. The sealed value never leaves this service.
        return rows.map((row) => ({ name: row.name, kind: row.type }));
      },
    };
  }

  // -------------------------------------------------------------- internals

  /** Skips the write and reports it when the binding is a dry run. */
  private async guardWrite<T>(
    binding: SandboxBinding,
    write: () => Promise<T>,
  ): Promise<T | { dryRun: true; skipped: true }> {
    if (binding.dryRun) return { dryRun: true, skipped: true };
    return write();
  }

  /**
   * Outbound HTTP, with the credential — when there is one — injected after
   * the extension has finished composing the request.
   *
   * The extension never sees the value, and cannot place it anywhere other
   * than the Authorization header of the request it asked for: the injection
   * happens here, on a header object the extension does not hold a reference
   * to. That is what makes `can_use_credentials` narrower than "read secrets".
   */
  private async egress(
    binding: SandboxBinding,
    args: Record<string, unknown>,
    credential: { id: string; value: string; iv: string; authTag: string; type: string } | null,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const url = typeof args.url === 'string' ? args.url : '';
    const target = SandboxService.parseTarget(url);

    const headers: Record<string, string> = {
      'user-agent': `PRISM-X-Extension/${binding.slug}@${binding.version}`,
    };
    for (const [name, value] of Object.entries(
      (args.headers as Record<string, string> | undefined) ?? {},
    )) {
      const lower = name.toLowerCase();
      // An extension setting these itself would be either spoofing its own
      // identity or overriding the credential the host is about to inject.
      if (lower === 'host' || lower === 'user-agent') continue;
      if (credential && lower === 'authorization') continue;
      headers[lower] = String(value);
    }

    if (credential) {
      const secret = this.crypto.open({
        value: credential.value,
        iv: credential.iv,
        authTag: credential.authTag,
      });
      headers.authorization =
        credential.type.toUpperCase() === 'BASIC' ? `Basic ${secret}` : `Bearer ${secret}`;
      await this.credentials.touch(credential.id);
    }

    if (binding.dryRun) {
      return { status: 0, headers: {}, body: '' };
    }

    const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
    const response = await fetch(target.toString(), {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: typeof args.body === 'string' ? args.body : undefined }),
      redirect: 'manual',
      signal: AbortSignal.timeout(binding.limits.timeoutMs),
    });

    const text = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      // Cookies are the one header an extension has no business reading: they
      // are the caller's session, not the extension's data.
      if (name.toLowerCase() !== 'set-cookie') responseHeaders[name.toLowerCase()] = value;
    });

    return {
      status: response.status,
      headers: responseHeaders,
      body: text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text,
    };
  }

  /**
   * Validates an egress target.
   *
   * This blocks the literal forms of server-side request forgery: loopback,
   * link-local, RFC1918 and the cloud metadata endpoint. It does not resolve
   * DNS, so a hostname that resolves to a private address still gets through —
   * defending against that belongs at the egress proxy, where the resolved
   * address is actually known, and pretending otherwise here would be worse
   * than saying so.
   */
  private static parseTarget(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`"${url}" is not a valid URL`);
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Only http and https are permitted, not "${parsed.protocol}"`);
    }

    const host = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(host) || host.endsWith('.localhost')) {
      throw new Error(`"${host}" is not a permitted destination`);
    }
    if (PRIVATE_IPV4.test(host)) {
      throw new Error(`"${host}" is a private address and is not a permitted destination`);
    }
    return parsed;
  }
}
