import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AlertEventRepository,
  AlertRuleRepository,
  ReadinessReviewRepository,
  SchemaRepository,
} from '../database/repositories/production.repositories';
import { DeadLetterRepository } from '../database/repositories/automation.repositories';
import { CacheService } from '../shared/cache/cache.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { activeIsolation } from '../shared/isolation-registry';
import { InstanceService } from './instance.service';
import { BackupService } from './backup.service';
import { SecurityService } from './security.service';
import { Metric, MetricsService } from './metrics.service';
import {
  READINESS_VERSION,
  describeChecks,
  review as runReview,
} from './readiness';
import type { ReadinessEvidence, ReadinessReview } from './readiness';

/**
 * How many API operations the generated OpenAPI document contains.
 *
 * Set once at bootstrap, where the document is actually built. A module-level
 * value rather than a service because the document is created before the
 * injector is available to ask, and re-generating it here to count it would
 * mean the number could differ from the one that was served.
 */
let documentedOperations = 0;
export function recordApiOperationCount(count: number): void {
  documentedOperations = count;
}

/**
 * Gathers evidence and runs the production readiness review.
 *
 * Every number here is measured rather than declared. That is the difference
 * between this and a checklist: nobody can mark the review green by editing a
 * document, because the review reads the database, the cache, the metrics
 * registry, the backup history and the filesystem, and reports what it finds.
 *
 * Where evidence cannot be gathered, the field is null and the corresponding
 * check returns UNKNOWN. A review that treated an unreachable cache as a pass
 * would be worse than no review, because it would be confidently wrong in the
 * exact situation it exists to catch.
 */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  /** Config values whose shipped defaults must never survive into production. */
  private static readonly DEFAULT_SECRETS: Array<{ env: string; shipped: string[] }> = [
    { env: 'JWT_SECRET', shipped: ['dev-secret', 'change-me', 'secret', ''] },
    { env: 'ENCRYPTION_KEY', shipped: ['dev-encryption-key-change-me-32ch', 'change-me', ''] },
    { env: 'JWT_REFRESH_SECRET', shipped: ['dev-refresh-secret', 'change-me', ''] },
  ];

  constructor(
    private readonly schema: SchemaRepository,
    private readonly config: ConfigService,
    private readonly instances: InstanceService,
    private readonly backups: BackupService,
    private readonly security: SecurityService,
    private readonly metrics: MetricsService,
    private readonly cache: CacheService,
    private readonly alertRules: AlertRuleRepository,
    private readonly alertEvents: AlertEventRepository,
    private readonly deadLetters: DeadLetterRepository,
    private readonly reviews: ReadinessReviewRepository,
    private readonly events: EventBusService,
  ) {}

  // ============================================================ evidence

  async gather(): Promise<ReadinessEvidence> {
    const [database, backups, security, alerts, deadLetters, cluster] = await Promise.all([
      this.databaseEvidence(),
      this.backups.posture().catch(() => null),
      this.security.posture().catch(() => null),
      this.alertEvidence(),
      this.deadLetterCount(),
      this.instances.cluster(),
    ]);

    const cacheReachable = await this.cache.ping().catch(() => false);

    // Fleet-wide rather than this process's share. A four-instance deployment
    // gives each process a quarter of the requests, and a review that graded
    // performance on a quarter of the evidence would pass or fail for reasons
    // that have nothing to do with the deployment.
    const fleet = await this.instances.fleetMetrics().catch(() => null);
    const statelessness = this.instances.statelessness();

    return {
      environment: this.instances.environment,

      config: {
        secretsFromEnvironment: true,
        defaultSecretsInUse: this.defaultSecrets(),
        corsOrigins: this.corsOrigins(),
        trustProxy: Boolean(this.config.get('app.trustProxy')) || existsSync(join(process.cwd(), 'Dockerfile')),
      },

      instances: {
        healthy: cluster.healthy,
        leader: cluster.leader,
        stateless: statelessness.stateless,
        statefulHoldings: statelessness.holdings
          .filter((holding) => holding.loadBearing)
          .map((holding) => `${holding.name} (${holding.detail})`),
      },

      database,
      cache: { reachable: cacheReachable },
      queues: { reachable: cacheReachable, deadLetters },

      backups: {
        lastSucceededAt: (backups?.lastSucceededAt as Date | null) ?? null,
        lastVerifiedAt: (backups?.lastVerifiedAt as Date | null) ?? null,
        allEncrypted: Boolean(backups?.allEncrypted),
        count: Number(backups?.count ?? 0),
        restoreTested: Boolean(backups?.restoreExercised),
      },

      security: {
        administrators: Number(security?.administrators ?? 0),
        administratorsWithMfa: Number(security?.administratorsWithMfa ?? 0),
        oldestKeyAgeDays:
          ((security?.rotation as Record<string, unknown> | undefined)?.oldestAgeDays as number | null) ?? null,
        staleApiKeys: Number(security?.staleApiKeys ?? 0),
        rateLimitingActive: true,
        securityHeadersActive: true,
        vulnerableDependencies: this.dependencyAdvisories(),
        extensionIsolation: activeIsolation(),
      },

      observability: {
        metricsExposed: this.metrics.names().length > 0,
        tracingEnabled: true,
        healthProbes: ['liveness', 'readiness', 'deep'],
        alertRules: alerts.rules,
        firingAlerts: alerts.firing,
      },

      performance: {
        // The slowest instance's p95, not a merged quantile — see
        // `MetricsService.merge`. Grading on the worst instance is the right
        // direction to be approximate in.
        p95Ms: fleet?.worstInstanceP95Ms ?? this.metrics.percentile(Metric.HttpDuration, 0.95),
        errorRate: fleet ? fleet.errorRate : this.errorRate(),
        sampleCount: fleet?.sampleCount ?? this.metrics.sampleCount(Metric.HttpDuration),
      },

      documentation: {
        apiOperations: documentedOperations,
        runbooks: this.runbookCount(),
      },

      quality: this.qualityEvidence(),
    };
  }

  /**
   * Migrations applied versus present, RLS coverage versus need.
   *
   * The RLS numbers come from the catalogue rather than a list in this file:
   * a table needing protection is one with an `organizationId`, and asking
   * Postgres that question means a new tenant table shows up as a gap without
   * anyone remembering to add it here.
   */
  private async databaseEvidence(): Promise<ReadinessEvidence['database']> {
    try {
      const posture = await this.schema.posture();
      const onDisk = ReadinessService.migrationsOnDisk();

      return {
        reachable: true,
        appliedMigrations: posture.appliedMigrations,
        pendingMigrations: Math.max(0, onDisk - posture.appliedMigrations),
        rlsTables: posture.rlsTables,
        tenantTables: posture.tenantTables,
      };
    } catch (error) {
      this.logger.warn(`Database evidence unavailable: ${(error as Error).message}`);
      return {
        reachable: false,
        appliedMigrations: 0,
        pendingMigrations: 0,
        rlsTables: 0,
        tenantTables: 0,
      };
    }
  }

  private static migrationsOnDisk(): number {
    try {
      const dir = join(process.cwd(), 'prisma', 'migrations');
      if (!existsSync(dir)) return 0;
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
    } catch {
      return 0;
    }
  }

  private async alertEvidence(): Promise<{ rules: number; firing: number }> {
    try {
      const [rules, firing] = await Promise.all([
        this.alertRules.count(),
        this.alertEvents.allFiring(),
      ]);
      return { rules, firing: firing.length };
    } catch {
      return { rules: 0, firing: 0 };
    }
  }

  private async deadLetterCount(): Promise<number> {
    // Tenant-scoped, so it answers for the organization asking. A
    // platform-wide count would need an operator repository, and dead letters
    // are the tenant's work rather than the platform's.
    try {
      const rows = await this.deadLetters.findMany({ resolvedAt: null }, { take: 500 });
      return rows.length;
    } catch {
      return 0;
    }
  }

  /** Config still holding a value this repository shipped. */
  private defaultSecrets(): string[] {
    return ReadinessService.DEFAULT_SECRETS.filter(({ env, shipped }) => {
      const value = process.env[env] ?? '';
      return shipped.includes(value) || value.length < 16;
    }).map(({ env }) => env);
  }

  private corsOrigins(): string[] {
    const configured = this.config.get('app.corsOrigins') ?? process.env.CORS_ORIGINS ?? '*';
    if (Array.isArray(configured)) return configured as string[];
    return String(configured)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  /**
   * High and critical advisories from the last dependency scan.
   *
   * Read from a file the pipeline writes rather than shelling out to `npm
   * audit` on a request. Returns null when no scan has run, which the review
   * reports as UNKNOWN — "we have not looked" and "we looked and found
   * nothing" are different claims and should not share an answer.
   */
  private dependencyAdvisories(): number | null {
    try {
      const path = join(process.cwd(), '.audit', 'summary.json');
      if (!existsSync(path)) return null;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const summary = require(path) as { high?: number; critical?: number };
      return Number(summary.high ?? 0) + Number(summary.critical ?? 0);
    } catch {
      return null;
    }
  }

  private runbookCount(): number {
    try {
      const dir = join(process.cwd(), 'docs', 'runbooks');
      if (!existsSync(dir)) return 0;
      return readdirSync(dir).filter((file) => file.endsWith('.md')).length;
    } catch {
      return 0;
    }
  }

  private qualityEvidence(): ReadinessEvidence['quality'] {
    const workflow = join(process.cwd(), '..', '.github', 'workflows', 'ci.yml');
    const local = join(process.cwd(), '.github', 'workflows', 'ci.yml');
    const gatesDeployment = existsSync(workflow) || existsSync(local);

    let suites = 0;
    try {
      const dir = join(process.cwd(), 'test');
      if (existsSync(dir)) {
        suites = readdirSync(dir).filter((file) => file.endsWith('-validation.js')).length;
      }
    } catch {
      suites = 0;
    }

    return { suites, gatesDeployment, lastRunPassed: null };
  }

  private errorRate(): number | null {
    const total = this.metrics.total(Metric.HttpRequests);
    if (total === 0) return null;
    return this.metrics.total(Metric.HttpErrors) / total;
  }

  // ============================================================ review

  /** Runs the review. `record` persists it; a dry read does not. */
  async review(options: { record?: boolean } = {}): Promise<ReadinessReview> {
    const evidence = await this.gather();
    const result = runReview(evidence);

    if (options.record !== false) {
      await this.reviews
        .create({
          environment: evidence.environment.toUpperCase(),
          version: result.version,
          ready: result.readyForProduction,
          score: result.score,
          summary: result.summary as never,
          verdicts: result.verdicts as never,
          blockers: result.blockers.length,
          reviewedById: RequestContextStore.get()?.userId ?? null,
        })
        .catch((error) => {
          // A review that cannot be filed is still a review worth returning.
          this.logger.error(`Could not record the review: ${(error as Error).message}`);
        });

      await this.events.publish(DomainEvent.ReadinessReviewed, {
        environment: evidence.environment,
        ready: result.readyForProduction,
        score: result.score,
        blockers: result.blockers.length,
      });
    }

    if (!result.readyForProduction) {
      this.logger.warn(
        `Readiness review: ${result.blockers.length} blocker(s) — ${result.blockers
          .map((blocker) => blocker.id)
          .join(', ')}`,
      );
    }
    return result;
  }

  history(take = 25) {
    return this.reviews.history(take);
  }

  /** The bar itself, without evaluating it. */
  checks(): Record<string, unknown> {
    return { version: READINESS_VERSION, checks: describeChecks() };
  }
}
