import { Injectable, Logger } from '@nestjs/common';
import { Knowledge } from '@prisma/client';
import { KnowledgeRepository } from '../../database/repositories/tenant.repositories';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEvent } from '../../events/domain-events';

export interface RetrievalQuery {
  query: string;
  limit?: number;
  tags?: string[];
  type?: Knowledge['type'];
  minScore?: number;
  /** Attribution for the `knowledge.retrieved` event. */
  workerId?: string;
  missionId?: string;
}

export interface RetrievedDocument {
  knowledge: Knowledge;
  score: number;
  /** The passage that matched, for citation in the prompt. */
  excerpt: string;
}

/**
 * Retrieval strategy. Swapping keyword search for vectors means adding an
 * implementation here, not changing any caller.
 */
export interface IRetrievalStrategy {
  readonly name: 'keyword' | 'vector' | 'hybrid';
  search(query: RetrievalQuery, candidates: Knowledge[]): Promise<RetrievedDocument[]>;
}

/**
 * TF-weighted keyword ranking.
 *
 * Deliberately not "count the matches": raw counts favour long documents that
 * mention a term incidentally over short ones that are actually about it.
 * Scoring here rewards term coverage, weights title matches above body
 * matches, and normalises by length.
 */
@Injectable()
export class KeywordRetrievalStrategy implements IRetrievalStrategy {
  readonly name = 'keyword' as const;

  async search(query: RetrievalQuery, candidates: Knowledge[]): Promise<RetrievedDocument[]> {
    const terms = tokenize(query.query);
    if (!terms.length) return [];

    return candidates
      .map((knowledge) => {
        const title = knowledge.title.toLowerCase();
        const content = knowledge.content.toLowerCase();

        const matchedInTitle = terms.filter((t) => title.includes(t));
        const matchedInContent = terms.filter((t) => content.includes(t));
        const matchedTags = terms.filter((t) => knowledge.tags.includes(t));

        // Coverage — what fraction of the query this document addresses —
        // matters more than how often any single term appears.
        const coverage =
          new Set([...matchedInTitle, ...matchedInContent, ...matchedTags]).size /
          terms.length;
        if (coverage === 0) return null;

        const titleBoost = (matchedInTitle.length / terms.length) * 0.3;
        const tagBoost = (matchedTags.length / terms.length) * 0.2;

        // Density, damped by log length so a 50-word note and a 5,000-word
        // report compete on comparable footing.
        const occurrences = terms.reduce(
          (sum, t) => sum + (content.split(t).length - 1),
          0,
        );
        const density = occurrences / Math.max(1, Math.log10(content.length + 10));

        const score = Math.min(
          1,
          coverage * 0.5 + titleBoost + tagBoost + Math.min(0.2, density * 0.02),
        ) * knowledge.confidence;

        return {
          knowledge,
          score,
          excerpt: extractExcerpt(knowledge.content, terms),
        };
      })
      .filter((d): d is RetrievedDocument => d !== null)
      .sort((a, b) => b.score - a.score);
  }
}

/**
 * Cosine similarity over stored embeddings.
 *
 * Registered but inert until embeddings are backfilled — `Knowledge.embedding`
 * is empty for every row today, so this returns nothing and the service falls
 * back to keyword search rather than silently returning an empty result set.
 * Wiring it up is a backfill job plus a strategy switch, no caller changes.
 */
@Injectable()
export class VectorRetrievalStrategy implements IRetrievalStrategy {
  readonly name = 'vector' as const;

  private queryEmbedding: number[] | null = null;

  /** Supplied by the caller, which owns the embedding provider. */
  withQueryEmbedding(embedding: number[]): this {
    this.queryEmbedding = embedding;
    return this;
  }

