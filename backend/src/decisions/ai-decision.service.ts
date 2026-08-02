import { Injectable, Logger } from '@nestjs/common';
import { RiskLevel } from '@prisma/client';
import { WorkerRuntimeService } from '../workers/runtime/worker-runtime.service';
import { ApprovalService } from '../approvals/approval.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';

export interface DecisionRequest {
  runId?: string;
  stepId?: string;
  workerId: string;
  question: string;
  /** The only answers the worker may give. */
  options: string[];
  context?: Record<string, unknown>;
  /** Below this confidence the decision escalates. Default 0.7. */
  confidenceThreshold?: number;
  /** Refuse the decision if it would cost more than this. */
  costLimitUsd?: number;
  /** When false, a low-confidence answer is returned rather than escalated. */
  requireApprovalBelowConfidence?: boolean;
  /** Escalate regardless of confidence — for inherently consequential calls. */
  alwaysRequireApproval?: boolean;
  riskLevel?: RiskLevel;
}

export interface DecisionOutcome {
  ok: boolean;
  choice?: string;
  confidence: number;
  reasoning?: string;
  escalated: boolean;
  approvalId?: string;
  costUsd: number;
  error?: string;
}

/**
 * Lets a worker make a bounded decision inside a workflow.
 *
 * The constraint that makes this safe is that the model never gets an open
 * question. It is given a closed set of options and must pick one; anything
 * outside the set is rejected rather than accepted as a novel answer. On top
 * of that:
 *
 *  - **Confidence threshold** — a hesitant answer escalates to a human instead
 *    of being acted on.
 *  - **Cost limit** — a decision that would exceed its budget fails rather
 *    than silently spending.
 *  - **Approval requirement** — consequential decisions can be made to always
 *    escalate regardless of how confident the model claims to be.
 *
 * Organization permissions still apply throughout: the decision runs as a
 * worker, so it can reach nothing that worker could not reach directly.
 */
@Injectable()
export class AiDecisionService {
  private readonly logger = new Logger(AiDecisionService.name);
  private static readonly DEFAULT_THRESHOLD = 0.7;

  constructor(
    private readonly workers: WorkerRuntimeService,
    private readonly approvals: ApprovalService,
    private readonly events: EventBusService,
  ) {}

  async decide(request: DecisionRequest): Promise<DecisionOutcome> {
    if (!request.workerId) {
      return this.failure('An AI decision needs a `workerId`');
    }
    if (!request.options?.length) {
      return this.failure('An AI decision needs at least one option to choose from');
    }
    if (!request.question) {
      return this.failure('An AI decision needs a `question`');
    }

    const threshold = request.confidenceThreshold ?? AiDecisionService.DEFAULT_THRESHOLD;

    const execution = await this.workers.execute({
      workerId: request.workerId,
      instruction: this.buildPrompt(request),
      // Retrieval is skipped: the decision must rest on the context supplied
      // by the workflow, not on whatever a search happens to surface.
      skipRetrieval: true,
      missionId: undefined,
    });

    if (execution.status !== 'SUCCEEDED') {
      return {
        ok: false,
        confidence: 0,
        escalated: false,
        costUsd: execution.costUsd,
        error: execution.error ?? 'Decision execution failed',
      };
    }

    if (request.costLimitUsd !== undefined && execution.costUsd > request.costLimitUsd) {
      return {
        ok: false,
        confidence: 0,
        escalated: false,
        costUsd: execution.costUsd,
        error:
          `Decision cost $${execution.costUsd.toFixed(6)} exceeded its ` +
          `$${request.costLimitUsd} limit`,
      };
    }

    const parsed = AiDecisionService.parse(execution.output, request.options);

    if (!parsed.choice) {
      return {
        ok: false,
        confidence: parsed.confidence,
        escalated: false,
        costUsd: execution.costUsd,
        error:
          'The worker did not choose one of the permitted options ' +
          `(${request.options.join(', ')})`,
      };
    }

    const mustEscalate =
      request.alwaysRequireApproval === true ||
      (parsed.confidence < threshold && request.requireApprovalBelowConfidence !== false);

    if (mustEscalate) {
      const approval = await this.approvals.request({
        runId: request.runId,
        stepId: request.stepId,
        title: `AI decision needs confirmation: ${request.question.slice(0, 80)}`,
        reason:
          request.alwaysRequireApproval === true
            ? 'This decision is configured to always require human confirmation.'
            : `The worker chose "${parsed.choice}" with confidence ` +
              `${parsed.confidence.toFixed(2)}, below the ${threshold} threshold.`,
        suggestedAction: parsed.choice,
        riskLevel: request.riskLevel ?? RiskLevel.MEDIUM,
        context: {
          question: request.question,
          options: request.options,
          proposed: parsed.choice,
          confidence: parsed.confidence,
          reasoning: parsed.reasoning,
          ...request.context,
        },
      });

      await this.events.publish(DomainEvent.AiDecisionEscalated, {
        runId: request.runId,
        workerId: request.workerId,
        choice: parsed.choice,
        confidence: parsed.confidence,
        approvalId: approval.id,
      });

      return {
        ok: false,
        choice: parsed.choice,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
        escalated: true,
        approvalId: approval.id,
        costUsd: execution.costUsd,
      };
    }

    await this.events.publish(DomainEvent.AiDecisionMade, {
      runId: request.runId,
      workerId: request.workerId,
      choice: parsed.choice,
      confidence: parsed.confidence,
      costUsd: execution.costUsd,
    });

    return {
      ok: true,
      choice: parsed.choice,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      escalated: false,
      costUsd: execution.costUsd,
    };
  }

