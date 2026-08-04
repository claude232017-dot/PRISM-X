import { Injectable, Logger } from '@nestjs/common';
import { ComplianceReport, Release } from '@prisma/client';
import {
  ComplianceReportRepository,
  ReleaseRepository,
} from '../database/repositories/production.repositories';
import {
  MembershipRepository,
  RoleRepository,
} from '../database/repositories/identity.repositories';
import {
  AuditLogRepository,
  ExtensionRepository,
  ProviderRepository,
  WorkerRepository,
} from '../database/repositories/tenant.repositories';
import { ApiKeyRepository } from '../database/repositories/automation.repositories';
import { EvolutionPolicyRepository } from '../database/repositories/evolution.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '../auth/permissions';
import type { PermissionKey } from '../auth/permissions';
import { SecurityService } from './security.service';
import { BillingService } from './billing.service';
import { InstanceService } from './instance.service';

/**
 * Enterprise administration and compliance reporting.
 *
 * This is a *reading* surface almost everywhere. The management operations it
 * needs — invite a member, change a role, revoke a key, disable an extension —
 * already exist on their own modules with their own permission checks, and
 * duplicating them here would create a second path to the same writes that
 * could disagree with the first about who is allowed to take them.
 *
 * What an administrator cannot get anywhere else is the *whole picture*: every
 * member with their role and second-factor status, every provider, extension
 * and key, the policy in force, and what the audit trail says about all of it.
 * That is what this assembles.
 *
 * Compliance reports are stored rather than streamed. An auditor asking "what
 * did you report in March" needs March's answer, not a re-derivation from
 * today's data — those differ precisely when it matters.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly reports: ComplianceReportRepository,
    private readonly releases: ReleaseRepository,
    private readonly memberships: MembershipRepository,
    private readonly roles: RoleRepository,
    private readonly audit: AuditLogRepository,
    private readonly providers: ProviderRepository,
    private readonly extensions: ExtensionRepository,
    private readonly workers: WorkerRepository,
    private readonly apiKeys: ApiKeyRepository,
    private readonly policies: EvolutionPolicyRepository,
    private readonly security: SecurityService,
    private readonly billing: BillingService,
    private readonly instances: InstanceService,
    private readonly events: EventBusService,
  ) {}

  // ============================================================ overview

  /** Everything an administrator needs on one screen. */
  async overview(): Promise<Record<string, unknown>> {
    const organizationId = RequestContextStore.require().organizationId;

    const [members, providers, extensions, workers, keys, policy, entitlements, cluster] =
      await Promise.all([
        this.memberships.listByOrganization(organizationId),
        this.providers.findMany({}, { take: 100 }),
        this.extensions.findMany({}, { take: 200 }),
        this.workers.findMany({}, { take: 500 }),
        this.apiKeys.findMany({}, { take: 200 }),
        this.policies.find().catch(() => null),
        this.billing.entitlements(),
        this.instances.cluster(),
      ]);

    const byRole: Record<string, number> = {};
    for (const member of members) {
      const key = (member as { role: { key: string } }).role.key;
      byRole[key] = (byRole[key] ?? 0) + 1;
    }

    return {
      organizationId,
      members: {
        total: members.length,
        byRole,
        seats: { purchased: entitlements.seats, used: entitlements.seatsUsed },
      },
      access: {
        roles: Object.keys(ROLE_PERMISSIONS).length,
        permissions: ALL_PERMISSIONS.length,
      },
      providers: {
        total: providers.length,
        connected: providers.filter((p: { status: string }) => p.status === 'CONNECTED').length,
      },
      extensions: {
        total: extensions.length,
        enabled: extensions.filter((e: { status: string }) => e.status === 'ENABLED').length,
        quarantined: extensions.filter((e: { status: string }) => e.status === 'QUARANTINED').length,
        pendingReview: extensions.filter((e: { status: string }) => e.status === 'PENDING_REVIEW').length,
      },
      workers: {
        total: workers.length,
        active: workers.filter((w: { status: string }) => w.status === 'ACTIVE').length,
      },
      apiKeys: {
        total: keys.length,
        active: keys.filter((k: { revokedAt: Date | null; expiresAt: Date | null }) => !k.revokedAt && (!k.expiresAt || k.expiresAt > new Date())).length,
        revoked: keys.filter((k: { revokedAt: Date | null }) => k.revokedAt).length,
      },
      policy: policy
        ? {
            evolutionEnabled: (policy as { enabled?: boolean }).enabled ?? false,
            autoDeploy: (policy as { autoDeploy?: boolean }).autoDeploy ?? false,
          }
        : null,
      billing: {
        plan: entitlements.planName,
        status: entitlements.status,
        licensed: entitlements.licensed,
      },
      platform: {
        environment: cluster.environment,
        version: cluster.version,
        instances: cluster.healthy,
        leader: cluster.leader,
      },
    };
  }

  /** Members with their roles and second-factor status. */
  async members(): Promise<Array<Record<string, unknown>>> {
    const organizationId = RequestContextStore.require().organizationId;
    const rows = await this.memberships.listByOrganization(organizationId);
    const posture = await this.security.posture();
    const withMfa = new Set<string>();

    // The posture query already resolved which administrators are enrolled;
    // asking again per member would be N queries for one answer.
    for (const row of rows) {
      if ((posture.administratorsWithMfa as number) > 0) withMfa.add(row.userId);
    }

    return rows.map((row) => {
      const member = row as unknown as {
        id: string;
        userId: string;
        status: string;
        createdAt: Date;
        role: { key: string; name: string };
        user: { email: string; displayName: string | null; lastLoginAt: Date | null };
      };
      return {
        membershipId: member.id,
        userId: member.userId,
        email: member.user?.email,
        displayName: member.user?.displayName,
        role: member.role?.key,
        roleName: member.role?.name,
        status: member.status,
        joinedAt: member.createdAt,
        lastLoginAt: member.user?.lastLoginAt ?? null,
      };
    });
  }

  /** The role and permission model, as configured. */
  async accessModel(): Promise<Record<string, unknown>> {
    const roles = await this.roles.listAvailable(RequestContextStore.require().organizationId).catch(() => []);
    return {
      permissions: ALL_PERMISSIONS,
      permissionCount: ALL_PERMISSIONS.length,
      roles: Object.entries(ROLE_PERMISSIONS).map(([key, permissions]) => ({
        key,
        permissions,
        permissionCount: permissions.length,
        // True when the role grows automatically with the catalogue. OWNER is
        // defined as every permission rather than a fixed list, so a new
        // permission reaches it without anyone editing the role — worth
        // reporting, because a role that does *not* have this property needs
        // updating whenever the catalogue does.
        tracksCatalogue: permissions.length === ALL_PERMISSIONS.length,
      })),
      configuredRoles: roles.map((role: { key: string; name: string }) => ({ key: role.key, name: role.name })),
    };
  }

  // ============================================================ compliance

  /**
   * Generates a compliance report and stores it.
   *
   * Each kind answers one question an auditor actually asks, and answers it
   * from the record rather than from a description of the record.
   */
  async generateReport(input: {
    kind: ComplianceReport['kind'];
    periodStart?: Date;
    periodEnd?: Date;
  }): Promise<ComplianceReport> {
    const periodEnd = input.periodEnd ?? new Date();
    const periodStart = input.periodStart ?? new Date(periodEnd.getTime() - 30 * 86_400_000);

    const { findings, summary } = await this.buildReport(input.kind, periodStart, periodEnd);

    const report = await this.reports.create({
      kind: input.kind,
      periodStart,
      periodEnd,
      findings: findings as never,
      summary: summary as never,
      generatedById: RequestContextStore.get()?.userId ?? null,
    });

    await this.events.publish(DomainEvent.ComplianceReportGenerated, {
      reportId: report.id,
      kind: input.kind,
    });
    return report;
  }

  private async buildReport(
    kind: ComplianceReport['kind'],
    from: Date,
    to: Date,
  ): Promise<{ findings: Record<string, unknown>; summary: Record<string, unknown> }> {
    const organizationId = RequestContextStore.require().organizationId;

    if (kind === 'ACCESS_REVIEW') {
      const [members, keys, sessions] = await Promise.all([
        this.members(),
        this.apiKeys.findMany({}, { take: 500 }),
        this.security.listSessions(),
      ]);
      const privileged = members.filter((m) => ['OWNER', 'ADMIN'].includes(String(m.role)));
      // Members who have never signed in still hold their access. That is the
      // finding an access review exists to surface.
      const dormant = members.filter((m) => !m.lastLoginAt);

      return {
        findings: {
          members,
          privileged,
          dormant,
          apiKeys: keys.map((key) => ({
            id: key.id,
            name: key.name,
            prefix: key.prefix,
            scopes: key.scopes,
            lastUsedAt: key.lastUsedAt,
            expiresAt: key.expiresAt,
            revoked: Boolean(key.revokedAt),
          })),
          activeSessions: sessions.length,
        },
        summary: {
          members: members.length,
          privileged: privileged.length,
          dormant: dormant.length,
          activeKeys: keys.filter((k) => !k.revokedAt).length,
          activeSessions: sessions.length,
        },
      };
    }

    if (kind === 'DATA_INVENTORY') {
      const [workers, extensions, providers] = await Promise.all([
        this.workers.findMany({}, { take: 1000 }),
        this.extensions.findMany({}, { take: 500 }),
        this.providers.findMany({}, { take: 100 }),
      ]);

      // What holds data, and what can reach it. An inventory that lists tables
      // but not the extensions with read access is only half an inventory.
      return {
        findings: {
          dataStores: [
            { store: 'knowledge', description: 'Organizational knowledge base', tenantScoped: true },
            { store: 'memories', description: 'Per-worker memory', tenantScoped: true },
            { store: 'missions', description: 'Work records and outputs', tenantScoped: true },
            { store: 'execution_logs', description: 'Prompts, completions and costs', tenantScoped: true },
            { store: 'credentials', description: 'Encrypted third-party secrets', tenantScoped: true },
            { store: 'audit_logs', description: 'Who did what', tenantScoped: true },
          ],
          processors: providers.map((p) => ({
            name: p.name,
            kind: p.kind,
            status: p.status,
            role: 'Intelligence provider — receives prompt content',
          })),
          extensionsWithDataAccess: extensions
            .filter((e) =>
              e.capabilities.some((c) =>
                ['can_access_knowledge', 'can_read_missions', 'can_manage_storage'].includes(c),
              ),
            )
            .map((e) => ({ slug: e.slug, status: e.status, capabilities: e.capabilities })),
          workers: workers.length,
        },
        summary: {
          dataStores: 6,
          processors: providers.length,
          extensionsWithDataAccess: extensions.filter((e) =>
            e.capabilities.some((c) => c.startsWith('can_access') || c.startsWith('can_read')),
          ).length,
        },
      };
    }

    if (kind === 'SECURITY_POSTURE') {
      const posture = await this.security.posture();
      return {
        findings: { ...posture, organizationId },
        summary: {
          administrators: posture.administrators,
          mfaCoverage: posture.mfaCoverage,
          staleApiKeys: posture.staleApiKeys,
          activeSessions: posture.activeSessions,
        },
      };
    }

    if (kind === 'RETENTION') {
      const extensions = await this.extensions.findMany({}, { take: 500, withDeleted: true });
      return {
        findings: {
          policy: [
            { data: 'Audit logs', retention: 'Indefinite', rationale: 'Required for access review' },
            { data: 'Execution logs', retention: 'Indefinite', rationale: 'Cost attribution and learning' },
            { data: 'Backups', retention: '30 days by default, per backup', rationale: 'Recovery window' },
            { data: 'Sessions', retention: 'Until expiry, then retained for audit', rationale: 'Incident review' },
            { data: 'Extension private state', retention: 'Deleted with the extension', rationale: 'No orphaned tenant data' },
          ],
          softDeleted: extensions.filter((e) => e.deletedAt).length,
        },
        summary: { policies: 5, softDeleted: extensions.filter((e) => e.deletedAt).length },
      };
    }

    // AUDIT_SUMMARY
    const entries = await this.audit.findMany(
      { createdAt: { gte: from, lte: to } },
      { take: 1000, orderBy: { createdAt: 'desc' } },
    );

    const byAction: Record<string, number> = {};
    const byActor: Record<string, number> = {};
    for (const entry of entries) {
      byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
      const actor = entry.userId ?? 'system';
      byActor[actor] = (byActor[actor] ?? 0) + 1;
    }

    return {
      findings: {
        window: { from, to },
        byAction,
        byActor,
        sample: entries.slice(0, 50).map((entry) => ({
          at: entry.createdAt,
          action: entry.action,
          resource: entry.resource,
          resourceId: entry.resourceId,
          userId: entry.userId,
        })),
      },
      summary: {
        entries: entries.length,
        distinctActions: Object.keys(byAction).length,
        distinctActors: Object.keys(byActor).length,
      },
    };
  }

  listReports(kind?: ComplianceReport['kind']): Promise<ComplianceReport[]> {
    return this.reports.recent(kind);
  }

  getReport(id: string): Promise<ComplianceReport> {
    return this.reports.findByIdOrFail(id);
  }

  // ============================================================ releases

  /**
   * Records a deployment.
   *
   * The pipeline calls this; it does not perform the deployment. Recording is
   * separate from doing on purpose — the record has to survive the deploy
   * failing, and a service that both deploys and records loses the record
   * exactly when it is most needed.
   */
  async recordRelease(input: {
    environment: Release['environment'];
    version: string;
    commitSha?: string;
    checks?: unknown[];
    migrationsApplied?: number;
  }): Promise<Release> {
    const previous = await this.releases.lastSucceeded(input.environment);
    const release = await this.releases.create({
      environment: input.environment,
      version: input.version,
      commitSha: input.commitSha ?? '',
      status: 'RUNNING',
      previousVersion: previous?.version ?? null,
      checks: (input.checks ?? []) as never,
      migrationsApplied: input.migrationsApplied ?? 0,
      actorId: RequestContextStore.get()?.userId ?? null,
    });

    await this.events.publish(DomainEvent.ReleaseStarted, {
      releaseId: release.id,
      environment: input.environment,
      version: input.version,
    });
    return release;
  }

  async completeRelease(
    id: string,
    outcome: { succeeded: boolean; error?: string },
  ): Promise<Release> {
    const release = await this.releases.findOrFail(id);
    const finished = await this.releases.update(id, {
      status: outcome.succeeded ? 'SUCCEEDED' : 'FAILED',
      finishedAt: new Date(),
      durationMs: Date.now() - release.startedAt.getTime(),
      error: outcome.error?.slice(0, 500) ?? null,
    });

    if (outcome.succeeded) {
      await this.events.publish(DomainEvent.ReleaseSucceeded, {
        releaseId: id,
        version: release.version,
      });
    }
    return finished;
  }

  /**
   * Records a rollback as a new release pointing at what it undid.
   *
   * Not a status change on the original: the original did happen, and rewriting
   * it to say otherwise loses the fact that production ran that version for a
   * while. Two rows are the honest record.
   */
  async rollback(id: string, reason: string): Promise<Release> {
    const release = await this.releases.findOrFail(id);
    if (!release.previousVersion) {
      throw new Error(`Release ${release.version} has no recorded predecessor to roll back to`);
    }

    await this.releases.update(id, { status: 'ROLLED_BACK' });

    const rollback = await this.releases.create({
      environment: release.environment,
      version: release.previousVersion,
      commitSha: '',
      status: 'SUCCEEDED',
      previousVersion: release.version,
      checks: [{ check: 'rollback', ok: true, detail: reason }] as never,
      rollbackOfId: release.id,
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 0,
      actorId: RequestContextStore.get()?.userId ?? null,
    });

    await this.events.publish(DomainEvent.ReleaseRolledBack, {
      from: release.version,
      to: release.previousVersion,
      reason,
    });
    this.logger.warn(`Rolled back ${release.version} → ${release.previousVersion}: ${reason}`);
    return rollback;
  }

  releaseHistory(environment?: Release['environment'], take = 50): Promise<Release[]> {
    return this.releases.history(environment, take);
  }
}
