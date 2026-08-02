import {
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Job, Queue, Worker as BullWorker } from 'bullmq';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

export const QUEUE_MISSION_EXECUTION = 'mission-execution';
export const QUEUE_WORKER_SCHEDULING = 'worker-scheduling';
export const QUEUE_MAINTENANCE = 'maintenance';

export interface MissionJobData {
  organizationId: string;
  missionId: string;
  taskId?: string;
  actorId?: string;
}

/**
 * BullMQ wiring.
 *
 * Phase 1 establishes the queues, the enqueue API, retry/backoff policy and
 * observability. Mission *execution* (the processor that actually drives tasks
 * through a provider) lands in Phase 2 — the placeholder processor here
 * acknowledges jobs and logs them so the pipeline is verifiably live without
 * pretending to do work it cannot yet do.
 *
 * Every job carries `organizationId` explicitly: background work runs outside
 * an HTTP request, so there is no ambient RequestContext to inherit.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();
  private readonly workers: BullWorker[] = [];
  private connection!: { host: string; port: number; password?: string };
  private prefix!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const redis = this.config.get('redis') as {
      host: string;
      port: number;
      password?: string;
      queuePrefix: string;
    };
    this.connection = { host: redis.host, port: redis.port, password: redis.password };
    this.prefix = redis.queuePrefix;

    for (const name of [
      QUEUE_MISSION_EXECUTION,
      QUEUE_WORKER_SCHEDULING,
      QUEUE_MAINTENANCE,
    ]) {
      this.queues.set(
        name,
        new Queue(name, {
          connection: this.connection,
          prefix: this.prefix,
          defaultJobOptions: {
            attempts: 3,
            // Exponential backoff so a struggling downstream is not hammered
            // by immediate retries.
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 86400 },
          },
        }),
      );
    }

    this.registerPlaceholderProcessor();
    this.logger.log(`Queues ready: ${[...this.queues.keys()].join(', ')}`);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
  }

  private registerPlaceholderProcessor(): void {
    const worker = new BullWorker(
      QUEUE_MISSION_EXECUTION,
      async (job: Job<MissionJobData>) => {
        this.logger.log(
          `[phase-1] Accepted ${job.name} for mission ${job.data.missionId} ` +
            `(org ${job.data.organizationId}). Execution lands in Phase 2.`,
        );
        return { accepted: true, phase: 1 };
      },
      { connection: this.connection, prefix: this.prefix, concurrency: 5 },
    );

    worker.on('failed', (job, error) => {
      this.logger.error(`Job ${job?.id} failed: ${error.message}`);
    });

    this.workers.push(worker);
  }

  queue(name: string): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Unknown queue "${name}"`);
    return queue;
  }

  /** Enqueues a mission for execution. */
  async enqueueMission(data: MissionJobData, options?: { delay?: number; priority?: number }) {
    const job = await this.queue(QUEUE_MISSION_EXECUTION).add('execute-mission', data, options);
    return { jobId: job.id, queue: QUEUE_MISSION_EXECUTION };
  }

  async enqueueTask(data: MissionJobData, options?: { delay?: number }) {
    const job = await this.queue(QUEUE_WORKER_SCHEDULING).add('run-task', data, options);
    return { jobId: job.id, queue: QUEUE_WORKER_SCHEDULING };
  }

  /** Depth and health of every queue — surfaced on the health endpoint. */
  async statistics() {
    const stats: Record<string, unknown> = {};
    for (const [name, queue] of this.queues) {
      try {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'completed',
          'failed',
          'delayed',
        );
        stats[name] = counts;
      } catch (error) {
        stats[name] = { error: (error as Error).message };
      }
    }
    return stats;
  }
}

@ApiTags('Queues')
@ApiBearerAuth()
@Controller('queues')
export class QueuesController {
  constructor(private readonly queues: QueueService) {}

  @Get('statistics')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({
    summary: 'Queue depths',
    description: 'Job counts per queue: waiting, active, completed, failed and delayed.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        'mission-execution': { waiting: 2, active: 1, completed: 140, failed: 0, delayed: 0 },
        'worker-scheduling': { waiting: 0, active: 0, completed: 89, failed: 1, delayed: 0 },
        maintenance: { waiting: 0, active: 0, completed: 12, failed: 0, delayed: 0 },
      },
    },
  })
  statistics() {
    return this.queues.statistics();
  }
}

@Module({
  controllers: [QueuesController],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueuesModule {}
