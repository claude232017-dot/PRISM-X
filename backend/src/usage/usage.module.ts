import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  ExecutionLogRepository,
  UsageDailyRepository,
} from '../database/repositories/execution.repositories';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';
import { PaginationQueryDto, paginate } from '../shared/dto/pagination.dto';

/**
 * Cost and usage reporting.
 *
 * Execution logs are the source of truth. `usage_daily` is a rollup that
 * exists so a dashboard spanning months does not scan every call — the two are
 * kept consistent because the rollup is written from the same code path that
 * writes the log.
 *
 * Note on precision: cost is a *derived reporting figure*, computed from
 * exactly-recorded token counts times a configurable rate table. Token counts
 * are authoritative; cost can always be recomputed if a rate was wrong.
 */
@Injectable()
export class UsageService {
  constructor(
    private readonly executionLogs: ExecutionLogRepository,
    private readonly usageDaily: UsageDailyRepository,
  ) {}

  /** Lifetime totals plus today's and this month's, in one view. */
  async overview() {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );

    const [lifetime, today, month] = await Promise.all([
      this.executionLogs.summarize(),
      this.executionLogs.summarize({ startedAt: { gte: startOfDay } }),
      this.executionLogs.summarize({ startedAt: { gte: startOfMonth } }),
    ]);

    return {
      lifetime,
      today,
      month,
      generatedAt: now.toISOString(),
    };
  }

  byProvider() {
    return this.executionLogs.groupBy('providerId');
  }

  byModel() {
    return this.executionLogs.groupBy('model');
  }

  byWorker() {
    return this.executionLogs.groupBy('workerId');
  }

  byMission(missionId: string) {
    return this.executionLogs.summarize({ missionId });
  }

  /** Daily series for charting. Defaults to the last 30 days. */
  async timeline(days = 30) {
    const to = new Date();
    to.setUTCHours(0, 0, 0, 0);
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);

    const rows = await this.usageDaily.findRange(from, to);

    // Collapse the per-provider/model/worker slices into one row per day.
    const byDay = new Map<string, {
      day: string;
      requests: number;
      failedRequests: number;
      totalTokens: number;
      costUsd: number;
      latencyMsTotal: number;
    }>();

    for (const row of rows) {
      const key = row.day.toISOString().slice(0, 10);
      const entry = byDay.get(key) ?? {
        day: key,
        requests: 0,
        failedRequests: 0,
        totalTokens: 0,
        costUsd: 0,
        latencyMsTotal: 0,
      };
      entry.requests += row.requests;
      entry.failedRequests += row.failedRequests;
      entry.totalTokens += row.totalTokens;
      entry.costUsd += row.costUsd;
      entry.latencyMsTotal += row.latencyMsTotal;
      byDay.set(key, entry);
    }

    return [...byDay.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((d) => ({
        ...d,
        costUsd: Math.round(d.costUsd * 1e8) / 1e8,
        averageLatencyMs: d.requests ? Math.round(d.latencyMsTotal / d.requests) : 0,
      }));
  }

  /** Provider reliability, derived from execution outcomes. */
  async providerReliability() {
    const rows = await this.executionLogs.groupBy('providerKind');
    return rows.map((row): {
      providerKind: string | null;
      requests: number;
      averageLatencyMs: number;
      totalTokens: number;
      costUsd: number;
    } => ({
      providerKind: row.key,
      requests: row.requests,
      averageLatencyMs: row.averageLatencyMs,
      totalTokens: row.totalTokens,
      costUsd: row.costUsd,
    }));
  }
}

@ApiTags('Usage')
@ApiBearerAuth()
@Controller('usage')
export class UsageController {
  constructor(
    private readonly usage: UsageService,
    private readonly executionLogs: ExecutionLogRepository,
  ) {}

  @Get('overview')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({
    summary: 'Cost and token usage overview',
    description:
      'Lifetime, month-to-date and today totals. Cost is derived from recorded ' +
      'token counts and a configurable rate table; token counts are authoritative.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        lifetime: {
          requests: 412,
          failedRequests: 3,
          successRate: 99,
          promptTokens: 184_320,
          completionTokens: 71_004,
          totalTokens: 255_324,
          costUsd: 0.9142,
          averageLatencyMs: 1840,
        },
        today: { requests: 24, totalTokens: 14_112, costUsd: 0.0503, averageLatencyMs: 1720 },
        month: { requests: 190, totalTokens: 118_400, costUsd: 0.4210, averageLatencyMs: 1810 },
        generatedAt: '2026-08-02T12:44:51.312Z',
      },
    },
  })
  overview() {
    return this.usage.overview();
  }

  @Get('by-provider')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({ summary: 'Usage grouped by provider' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          key: 'clx0prov0001',
          requests: 380,
          totalTokens: 240_100,
          costUsd: 0.8801,
          averageLatencyMs: 1790,
        },
      ],
    },
  })
  byProvider() {
    return this.usage.byProvider();
  }

  @Get('by-model')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({ summary: 'Usage grouped by model' })
  @ApiOkResponse({
    schema: {
      example: [
        { key: 'claude-sonnet-4-5', requests: 210, totalTokens: 150_000, costUsd: 0.72, averageLatencyMs: 1900 },
      ],
    },
  })
  byModel() {
    return this.usage.byModel();
  }

  @Get('by-worker')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({ summary: 'Usage grouped by worker' })
  @ApiOkResponse({
    schema: {
      example: [
        { key: 'clx0worker001', requests: 96, totalTokens: 61_200, costUsd: 0.2140, averageLatencyMs: 1650 },
      ],
    },
  })
  byWorker() {
    return this.usage.byWorker();
  }

  @Get('timeline')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiQuery({ name: 'days', required: false, example: 30 })
  @ApiOperation({
    summary: 'Daily usage series',
    description: 'One row per day from the rollup table, for charting.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          day: '2026-08-01',
          requests: 42,
          failedRequests: 1,
          totalTokens: 28_900,
          costUsd: 0.1032,
          averageLatencyMs: 1755,
        },
      ],
    },
  })
  timeline(@Query('days') days?: string) {
    return this.usage.timeline(Math.min(Number(days ?? 30) || 30, 365));
  }

  @Get('provider-reliability')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({ summary: 'Reliability and latency by provider kind' })
  @ApiOkResponse({
    schema: {
      example: [
        { providerKind: 'ANTHROPIC', requests: 300, averageLatencyMs: 1820, totalTokens: 210_000, costUsd: 0.81 },
      ],
    },
  })
  reliability() {
    return this.usage.providerReliability();
  }

  @Get('executions')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({
    summary: 'List execution logs',
    description: 'Every AI call, newest first — the traceable record of what ran.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        data: [
          {
            id: 'clx0exec0001',
            workerId: 'clx0worker001',
            missionId: 'clx0mission01',
            taskId: 'clx0task001',
            providerKind: 'LOCAL',
            model: 'prism-sim-1',
            status: 'SUCCEEDED',
            promptTokens: 412,
            completionTokens: 96,
            totalTokens: 508,
            costUsd: 0,
            latencyMs: 12,
            attempts: 1,
            startedAt: '2026-08-02T12:44:51.312Z',
            finishedAt: '2026-08-02T12:44:51.324Z',
          },
        ],
        meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrevious: false },
      },
    },
  })
  async executions(@Query() query: PaginationQueryDto) {
    const { rows, total } = await this.executionLogs.paginate(
      {},
      { skip: query.skip, take: query.limit, orderBy: { startedAt: 'desc' } },
    );
    return paginate(rows, total, query.page, query.limit);
  }
}

@Module({
  controllers: [UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
