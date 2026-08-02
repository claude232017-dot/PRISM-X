import { Injectable } from '@nestjs/common';
import type {
  ApiKey,
  ApprovalRequest,
  DeadLetter,
  Notification,
  Trigger,
  WebhookDelivery,
  WebhookEndpoint,
  Workflow,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowVersion,
} from '@prisma/client';
import { BaseRepository } from './base.repository';
import { PrismaService } from '../prisma.service';
import { RequestContextStore } from '../../shared/context/request-context';

/**
 * Phase 3 repositories.
 *
 * Each declares a constructor that only calls super() — TypeScript emits the
 * `design:paramtypes` metadata Nest needs for injection only when a class
 * declares one.
 */

@Injectable()
export class WorkflowRepository extends BaseRepository<Workflow> {
  protected readonly modelName = 'workflow';
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findWithActiveVersion(id: string) {
    return this.findById(id, { include: { activeVersion: true } });
  }

  findActive(): Promise<Workflow[]> {
    return this.findMany({ status: 'ACTIVE' });
  }

  findTemplates(): Promise<Workflow[]> {
    return this.findMany({ isTemplate: true });
  }
}

@Injectable()
export class WorkflowVersionRepository extends BaseRepository<WorkflowVersion> {
  protected readonly modelName = 'workflowVersion';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  listForWorkflow(workflowId: string): Promise<WorkflowVersion[]> {
    return this.findMany({ workflowId }, { orderBy: { version: 'desc' } });
  }

  /** Next version number for a workflow. Versions are never reused. */
  async nextVersion(workflowId: string): Promise<number> {
    const existing = await this.findMany({ workflowId }, { orderBy: { version: 'desc' }, take: 1 });
    return (existing[0]?.version ?? 0) + 1;
  }
}

@Injectable()
export class WorkflowRunRepository extends BaseRepository<WorkflowRun> {
  protected readonly modelName = 'workflowRun';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findByIdempotencyKey(key: string): Promise<WorkflowRun | null> {
    return this.delegate().findFirst({ where: this.scope({ idempotencyKey: key }) });
  }

  countActive(workflowId: string): Promise<number> {
    return this.count({ workflowId, status: { in: ['PENDING', 'RUNNING', 'SLEEPING'] } });
  }

  findSuspended(): Promise<WorkflowRun[]> {
    return this.findMany({ status: { in: ['AWAITING_APPROVAL', 'SLEEPING'] } });
  }

  /** Aggregate run metrics for the automation dashboard. */
  async metrics(where: Record<string, unknown> = {}) {
    const { organizationId } = RequestContextStore.require();
    const scoped = { ...where, organizationId };

    const [aggregate, succeeded, failed] = await Promise.all([
      this.prisma.workflowRun.aggregate({
        where: scoped,
        _sum: { costUsd: true, totalTokens: true, durationMs: true, stepsRun: true },
        _avg: { durationMs: true },
        _count: true,
      }),
      this.prisma.workflowRun.count({ where: { ...scoped, status: 'SUCCEEDED' } }),
      this.prisma.workflowRun.count({
        where: { ...scoped, status: { in: ['FAILED', 'DEAD_LETTERED'] } },
      }),
    ]);

    const total = aggregate._count;
    const finished = succeeded + failed;

    return {
      executions: total,
      succeeded,
      failed,
      // null rather than 0 when nothing has finished: "no data yet" and "0%
      // success" are different facts.
      successRate: finished > 0 ? Math.round((succeeded / finished) * 100) : null,
      failureRate: finished > 0 ? Math.round((failed / finished) * 100) : null,
      averageDurationMs: Math.round(aggregate._avg.durationMs ?? 0),
      totalDurationMs: aggregate._sum.durationMs ?? 0,
      stepsRun: aggregate._sum.stepsRun ?? 0,
      aiCostUsd: Math.round((aggregate._sum.costUsd ?? 0) * 1e8) / 1e8,
      totalTokens: aggregate._sum.totalTokens ?? 0,
    };
  }

  async groupByWorkflow() {
    const { organizationId } = RequestContextStore.require();
    const rows = (await (this.prisma.workflowRun.groupBy as unknown as (
      a: unknown,
    ) => Promise<Record<string, unknown>[]>)({
      by: ['workflowId'],
      where: { organizationId },
      _sum: { costUsd: true, durationMs: true },
      _count: { _all: true },
    })) as Record<string, unknown>[];

    return rows.map((row) => ({
      workflowId: row.workflowId as string,
      executions: (row._count as { _all: number })._all,
      costUsd:
        Math.round(((row._sum as { costUsd: number | null }).costUsd ?? 0) * 1e8) / 1e8,
      totalDurationMs: (row._sum as { durationMs: number | null }).durationMs ?? 0,
    }));
  }
}

