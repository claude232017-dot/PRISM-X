import { BadRequestException, Injectable } from '@nestjs/common';
import { Mission, MissionStatus, Task, TaskStatus } from '@prisma/client';
import {
  MissionRepository,
  TaskRepository,
  WorkerRepository,
} from '../database/repositories/tenant.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import {
  CreateMissionDto,
  CreateTaskDto,
  QueryMissionsDto,
  UpdateMissionDto,
  UpdateTaskDto,
} from './dto/mission.dto';
import { paginate } from '../shared/dto/pagination.dto';

/**
 * Legal mission state transitions. Encoded as data rather than scattered
 * `if` statements so the whole state machine is auditable in one place.
 */
/**
 * Re-exported from the orchestrator, which owns the Phase 2 lifecycle
 * (DRAFT → QUEUED → PLANNING → RUNNING → [WAITING] → COMPLETED → ARCHIVED).
 * Keeping one table means the CRUD controller and the execution engine can
 * never disagree about what transition is legal.
 */
import { MISSION_TRANSITIONS } from './orchestrator/mission-orchestrator.service';

@Injectable()
export class MissionsService {
  constructor(
    private readonly missions: MissionRepository,
    private readonly tasks: TaskRepository,
    private readonly workers: WorkerRepository,
    private readonly events: EventBusService,
  ) {}

  async create(dto: CreateMissionDto): Promise<Mission> {
    const mission = await this.missions.create({
      title: dto.title,
      objective: dto.objective,
      priority: dto.priority ?? 'MEDIUM',
      metadata: (dto.metadata ?? {}) as never,
      status: MissionStatus.DRAFT,
    });

    if (dto.tasks?.length) {
      await this.createTaskGraph(mission.id, dto.tasks);
    }

    await this.events.publish(DomainEvent.MissionCreated, {
      missionId: mission.id,
      title: mission.title,
      taskCount: dto.tasks?.length ?? 0,
    });

    return this.missions.findByIdOrFail(mission.id);
  }

  /**
   * Creates tasks and rewrites index-based dependencies into real ids.
   *
   * Callers describe the DAG positionally (`dependsOn: [0, 1]` as strings)
   * because the ids do not exist yet. Tasks are inserted first, then patched
   * with resolved ids.
   */
  private async createTaskGraph(missionId: string, specs: CreateTaskDto[]): Promise<void> {
    this.assertAcyclic(specs);

    const created: Task[] = [];
    for (const spec of specs) {
      if (spec.workerId) await this.workers.findByIdOrFail(spec.workerId);
      created.push(
        await this.tasks.create({
          missionId,
          title: spec.title,
          description: spec.description ?? null,
          priority: spec.priority ?? 'MEDIUM',
          workerId: spec.workerId ?? null,
        }),
      );
    }

    for (const [index, spec] of specs.entries()) {
      if (!spec.dependsOn?.length) continue;
      const resolved = spec.dependsOn
        .map((ref) => {
          const position = Number(ref);
          return Number.isInteger(position) ? created[position]?.id : ref;
        })
        .filter((id): id is string => Boolean(id));

      if (resolved.length) {
        await this.tasks.update(created[index].id, { dependsOn: resolved });
      }
    }
  }

  /** Rejects dependency cycles before anything is written. */
  private assertAcyclic(specs: CreateTaskDto[]): void {
    const edges = specs.map(
      (s) =>
        (s.dependsOn ?? [])
          .map(Number)
          .filter((n) => Number.isInteger(n) && n >= 0 && n < specs.length),
    );

    const UNVISITED = 0;
    const IN_PROGRESS = 1;
    const DONE = 2;
    const state = new Array<number>(specs.length).fill(UNVISITED);

    const visit = (node: number): boolean => {
      if (state[node] === IN_PROGRESS) return false; // back edge => cycle
      if (state[node] === DONE) return true;
      state[node] = IN_PROGRESS;
      for (const next of edges[node]) {
        if (!visit(next)) return false;
      }
      state[node] = DONE;
      return true;
    };

    for (let i = 0; i < specs.length; i++) {
      if (!visit(i)) {
        throw new BadRequestException(
          'Task dependencies contain a cycle; the mission graph must be acyclic',
        );
      }
    }
  }

