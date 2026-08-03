import { Injectable, Logger } from '@nestjs/common';
import {
  Knowledge,
  KnowledgeAudit,
  KnowledgeFinding,
  MetricSubject,
  RecommendationKind,
} from '@prisma/client';
import { KnowledgeAuditRepository } from '../database/repositories/learning.repositories';
import { KnowledgeRepository } from '../database/repositories/tenant.repositories';
import { ToolCallRepository } from '../database/repositories/execution.repositories';
import { MissionReviewRepository } from '../database/repositories/learning.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { RecommendationService } from './recommendation.service';
import * as Confidence from './confidence';

export interface AuditReport {
  documents: number;
  findings: number;
  byFinding: Record<string, number>;
  /** Mean confidence across the corpus, before and after this audit. */
  corpusConfidence: number;
}

/**
 * Keeps the knowledge base honest.
 *
 * Everything here is a *finding*, never an edit. Merging two documents or
 * deleting a stale one destroys information, and the judgement of whether
 * two documents say the same thing is exactly the sort a similarity score
 * gets wrong at the margins. So the audit writes findings, a human resolves
 * them, and the system's opinion never silently becomes the corpus.
 *
 * Similarity is computed on token overlap rather than embeddings, matching
 * the retrieval layer from Phase 2: an audit that judged similarity by a
 * different measure than the one used to retrieve would flag duplicates that
 * retrieval never confuses, and miss the ones it does.
 */
@Injectable()
export class KnowledgeEvolutionService {
  private readonly logger = new Logger(KnowledgeEvolutionService.name);

  /** Jaccard overlap above which two documents are near-duplicates. */
  static readonly NEAR_DUPLICATE = 0.6;
  /** Overlap above which they are effectively the same document. */
  static readonly DUPLICATE = 0.85;
  /** Days without an update before a document is considered stale. */
  static readonly STALE_DAYS = 180;
  /** Documents to compare in one pass. */
  static readonly WINDOW = 300;

  constructor(
    private readonly audits: KnowledgeAuditRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly toolCalls: ToolCallRepository,
    private readonly reviews: MissionReviewRepository,
    private readonly recommendations: RecommendationService,
    private readonly events: EventBusService,
  ) {}

  /**
   * Audits the corpus and records what it finds.
   *
   * Unresolved findings are cleared first so a re-audit converges on the
   * current state rather than piling a second opinion on top of the first.
   * Resolved ones are kept — a decision someone already made is not
   * something to ask again.
   */
  async audit(): Promise<AuditReport> {
    await this.audits.clearUnresolved();

    const documents = await this.knowledge.findMany(
      {},
      { take: KnowledgeEvolutionService.WINDOW, orderBy: { updatedAt: 'desc' } },
    );

    const usage = await this.usageCounts();
    const findings: Array<Parameters<typeof this.record>[0]> = [];

    // Pairwise similarity. Bounded by WINDOW because this is O(n²) and a
    // corpus audit that takes minutes will simply never be run.
    const tokenised = documents.map((doc) => ({
      doc,
      tokens: KnowledgeEvolutionService.tokenise(`${doc.title} ${doc.content}`),
    }));

    for (let i = 0; i < tokenised.length; i += 1) {
      for (let j = i + 1; j < tokenised.length; j += 1) {
        const similarity = KnowledgeEvolutionService.jaccard(
          tokenised[i].tokens,
          tokenised[j].tokens,
        );
        if (similarity < KnowledgeEvolutionService.NEAR_DUPLICATE) continue;

        const exact = similarity >= KnowledgeEvolutionService.DUPLICATE;
        findings.push({
          knowledgeId: tokenised[i].doc.id,
          finding: exact ? KnowledgeFinding.DUPLICATE : KnowledgeFinding.NEAR_DUPLICATE,
          relatedId: tokenised[j].doc.id,
          similarity,
          detail:
            `"${tokenised[i].doc.title}" and "${tokenised[j].doc.title}" share ` +
            `${(similarity * 100).toFixed(0)}% of their vocabulary.`,
          suggestion: exact
            ? 'Keep the more recent one and delete the other, or merge them.'
            : 'Review whether these should be one document.',
          confidence: similarity,
        });
      }
    }

    const now = Date.now();
    for (const doc of documents) {
      const ageDays = (now - doc.updatedAt.getTime()) / 86_400_000;
      const uses = usage.get(doc.id) ?? 0;

      if (ageDays > KnowledgeEvolutionService.STALE_DAYS) {
        findings.push({
          knowledgeId: doc.id,
          finding: KnowledgeFinding.OUTDATED,
          detail:
            `"${doc.title}" has not been touched in ${Math.round(ageDays)} days.`,
          suggestion: 'Confirm it is still accurate, or retire it.',
          confidence: Confidence.score({
            samples: 1,
            ageDays,
            halfLifeDays: KnowledgeEvolutionService.STALE_DAYS,
          }).value,
        });
      }

      // Never retrieved and not new: either nobody needs it or it is
      // phrased so that search never finds it. Both are worth knowing.
      if (uses === 0 && ageDays > 30) {
        findings.push({
          knowledgeId: doc.id,
          finding: KnowledgeFinding.UNUSED,
          detail: `"${doc.title}" has never been retrieved in ${Math.round(ageDays)} days.`,
          suggestion:
            'Either it is not needed, or its wording does not match how people search. ' +
            'Check the title and tags before retiring it.',
          confidence: Confidence.score({ samples: Math.max(1, Math.round(ageDays / 30)) }).value,
        });
      }

      if (doc.tags.length === 0) {
        findings.push({
          knowledgeId: doc.id,
          finding: KnowledgeFinding.MISCATEGORISED,
          detail: `"${doc.title}" has no tags, so it only surfaces on a full-text match.`,
          suggestion: `Suggested tags: ${KnowledgeEvolutionService.suggestTags(doc).join(', ') || 'none obvious'}.`,
          confidence: 0.7,
        });
      }

      if (doc.confidence < 0.5) {
        findings.push({
          knowledgeId: doc.id,
          finding: KnowledgeFinding.LOW_CONFIDENCE,
          detail: `"${doc.title}" is stored with confidence ${doc.confidence.toFixed(2)}.`,
          suggestion: 'Verify it against a source, or mark it as a draft.',
          confidence: 1 - doc.confidence,
        });
      }
    }

    // Gaps: recurring mission errors with nothing in the corpus about them.
    findings.push(...(await this.findGaps(tokenised)));

    for (const finding of findings) await this.record(finding);

    const byFinding: Record<string, number> = {};
    for (const finding of findings) {
      byFinding[finding.finding] = (byFinding[finding.finding] ?? 0) + 1;
    }

    const corpusConfidence =
      documents.length > 0
        ? Number(
            (documents.reduce((s, d) => s + d.confidence, 0) / documents.length).toFixed(4),
          )
        : 0;

    await this.events.publish(DomainEvent.KnowledgeAudited, {
      documents: documents.length,
      findings: findings.length,
      byFinding,
    });

    await this.proposeCleanups(findings.length, byFinding);

    return {
      documents: documents.length,
      findings: findings.length,
      byFinding,
      corpusConfidence,
    };
  }

