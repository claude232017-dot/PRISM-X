import { Injectable } from '@nestjs/common';
import { Knowledge } from '@prisma/client';
import {
  KnowledgeRepository,
  WorkerRepository,
} from '../database/repositories/tenant.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import {
  CreateKnowledgeDto,
  QueryKnowledgeDto,
  UpdateKnowledgeDto,
} from './dto/knowledge.dto';
import { paginate } from '../shared/dto/pagination.dto';

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly workers: WorkerRepository,
    private readonly events: EventBusService,
  ) {}

  async create(dto: CreateKnowledgeDto): Promise<Knowledge> {
    if (dto.workerId) await this.workers.findByIdOrFail(dto.workerId);

    const entry = await this.knowledge.create({
      title: dto.title,
      content: dto.content,
      type: dto.type ?? 'NOTE',
      tags: KnowledgeService.normalizeTags(dto.tags),
      workerId: dto.workerId ?? null,
      source: dto.source ?? null,
      storagePath: dto.storagePath ?? null,
      confidence: dto.confidence ?? 1,
      metadata: (dto.metadata ?? {}) as never,
    });

    await this.events.publish(DomainEvent.KnowledgeStored, {
      knowledgeId: entry.id,
      title: entry.title,
      type: entry.type,
    });
    return entry;
  }

  async findAll(query: QueryKnowledgeDto) {
    if (query.search) {
      const { rows, total } = await this.knowledge.search(query.search, {
        skip: query.skip,
        take: query.limit,
      });
      return paginate(rows, total, query.page, query.limit);
    }

    const where: Record<string, unknown> = {};
    if (query.type) where.type = query.type;
    if (query.tags) {
      where.tags = { hasSome: KnowledgeService.normalizeTags(query.tags.split(',')) };
    }

    const { rows, total } = await this.knowledge.paginate(where, {
      skip: query.skip,
      take: query.limit,
      orderBy: { [query.sortBy]: query.sortOrder },
    });
    return paginate(rows, total, query.page, query.limit);
  }

  findOne(id: string): Promise<Knowledge> {
    return this.knowledge.findByIdOrFail(id);
  }

  async update(id: string, dto: UpdateKnowledgeDto): Promise<Knowledge> {
    await this.knowledge.findByIdOrFail(id);
    if (dto.workerId) await this.workers.findByIdOrFail(dto.workerId);

    const patch: Record<string, unknown> = { ...dto };
    if (dto.tags) patch.tags = KnowledgeService.normalizeTags(dto.tags);

    const updated = await this.knowledge.update(id, patch);
    await this.events.publish(DomainEvent.KnowledgeUpdated, { knowledgeId: id });
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.knowledge.findByIdOrFail(id);
    await this.knowledge.remove(id);
    await this.events.publish(DomainEvent.KnowledgeDeleted, { knowledgeId: id });
  }

  /**
   * Lower-cased, trimmed, de-duplicated. Without this, "Pricing" and
   * "pricing " become distinct tags and tag filters quietly miss entries.
   */
  private static normalizeTags(tags?: string[]): string[] {
    if (!tags?.length) return [];
    return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  }

  async statistics() {
    const [total, insights, documents] = await Promise.all([
      this.knowledge.count(),
      this.knowledge.count({ type: 'INSIGHT' }),
      this.knowledge.count({ type: 'DOCUMENT' }),
    ]);
    return { total, insights, documents };
  }
}