  async search(query: RetrievalQuery, candidates: Knowledge[]): Promise<RetrievedDocument[]> {
    if (!this.queryEmbedding) return [];
    const terms = tokenize(query.query);

    return candidates
      .map((knowledge) => {
        const embedding = (knowledge as Knowledge & { embedding?: number[] }).embedding;
        if (!embedding?.length) return null;

        const score = cosineSimilarity(this.queryEmbedding!, embedding);
        return { knowledge, score, excerpt: extractExcerpt(knowledge.content, terms) };
      })
      .filter((d): d is RetrievedDocument => d !== null)
      .sort((a, b) => b.score - a.score);
  }
}

/**
 * Knowledge retrieval for workers.
 *
 * Workers do not search — they state what they need and receive ranked,
 * excerpted documents ready to drop into a prompt. Keeping retrieval on this
 * side of the boundary means the ranking can be upgraded (keyword → vector →
 * hybrid) without touching a single worker or prompt.
 */
@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new Logger(KnowledgeRetrievalService.name);
  private static readonly DEFAULT_LIMIT = 5;
  private static readonly CANDIDATE_POOL = 200;

  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly keyword: KeywordRetrievalStrategy,
    private readonly events: EventBusService,
  ) {}

  async retrieve(query: RetrievalQuery): Promise<RetrievedDocument[]> {
    const limit = query.limit ?? KnowledgeRetrievalService.DEFAULT_LIMIT;

    // Narrow in SQL first so ranking runs over a bounded set rather than the
    // whole corpus.
    const where: Record<string, unknown> = {};
    if (query.type) where.type = query.type;
    if (query.tags?.length) where.tags = { hasSome: query.tags };

    const candidates = await this.knowledge.findMany(where, {
      take: KnowledgeRetrievalService.CANDIDATE_POOL,
      orderBy: { createdAt: 'desc' },
    });

    const ranked = await this.keyword.search(query, candidates);
    const results = ranked
      .filter((d) => d.score >= (query.minScore ?? 0.1))
      .slice(0, limit);

    await this.events.publish(DomainEvent.KnowledgeRetrieved, {
      query: query.query.slice(0, 200),
      strategy: this.keyword.name,
      candidates: candidates.length,
      returned: results.length,
      workerId: query.workerId,
      missionId: query.missionId,
    });

    return results;
  }

  /** Retrieved documents rendered for a prompt, with citations. */
  async retrieveAsContext(query: RetrievalQuery): Promise<string> {
    const documents = await this.retrieve(query);
    if (!documents.length) return '';

    return documents
      .map(
        (d, i) =>
          `[${i + 1}] ${d.knowledge.title} (relevance ${d.score.toFixed(2)})\n${d.excerpt}`,
      )
      .join('\n\n');
  }

  get strategy(): string {
    return this.keyword.name;
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Stop words carry no retrieval signal and dilute coverage scoring. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
  'one', 'our', 'out', 'his', 'has', 'had', 'how', 'its', 'who', 'did', 'yes',
  'this', 'that', 'with', 'from', 'have', 'been', 'were', 'they', 'them',
  'what', 'when', 'which', 'their', 'would', 'there', 'about', 'into',
]);

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
    ),
  ].slice(0, 16);
}

/**
 * Returns the window of text around the densest cluster of query terms, so
 * the excerpt shows why the document matched rather than just its opening.
 */
function extractExcerpt(content: string, terms: string[], width = 320): string {
  if (content.length <= width) return content;
  if (!terms.length) return `${content.slice(0, width)}…`;

  const lower = content.toLowerCase();
  let bestIndex = 0;
  let bestHits = -1;

  // Coarse stride: exact positioning is not worth the extra passes.
  for (let i = 0; i < lower.length; i += 80) {
    const window = lower.slice(i, i + width);
    const hits = terms.filter((t) => window.includes(t)).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestIndex = i;
    }
  }

  const start = Math.max(0, bestIndex - 40);
  const excerpt = content.slice(start, start + width).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${start + width < content.length ? '…' : ''}`;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
