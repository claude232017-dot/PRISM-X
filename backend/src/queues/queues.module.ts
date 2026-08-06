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
import { Job, Queue, QueueEvents, Worker as BullWorker } from 'bullmq';
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
  /** What the processor should do — `run` or `resume`. Defaults to `run`. */
  intent?: 'run' | 'resume';
}

/** Registered by the missions module; see `onMissionJob`. */
export type MissionJobHandler = (data: MissionJobData) => Promise<unknown>;

interface RedisTarget {
  host: string;
  port: number;
  password?: string;
}

/**
 * Producer-side connection options.
 *
 * The defaults are the problem this replaces. ioredis retries forever and
 * parks commands in an offline queue while it does, so with Redis unreachable
 * `queue.add(...)` never resolves *and never rejects* — the HTTP request that
 * called it hangs until the client gives up, holding a handler the whole time.
 * Measured: `POST /missions/:id/execute` returned nothing after 45 seconds.
 *
 * A queue that is down should fail immediately and loudly. `enableOfflineQueue:
 * false` makes a command reject the moment there is no connection instead of
 * being buffered, and the bounded retry strategy stops the reconnect loop from
 * running forever. This mirrors `CacheService`, which already degrades cleanly
 * for exactly this reason.
 */
type ProducerConnection = RedisTarget & {
  maxRetriesPerRequest: number;
  enableOfflineQueue: false;
  connectTimeout: number;
  retryStrategy: (times: number) => number | null;
};

/**
 * Worker-side connection options.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on a Worker connection — it
 * issues blocking commands (`BRPOPLPUSH`) that must not be given up on — and
 * throws at construction if given anything else. So the worker keeps the
 * retrying connection and the producer does not. With Redis down the worker
 * simply consumes nothing, which is harmless; the failure that matters is the
 * producer's, and that one now fails fast.
 */
type WorkerConnection = RedisTarget & { maxRetriesPerRequest: null };

/** Raised when the queue is unreachable, so callers can answer 503. */
export class QueueUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `The job queue is unavailable (${cause}). Mission execution is queued, ` +
        'so it cannot run until Redis is reachable. Check REDIS_HOST/REDIS_PORT.',
    );
    this.name = 'QueueUnavailableError';
  }
}

