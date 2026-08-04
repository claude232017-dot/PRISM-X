import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { MissionStatus } from '@prisma/client';
import {
  MissionJobData,
  QueueService,
} from '../../queues/queues.module';
import { MissionRepository } from '../../database/repositories/tenant.repositories';
import { RequestContextStore } from '../../shared/context/request-context';
import { MissionOrchestrator } from './mission-orchestrator.service';
import type { MissionRunResult } from './mission-orchestrator.service';

/** What the API hands back when a mission is accepted rather than completed. */
export interface MissionAccepted {
  missionId: string;
  status: MissionStatus | 'QUEUED';
  jobId: string | null;
  queue: string;
  accepted: true;
  /** Where to look for the outcome. */
  statusUrl: string;
}

/** How long a caller may ask to wait inline, in seconds. */
export const MAX_WAIT_SECONDS = 120;

/**
 * Mission execution, off the request path.
 *
 * A mission is an unbounded workload: it walks a task graph, each task calls a
 * provider, and a provider call is a network round trip to somebody else's
 * service. Running that inside the HTTP request means the request lives as long
 * as the mission does, which fails in every direction at once — the balancer's
 * idle timeout kills it halfway through, a deploy abandons it mid-wave with
 * tasks stuck RUNNING, there is no retry because the caller has already gone,
 * and nothing bounds how many run at once, so a burst of executes is a burst of
 * concurrent provider calls into a shared quota.
 *
 * So the request enqueues and the queue executes. That gets, for free, four
 * things the synchronous path could not have: retries with backoff, a
 * concurrency ceiling, survival across a deploy (workers drain rather than drop
 * in-flight jobs), and backpressure that is visible as queue depth instead of
 * as a wall of timeouts.
 *
 * The seam is a callback registered on `QueueService`, because the queue module
 * sits below the orchestrator and cannot import it. The processor re-enters the
 * tenant from the job data — background work has no ambient request to inherit
 * one from, and a repository without a tenant fails closed rather than reading
 * across organizations.
 */
@Injectable()
export class MissionQueueService implements OnModuleInit {
  private readonly logger = new Logger(MissionQueueService.name);

  constructor(
    private readonly queues: QueueService,
    private readonly orchestrator: MissionOrchestrator,
    private readonly missions: MissionRepository,
  ) {}

  onModuleInit(): void {
    this.queues.onMissionJob((data) => this.process(data));
  }

  // ------------------------------------------------------------- producing

  /**
   * Accepts a mission for execution.
   *
   * `waitSeconds` lets a caller block on the outcome — a small mission, a CI
   * run, a workflow step whose next step needs the output. The work still
   * happens on a queue worker either way; waiting changes who holds the
   * result, not where it runs. A wait that expires is not a failure: the job
   * is still going, and the caller gets its id.
   */
  async enqueue(
    missionId: string,
    options: { intent?: 'run' | 'resume'; waitSeconds?: number } = {},
  ): Promise<MissionRunResult | MissionAccepted> {
    // Read it first so a missing mission, or one in a state that cannot run,
    // is a 404/400 now rather than a job that fails on a worker where nobody
    // is listening.
    const mission = await this.missions.findByIdOrFail(missionId);
    const intent = options.intent ?? 'run';
    if (intent === 'resume') {
      MissionQueueService.assertResumable(mission.status);
    } else {
      MissionQueueService.assertRunnable(mission.status);
    }

    const context = RequestContextStore.get();
    const job = await this.queues.enqueueMission({
      organizationId: mission.organizationId,
      missionId,
      actorId: context?.userId,
      intent,
    });

    const wait = Math.min(Math.max(options.waitSeconds ?? 0, 0), MAX_WAIT_SECONDS);
    if (wait > 0 && job.jobId) {
      const result = await this.queues.awaitMission(job.jobId, wait * 1000);
      if (result) return result as MissionRunResult;
    }

    return {
      missionId,
      status: 'QUEUED',
      jobId: job.jobId ?? null,
      queue: job.queue,
      accepted: true,
      statusUrl: `/missions/${missionId}`,
    };
  }

  /** State of a previously accepted job. */
  job(jobId: string) {
    return this.queues.missionJob(jobId);
  }

  // ------------------------------------------------------------- consuming

  /**
   * Runs one queued mission.
   *
   * The tenant comes from the job, not from the process. Everything below the
   * repository layer reads `organizationId` from the ambient context and fails
   * closed without one, so this scope is what makes background execution
   * possible at all — and pinning it to the mission's own organization is what
   * keeps a job from ever touching a different tenant's rows.
   */
  private async process(data: MissionJobData): Promise<MissionRunResult> {
    const scope = {
      userId: data.actorId ?? '',
      organizationId: data.organizationId,
      roleKey: 'SYSTEM',
      permissions: [] as string[],
      requestId: `mission-job-${data.missionId}`,
    };

    return RequestContextStore.run(scope, async () => {
      const started = Date.now();
      try {
        const result =
          data.intent === 'resume'
            ? await this.orchestrator.resume(data.missionId)
            : await this.orchestrator.run(data.missionId);

        this.logger.log(
          `Mission ${data.missionId} finished ${result.status} in ${Date.now() - started}ms ` +
            `(${result.tasksSucceeded}/${result.tasksExecuted} task(s) succeeded)`,
        );
        return result;
      } catch (error) {
        // Rethrown so BullMQ retries with backoff and, past `attempts`, moves
        // the job where a human can see it. Swallowing here would turn a
        // failed mission into a job that "succeeded" and did nothing.
        this.logger.error(
          `Mission ${data.missionId} failed: ${(error as Error).message}`,
        );
        throw error;
      }
    });
  }

  // ------------------------------------------------------------- guards

  /**
   * States from which a mission may be executed.
   *
   * Checked here as well as in the orchestrator, and deliberately so: the
   * orchestrator's check happens on a worker, where a rejection is a failed
   * job rather than a useful response. This one happens while the caller is
   * still listening.
   */
  private static readonly RUNNABLE: MissionStatus[] = [
    MissionStatus.DRAFT,
    MissionStatus.QUEUED,
    MissionStatus.PLANNING,
    MissionStatus.RUNNING,
    MissionStatus.WAITING,
    MissionStatus.PAUSED,
  ];

  private static assertRunnable(status: MissionStatus): void {
    if (!MissionQueueService.RUNNABLE.includes(status)) {
      throw new BadRequestException(
        `Mission is ${status} and cannot be executed`,
      );
    }
  }

  private static assertResumable(status: MissionStatus): void {
    if (status !== MissionStatus.PAUSED && status !== MissionStatus.WAITING) {
      throw new BadRequestException(
        `Only PAUSED or WAITING missions can be resumed; this one is ${status}`,
      );
    }
  }
}
