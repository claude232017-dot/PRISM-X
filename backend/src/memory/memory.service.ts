import { Injectable, Logger } from '@nestjs/common';
import { Memory, MemoryType } from '@prisma/client';
import { MemoryRepository } from '../database/repositories/execution.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';

export interface RememberInput {
  workerId: string;
  content: string;
  type?: MemoryType;
  category?: string;
  tags?: string[];
  /** 0..1. Higher survives consolidation and ranks earlier in recall. */
  importance?: number;
  missionId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  /** Lifetime for short-term entries. Ignored for long-term. */
  ttlSeconds?: number;
}

export interface RecallOptions {
  workerId: string;
  /** Free text the memories should be relevant to. */
  query?: string;
  limit?: number;
  type?: MemoryType;
  /** Drop anything scoring below this. */
  minScore?: number;
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
}

/**
 * Persistent worker memory.
 *
 * Two tiers with different lifetimes and different jobs:
 *
 *  - **Short-term** — the current conversation and recent execution context.
 *    Written constantly, expires on a TTL, cheap and disposable.
 *  - **Long-term** — learned strategies, user preferences, mission outcomes.
 *    Written deliberately, never expires, and is what makes a worker better
 *    at its job over time rather than merely repetitive.
 *
 * Retrieval is ranked rather than chronological, because the constraint that
 * matters is the context window: a worker can only be given a handful of
 * memories, so they must be the *right* handful.
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  private static readonly DEFAULT_SHORT_TERM_TTL = 60 * 60 * 24; // 24h
  private static readonly DEFAULT_RECALL_LIMIT = 8;
  /** Half-life used by the recency term, in days. */
  private static readonly RECENCY_HALF_LIFE_DAYS = 7;

  constructor(
    private readonly memories: MemoryRepository,
    private readonly events: EventBusService,
  ) {}

  async remember(input: RememberInput): Promise<Memory> {
    const type = input.type ?? MemoryType.SHORT_TERM;

    // Long-term memories are permanent by definition; only short-term ones
    // carry an expiry.
    const expiresAt =
      type === MemoryType.SHORT_TERM
        ? new Date(
            Date.now() +
              (input.ttlSeconds ?? MemoryService.DEFAULT_SHORT_TERM_TTL) * 1000,
          )
        : null;

    const memory = await this.memories.create({
      workerId: input.workerId,
      type,
      content: input.content,
      category: input.category ?? null,
      tags: MemoryService.normalizeTags(input.tags),
      importance: MemoryService.clamp(input.importance ?? 0.5),
      missionId: input.missionId ?? null,
      taskId: input.taskId ?? null,
      metadata: (input.metadata ?? {}) as never,
      expiresAt,
    });

    await this.events.publish(DomainEvent.MemoryUpdated, {
      workerId: input.workerId,
      memoryId: memory.id,
      type,
    });

    return memory;
  }

  /** Convenience for the common "record what happened" case. */
  rememberExecution(input: {
    workerId: string;
    missionId?: string;
    taskId?: string;
    summary: string;
    succeeded: boolean;
  }): Promise<Memory> {
    return this.remember({
      workerId: input.workerId,
      content: input.summary,
      type: MemoryType.SHORT_TERM,
      category: 'execution',
      tags: ['execution', input.succeeded ? 'success' : 'failure'],
      // Failures are worth more than successes: they carry the information
      // that changes future behaviour.
      importance: input.succeeded ? 0.4 : 0.7,
      missionId: input.missionId,
      taskId: input.taskId,
    });
  }

  /**
   * Returns the memories most worth putting in front of the worker.
   *
   * Score blends three signals:
   *   relevance  — keyword overlap with the query
   *   importance — as assigned when the memory was written
   *   recency    — exponential decay, so stale context fades
   *
   * With no query, relevance is neutral and ranking falls back to importance
   * and recency, which is the sensible default for "what should this worker
   * generally keep in mind".
   */
  async recall(options: RecallOptions): Promise<ScoredMemory[]> {
    const limit = options.limit ?? MemoryService.DEFAULT_RECALL_LIMIT;
    const terms = MemoryService.terms(options.query);

    const candidates = terms.length
      ? await this.memories.findCandidates(options.workerId, terms)
      : await this.memories.findLive(options.workerId, options.type);

    const scored = candidates
      .filter((m) => !options.type || m.type === options.type)
      .map((memory) => ({
        memory,
        score: this.score(memory, terms),
      }))
      .filter((s) => s.score >= (options.minScore ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Recording access is what lets consolidation distinguish memories that
    // are actually used from ones that merely exist.
    await this.memories.touchMany(scored.map((s) => s.memory.id));

    return scored;
  }

  /** Recalled memories rendered for inclusion in a prompt. */
  async recallAsContext(options: RecallOptions): Promise<string> {
    const scored = await this.recall(options);
    if (!scored.length) return '';

    return scored
      .map((s, i) => {
        const age = MemoryService.humanAge(s.memory.createdAt);
        const tier = s.memory.type === MemoryType.LONG_TERM ? 'long-term' : 'recent';
        return `${i + 1}. [${tier}, ${age}] ${s.memory.content}`;
      })
      .join('\n');
  }

  private score(memory: Memory, terms: string[]): number {
    const content = memory.content.toLowerCase();

    const relevance = terms.length
      ? terms.filter((t) => content.includes(t) || memory.tags.includes(t)).length /
        terms.length
      : 0.5;

    const ageDays = (Date.now() - memory.createdAt.getTime()) / 86_400_000;
    const recency = Math.pow(0.5, ageDays / MemoryService.RECENCY_HALF_LIFE_DAYS);

    // Long-term memories are meant to outlast recency decay — that is the
    // whole reason they were promoted — so the recency term is softened
    // rather than removed for them.
    const recencyWeight = memory.type === MemoryType.LONG_TERM ? 0.1 : 0.3;
    const relevanceWeight = 0.45;
    const importanceWeight = 1 - relevanceWeight - recencyWeight;

    return (
      relevance * relevanceWeight +
      memory.importance * importanceWeight +
      recency * recencyWeight
    );
  }

  /**
   * Promotes durable short-term memories to long-term and clears expired ones.
   *
   * A memory earns promotion by being important *and* repeatedly useful —
   * accessed more than once. Promoting on importance alone would fill
   * long-term memory with things that were written confidently and then never
   * mattered.
   */
  async consolidate(workerId: string): Promise<{
    promoted: number;
    pruned: number;
  }> {
    const shortTerm = await this.memories.findLive(workerId, MemoryType.SHORT_TERM, 500);

    const promotable = shortTerm.filter(
      (m) => m.importance >= 0.7 && m.accessCount >= 2,
    );

    for (const memory of promotable) {
      await this.memories.update(memory.id, {
        type: MemoryType.LONG_TERM,
        expiresAt: null,
        // Nudge importance up, capped, to reflect proven usefulness.
        importance: MemoryService.clamp(memory.importance + 0.1),
      });
    }

    const pruned = await this.memories.pruneExpired();

    if (promotable.length || pruned) {
      await this.events.publish(DomainEvent.MemoryConsolidated, {
        workerId,
        promoted: promotable.length,
        pruned,
      });
      this.logger.log(
        `Consolidated worker ${workerId}: ${promotable.length} promoted, ${pruned} pruned`,
      );
    }

    return { promoted: promotable.length, pruned };
  }

  async statistics(workerId: string) {
    const [shortTerm, longTerm] = await Promise.all([
      this.memories.countByType(workerId, MemoryType.SHORT_TERM),
      this.memories.countByType(workerId, MemoryType.LONG_TERM),
    ]);
    return { workerId, shortTerm, longTerm, total: shortTerm + longTerm };
  }

  list(workerId: string, type?: MemoryType): Promise<Memory[]> {
    return this.memories.findLive(workerId, type);
  }

  forget(id: string): Promise<void> {
    return this.memories.remove(id);
  }

  private static terms(query?: string): string[] {
    if (!query) return [];
    return [
      ...new Set(
        query
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          // Short tokens match everything and add noise rather than signal.
          .filter((t) => t.length > 3),
      ),
    ].slice(0, 12);
  }

  private static normalizeTags(tags?: string[]): string[] {
    if (!tags?.length) return [];
    return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  }

  private static clamp(value: number): number {
    return Math.min(1, Math.max(0, value));
  }

  private static humanAge(date: Date): string {
    const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
}
