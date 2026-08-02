import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ApprovalRequest, ApprovalStatus, RiskLevel } from '@prisma/client';
import { ApprovalRepository } from '../database/repositories/automation.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { NotificationService } from '../notifications/notification.service';
import { RequestContextStore } from '../shared/context/request-context';

export interface RequestApprovalInput {
  runId?: string;
  stepId?: string;
  title: string;
  reason: string;
  suggestedAction?: string;
  riskLevel?: RiskLevel;
  context?: Record<string, unknown>;
  expiresInSeconds?: number;
}

export interface DecisionInput {
  comment?: string;
  /** Required when delegating. */
  delegateToUserId?: string;
}

/**
 * Human-in-the-loop decisions.
 *
 * An approval is what makes automation safe to point at consequential actions:
 * the workflow suspends, a person is told exactly what is proposed and why,
 * and the run continues only on their decision.
 *
 * Every request carries reason, context, suggested action and risk level —
 * approving something you cannot see is not meaningfully approving it.
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);
  private static readonly DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 3;

  /**
   * Resolving a suspended run is the workflow engine's job, but this service
   * is constructed before it. The callback is registered at boot to avoid a
   * circular dependency between the two.
   */
  private resumeRun: ((runId: string) => Promise<unknown>) | null = null;

  constructor(
    private readonly approvals: ApprovalRepository,
    private readonly notifications: NotificationService,
    private readonly events: EventBusService,
  ) {}

  onRunResumable(handler: (runId: string) => Promise<unknown>): void {
    this.resumeRun = handler;
  }

  async request(input: RequestApprovalInput): Promise<ApprovalRequest> {
    const ctx = RequestContextStore.get();

    const approval = await this.approvals.create({
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      title: input.title,
      reason: input.reason,
      suggestedAction: input.suggestedAction ?? null,
      riskLevel: input.riskLevel ?? RiskLevel.MEDIUM,
      context: (input.context ?? {}) as never,
      status: ApprovalStatus.PENDING,
      requestedById: ctx?.userId ?? null,
      expiresAt: new Date(
        Date.now() + (input.expiresInSeconds ?? ApprovalService.DEFAULT_TTL_SECONDS) * 1000,
      ),
    });

    await this.events.publish(DomainEvent.ApprovalRequested, {
      approvalId: approval.id,
      runId: input.runId,
      riskLevel: approval.riskLevel,
      title: approval.title,
    });

    await this.notifications.send({
      category: 'approval',
      severity: approval.riskLevel === RiskLevel.CRITICAL ? 'CRITICAL' : 'WARNING',
      subject: `Approval needed: ${approval.title}`,
      body:
        `${approval.reason}\n\n` +
        (approval.suggestedAction ? `Suggested: ${approval.suggestedAction}\n` : '') +
        `Risk: ${approval.riskLevel}`,
      metadata: { approvalId: approval.id, runId: input.runId },
    });

    return approval;
  }

  list(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return status
      ? this.approvals.findMany({ status }, { orderBy: { createdAt: 'desc' } })
      : this.approvals.findMany({}, { orderBy: { createdAt: 'desc' } });
  }

  findOne(id: string): Promise<ApprovalRequest> {
    return this.approvals.findByIdOrFail(id);
  }

  /** Approves and resumes the suspended run, if there is one. */
  async approve(id: string, input: DecisionInput = {}) {
    const approval = await this.assertPending(id);
    const ctx = RequestContextStore.require();

    const decided = await this.approvals.update(id, {
      status: ApprovalStatus.APPROVED,
      decision: 'approved',
      comment: input.comment ?? null,
      decidedById: ctx.userId,
      decidedAt: new Date(),
    });

    await this.events.publish(DomainEvent.ApprovalGranted, {
      approvalId: id,
      runId: approval.runId,
      decidedBy: ctx.userId,
    });

    const resumed = await this.tryResume(approval.runId);
    return { approval: decided, resumed };
  }

  /** Rejects; the suspended run stays suspended and is not resumed. */
  async reject(id: string, input: DecisionInput = {}) {
    const approval = await this.assertPending(id);
    const ctx = RequestContextStore.require();

    const decided = await this.approvals.update(id, {
      status: ApprovalStatus.REJECTED,
      decision: 'rejected',
      comment: input.comment ?? null,
      decidedById: ctx.userId,
      decidedAt: new Date(),
    });

    await this.events.publish(DomainEvent.ApprovalRejected, {
      approvalId: id,
      runId: approval.runId,
      reason: input.comment,
    });

    await this.notifications.send({
      category: 'approval',
      severity: 'INFO',
      subject: `Approval rejected: ${approval.title}`,
      body: input.comment ?? 'No reason given.',
      metadata: { approvalId: id, runId: approval.runId },
    });

    return { approval: decided, resumed: false };
  }

  /**
   * Asks the requester to revise. The run stays suspended — this is feedback,
   * not a decision, and resuming would discard the point of asking.
   */
  async requestChanges(id: string, input: DecisionInput = {}) {
    const approval = await this.assertPending(id);
    const ctx = RequestContextStore.require();

    if (!input.comment) {
      throw new BadRequestException(
        'Requesting changes needs a comment explaining what should change',
      );
    }

    const decided = await this.approvals.update(id, {
      status: ApprovalStatus.CHANGES_REQUESTED,
      decision: 'changes_requested',
      comment: input.comment,
      decidedById: ctx.userId,
      decidedAt: new Date(),
    });

    await this.events.publish(DomainEvent.ApprovalChangesRequested, {
      approvalId: id,
      runId: approval.runId,
      comment: input.comment,
    });

    return { approval: decided, resumed: false };
  }

  /**
   * Hands the decision to someone else.
   *
   * The request stays actionable — status returns to PENDING with a recorded
   * delegate — because delegating is not deciding.
   */
  async delegate(id: string, input: DecisionInput) {
    const approval = await this.assertPending(id);
    const ctx = RequestContextStore.require();

    if (!input.delegateToUserId) {
      throw new BadRequestException('Delegation needs `delegateToUserId`');
    }

    const updated = await this.approvals.update(id, {
      status: ApprovalStatus.PENDING,
      delegatedToId: input.delegateToUserId,
      comment: input.comment ?? null,
    });

    await this.events.publish(DomainEvent.ApprovalDelegated, {
      approvalId: id,
      from: ctx.userId,
      to: input.delegateToUserId,
    });

    await this.notifications.send({
      category: 'approval',
      severity: 'WARNING',
      subject: `Approval delegated to you: ${approval.title}`,
      body: approval.reason,
      userId: input.delegateToUserId,
      metadata: { approvalId: id, runId: approval.runId },
    });

    return { approval: updated, resumed: false };
  }

  async cancel(id: string) {
    await this.assertPending(id);
    return this.approvals.update(id, {
      status: ApprovalStatus.CANCELLED,
      decidedAt: new Date(),
    });
  }

  /**
   * Expires stale requests.
   *
   * An approval that sits forever silently blocks a run; expiring it makes the
   * stall visible and lets the failure path run.
   */
  async expireStale(): Promise<number> {
    const stale = await this.approvals.findExpired();

    for (const approval of stale) {
      await this.approvals.update(approval.id, {
        status: ApprovalStatus.EXPIRED,
        decidedAt: new Date(),
      });
      await this.events.publish(DomainEvent.ApprovalExpired, {
        approvalId: approval.id,
        runId: approval.runId,
      });
    }

    if (stale.length) this.logger.log(`Expired ${stale.length} stale approval(s)`);
    return stale.length;
  }

  async statistics() {
    const [pending, approved, rejected] = await Promise.all([
      this.approvals.count({ status: ApprovalStatus.PENDING }),
      this.approvals.count({ status: ApprovalStatus.APPROVED }),
      this.approvals.count({ status: ApprovalStatus.REJECTED }),
    ]);
    const decided = approved + rejected;
    return {
      pending,
      approved,
      rejected,
      approvalRate: decided > 0 ? Math.round((approved / decided) * 100) : null,
    };
  }

  private async assertPending(id: string): Promise<ApprovalRequest> {
    const approval = await this.approvals.findByIdOrFail(id);
    if (approval.status !== ApprovalStatus.PENDING) {
      throw new BadRequestException(
        `Approval is already ${approval.status} and cannot be decided again`,
      );
    }
    return approval;
  }

  private async tryResume(runId: string | null): Promise<boolean> {
    if (!runId || !this.resumeRun) return false;
    try {
      await this.resumeRun(runId);
      return true;
    } catch (error) {
      // A failure to resume must not undo a recorded decision.
      this.logger.error(`Failed to resume run ${runId}: ${(error as Error).message}`);
      return false;
    }
  }
}
