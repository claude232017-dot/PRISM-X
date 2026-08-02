import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  EventRepository,
  KnowledgeRepository,
  MissionRepository,
  TaskRepository,
  WorkerRepository,
} from '../database/repositories/tenant.repositories';
import { CacheService } from '../shared/cache/cache.service';
import { RequestContextStore } from '../shared/context/request-context';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

/**
 * Read-only aggregate views over the tenant's data.
 *
 * Results are cached briefly — dashboards poll, and these counts do not need
 * to be transactionally fresh.
 */
@Injectable()
export class AnalyticsService {
  private static readonly TTL = 60;

  constructor(
    private readonly workers: WorkerRepository,
    private readonly missions: MissionRepository,
    private readonly tasks: TaskRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly events: EventRepository,
    private readonly cache: CacheService,
  ) {}

  async overview() {
    const { organizationId } = RequestContextStore.require();

    return this.cache.remember(
      `analytics:overview:${organizationId}`,
      AnalyticsService.TTL,
      async () => {
        const [
          workers,
          activeWorkers,
          missions,
          runningMissions,
          completedMissions,
          failedMissions,
          tasks,
          completedTasks,
          knowledge,
        ] = await Promise.all([
          this.workers.count(),
          this.workers.count({ status: 'ACTIVE' }),
          this.missions.count(),
          this.missions.count({ status: 'RUNNING' }),
          this.missions.count({ status: 'COMPLETED' }),
          this.missions.count({ status: 'FAILED' }),
          this.tasks.count(),
          this.tasks.count({ status: 'COMPLETED' }),
          this.knowledge.count(),
        ]);

        const finished = completedMissions + failedMissions;

        return {
          workers: { total: workers, active: activeWorkers },
          missions: {
            total: missions,
            running: runningMissions,
            completed: completedMissions,
            failed: failedMissions,
            // Undefined rather than 0 when nothing has finished — a 0% success
            // rate and "no data yet" are different facts.
            successRate: finished > 0 ? Math.round((completedMissions / finished) * 100) : null,
          },
          tasks: {
            total: tasks,
            completed: completedTasks,
            completionRate: tasks > 0 ? Math.round((completedTasks / tasks) * 100) : null,
          },
          knowledge: { total: knowledge },
          generatedAt: new Date().toISOString(),
        };
      },
    );
  }

  /** Event volume grouped by name over the most recent slice of activity. */
  async activity() {
    const recent = await this.events.findRecent(500);
    const byName = new Map<string, number>();
    for (const event of recent) {
      byName.set(event.name, (byName.get(event.name) ?? 0) + 1);
    }

    return {
      sampleSize: recent.length,
      byEvent: [...byName.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      mostRecentAt: recent[0]?.createdAt ?? null,
    };
  }
}

@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({
    summary: 'Organization overview metrics',
    description:
      'Aggregate counts across workers, missions, tasks and knowledge. Rates are ' +
      '`null` rather than 0 when there is no data to compute them from. Cached for 60s.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        workers: { total: 12, active: 7 },
        missions: { total: 24, running: 3, completed: 19, failed: 2, successRate: 90 },
        tasks: { total: 186, completed: 171, completionRate: 92 },
        knowledge: { total: 148 },
        generatedAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  overview() {
    return this.analytics.overview();
  }

  @Get('activity')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({
    summary: 'Recent event activity',
    description: 'Counts the last 500 domain events by name.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        sampleSize: 213,
        byEvent: [
          { name: 'task.completed', count: 96 },
          { name: 'mission.started', count: 24 },
        ],
        mostRecentAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  activity() {
    return this.analytics.activity();
  }
}

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
