import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AlertEvent,
  AlertRule,
  Backup,
  ComplianceReport,
  Instance,
  Invoice,
  IpAllowEntry,
  MfaEnrollment,
  Plan,
  ReadinessReview,
  Release,
  RestoreRun,
  SecretRotation,
  Subscription,
  UserSession,
} from '@prisma/client';
import { BaseRepository } from './base.repository';
import { PrismaService } from '../prisma.service';

/**
 * Phase 8 repositories.
 *
 * Three scopes, matching the three RLS shapes in the Phase 8 migration.
 *
 *  - **Tenant repositories** extend BaseRepository: subscriptions, invoices,
 *    sessions, allowlists, compliance reports.
 *
 *  - **The plan catalogue** is global and read-mostly. Writes are operator
 *    actions gated by `admin:manage`.
 *
 *  - **Operator repositories** describe the platform rather than a tenant —
 *    instances, backups, alerts, rotations, releases, readiness reviews. They
 *    cannot extend BaseRepository because they have no `organizationId` to
 *    scope by, and they should not: an instance belongs to the deployment, not
 *    to a customer. What replaces tenant scoping is that the tables are
 *    unreachable from any constrained database session at all (RLS enabled,
 *    no policies), so the only route is this layer.
 */

// ============================================================
// Tenant-scoped
// ============================================================

@Injectable()
export class SubscriptionRepository extends BaseRepository<Subscription> {
  protected readonly modelName = 'subscription';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  current(): Promise<Subscription | null> {
    return this.delegate().findFirst({ where: this.scope({}) });
  }

  /**
   * Subscriptions whose period has ended, across every organization.
   *
   * Deliberately unscoped: billing runs on a schedule for everyone at once,
   * and a tenant-scoped query would bill only whoever happened to be logged in.
   */
  dueForRenewal(now = new Date()): Promise<Subscription[]> {
    return this.prisma.subscription.findMany({
      where: {
        currentPeriodEnd: { lte: now },
        status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
      },
      orderBy: { currentPeriodEnd: 'asc' },
    });
  }
}

@Injectable()
export class InvoiceRepository extends BaseRepository<Invoice> {
  protected readonly modelName = 'invoice';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  history(take = 50): Promise<Invoice[]> {
    return this.findMany({}, { take, orderBy: { periodStart: 'desc' } });
  }

  /** Next sequential number for this organization. */
  async nextNumber(): Promise<string> {
    const count = await this.delegate().count({ where: this.scope({}) });
    return `INV-${String(count + 1).padStart(5, '0')}`;
  }
}