  /**
   * Builds a prompt demanding a machine-readable answer.
   *
   * The explicit format matters: a free-form reply would have to be
   * interpreted, and interpretation is exactly where a decision layer starts
   * inventing answers nobody authorised.
   */
  private buildPrompt(request: DecisionRequest): string {
    return [
      'You must make a decision. Choose exactly one option from the permitted list.',
      '',
      `Question: ${request.question}`,
      '',
      'Permitted options:',
      ...request.options.map((o, i) => `  ${i + 1}. ${o}`),
      '',
      Object.keys(request.context ?? {}).length
        ? `Context:\n${JSON.stringify(request.context, null, 2)}`
        : '',
      '',
      'Reply with exactly this JSON and nothing else:',
      'DECISION: {"choice": "<one permitted option, copied verbatim>", ' +
        '"confidence": <0.0-1.0>, "reasoning": "<one sentence>"}',
      '',
      'If the context is insufficient to choose responsibly, still choose the ' +
        'safest option but report low confidence.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Extracts the decision from the model's reply.
   *
   * A choice outside the permitted set is discarded rather than coerced —
   * silently mapping an unexpected answer onto a permitted one would be the
   * decision layer overriding the model with a guess.
   */
  private static parse(
    output: string,
    options: string[],
  ): { choice?: string; confidence: number; reasoning?: string } {
    const match = /DECISION:\s*(\{[\s\S]*\})/.exec(output);

    if (match) {
      try {
        const parsed = JSON.parse(match[1]) as {
          choice?: string;
          confidence?: number;
          reasoning?: string;
        };
        const choice = options.find(
          (o) => o.toLowerCase() === String(parsed.choice ?? '').toLowerCase().trim(),
        );
        if (choice) {
          return {
            choice,
            confidence: clamp(Number(parsed.confidence ?? 0.5)),
            reasoning: parsed.reasoning,
          };
        }
      } catch {
        // Fall through to the textual scan below.
      }
    }

    // Fallback: an option quoted verbatim in the reply, accepted only when
    // exactly one matches — two candidates means the answer is ambiguous.
    const mentioned = options.filter((o) =>
      output.toLowerCase().includes(o.toLowerCase()),
    );
    if (mentioned.length === 1) {
      // Confidence is deliberately low: this was inferred, not stated.
      return { choice: mentioned[0], confidence: 0.4, reasoning: 'Inferred from reply text' };
    }

    return { confidence: 0 };
  }

  private failure(message: string): DecisionOutcome {
    return { ok: false, confidence: 0, escalated: false, costUsd: 0, error: message };
  }
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