/**
 * BullMQ wiring.
 *
 * The queues, the enqueue API, the retry/backoff policy and the observability
 * live here; the *work* does not. A processor is registered from above through
 * `onMissionJob`, following the same seam the platform uses everywhere it needs
 * an upward edge — this module sits below the mission orchestrator and must not
 * import it.
 *
 * Every job carries `organizationId` explicitly: background work runs outside
 * an HTTP request, so there is no ambient RequestContext to inherit, and the
 * processor re-enters the tenant from the job rather than from wherever it
 * happens to be running.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();
  private readonly workers: BullWorker[] = [];
  private readonly queueEvents = new Map<string, QueueEvents>();
  private connection!: ProducerConnection;
  private workerConnection!: WorkerConnection;
  private prefix!: string;

  /**
   * The registered mission processor.
   *
   * Until something registers one, jobs are acknowledged and logged rather
   * than silently retried forever — a queue with no consumer should say so,
   * not accumulate.
   */
  private missionHandler?: MissionJobHandler;

  /**
   * Installs the processor that actually runs missions.
   *
   * A callback rather than an injected dependency: `MissionOrchestrator` pulls
   * in the worker runtime, the provider manager and the tool registry, all of
   * which sit above this module. An injected edge would be a cycle.
   */
  onMissionJob(handler: MissionJobHandler): void {
    this.missionHandler = handler;
    this.logger.log('Mission processor registered — jobs will be executed');
  }

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const redis = this.config.get('redis') as {
      host: string;
      port: number;
      password?: string;
      queuePrefix: string;
    };
    const target: RedisTarget = {
      host: redis.host,
      port: redis.port,
      password: redis.password,
    };
    this.connection = QueueService.producerConnection(target);
    this.workerConnection = QueueService.workerConnection(target);
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

    this.registerMissionProcessor();
    this.logger.log(`Queues ready: ${[...this.queues.keys()].join(', ')}`);
  }

  /**
   * Closes workers before queues, and waits for in-flight jobs.
   *
   * `close()` without `force` lets an active job finish. That is what makes a
   * rolling deploy safe: a mission halfway through its second wave completes on
   * the old instance instead of being abandoned mid-flight.
   */
  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
    await Promise.all(
      [...this.queueEvents.values()].map((e) => e.close().catch(() => undefined)),
    );
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
  }

  /**
   * Consumes the mission queue.
   *
   * `concurrency` is per instance and deliberately modest: a mission drives
   * provider calls, and the ceiling that matters is the provider's rate limit,
   * which is per account rather than per instance. Twenty instances at five
   * each is a hundred concurrent runs into a shared quota, so this is a number
   * to raise with the quota, not with the replica count.
   */
  private registerMissionProcessor(): void {
    const worker = new BullWorker(
      QUEUE_MISSION_EXECUTION,
      async (job: Job<MissionJobData>) => {
        if (!this.missionHandler) {
          // No consumer registered. Acknowledged rather than failed: retrying
          // a job nothing can process just moves it to the dead letter queue
          // more slowly.
          this.logger.warn(
            `No mission processor registered; acknowledging ${job.name} for ` +
              `mission ${job.data.missionId} without running it`,
          );
          return { accepted: true, executed: false, reason: 'no processor registered' };
        }
        return this.missionHandler(job.data);
      },
      {
        connection: this.workerConnection,
        prefix: this.prefix,
        concurrency: QueueService.missionConcurrency(),
        // A mission can legitimately run for minutes. Without a raised lock
        // duration BullMQ decides the job is stalled and hands it to a second
        // worker, which is how one mission gets executed twice.
        lockDuration: 300_000,
        stalledInterval: 60_000,
      },
    );

    worker.on('failed', (job, error) => {
      this.logger.error(`Job ${job?.id} failed: ${error.message}`);
    });

    this.workers.push(worker);
  }

  /**
   * Connection options for enqueueing. Static and pure so the property that
   * matters — that a producer command cannot wait forever — is testable
   * without standing up Redis.
   */
  static producerConnection(target: RedisTarget): ProducerConnection {
    return {
      ...target,
      maxRetriesPerRequest: 1,
      // The line that turns a hang into an error.
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2_000)),
    };
  }

  /** Connection options for consuming. BullMQ demands the null here. */
  static workerConnection(target: RedisTarget): WorkerConnection {
    return { ...target, maxRetriesPerRequest: null };
  }

  /** Concurrent missions per instance. Raise with the provider quota. */
  private static missionConcurrency(): number {
    const configured = Number.parseInt(process.env.MISSION_CONCURRENCY ?? '', 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 5;
  }

  queue(name: string): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Unknown queue "${name}"`);
    return queue;
  }

  /**
   * Enqueues a mission for execution.
   *
   * The job id is derived from the mission and its intent, so a caller
   * hammering "execute" produces one job rather than five. BullMQ ignores an
   * `add` whose id already exists, which makes the enqueue idempotent for as
   * long as the job is around — and jobs are removed on completion, so a
   * legitimate re-run later still enqueues.
   */
  async enqueueMission(
    data: MissionJobData,
    options?: { delay?: number; priority?: number; jobId?: string },
  ) {
    const intent = data.intent ?? 'run';
    try {
      const job = await this.queue(QUEUE_MISSION_EXECUTION).add(
        'execute-mission',
        { ...data, intent },
        // Keyed on the mission alone, not on the intent: running and resuming
        // the same mission concurrently is never what anybody meant, and two
        // orchestrators walking one task graph is how a task runs twice.
        // A hyphen rather than a colon — BullMQ reserves `:` in custom job ids.
        { jobId: options?.jobId ?? `mission-${data.missionId}`, ...options },
      );
      return { jobId: job.id, queue: QUEUE_MISSION_EXECUTION };
    } catch (error) {
      // Translated at the boundary so the caller answers 503 with something
      // actionable, rather than 500 with an ioredis stack trace.
      throw new QueueUnavailableError((error as Error).message);
    }
  }

  /**
   * Waits for a queued job to finish, up to `timeoutMs`.
   *
   * This exists so a caller that genuinely wants to block — a small mission, a
   * CI run, a workflow step whose next step needs the output — can do so
   * *without* the work happening inside the HTTP request. The mission still
   * runs on a queue worker, with its retries, its concurrency limit and its
   * survival across a deploy; the only thing the request holds is a wait.
   *
   * Returns null on timeout rather than throwing: the job has not failed, it
   * is merely still running, and the caller is handed its id to poll.
   */
  async awaitMission(jobId: string, timeoutMs: number): Promise<unknown | null> {
    const queue = this.queue(QUEUE_MISSION_EXECUTION);
    const job = await queue.getJob(jobId);
    if (!job) return null;

    try {
      return await job.waitUntilFinished(this.events(QUEUE_MISSION_EXECUTION), timeoutMs);
    } catch (error) {
      const message = (error as Error).message ?? '';
      // BullMQ signals a wait timeout by message; a genuine job failure is a
      // different thing and must not be reported as "still running".
      if (/timed out/i.test(message)) return null;
      throw error;
    }
  }

  /** Lazily created listener, shared by every waiter on a queue. */
  private events(name: string): QueueEvents {
    const existing = this.queueEvents.get(name);
    if (existing) return existing;
    const created = new QueueEvents(name, {
      connection: this.connection,
      prefix: this.prefix,
    });
    this.queueEvents.set(name, created);
    return created;
  }

  /** Current state of one job, for a caller polling rather than waiting. */
  async missionJob(jobId: string) {
    const job = await this.queue(QUEUE_MISSION_EXECUTION).getJob(jobId);
    if (!job) return null;
    return {
      jobId: job.id,
      state: await job.getState(),
      attemptsMade: job.attemptsMade,
      result: job.returnvalue ?? null,
      failedReason: job.failedReason ?? null,
      enqueuedAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    };
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