@Injectable()
export class WorkflowStepRunRepository extends BaseRepository<WorkflowStepRun> {
  protected readonly modelName = 'workflowStepRun';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findByRun(runId: string): Promise<WorkflowStepRun[]> {
    return this.findMany({ runId }, { orderBy: { startedAt: 'asc' } });
  }
}

@Injectable()
export class TriggerRepository extends BaseRepository<Trigger> {
  protected readonly modelName = 'trigger';
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findByEvent(eventName: string): Promise<Trigger[]> {
    return this.findMany({ type: 'EVENT', enabled: true, eventName });
  }

  findEnabledSchedules(): Promise<Trigger[]> {
    return this.findMany({ type: 'SCHEDULE', enabled: true });
  }

  /**
   * Webhook lookup is intentionally unscoped: an inbound request carries no
   * authentication, only an unguessable path, so the path itself must resolve
   * the organization. The caller then uses the returned `organizationId` to
   * establish context for everything that follows.
   */
  findByWebhookPathUnscoped(path: string): Promise<Trigger | null> {
    return this.prisma.trigger.findFirst({
      where: { webhookPath: path, enabled: true, deletedAt: null },
    });
  }

  /**
   * Schedules due to fire, across every organization.
   *
   * Also unscoped by necessity: the scheduler belongs to no tenant. The caller
   * processes each trigger inside its own organization's context, so the
   * scoping guarantee is restored immediately downstream.
   */
  findDueSchedulesUnscoped(limit = 100): Promise<Trigger[]> {
    return this.prisma.trigger.findMany({
      where: {
        type: 'SCHEDULE',
        enabled: true,
        deletedAt: null,
        OR: [{ nextRunAt: null }, { nextRunAt: { lte: new Date() } }],
      },
      take: limit,
    });
  }
}

@Injectable()
export class ApprovalRepository extends BaseRepository<ApprovalRequest> {
  protected readonly modelName = 'approvalRequest';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findPending(): Promise<ApprovalRequest[]> {
    return this.findMany({ status: 'PENDING' }, { orderBy: { createdAt: 'desc' } });
  }

  findExpired(): Promise<ApprovalRequest[]> {
    return this.findMany({ status: 'PENDING', expiresAt: { not: null, lte: new Date() } });
  }
}

@Injectable()
export class NotificationRepository extends BaseRepository<Notification> {
  protected readonly modelName = 'notification';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findUnread(take = 50): Promise<Notification[]> {
    return this.findMany({ readAt: null }, { take, orderBy: { createdAt: 'desc' } });
  }

  async markAllRead(): Promise<number> {
    const { organizationId } = RequestContextStore.require();
    const { count } = await this.prisma.notification.updateMany({
      where: { organizationId, readAt: null },
      data: { readAt: new Date() },
    });
    return count;
  }
}

@Injectable()
export class ApiKeyRepository extends BaseRepository<ApiKey> {
  protected readonly modelName = 'apiKey';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Unscoped by necessity: an API key *is* the authentication, so there is no
   * organization context until it resolves. Lookup is by hash of the presented
   * key, so a stolen database still yields nothing usable.
   */
  findByHashUnscoped(keyHash: string): Promise<ApiKey | null> {
    return this.prisma.apiKey.findFirst({
      where: { keyHash, revokedAt: null },
    });
  }

  async recordUse(id: string): Promise<void> {
    await this.prisma.apiKey.update({
      where: { id },
      data: { lastUsedAt: new Date(), requestCount: { increment: 1 } },
    });
  }
}

@Injectable()
export class WebhookEndpointRepository extends BaseRepository<WebhookEndpoint> {
  protected readonly modelName = 'webhookEndpoint';
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findSubscribers(eventName: string): Promise<WebhookEndpoint[]> {
    return this.findMany({ enabled: true, events: { has: eventName } });
  }
}

@Injectable()
export class WebhookDeliveryRepository extends BaseRepository<WebhookDelivery> {
  protected readonly modelName = 'webhookDelivery';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findRetryable(take = 50): Promise<WebhookDelivery[]> {
    return this.findMany(
      { status: 'FAILED', nextAttemptAt: { not: null, lte: new Date() } },
      { take, orderBy: { nextAttemptAt: 'asc' } },
    );
  }
}

@Injectable()
export class DeadLetterRepository extends BaseRepository<DeadLetter> {
  protected readonly modelName = 'deadLetter';
  protected readonly softDeletes = false;
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findUnresolved(take = 100): Promise<DeadLetter[]> {
    return this.findMany({ resolvedAt: null }, { take, orderBy: { createdAt: 'desc' } });
  }
}

export const AUTOMATION_REPOSITORIES = [
  WorkflowRepository,
  WorkflowVersionRepository,
  WorkflowRunRepository,
  WorkflowStepRunRepository,
  TriggerRepository,
  ApprovalRepository,
  NotificationRepository,
  ApiKeyRepository,
  WebhookEndpointRepository,
  WebhookDeliveryRepository,
  DeadLetterRepository,
];
