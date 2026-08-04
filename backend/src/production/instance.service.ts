import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { Instance } from '@prisma/client';
import { InstanceRepository } from '../database/repositories/production.repositories';
import { CacheService } from '../shared/cache/cache.service';
import { processHoldings } from '../shared/process-state';
import { MetricsService } from './metrics.service';
import type { FleetMetrics, InstanceMetrics } from './metrics.service';
import type { Environment } from './readiness';

/**
 * Instance identity and leader election.
 *
 * This is the piece that makes "add another backend instance" safe rather than
 * merely possible. Everything else in the stack is already stateless — sessions
 * live in Postgres, cache in Redis, queues in BullMQ — but *scheduled* work is
 * not. A cron tick running on every instance fires every schedule N times, and
 * it does so quietly: nothing errors, the work simply happens repeatedly. That
 * is the first thing that breaks when one server becomes three, and it is the
 * hardest to notice from the outside.
 *
 * The fix is a lease. Exactly one instance holds it, only the holder runs
 * scheduled work, and the lease expires on its own so a dead leader does not
 * take the schedules down with it.
 *
 * The election is a single conditional UPDATE rather than a read followed by a
 * write. Two instances racing produce one winner because Postgres serialises
 * the statement, not because the application looked first and hoped — a
 * check-then-act would hand the lease to both under exactly the contention it
 * exists to handle.
 *
 * Redis is deliberately not the store here. The lease is infrequent, must
 * survive a cache flush, and needs to be answerable by an operator asking "who
 * is running the schedules right now" — which is a question about the
 * deployment, and the deployment's state lives in the database.
 */
