import { NotFoundException } from '@nestjs/common';
import { PrismaService, PrismaTx } from '../prisma.service';
import { RequestContextStore } from '../../shared/context/request-context';

/**
 * Delegate shape shared by every generated Prisma model client. Kept
 * structural (rather than importing Prisma's per-model types) so one base
 * class can serve all repositories.
 */
export interface PrismaDelegate {
  findFirst(args?: any): Promise<any>;
  findMany(args?: any): Promise<any[]>;
  create(args: any): Promise<any>;
  update(args: any): Promise<any>;
  updateMany(args: any): Promise<{ count: number }>;
  delete(args: any): Promise<any>;
  deleteMany(args: any): Promise<{ count: number }>;
  count(args?: any): Promise<number>;
}

export interface ListOptions {
  skip?: number;
  take?: number;
  orderBy?: Record<string, 'asc' | 'desc'>;
  include?: Record<string, unknown>;
  select?: Record<string, unknown>;
  /** Include soft-deleted rows. Off by default. */
  withDeleted?: boolean;
}

/**
 * The only place in the codebase permitted to issue database calls.
 *
 * Two invariants are enforced here rather than left to callers:
 *
 *  1. **Tenant scoping.** `organizationId` is taken from the ambient
 *     RequestContext and merged into every `where` clause. It is not a
 *     parameter a caller can omit, and an unauthenticated caller gets an
 *     exception instead of an unscoped query. Repositories fail closed.
 *
 *  2. **Soft deletes.** Models with `deletedAt` are filtered automatically,
 *     so a deleted row cannot leak back through a forgotten predicate.
 *
 * This is the application half of tenant isolation; Postgres RLS is the other
 * half (see the `_rls` migration). Neither is trusted alone.
 */
export abstract class BaseRepository<TModel> {
  protected abstract readonly modelName: string;
  /** Set false for models without a `deletedAt` column (events, audit logs). */
  protected readonly softDeletes: boolean = true;

  constructor(protected readonly prisma: PrismaService) {}

  /** Resolves the delegate on the client or the supplied transaction. */
  protected delegate(tx?: PrismaTx): PrismaDelegate {
    const client = (tx ?? this.prisma) as unknown as Record<string, PrismaDelegate>;
    const delegate = client[this.modelName];
    if (!delegate) {
      throw new Error(`Unknown Prisma model "${this.modelName}"`);
    }
    return delegate;
  }

  /** The tenant every query in this repository is confined to. */
  protected get organizationId(): string {
    return RequestContextStore.require().organizationId;
  }

  /** Merges tenant scope (and soft-delete filter) into a caller's predicate. */
  protected scope(
    where: Record<string, unknown> = {},
    opts: { withDeleted?: boolean } = {},
  ): Record<string, unknown> {
    const scoped: Record<string, unknown> = {
      ...where,
      organizationId: this.organizationId,
    };
    if (this.softDeletes && !opts.withDeleted) scoped.deletedAt = null;
    return scoped;
  }

  async findById(id: string, options: ListOptions = {}): Promise<TModel | null> {
    return this.delegate().findFirst({
      where: this.scope({ id }, options),
      ...(options.include ? { include: options.include } : {}),
    });
  }

  /** Same as `findById` but throws a 404 instead of returning null. */
  async findByIdOrFail(id: string, options: ListOptions = {}): Promise<TModel> {
    const record = await this.findById(id, options);
    if (!record) {
      throw new NotFoundException(`${this.label} "${id}" was not found`);
    }
    return record;
  }

  async findMany(
    where: Record<string, unknown> = {},
    options: ListOptions = {},
  ): Promise<TModel[]> {
    return this.delegate().findMany({
      where: this.scope(where, options),
      ...(options.skip !== undefined ? { skip: options.skip } : {}),
      ...(options.take !== undefined ? { take: options.take } : {}),
      ...(options.orderBy ? { orderBy: options.orderBy } : {}),
      ...(options.include ? { include: options.include } : {}),
    });
  }

  /** One round trip for the page and its total, so counts can't drift. */
  async paginate(
    where: Record<string, unknown> = {},
    options: ListOptions = {},
  ): Promise<{ rows: TModel[]; total: number }> {
    const scoped = this.scope(where, options);
    const [rows, total] = await Promise.all([
      this.delegate().findMany({
        where: scoped,
        ...(options.skip !== undefined ? { skip: options.skip } : {}),
        ...(options.take !== undefined ? { take: options.take } : {}),
        ...(options.orderBy ? { orderBy: options.orderBy } : {}),
        ...(options.include ? { include: options.include } : {}),
      }),
      this.delegate().count({ where: scoped }),
    ]);
    return { rows, total };
  }

  async count(where: Record<string, unknown> = {}): Promise<number> {
    return this.delegate().count({ where: this.scope(where) });
  }

  async exists(where: Record<string, unknown>): Promise<boolean> {
    return (await this.count(where)) > 0;
  }

  /** `organizationId` is stamped from context and cannot be spoofed by input. */
  async create(data: Record<string, unknown>, tx?: PrismaTx): Promise<TModel> {
    return this.delegate(tx).create({
      data: { ...data, organizationId: this.organizationId },
    });
  }

  async update(
    id: string,
    data: Record<string, unknown>,
    tx?: PrismaTx,
  ): Promise<TModel> {
    // updateMany (not update) so the tenant predicate participates in the
    // match — `update` only accepts unique fields and would ignore scope.
    const { count } = await this.delegate(tx).updateMany({
      where: this.scope({ id }),
      data,
    });
    if (count === 0) {
      throw new NotFoundException(`${this.label} "${id}" was not found`);
    }
    return this.findByIdOrFail(id);
  }

  /** Soft-deletes when the model supports it, hard-deletes otherwise. */
  async remove(id: string, tx?: PrismaTx): Promise<void> {
    const { count } = this.softDeletes
      ? await this.delegate(tx).updateMany({
          where: this.scope({ id }),
          data: { deletedAt: new Date() },
        })
      : await this.delegate(tx).deleteMany({ where: this.scope({ id }) });

    if (count === 0) {
      throw new NotFoundException(`${this.label} "${id}" was not found`);
    }
  }

  /** Permanently removes a soft-deleted row. Irreversible. */
  async purge(id: string, tx?: PrismaTx): Promise<void> {
    await this.delegate(tx).deleteMany({
      where: { id, organizationId: this.organizationId },
    });
  }

  async restore(id: string, tx?: PrismaTx): Promise<TModel> {
    if (!this.softDeletes) {
      throw new Error(`${this.label} does not support soft deletion`);
    }
    await this.delegate(tx).updateMany({
      where: { id, organizationId: this.organizationId },
      data: { deletedAt: null },
    });
    return this.findByIdOrFail(id);
  }

  protected get label(): string {
    return this.modelName.charAt(0).toUpperCase() + this.modelName.slice(1);
  }
}