  async findAll(query: QueryMissionsDto) {
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;

    const { rows, total } = await this.missions.paginate(where, {
      skip: query.skip,
      take: query.limit,
      orderBy: { [query.sortBy]: query.sortOrder },
    });
    return paginate(rows, total, query.page, query.limit);
  }

  async findOne(id: string) {
    const mission = await this.missions.findWithTasks(id);
    if (!mission) await this.missions.findByIdOrFail(id); // throws 404
    return mission;
  }

  async update(id: string, dto: UpdateMissionDto): Promise<Mission> {
    const mission = await this.missions.findByIdOrFail(id);

    // Editing the brief of a mission that is already executing would leave
    // running tasks pursuing an objective that no longer exists.
    if (mission.status === MissionStatus.RUNNING && (dto.objective || dto.title)) {
      throw new BadRequestException(
        'Pause the mission before changing its title or objective',
      );
    }

    const { tasks: _ignored, ...rest } = dto;
    return this.missions.update(id, rest as Record<string, unknown>);
  }

  /** Queues a mission for execution. Requires at least one task. */
  async start(id: string): Promise<Mission> {
    const mission = await this.missions.findByIdOrFail(id);
    this.assertTransition(mission.status, MissionStatus.QUEUED);

    const taskCount = await this.tasks.count({ missionId: id });
    if (taskCount === 0) {
      throw new BadRequestException('A mission needs at least one task before it can start');
    }

    const updated = await this.missions.update(id, {
      status: MissionStatus.RUNNING,
      startedAt: new Date(),
    });

    await this.events.publish(DomainEvent.MissionStarted, {
      missionId: id,
      title: mission.title,
      taskCount,
    });
    return updated;
  }

  async pause(id: string): Promise<Mission> {
    const mission = await this.missions.findByIdOrFail(id);
    this.assertTransition(mission.status, MissionStatus.PAUSED);

    const updated = await this.missions.update(id, { status: MissionStatus.PAUSED });
    await this.events.publish(DomainEvent.MissionPaused, { missionId: id });
    return updated;
  }

  async cancel(id: string): Promise<Mission> {
    const mission = await this.missions.findByIdOrFail(id);
    this.assertTransition(mission.status, MissionStatus.CANCELLED);

    const updated = await this.missions.update(id, { status: MissionStatus.CANCELLED });
    await this.events.publish(DomainEvent.MissionCancelled, { missionId: id });
    return updated;
  }

  async remove(id: string): Promise<void> {
    const mission = await this.missions.findByIdOrFail(id);
    if (mission.status === MissionStatus.RUNNING) {
      throw new BadRequestException('Cancel the mission before deleting it');
    }
    await this.missions.remove(id);
  }

  // ----------------------------------------------------------------
  // Tasks
  // ----------------------------------------------------------------

  async listTasks(missionId: string): Promise<Task[]> {
    await this.missions.findByIdOrFail(missionId);
    return this.tasks.findByMission(missionId);
  }

  /** Tasks whose dependencies are satisfied — what a worker may pick up now. */
  async listRunnableTasks(missionId: string): Promise<Task[]> {
    await this.missions.findByIdOrFail(missionId);
    return this.tasks.findRunnable(missionId);
  }

  async addTask(missionId: string, dto: CreateTaskDto): Promise<Task> {
    await this.missions.findByIdOrFail(missionId);
    if (dto.workerId) await this.workers.findByIdOrFail(dto.workerId);

    // Dependencies must point at tasks in this same mission.
    if (dto.dependsOn?.length) {
      const siblings = await this.tasks.findByMission(missionId);
      const known = new Set(siblings.map((t) => t.id));
      const unknown = dto.dependsOn.filter((d) => !known.has(d));
      if (unknown.length) {
        throw new BadRequestException(
          `These dependencies are not tasks of this mission: ${unknown.join(', ')}`,
        );
      }
    }

    const task = await this.tasks.create({
      missionId,
      title: dto.title,
      description: dto.description ?? null,
      priority: dto.priority ?? 'MEDIUM',
      workerId: dto.workerId ?? null,
      dependsOn: dto.dependsOn ?? [],
    });

    await this.events.publish(DomainEvent.TaskCreated, { missionId, taskId: task.id });
    return task;
  }