@Injectable()
export class InstanceService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(InstanceService.name);

  /** New on every start: a restarted process is a new instance. */
  readonly instanceId = `${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`;

  /**
   * Renewed every `HEARTBEAT_MS`, held for `LEASE_MS`. The gap is what lets a
   * leader miss one renewal — a slow query, a GC pause — without the lease
   * changing hands and two instances briefly believing they own it.
   */
  private static readonly HEARTBEAT_MS = 15_000;
  private static readonly LEASE_MS = 45_000;
  /** Past this without a heartbeat, an instance is presumed gone. */
  private static readonly UNREACHABLE_MS = 60_000;

  private timer?: NodeJS.Timeout;
  private leader = false;
  private activeRequests = 0;
  private handledRequests = 0n;
  private draining = false;

  /**
   * Where each instance publishes its share of the traffic figures.
   *
   * Short-lived on purpose: the key expires just after the next heartbeat is
   * due, so an instance that dies stops contributing to the fleet view within
   * one interval rather than skewing it until someone notices.
   */
  private static readonly METRICS_PREFIX = 'metrics:instance:';
  private static readonly METRICS_TTL_SECONDS = 45;

  constructor(
    private readonly instances: InstanceRepository,
    private readonly config: ConfigService,
    private readonly cache: CacheService,
    private readonly metrics: MetricsService,
  ) {}

  get environment(): Environment {
    const value = String(this.config.get('app.environment') ?? process.env.NODE_ENV ?? 'development');
    return (['development', 'test', 'staging', 'production'] as const).includes(value as Environment)
      ? (value as Environment)
      : 'development';
  }

  get version(): string {
    return String(this.config.get('app.version') ?? process.env.APP_VERSION ?? '1.0.0');
  }

  /** True when this instance currently owns the scheduler lease. */
  get isLeader(): boolean {
    return this.leader && !this.draining;
  }

  async onModuleInit(): Promise<void> {
    await this.instances
      .register({
        instanceId: this.instanceId,
        hostname: hostname(),
        environment: this.environment.toUpperCase() as never,
        version: this.version,
        status: 'HEALTHY',
        pid: process.pid,
        startedAt: new Date(),
      })
      .catch((error) => {
        // Failing to register must not stop the process from serving traffic.
        // An unregistered instance loses its shot at leadership, which is the
        // safe direction to fail in.
        this.logger.error(`Could not register instance: ${(error as Error).message}`);
      });

    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, InstanceService.HEARTBEAT_MS);
    // Never keep the process alive for a heartbeat.
    this.timer.unref?.();

    this.logger.log(
      `Instance ${this.instanceId} online (${this.environment}, v${this.version})`,
    );
  }

  /**
   * Stops taking new work and gives up the lease before exiting.
   *
   * Releasing rather than letting it expire means a rolling deploy hands the
   * schedules over in seconds instead of after a full lease window, which is
   * the difference between a seamless restart and a minute of nothing running.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.draining = true;
    if (this.timer) clearInterval(this.timer);

    if (this.leader) {
      await this.instances.releaseLeadership(this.instanceId).catch(() => undefined);
      this.leader = false;
    }
    await this.instances.markStopped(this.instanceId);
    this.logger.log(`Instance ${this.instanceId} stopped${signal ? ` on ${signal}` : ''}`);
  }

  /** Heartbeat, leadership renewal, and reaping of instances that went quiet. */
  private async tick(): Promise<void> {
    try {
      const load = os.loadavg()[0];
      const cpuCount = os.cpus().length || 1;
      const memory = process.memoryUsage();

      await this.instances.heartbeat(this.instanceId, {
        status: this.draining ? 'DRAINING' : 'HEALTHY',
        // Load average over core count: a figure comparable between a laptop
        // and a 32-core box, which a raw load average is not.
        cpuPercent: Number(Math.min(100, (load / cpuCount) * 100).toFixed(2)),
        memoryMb: Number((memory.rss / 1024 / 1024).toFixed(1)),
        activeRequests: this.activeRequests,
        handledRequests: this.handledRequests,
      });

      // Publish this instance's share so readiness and alerting can evaluate
      // the deployment rather than one process's quarter of it.
      await this.cache
        .set(
          `${InstanceService.METRICS_PREFIX}${this.instanceId}`,
          this.metrics.contribution(this.instanceId),
          InstanceService.METRICS_TTL_SECONDS,
        )
        .catch(() => undefined);

      const held = this.draining
        ? false
        : await this.instances.claimLeadership(this.instanceId, InstanceService.LEASE_MS);

      if (held !== this.leader) {
        this.logger.log(held ? 'Acquired the scheduler lease' : 'Lost the scheduler lease');
      }
      this.leader = held;

      if (this.leader) {
        // Reaping is leader work: every instance doing it would be N identical
        // updates, and the whole point of the lease is that one instance acts.
        const reaped = await this.instances.markUnreachable(
          new Date(Date.now() - InstanceService.UNREACHABLE_MS),
        );
        if (reaped) this.logger.warn(`${reaped} instance(s) stopped reporting`);
      }
    } catch (error) {
      // A failed heartbeat means the lease lapses and someone else takes over.
      // Assuming leadership through a database outage is the dangerous answer.
      this.leader = false;
      this.logger.warn(`Heartbeat failed: ${(error as Error).message}`);
    }
  }

  /** Called by the observability interceptor around every request. */
  requestStarted(): void {
    this.activeRequests += 1;
  }

  requestFinished(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.handledRequests += 1n;
  }

  /**
   * Guard for work that must happen once per cluster rather than once per
   * instance. Callers wrap their scheduled tick in this.
   */
  async runIfLeader<T>(name: string, work: () => Promise<T>): Promise<T | null> {
    if (!this.isLeader) return null;
    try {
      return await work();
    } catch (error) {
      this.logger.error(`Leader task "${name}" failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Traffic figures across every instance that has reported recently.
   *
   * Falls back to this process alone when the shared cache is unreachable —
   * a partial answer beats no answer, and the `instances` count makes the
   * difference visible.
   */
  async fleetMetrics(): Promise<FleetMetrics> {
    const published = await this.cache
      .getByPrefix<InstanceMetrics>(InstanceService.METRICS_PREFIX)
      .catch(() => [] as InstanceMetrics[]);

    const contributions = published.length
      ? published
      : [this.metrics.contribution(this.instanceId)];

    return MetricsService.merge(contributions);
  }

  // ------------------------------------------------------------- reporting

  async cluster(): Promise<{
    self: string;
    environment: Environment;
    version: string;
    leader: string | null;
    isLeader: boolean;
    healthy: number;
    instances: Array<Record<string, unknown>>;
  }> {
    const since = new Date(Date.now() - InstanceService.UNREACHABLE_MS);
    const [healthy, all, leader] = await Promise.all([
      this.instances.healthy(since),
      this.instances.all(50),
      this.instances.currentLeader(),
    ]);

    return {
      self: this.instanceId,
      environment: this.environment,
      version: this.version,
      leader: leader?.instanceId ?? null,
      isLeader: this.isLeader,
      healthy: healthy.length,
      instances: all.map((instance) => InstanceService.describe(instance, leader?.instanceId)),
    };
  }

  private static describe(instance: Instance, leaderId?: string): Record<string, unknown> {
    return {
      instanceId: instance.instanceId,
      hostname: instance.hostname,
      environment: instance.environment,
      version: instance.version,
      status: instance.status,
      isLeader: instance.instanceId === leaderId,
      cpuPercent: instance.cpuPercent,
      memoryMb: instance.memoryMb,
      activeRequests: instance.activeRequests,
      // BigInt does not survive JSON.stringify; the count is well within Number.
      handledRequests: Number(instance.handledRequests),
      startedAt: instance.startedAt,
      lastHeartbeat: instance.lastHeartbeat,
      uptimeSeconds: Math.round((Date.now() - instance.startedAt.getTime()) / 1000),
    };
  }

  /**
   * Whether this process holds request state that would not survive being
   * rescheduled onto another instance.
   *
   * Measured rather than declared. This used to return a hard-coded `true`
   * beside a list of reassuring prose, which meant the readiness review
   * reported statelessness whether or not the process was stateless — a check
   * that cannot fail is not a check. Now it reports what components actually
   * registered, and `stateless` is false the moment any of it is load-bearing.
   */
  statelessness(): {
    stateless: boolean;
    notes: string[];
    holdings: Array<{ name: string; loadBearing: boolean; detail: string }>;
  } {
    const holdings = processHoldings();

    const notes = [
      'Sessions are rows in Postgres, resolved per request.',
      'Cache, rate-limit counters and password-reset tokens live in Redis, shared by every instance.',
      'Queues are BullMQ on shared Redis; a job is claimed, not routed.',
      'Request context is per-request AsyncLocalStorage, discarded on response.',
      'Scheduled work runs only for the lease holder, so it is not duplicated.',
    ];

    const blocking = holdings.filter((holding) => holding.loadBearing);
    for (const holding of blocking) {
      notes.push(`Request state held in process: ${holding.name} — ${holding.detail}`);
    }

    return { stateless: blocking.length === 0, notes, holdings };
  }
}
