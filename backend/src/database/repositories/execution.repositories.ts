import { Injectable } from '@nestjs/common';
import type {
  ExecutionLog,
  Memory,
  MemoryType,
  ToolCall,
  UsageDaily,
} from '@prisma/client';
import { BaseRepository } from './base.repository';
import { PrismaService } from '../prisma.service';
import { RequestContextStore } from '../../shared/context/request-context';

/**
 * Phase 2 repositories: worker memory and execution telemetry.
 *
 * Each declares a constructor that only calls super() — required so
 * TypeScript emits the `design:paramtypes` metadata Nest needs to inject
 * PrismaService into the inherited constructor.
 */

@Injectable()
export class MemoryRepository extends BaseRepository<Memory> {
  protected readonly modelName = 'memory';
  protected readonly softDeletes = false;

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** Live memories for a worker — expired short-term entries excluded. */
  findLive(workerId: string, type?: MemoryType, take = 200): Promise<Memory[]> {
    return this.findMany(
      {
        workerId,
        ...(type ? { type } : {}),
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      { take, orderBy: { createdAt: 'desc' } },
    );
  }

  /**
   * Candidate set for retrieval ranking.
   *
   * Keyword filtering happens in SQL to keep the row count down; the actual
   * relevance scoring (which blends importance and recency) is done in the
   * service, because expressing that formula in SQL would make it far harder
   * to change when the ranking is tuned.
   */
  findCandidates(workerId: string, terms: string[], take = 100): Promise<Memory[]> {
    const now = new Date();
    const keywordFilter = terms.length
      ? {
          OR: [
            ...terms.map((term) => ({
              content: { contains: term, mode: 'insensitive' as const },
            })),
            { tags: { hasSome: terms } },
          ],
        }
      : {};

    return this.findMany(
      {
        workerId,
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, keywordFilter],
      },
      { take, orderBy: { importance: 'desc' } },
    );
  }

  /** Bumps access statistics so frequently used memories survive pruning. */
  async touchMany(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const { organizationId } = RequestContextStore.require();
    await this.prisma.memory.updateMany({
      where: { id: { in: ids }, organizationId },
      data: { lastAccessedAt: new Date(), accessCount: { increment: 1 } },
    });
  }

  /** Deletes expired short-term memories. Returns how many went. */
  async pruneExpired(): Promise<number> {
    const { organizationId } = RequestContextStore.require();
    const { count } = await this.prisma.memory.deleteMany({
      where: {
        organizationId,
        type: 'SHORT_TERM',
        expiresAt: { not: null, lte: new Date() },
      },
    });
    return count;
  }

  countByType(workerId: string, type: MemoryType): Promise<number> {
    return this.count({ workerId, type });
  }
}

@Injectable()
export class ExecutionLogRepository extends BaseRepository<ExecutionLog> {
  protected readonly modelName = 'executionLog';
  protected readonly softDeletes = false;

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findByMission(missionId: string, take = 200): Promise<ExecutionLog[]> {
    return this.findMany({ missionId }, { take, orderBy: { startedAt: 'desc' } });
  }

  findByWorker(workerId: string, take = 100): Promise<ExecutionLog[]> {
    return this.findMany({ workerId }, { take, orderBy: { startedAt: 'desc' } });
  }

  /** Aggregate totals over an arbitrary slice, for the cost dashboard. */
  async summarize(where: Record<string, unknown> = {}) {
    const { organizationId } = RequestContextStore.require();
    const scoped = { ...where, organizationId };

    const [aggregate, failures] = await Promise.all([
      this.prisma.executionLog.aggregate({
        where: scoped,
        _sum: {
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          costUsd: true,
          latencyMs: true,
        },
        _avg: { latencyMs: true },
        _count: true,
      }),
      this.prisma.executionLog.count({ where: { ...scoped, status: 'FAILED' } }),
    ]);

    const requests = aggregate._count;
    return {
      requests,
      failedRequests: failures,
      successRate: requests > 0 ? Math.round(((requests - failures) / requests) * 100) : null,
      promptTokens: aggregate._sum.promptTokens ?? 0,
      completionTokens: aggregate._sum.completionTokens ?? 0,
      totalTokens: aggregate._sum.totalTokens ?? 0,
      costUsd: Math.round((aggregate._sum.costUsd ?? 0) * 1e8) / 1e8,
      averageLatencyMs: Math.round(aggregate._avg.latencyMs ?? 0),
    };
  }