@Injectable()
export class UserSessionRepository extends BaseRepository<UserSession> {
  protected readonly modelName = 'userSession';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Resolves a presented token. Unscoped by necessity: the session *is* the
   * claim to an organization, so there is no context until it resolves.
   */
  findByTokenUnscoped(tokenHash: string): Promise<UserSession | null> {
    return this.prisma.userSession.findFirst({
      where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  active(userId?: string): Promise<UserSession[]> {
    return this.findMany(
      { revokedAt: null, expiresAt: { gt: new Date() }, ...(userId ? { userId } : {}) },
      { orderBy: { lastSeenAt: 'desc' } },
    );
  }

  async revoke(id: string, reason: string): Promise<number> {
    const { count } = await this.delegate().updateMany({
      where: this.scope({ id, revokedAt: null }),
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }

  /** Ends every session for a user — what a compromised password requires. */
  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    const { count } = await this.delegate().updateMany({
      where: this.scope({ userId, revokedAt: null }),
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }

  touch(id: string): Promise<unknown> {
    return this.prisma.userSession.update({
      where: { id },
      data: { lastSeenAt: new Date() },
    });
  }
}

@Injectable()
export class IpAllowRepository extends BaseRepository<IpAllowEntry> {
  protected readonly modelName = 'ipAllowEntry';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  enabled(): Promise<IpAllowEntry[]> {
    return this.findMany({ enabled: true }, { orderBy: { createdAt: 'asc' } });
  }

  /** Unscoped: the check runs before a request has proved which tenant it is. */
  enabledForOrganization(organizationId: string): Promise<IpAllowEntry[]> {
    return this.prisma.ipAllowEntry.findMany({
      where: { organizationId, enabled: true },
    });
  }
}

@Injectable()
export class ComplianceReportRepository extends BaseRepository<ComplianceReport> {
  protected readonly modelName = 'complianceReport';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  recent(kind?: ComplianceReport['kind'], take = 50): Promise<ComplianceReport[]> {
    return this.findMany(kind ? { kind } : {}, { take, orderBy: { createdAt: 'desc' } });
  }
}

// ============================================================
// Plan catalogue
// ============================================================

@Injectable()
export class PlanRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(key: string): Promise<Plan | null> {
    return this.prisma.plan.findUnique({ where: { key } });
  }

  async findOrFail(key: string): Promise<Plan> {
    const plan = await this.find(key);
    if (!plan) throw new NotFoundException(`Plan "${key}" was not found`);
    return plan;
  }

  list(includeHidden = false): Promise<Plan[]> {
    return this.prisma.plan.findMany({
      where: { active: true, ...(includeHidden ? {} : { isPublic: true }) },
      orderBy: { sortOrder: 'asc' },
    });
  }

  upsert(key: string, data: Record<string, unknown>): Promise<Plan> {
    return this.prisma.plan.upsert({
      where: { key },
      create: { key, ...data } as never,
      update: data as never,
    });
  }
}

// ============================================================
// Operator scope
// ============================================================

@Injectable()
export class InstanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(instanceId: string): Promise<Instance | null> {
    return this.prisma.instance.findUnique({ where: { instanceId } });
  }

  register(data: Record<string, unknown> & { instanceId: string }): Promise<Instance> {
    return this.prisma.instance.upsert({
      where: { instanceId: data.instanceId },
      create: data as never,
      update: { ...data, stoppedAt: null } as never,
    });
  }

  heartbeat(instanceId: string, data: Record<string, unknown>): Promise<Instance> {
    return this.prisma.instance.update({
      where: { instanceId },
      data: { ...data, lastHeartbeat: new Date() },
    });
  }

  /** Instances that have reported within the window. */
  healthy(since: Date): Promise<Instance[]> {
    return this.prisma.instance.findMany({
      where: { lastHeartbeat: { gte: since }, stoppedAt: null },
      orderBy: { startedAt: 'asc' },
    });
  }

  all(take = 100): Promise<Instance[]> {
    return this.prisma.instance.findMany({ take, orderBy: { lastHeartbeat: 'desc' } });
  }

  /**
   * Claims the scheduler lease, or renews it.
   *
   * One statement, and the `WHERE` is what makes it safe: the lease is granted
   * only when nobody holds it, it has expired, or the claimant already holds
   * it. Two instances racing produce one winner because Postgres serialises
   * the update, not because the application checked first.
   */
  async claimLeadership(instanceId: string, leaseMs: number): Promise<boolean> {
    const now = new Date();
    const until = new Date(now.getTime() + leaseMs);

    const claimed = await this.prisma.$executeRaw`
      UPDATE instances
         SET "leaderUntil" = ${until}
       WHERE "instanceId" = ${instanceId}
         AND NOT EXISTS (
           SELECT 1 FROM instances other
            WHERE other."leaderUntil" > ${now}
              AND other."instanceId" <> ${instanceId}
         )
    `;
    return claimed > 0;
  }

  currentLeader(): Promise<Instance | null> {
    return this.prisma.instance.findFirst({
      where: { leaderUntil: { gt: new Date() } },
      orderBy: { leaderUntil: 'desc' },
    });
  }

  async releaseLeadership(instanceId: string): Promise<void> {
    await this.prisma.instance.updateMany({
      where: { instanceId },
      data: { leaderUntil: null },
    });
  }

  async markStopped(instanceId: string): Promise<void> {
    await this.prisma.instance
      .update({
        where: { instanceId },
        data: { status: 'STOPPED', stoppedAt: new Date(), leaderUntil: null },
      })
      .catch(() => undefined);
  }

  /** Flags instances that stopped reporting, so their work can be reclaimed. */
  async markUnreachable(before: Date): Promise<number> {
    const { count } = await this.prisma.instance.updateMany({
      where: { lastHeartbeat: { lt: before }, status: { in: ['STARTING', 'HEALTHY', 'DRAINING'] } },
      data: { status: 'UNREACHABLE' },
    });
    return count;
  }
}

@Injectable()
export class BackupRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Record<string, unknown>): Promise<Backup> {
    return this.prisma.backup.create({ data: data as never });
  }

  update(id: string, data: Record<string, unknown>): Promise<Backup> {
    return this.prisma.backup.update({ where: { id }, data });
  }

  find(id: string): Promise<Backup | null> {
    return this.prisma.backup.findUnique({ where: { id } });
  }

  async findOrFail(id: string): Promise<Backup> {
    const backup = await this.find(id);
    if (!backup) throw new NotFoundException(`Backup "${id}" was not found`);
    return backup;
  }

  list(take = 50): Promise<Backup[]> {
    return this.prisma.backup.findMany({ take, orderBy: { startedAt: 'desc' } });
  }

  latestSucceeded(kind?: Backup['kind']): Promise<Backup | null> {
    return this.prisma.backup.findFirst({
      where: { status: { in: ['SUCCEEDED', 'VERIFIED'] }, ...(kind ? { kind } : {}) },
      orderBy: { finishedAt: 'desc' },
    });
  }

  latestVerified(): Promise<Backup | null> {
    return this.prisma.backup.findFirst({
      where: { verifiedAt: { not: null }, status: 'VERIFIED' },
      orderBy: { verifiedAt: 'desc' },
    });
  }

  async posture(): Promise<{ count: number; allEncrypted: boolean; unencrypted: number }> {
    const rows = await this.prisma.backup.findMany({
      where: { status: { in: ['SUCCEEDED', 'VERIFIED'] } },
      select: { encrypted: true },
    });
    const unencrypted = rows.filter((row) => !row.encrypted).length;
    return { count: rows.length, allEncrypted: unencrypted === 0, unencrypted };
  }

  expired(now = new Date()): Promise<Backup[]> {
    return this.prisma.backup.findMany({
      where: { retentionUntil: { lt: now }, status: { not: 'EXPIRED' } },
    });
  }
}

@Injectable()
export class RestoreRunRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Record<string, unknown>): Promise<RestoreRun> {
    return this.prisma.restoreRun.create({ data: data as never });
  }