  /**
   * Updates a task and rolls the mission's progress forward.
   *
   * Mission completion is derived here rather than left to a caller: the
   * moment the last task finishes, the mission is completed and the event
   * fires, with no polling required.
   */
  async updateTask(missionId: string, taskId: string, dto: UpdateTaskDto): Promise<Task> {
    await this.missions.findByIdOrFail(missionId);
    const task = await this.tasks.findByIdOrFail(taskId);

    if (task.missionId !== missionId) {
      throw new BadRequestException('That task does not belong to this mission');
    }
    if (dto.workerId) await this.workers.findByIdOrFail(dto.workerId);

    const patch: Record<string, unknown> = { ...dto };
    if (dto.status === TaskStatus.RUNNING && !task.startedAt) {
      patch.startedAt = new Date();
    }
    if (dto.status === TaskStatus.COMPLETED || dto.status === TaskStatus.FAILED) {
      patch.completedAt = new Date();
    }
    if (dto.status === TaskStatus.FAILED) {
      patch.attempts = task.attempts + 1;
    }

    const updated = await this.tasks.update(taskId, patch);

    if (dto.status === TaskStatus.RUNNING) {
      await this.events.publish(DomainEvent.TaskStarted, { missionId, taskId });
    } else if (dto.status === TaskStatus.COMPLETED) {
      await this.events.publish(DomainEvent.TaskCompleted, { missionId, taskId });
    } else if (dto.status === TaskStatus.FAILED) {
      await this.events.publish(DomainEvent.TaskFailed, {
        missionId,
        taskId,
        error: dto.error,
      });
    }

    await this.recalculateProgress(missionId);
    return updated;
  }

  private async recalculateProgress(missionId: string): Promise<void> {
    const tasks = await this.tasks.findByMission(missionId);
    if (!tasks.length) return;

    const finished = tasks.filter(
      (t) => t.status === TaskStatus.COMPLETED || t.status === TaskStatus.SKIPPED,
    ).length;
    const failed = tasks.filter((t) => t.status === TaskStatus.FAILED).length;
    const progress = Math.round((finished / tasks.length) * 100);

    const mission = await this.missions.findByIdOrFail(missionId);
    if (mission.status !== MissionStatus.RUNNING) {
      await this.missions.update(missionId, { progress });
      return;
    }

    if (finished === tasks.length) {
      await this.missions.update(missionId, {
        progress: 100,
        status: MissionStatus.COMPLETED,
        completedAt: new Date(),
      });
      await this.events.publish(DomainEvent.MissionCompleted, { missionId });
      return;
    }

    // Every remaining task is blocked behind a failure — the mission cannot
    // finish, so surface that now instead of leaving it RUNNING forever.
    if (failed > 0 && finished + failed === tasks.length) {
      await this.missions.update(missionId, {
        progress,
        status: MissionStatus.FAILED,
        completedAt: new Date(),
      });
      await this.events.publish(DomainEvent.MissionFailed, { missionId, failedTasks: failed });
      return;
    }

    await this.missions.update(missionId, { progress });
  }

  private assertTransition(from: MissionStatus, to: MissionStatus): void {
    if (!MISSION_TRANSITIONS[from].includes(to)) {
      throw new BadRequestException(
        `A ${from} mission cannot move to ${to}. Allowed: ${
          MISSION_TRANSITIONS[from].join(', ') || 'none (terminal state)'
        }`,
      );
    }
  }

  async statistics() {
    const [total, running, completed, failed] = await Promise.all([
      this.missions.count(),
      this.missions.count({ status: MissionStatus.RUNNING }),
      this.missions.count({ status: MissionStatus.COMPLETED }),
      this.missions.count({ status: MissionStatus.FAILED }),
    ]);
    return { total, running, completed, failed };
  }
}
