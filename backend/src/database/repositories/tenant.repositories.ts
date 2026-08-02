import { Injectable } from '@nestjs/common';
import type {
  AuditLog,
  Credential,
  Event,
  Extension,
  Integration,
  Knowledge,
  Mission,
  Provider,
  Task,
  Worker,
} from '@prisma/client';
import { BaseRepository } from './base.repository';
import { PrismaService, PrismaTx } from '../prisma.service';

@Injectable()
export class WorkerRepository extends BaseRepository<Worker> {
  protected readonly modelName = 'worker';
  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }


  findByStatus(status: Worker['status']): Promise<Worker[]> {
    return this.findMany({ status }, { orderBy: { createdAt: 'desc' } });
  }

  /** Workers bound to a provider — used to block deletion of a live provider. */
  countByProvider(providerId: string): Promise<number> {
    return this.count({ providerId });
  }
}

@Injectable()
export class MissionRepository extends BaseRepository<Mission> {
  protected readonly modelName = 'mission';
  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }


  findWithTasks(id: string): Promise<Mission | null> {
    return this.findById(id, { include: { tasks: { orderBy: { createdAt: 'asc' } } } });
  }

  findActive(): Promise<Mission[]> {
    return this.findMany({ status: { in: ['QUEUED', 'RUNNING'] } });
  }
}

@Injectable()
export class TaskRepository extends BaseRepository<Task> {
  protected readonly modelName = 'task';
  protected readonly softDeletes = false;
  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }


  findByMission(missionId: string): Promise<Task[]> {
    return this.findMany({ missionId }, { orderBy: { createdAt: 'asc' } });
  }

  /**
   * Tasks whose dependencies are all satisfied — the queue's ready set.
   * Dependency resolution happens in memory because `dependsOn` is an array
   * column; the row count per mission is small enough that this is cheaper
   * than a recursive CTE.
   */
  async findRunnable(missionId: string): Promise<Task[]> {
    const tasks = await this.findByMission(missionId);
    const completed = new Set(
      tasks.filter((t) => t.status === 'COMPLETED').map((t) => t.id),
    );
    return tasks.filter(
      (t) => t.status === 'PENDING' && t.dependsOn.every((dep) => completed.has(dep)),
    );
  }

  countByStatus(missionId: string, status: Task['status']): Promise<number> {
    return this.count({ missionId, status });
  }
}

@Injectable()
export class KnowledgeRepository extends BaseRepository<Knowledge> {
  protected readonly modelName = 'knowledge';
  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }


  /** Case-insensitive contains across title and content, plus tag matching. */
  search(term: string, options: { skip?: number; take?: number } = {}) {
    return this.paginate(
      {
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { content: { contains: term, mode: 'insensitive' } },
          { tags: { has: term } },
        ],
      },
      { ...options, orderBy: { createdAt: 'desc' } },
    );
  }

  findByTags(tags: string[]): Promise<Knowledge[]> {
    return this.findMany({ tags: { hasSome: tags } });
  }
}

@Injectable()
export class ProviderRepository extends BaseRepository<Provider> {
  protected readonly modelName = 'provider';
  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }


  findDefault(): Promise<Provider | null> {
    return this.delegate().findFirst({
      where: this.scope({ isDefault: true, status: 'CONNECTED' }),
    });
  }

  /** Clears the default flag across the tenant so only one can hold it. */
  async clearDefault(tx?: PrismaTx): Promise<void> {
    await this.delegate(tx).updateMany({
      where: this.scope({ isDefault: true }),
      data: { isDefault: false },
    });
  }
}

@Injectable()
export class IntegrationRepository extends BaseRepository<Integration> {
  protected readonly modelName = 'integration';
  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }

}

@Injectable()
export class ExtensionRepository extends BaseRepository<Extension> {
  protected readonly modelName = 'extension';
  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }


  findBySlug(slug: string): Promise<Extension | null> {
    return this.delegate().findFirst({ where: this.scope({ slug }) });
  }

  /** Enabled extensions subscribed to a given domain event. */
  findSubscribers(eventName: string): Promise<Extension[]> {
    return this.findMany({ status: 'ENABLED', subscribes: { has: eventName } });
  }
}

@Injectable()
export class EventRepository extends BaseRepository<Event> {
  protected readonly modelName = 'event';
  protected readonly softDeletes = false;
  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }


  findByName(name: string, take = 100): Promise<Event[]> {
    return this.findMany({ name }, { take, orderBy: { createdAt: 'desc' } });
  }

  findRecent(take = 100): Promise<Event[]> {
    return this.findMany({}, { take, orderBy: { createdAt: 'desc' } });
  }
}

@Injectable()
export class AuditLogRepository extends BaseRepository<AuditLog> {
  protected readonly modelName = 'auditLog';
  protected readonly softDeletes = false;
  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }


  findByResource(resource: string, take = 100): Promise<AuditLog[]> {
    return this.findMany({ resource }, { take, orderBy: { createdAt: 'desc' } });
  }
}

@Injectable()
export class CredentialRepository extends BaseRepository<Credential> {
  protected readonly modelName = 'credential';
  protected readonly softDeletes = false;
  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }


  async touch(id: string): Promise<void> {
    await this.delegate().updateMany({
      where: this.scope({ id }),
      data: { lastUsedAt: new Date() },
    });
  }
}

/** Barrel for module registration. */
export const TENANT_REPOSITORIES = [
  WorkerRepository,
  MissionRepository,
  TaskRepository,
  KnowledgeRepository,
  ProviderRepository,
  IntegrationRepository,
  ExtensionRepository,
  EventRepository,
  AuditLogRepository,
  CredentialRepository,
];

export type { PrismaService };