  update(id: string, data: Record<string, unknown>): Promise<RestoreRun> {
    return this.prisma.restoreRun.update({ where: { id }, data });
  }

  list(take = 50): Promise<RestoreRun[]> {
    return this.prisma.restoreRun.findMany({ take, orderBy: { startedAt: 'desc' } });
  }

  /** True once a restore has actually written something, not merely verified. */
  async everExercised(): Promise<boolean> {
    const count = await this.prisma.restoreRun.count({
      where: { status: 'SUCCEEDED', dryRun: false },
    });
    return count > 0;
  }
}

@Injectable()
export class AlertRuleRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(enabledOnly = false): Promise<AlertRule[]> {
    return this.prisma.alertRule.findMany({
      where: enabledOnly ? { enabled: true } : {},
      orderBy: { key: 'asc' },
    });
  }

  find(key: string): Promise<AlertRule | null> {
    return this.prisma.alertRule.findUnique({ where: { key } });
  }

  upsert(key: string, data: Record<string, unknown>): Promise<AlertRule> {
    return this.prisma.alertRule.upsert({
      where: { key },
      create: { key, ...data } as never,
      update: data as never,
    });
  }

  count(): Promise<number> {
    return this.prisma.alertRule.count({ where: { enabled: true } });
  }
}

@Injectable()
export class AlertEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Record<string, unknown>): Promise<AlertEvent> {
    return this.prisma.alertEvent.create({ data: data as never });
  }

  /** The open event for a rule, if it is already firing. */
  firing(ruleKey: string): Promise<AlertEvent | null> {
    return this.prisma.alertEvent.findFirst({
      where: { ruleKey, status: 'FIRING' },
      orderBy: { firedAt: 'desc' },
    });
  }

  allFiring(): Promise<AlertEvent[]> {
    return this.prisma.alertEvent.findMany({
      where: { status: 'FIRING' },
      orderBy: { firedAt: 'desc' },
    });
  }

  history(take = 100): Promise<AlertEvent[]> {
    return this.prisma.alertEvent.findMany({ take, orderBy: { firedAt: 'desc' } });
  }

  update(id: string, data: Record<string, unknown>): Promise<AlertEvent> {
    return this.prisma.alertEvent.update({ where: { id }, data });
  }
}

@Injectable()
export class SecretRotationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Record<string, unknown>): Promise<SecretRotation> {
    return this.prisma.secretRotation.create({ data: data as never });
  }

  update(id: string, data: Record<string, unknown>): Promise<SecretRotation> {
    return this.prisma.secretRotation.update({ where: { id }, data });
  }

  list(take = 50): Promise<SecretRotation[]> {
    return this.prisma.secretRotation.findMany({ take, orderBy: { startedAt: 'desc' } });
  }

  latest(scope: SecretRotation['scope']): Promise<SecretRotation | null> {
    return this.prisma.secretRotation.findFirst({
      where: { scope, status: { in: ['SUCCEEDED', 'OVERLAPPING'] } },
      orderBy: { startedAt: 'desc' },
    });
  }
}

@Injectable()
export class ReleaseRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Record<string, unknown>): Promise<Release> {
    return this.prisma.release.create({ data: data as never });
  }

  update(id: string, data: Record<string, unknown>): Promise<Release> {
    return this.prisma.release.update({ where: { id }, data });
  }

  find(id: string): Promise<Release | null> {
    return this.prisma.release.findUnique({ where: { id } });
  }

  async findOrFail(id: string): Promise<Release> {
    const release = await this.find(id);
    if (!release) throw new NotFoundException(`Release "${id}" was not found`);
    return release;
  }

  history(environment?: Release['environment'], take = 50): Promise<Release[]> {
    return this.prisma.release.findMany({
      where: environment ? { environment } : {},
      take,
      orderBy: { startedAt: 'desc' },
    });
  }

  /** The last release that actually reached this environment. */
  lastSucceeded(environment: Release['environment']): Promise<Release | null> {
    return this.prisma.release.findFirst({
      where: { environment, status: 'SUCCEEDED' },
      orderBy: { finishedAt: 'desc' },
    });
  }
}