  /**
   * Group totals by an arbitrary column — provider, model or worker.
   *
   * Prisma types `groupBy` against a literal `by` array, which a runtime
   * variable cannot satisfy. The call is cast at this single boundary and the
   * result re-typed immediately, so the looseness does not escape the method.
   */
  async groupBy(
    field: 'providerId' | 'model' | 'workerId' | 'providerKind',
  ): Promise<GroupedUsage[]> {
    const { organizationId } = RequestContextStore.require();

    const rows = (await (this.prisma.executionLog.groupBy as unknown as (
      args: unknown,
    ) => Promise<RawGroupRow[]>)({
      by: [field],
      where: { organizationId },
      _sum: { totalTokens: true, costUsd: true },
      _avg: { latencyMs: true },
      _count: { _all: true },
    })) as RawGroupRow[];

    return rows.map((row) => ({
      key: (row[field] as string | null) ?? null,
      requests: row._count?._all ?? 0,
      totalTokens: row._sum?.totalTokens ?? 0,
      costUsd: Math.round((row._sum?.costUsd ?? 0) * 1e8) / 1e8,
      averageLatencyMs: Math.round(row._avg?.latencyMs ?? 0),
    }));
  }
}

/** Shape Prisma returns from a grouped aggregate. */
interface RawGroupRow {
  [key: string]: unknown;
  _count?: { _all: number };
  _sum?: { totalTokens: number | null; costUsd: number | null };
  _avg?: { latencyMs: number | null };
}

export interface GroupedUsage {
  key: string | null;
  requests: number;
  totalTokens: number;
  costUsd: number;
  averageLatencyMs: number;
}

@Injectable()
export class ToolCallRepository extends BaseRepository<ToolCall> {
  protected readonly modelName = 'toolCall';
  protected readonly softDeletes = false;

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findRecent(take = 100): Promise<ToolCall[]> {
    return this.findMany({}, { take, orderBy: { createdAt: 'desc' } });
  }

  countDenied(): Promise<number> {
    return this.count({ denied: true });
  }
}

@Injectable()
export class UsageDailyRepository extends BaseRepository<UsageDaily> {
  protected readonly modelName = 'usageDaily';
  protected readonly softDeletes = false;

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Adds one execution into its daily bucket.
   *
   * An upsert with atomic increments, so concurrent executions in the same
   * slice cannot lose updates the way read-modify-write would.
   */
  async accumulate(slice: {
    day: Date;
    providerId: string | null;
    providerKind: UsageDaily['providerKind'];
    model: string | null;
    workerId: string | null;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    latencyMs: number;
    failed: boolean;
  }): Promise<void> {
    const { organizationId } = RequestContextStore.require();
    const totalTokens = slice.promptTokens + slice.completionTokens;

    // Empty string, never null — see the schema comment on UsageDaily.
    const providerId = slice.providerId ?? '';
    const model = slice.model ?? '';
    const workerId = slice.workerId ?? '';

    await this.prisma.usageDaily.upsert({
      where: {
        usage_daily_slice: {
          organizationId,
          day: slice.day,
          providerId,
          model,
          workerId,
        },
      },
      create: {
        organizationId,
        day: slice.day,
        providerId,
        providerKind: slice.providerKind,
        model,
        workerId,
        requests: 1,
        failedRequests: slice.failed ? 1 : 0,
        promptTokens: slice.promptTokens,
        completionTokens: slice.completionTokens,
        totalTokens,
        costUsd: slice.costUsd,
        latencyMsTotal: slice.latencyMs,
      },
      update: {
        requests: { increment: 1 },
        failedRequests: { increment: slice.failed ? 1 : 0 },
        promptTokens: { increment: slice.promptTokens },
        completionTokens: { increment: slice.completionTokens },
        totalTokens: { increment: totalTokens },
        costUsd: { increment: slice.costUsd },
        latencyMsTotal: { increment: slice.latencyMs },
      },
    });
  }

  findRange(from: Date, to: Date): Promise<UsageDaily[]> {
    return this.findMany({ day: { gte: from, lte: to } }, { orderBy: { day: 'asc' } });
  }
}

export const EXECUTION_REPOSITORIES = [
  MemoryRepository,
  ExecutionLogRepository,
  ToolCallRepository,
  UsageDailyRepository,
];