  async findings(take = 100): Promise<KnowledgeAudit[]> {
    return this.audits.unresolved(take);
  }

  async forDocument(knowledgeId: string): Promise<KnowledgeAudit[]> {
    return this.audits.forDocument(knowledgeId);
  }

  /**
   * Marks a finding handled.
   *
   * Resolving does not perform the action — deleting or merging documents
   * stays with the ordinary knowledge endpoints, where it is audited like
   * any other write. This only records that a human considered it.
   */
  async resolve(id: string, resolution: string): Promise<KnowledgeAudit> {
    const ctx = RequestContextStore.require();
    return this.audits.update(id, {
      resolvedAt: new Date(),
      resolvedById: ctx.userId,
      resolution,
    });
  }

  /**
   * Recomputes a document's confidence from how it has actually been used.
   *
   * Retrieval is weak evidence of usefulness and age is weak evidence
   * against, which is why both are folded in gently rather than allowed to
   * dominate — a document nobody has needed yet is not thereby wrong.
   */
  async rescore(knowledgeId: string): Promise<Knowledge> {
    const doc = await this.knowledge.findByIdOrFail(knowledgeId);
    const usage = await this.usageCounts();
    const uses = usage.get(knowledgeId) ?? 0;
    const ageDays = (Date.now() - doc.updatedAt.getTime()) / 86_400_000;

    const evidence = Confidence.score({
      samples: uses,
      ageDays,
      halfLifeDays: KnowledgeEvolutionService.STALE_DAYS,
    });

    // Anchored at the stored value: usage nudges it rather than replacing a
    // human's assessment of whether the document is true.
    const rescored = Number(
      Math.min(1, Math.max(0.1, doc.confidence * 0.7 + evidence.value * 0.3)).toFixed(4),
    );

    return this.knowledge.update(knowledgeId, { confidence: rescored });
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  /** How often each document has been returned by the knowledge tools. */
  private async usageCounts(): Promise<Map<string, number>> {
    const calls = await this.toolCalls.findMany(
      { tool: { in: ['knowledge.search', 'knowledge.store'] } },
      { take: 2000, orderBy: { createdAt: 'desc' } },
    );

    const counts = new Map<string, number>();
    for (const call of calls) {
      const output = JSON.stringify(call.output ?? '');
      // Ids appear in the serialised result; counting occurrences is coarse
      // but needs no extra bookkeeping on the retrieval path.
      for (const match of output.matchAll(/"id":"(c[a-z0-9]{20,})"/g)) {
        counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
      }
    }
    return counts;
  }

  private async findGaps(
    tokenised: Array<{ doc: Knowledge; tokens: Set<string> }>,
  ): Promise<Array<Parameters<typeof this.record>[0]>> {
    const reviews = await this.reviews.recent(100);
    const errorCounts = new Map<string, number>();

    for (const review of reviews) {
      for (const error of review.errors) {
        errorCounts.set(error, (errorCounts.get(error) ?? 0) + 1);
      }
    }

    const gaps: Array<Parameters<typeof this.record>[0]> = [];
    for (const [error, count] of errorCounts) {
      if (count < 3) continue;

      const errorTokens = KnowledgeEvolutionService.tokenise(error);
      const covered = tokenised.some(
        (entry) => KnowledgeEvolutionService.jaccard(entry.tokens, errorTokens) > 0.25,
      );
      if (covered) continue;

      // Attached to the most recently updated document only so the finding
      // has somewhere to live; the corpus has no row for "the thing that is
      // missing", which is the nature of a gap.
      const anchor = tokenised[0]?.doc;
      if (!anchor) continue;

      gaps.push({
        knowledgeId: anchor.id,
        finding: KnowledgeFinding.GAP,
        detail:
          `"${error.slice(0, 100)}" has come up in ${count} mission reviews and nothing ` +
          'in the knowledge base addresses it.',
        suggestion: 'Write a short document covering this failure and how to handle it.',
        confidence: Confidence.score({ samples: count }).value,
      });
    }

    return gaps.slice(0, 10);
  }

  private async record(input: {
    knowledgeId: string;
    finding: KnowledgeFinding;
    relatedId?: string;
    similarity?: number;
    detail: string;
    suggestion: string;
    confidence: number;
  }): Promise<void> {
    await this.audits.create({
      knowledgeId: input.knowledgeId,
      finding: input.finding,
      relatedId: input.relatedId ?? null,
      similarity: input.similarity ?? null,
      detail: input.detail,
      suggestion: input.suggestion,
      confidence: Number(input.confidence.toFixed(4)),
    });
  }

  /**
   * Raises a single recommendation summarising the audit.
   *
   * One proposal for the corpus, not one per document: a hundred separate
   * "review this document" cards is a backlog nobody clears, and the
   * decision a person actually makes is whether to spend an afternoon on
   * knowledge cleanup at all.
   */
  private async proposeCleanups(
    total: number,
    byFinding: Record<string, number>,
  ): Promise<void> {
    const duplicates = (byFinding[KnowledgeFinding.DUPLICATE] ?? 0) +
      (byFinding[KnowledgeFinding.NEAR_DUPLICATE] ?? 0);
    if (duplicates === 0) return;

    await this.recommendations.propose({
      kind: RecommendationKind.KNOWLEDGE_MERGE,
      subject: MetricSubject.ORGANIZATION,
      subjectId: 'organization',
      subjectLabel: 'Knowledge base',
      title: `Review ${duplicates} duplicate document(s)`,
      reasoning:
        `A corpus audit found ${duplicates} pair(s) of documents with substantially ` +
        `overlapping content, out of ${total} findings overall. Duplicates split ` +
        'retrieval across near-identical answers and make updates easy to miss.',
      evidence: { byFinding, total },
      estimatedImpact: Math.min(0.5, duplicates / 20),
      impactSummary: 'cleaner retrieval and fewer contradictory answers',
      // Merging destroys information and the similarity score is a proxy,
      // not a judgement about meaning. This never goes through unattended.
      risk: 'MEDIUM',
      riskNotes: 'Merging is not reversible once the losing document is deleted.',
      proposedChange: {},
      rollback: { note: 'No automatic change is made; resolve findings individually.' },
      confidence: Confidence.score({ samples: duplicates }).value,
      sampleSize: duplicates,
    });
  }

  // ----------------------------------------------------------------
  // Pure helpers
  // ----------------------------------------------------------------

  static tokenise(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/\W+/)
        .filter((token) => token.length > 3 && !STOP_WORDS.has(token)),
    );
  }

  /**
   * Jaccard overlap: shared tokens over total distinct tokens.
   *
   * Chosen over raw shared-token count because that would rate two long
   * documents as similar simply for both being long.
   */
  static jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const token of a) if (b.has(token)) shared += 1;
    const union = a.size + b.size - shared;
    return union > 0 ? Number((shared / union).toFixed(4)) : 0;
  }

  static suggestTags(doc: Pick<Knowledge, 'title' | 'content' | 'type'>): string[] {
    const counts = new Map<string, number>();
    for (const token of `${doc.title} ${doc.content}`.toLowerCase().split(/\W+/)) {
      if (token.length <= 3 || STOP_WORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([token]) => token);
  }
}

/**
 * Words too common to carry meaning in an overlap score. Kept short and
 * English-only on purpose — an aggressive list starts removing the domain
 * terms that make two documents genuinely comparable.
 */
const STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'they', 'them', 'then', 'than',
  'been', 'will', 'would', 'could', 'should', 'about', 'into', 'over',
  'when', 'what', 'which', 'their', 'there', 'here', 'were', 'also',
  'each', 'more', 'most', 'some', 'such', 'only', 'other', 'these', 'those',
  'because', 'while', 'after', 'before', 'between', 'through', 'during',
]);