@Injectable()
export class ReadinessReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Record<string, unknown>): Promise<ReadinessReview> {
    return this.prisma.readinessReview.create({ data: data as never });
  }

  history(take = 25): Promise<ReadinessReview[]> {
    return this.prisma.readinessReview.findMany({ take, orderBy: { createdAt: 'desc' } });
  }

  latest(environment: ReadinessReview['environment']): Promise<ReadinessReview | null> {
    return this.prisma.readinessReview.findFirst({
      where: { environment },
      orderBy: { createdAt: 'desc' },
    });
  }
}

@Injectable()
export class MfaRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(userId: string): Promise<MfaEnrollment | null> {
    return this.prisma.mfaEnrollment.findUnique({ where: { userId } });
  }

  upsert(userId: string, data: Record<string, unknown>): Promise<MfaEnrollment> {
    return this.prisma.mfaEnrollment.upsert({
      where: { userId },
      create: { userId, ...data } as never,
      update: data as never,
    });
  }

  update(userId: string, data: Record<string, unknown>): Promise<MfaEnrollment> {
    return this.prisma.mfaEnrollment.update({ where: { userId }, data });
  }

  /** Confirmed, not-disabled enrolments among the given users. */
  async confirmedFor(userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    const rows = await this.prisma.mfaEnrollment.findMany({
      where: { userId: { in: userIds }, confirmedAt: { not: null }, disabledAt: null },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }
}

/**
 * Raw-SQL access for the two operations that cannot be expressed through a
 * model delegate: exporting arbitrary tables for a backup, and asking Postgres
 * about its own catalogue.
 *
 * Both belong here rather than in a service for the same reason every other
 * query does — the repository layer is the only place permitted to issue
 * database calls, and an exception carved out for "but this one is raw" is how
 * that rule stops being a rule.
 *
 * Table names are interpolated because a parameter cannot stand in for an
 * identifier. Every caller passes a name from a frozen constant; no
 * request-derived value reaches these strings, and `assertIdentifier` refuses
 * anything that is not a plain table name regardless.
 */
@Injectable()
export class SchemaRepository {
  constructor(private readonly prisma: PrismaService) {}

  private static assertIdentifier(name: string): string {
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
      throw new Error(`"${name}" is not a valid identifier`);
    }
    return name;
  }

  /** Every row of one table, capped. */
  exportTable(table: string, limit: number): Promise<Array<Record<string, unknown>>> {
    return this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM "${SchemaRepository.assertIdentifier(table)}" LIMIT ${Math.max(0, Math.floor(limit))}`,
    );
  }

  /**
   * Inserts one restored row, skipping anything that already exists. A restore
   * that clobbers rows newer than the backup turns a partial loss into a total
   * one.
   */
  async insertRow(table: string, row: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(row);
    if (!columns.length) return;

    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const quoted = columns
      .map((column) => `"${SchemaRepository.assertIdentifier(column)}"`)
      .join(', ');

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "${SchemaRepository.assertIdentifier(table)}" (${quoted}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      ...columns.map((column) => row[column]),
    );
  }

  /**
   * What Postgres says about its own shape.
   *
   * Tables needing row-level security are those carrying an `organizationId`,
   * asked of the catalogue rather than listed in code — so a new tenant table
   * shows up as a gap without anyone remembering to add it anywhere.
   */
  async posture(): Promise<{
    appliedMigrations: number;
    rlsTables: number;
    tenantTables: number;
  }> {
    const [applied] = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
    );
    const [rls] = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM pg_tables WHERE schemaname = 'public' AND rowsecurity`,
    );
    const [tenant] = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(DISTINCT table_name)::bigint AS count
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'organizationId'`,
    );

    return {
      appliedMigrations: Number(applied?.count ?? 0),
      rlsTables: Number(rls?.count ?? 0),
      tenantTables: Number(tenant?.count ?? 0),
    };
  }

  healthy(): Promise<boolean> {
    return this.prisma.isHealthy();
  }
}

export const PRODUCTION_REPOSITORIES = [
  SchemaRepository,
  SubscriptionRepository,
  InvoiceRepository,
  UserSessionRepository,
  IpAllowRepository,
  ComplianceReportRepository,
  PlanRepository,
  InstanceRepository,
  BackupRepository,
  RestoreRunRepository,
  AlertRuleRepository,
  AlertEventRepository,
  SecretRotationRepository,
  ReleaseRepository,
  ReadinessReviewRepository,
  MfaRepository,
];
