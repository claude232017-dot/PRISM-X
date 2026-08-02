import { BadRequestException, Injectable } from '@nestjs/common';
import { Worker, WorkerStatus } from '@prisma/client';
import {
  ProviderRepository,
  TaskRepository,
  WorkerRepository,
} from '../database/repositories/tenant.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { CreateWorkerDto, QueryWorkersDto, UpdateWorkerDto } from './dto/worker.dto';
import { paginate } from '../shared/dto/pagination.dto';

@Injectable()
export class WorkersService {
  constructor(
    private readonly workers: WorkerRepository,
    private readonly providers: ProviderRepository,
    private readonly tasks: TaskRepository,
    private readonly events: EventBusService,
  ) {}

  async create(dto: CreateWorkerDto): Promise<Worker> {
    // Validated through the repository so the provider must belong to the
    // caller's organization — a foreign key alone would happily accept
    // another tenant's id.
    if (dto.providerId) await this.providers.findByIdOrFail(dto.providerId);

    const worker = await this.workers.create({
      name: dto.name,
      role: dto.role,
      status: dto.status ?? WorkerStatus.DORMANT,
      dna: (dto.dna ?? {}) as never,
      capabilities: dto.capabilities ?? [],
      providerId: dto.providerId ?? null,
    });

    await this.events.publish(DomainEvent.WorkerCreated, {
      workerId: worker.id,
      name: worker.name,
      role: worker.role,
    });

    return worker;
  }

  async findAll(query: QueryWorkersDto) {
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.role) where.role = query.role;

    const { rows, total } = await this.workers.paginate(where, {
      skip: query.skip,
      take: query.limit,
      orderBy: { [query.sortBy]: query.sortOrder },
    });
    return paginate(rows, total, query.page, query.limit);
  }

  findOne(id: string): Promise<Worker> {
    return this.workers.findByIdOrFail(id);
  }

  async update(id: string, dto: UpdateWorkerDto): Promise<Worker> {
    await this.workers.findByIdOrFail(id);
    if (dto.providerId) await this.providers.findByIdOrFail(dto.providerId);

    const worker = await this.workers.update(id, { ...dto } as Record<string, unknown>);
    await this.events.publish(DomainEvent.WorkerUpdated, {
      workerId: id,
      changes: Object.keys(dto),
    });
    return worker;
  }

  async activate(id: string): Promise<Worker> {
    const worker = await this.workers.findByIdOrFail(id);

    // A worker with no capabilities cannot be assigned work, so activating it
    // would produce a status that lies about what the system can do.
    if (worker.capabilities.length === 0) {
      throw new BadRequestException(
        'A worker needs at least one capability before it can be activated',
      );
    }

    const updated = await this.workers.update(id, { status: WorkerStatus.ACTIVE });
    await this.events.publish(DomainEvent.WorkerActivated, { workerId: id });
    return updated;
  }

  async archive(id: string): Promise<Worker> {
    await this.workers.findByIdOrFail(id);
    const updated = await this.workers.update(id, { status: WorkerStatus.ARCHIVED });
    await this.events.publish(DomainEvent.WorkerArchived, { workerId: id });
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.workers.findByIdOrFail(id);

    // Removing a worker mid-mission would orphan running tasks; the caller
    // should archive instead.
    const running = await this.tasks.count({ workerId: id, status: 'RUNNING' });
    if (running > 0) {
      throw new BadRequestException(
        `This worker has ${running} running task(s). Archive it instead, or wait for them to finish.`,
      );
    }

    await this.workers.remove(id);
    await this.events.publish(DomainEvent.WorkerDeleted, { workerId: id });
  }

  /** Counts by status — feeds the dashboard without loading every row. */
  async statistics() {
    const [total, active, learning, dormant] = await Promise.all([
      this.workers.count(),
      this.workers.count({ status: WorkerStatus.ACTIVE }),
      this.workers.count({ status: WorkerStatus.LEARNING }),
      this.workers.count({ status: WorkerStatus.DORMANT }),
    ]);
    return { total, active, learning, dormant };
  }
}
