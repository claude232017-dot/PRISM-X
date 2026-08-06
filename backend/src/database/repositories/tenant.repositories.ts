import { Injectable, OnApplicationShutdown } from '@nestjs/common';
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
import { AppendBuffer } from '../append-buffer';

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


  /**
   * Case-insensitive search across title, content and tags.
   *
   * The query is tokenized and matched term-by-term rather than as one literal
   * string: searching "competitor pricing tiers" should find a document about
   * competitor pricing even though that exact phrase appears nowhere in it.
   * Matching the whole string finds only documents containing the user's exact
   * word order, which is almost never what they meant.
   */
  search(term: string, options: { skip?: number; take?: number } = {}) {
    const tokens = [
      ...new Set(
        term
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length > 2),
      ),
    ].slice(0, 10);

    // Fall back to the raw string when the query is all short tokens, so a
    // search for something like "Q2" still works.
    const needles = tokens.length ? tokens : [term];

    return this.paginate(
      {
        OR: [
          ...needles.map((t) => ({
            title: { contains: t, mode: 'insensitive' as const },
          })),
          ...needles.map((t) => ({
            content: { contains: t, mode: 'insensitive' as const },
          })),
          { tags: { hasSome: needles } },
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

/**
 * The event log.
 *
 * The highest-volume write in the system: one row for every domain event, on
 * every mutating request, on every worker step. Buffered rather than written
 * one statement at a time — see `AppendBuffer` for the trade that makes.
 *
 * Reads drain the buffer first, so publishing an event and then listing events
 * behaves exactly as it did before batching existed.
 */
@Injectable()
export class EventRepository
  extends BaseRepository<Event>
  implements OnApplicationShutdown
{
  protected readonly modelName = 'event';
  protected readonly softDeletes = false;

  private readonly buffer = new AppendBuffer<Record<string, unknown>>(
    'event',
    (organizationId, rows) =>
      this.writeBatch(organizationId, rows as Array<Record<string, unknown>>),
  );

  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Buffers an event row instead of writing it immediately.
   *
   * The tenant is captured here, from the ambient context, because by flush
   * time the request that produced the row no longer exists.
   */
  async append(data: Record<string, unknown>): Promise<void> {
    await this.buffer.add(this.organizationId, {
      ...data,
      // `createMany` does not run Prisma's `@default(now())` per row the way
      // separate inserts do reliably enough to order by, so the timestamp is
      // taken when the event happened rather than when the batch went out.
      createdAt: new Date(),
    });
  }

  /**
   * Writes one tenant's buffered events.
   *
   * Performed inside `withTenant`, which pins the Postgres session variable the
   * row-level security policies read. This is one of the few places where that
   * is free: the buffer has already grouped rows by organization, the work is
   * pure database with no external I/O, and it is off the request path — so the
   * transaction is short and nothing waits on it.
   *
   * That matters because it makes the second isolation layer *load-bearing*
   * here rather than merely present: if this batch ever carried a row for the
   * wrong organization, the policy's WITH CHECK would reject the insert instead
   * of the platform discovering it later.
   */
  private async writeBatch(
    organizationId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    await this.prisma.withTenant(organizationId, (tx) =>
      tx.event.createMany({
        data: rows.map((row) => ({ ...row, organizationId })) as never,
        skipDuplicates: true,
      }),
    );
  }

  /** Forces buffered rows out. Called before any read of this table. */
  flush(): Promise<void> {
    return this.buffer.flush();
  }

  /** Rows waiting to be written, for the metrics gauge. */
  get pending(): number {
    return this.buffer.depth;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.buffer.flush().catch(() => undefined);
  }

  /** Every read drains the buffer first, so batching is invisible to callers. */
  protected async beforeRead(): Promise<void> {
    await this.flush();
  }

  async findByName(name: string, take = 100): Promise<Event[]> {
    return this.findMany({ name }, { take, orderBy: { createdAt: 'desc' } });
  }

  async findRecent(take = 100): Promise<Event[]> {
    return this.findMany({}, { take, orderBy: { createdAt: 'desc' } });
  }
}

/**
 * The audit trail. Buffered on the same terms as the event log.
 *
 * One row per mutating request, and the read path drains before querying, so
 * an administrator who makes a change and immediately opens the audit view
 * sees it.
 */
@Injectable()
export class AuditLogRepository
  extends BaseRepository<AuditLog>
  implements OnApplicationShutdown
{
  protected readonly modelName = 'auditLog';
  protected readonly softDeletes = false;

  private readonly buffer = new AppendBuffer<Record<string, unknown>>(
    'audit',
    (organizationId, rows) =>
      this.writeBatch(organizationId, rows as Array<Record<string, unknown>>),
  );

  // An explicit constructor is required even though it only calls super():
  // TypeScript emits `design:paramtypes` metadata only for classes that
  // declare a constructor, and without that metadata Nest injects nothing
  // into the inherited one, leaving `prisma` undefined at runtime.
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** Buffers an audit row, capturing the tenant at the point of the write. */
  async append(data: Record<string, unknown>): Promise<void> {
    await this.buffer.add(this.organizationId, { ...data, createdAt: new Date() });
  }

  /** Written under `withTenant`, for the reasons given on the event buffer. */
  private async writeBatch(
    organizationId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    await this.prisma.withTenant(organizationId, (tx) =>
      tx.auditLog.createMany({
        data: rows.map((row) => ({ ...row, organizationId })) as never,
        skipDuplicates: true,
      }),
    );
  }

  flush(): Promise<void> {
    return this.buffer.flush();
  }

  get pending(): number {
    return this.buffer.depth;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.buffer.flush().catch(() => undefined);
  }

  /** Every read drains the buffer first, so batching is invisible to callers. */
  protected async beforeRead(): Promise<void> {
    await this.flush();
  }

  async findByResource(resource: string, take = 100): Promise<AuditLog[]> {
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
