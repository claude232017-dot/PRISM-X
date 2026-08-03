import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  EntityVersion,
  EvolutionSubject,
  VersionAspect,
  VersionOrigin,
  Worker,
} from '@prisma/client';
import { EntityVersionRepository } from '../database/repositories/evolution.repositories';
import { WorkerRepository } from '../database/repositories/tenant.repositories';
import {
  WorkflowRepository,
  WorkflowVersionRepository,
} from '../database/repositories/automation.repositories';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';

export interface VersionDiff {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * Version history for everything that can evolve.
 *
 * Versions are immutable and are never deleted — a new one supersedes its
 * predecessor. That is what makes rollback a matter of re-activating a row
 * that already exists, rather than reconstructing a past state by replaying
 * diffs and hoping. It is also why the Constitution's NO_AUTOMATIC_DELETION
 * law can be absolute: nothing in the evolution path ever needs to remove a
 * row, so a change that would is always a mistake.
 *
 * A subject has independent lineages per **aspect**. A worker's prompt,
 * model, tool permissions, memory strategy and limits each version
 * separately, because they change for different reasons and at different
 * rates — versioning them together would mean a prompt tweak invalidating a
 * carefully benchmarked model choice.
 */
@Injectable()
export class VersionService {
  private readonly logger = new Logger(VersionService.name);

  /** Which worker fields belong to which aspect. */
  static readonly WORKER_ASPECTS: Record<string, VersionAspect> = {
    systemPrompt: VersionAspect.PROMPT,
    defaultModel: VersionAspect.MODEL,
    providerId: VersionAspect.MODEL,
    temperature: VersionAspect.MODEL,
    toolPermissions: VersionAspect.TOOLS,
    maxIterations: VersionAspect.LIMITS,
    maxTokens: VersionAspect.LIMITS,
    timeoutMs: VersionAspect.LIMITS,
    costLimitUsd: VersionAspect.LIMITS,
    allowFailover: VersionAspect.LIMITS,
    nodeRequirements: VersionAspect.LIMITS,
    preferredNodeId: VersionAspect.LIMITS,
  };

  constructor(
    private readonly versions: EntityVersionRepository,
    private readonly workers: WorkerRepository,
    private readonly workflows: WorkflowRepository,
    private readonly workflowVersions: WorkflowVersionRepository,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Capturing
  // ----------------------------------------------------------------

  /**
   * Records a new version without activating it.
   *
   * Creating and activating are separate acts on purpose: a candidate's
   * version exists while it is being benchmarked, and only becomes what
   * production runs if it wins. A create-and-activate helper would make the
   * unsafe path the convenient one.
   */
  async capture(input: {
    subject: EvolutionSubject;
    subjectId: string;
    aspect: VersionAspect;
    payload: Record<string, unknown>;
    previous?: Record<string, unknown>;
    label?: string;
    notes?: string;
    origin?: VersionOrigin;
    candidateId?: string;
    benchmarkId?: string;
  }): Promise<EntityVersion> {
    const ctx = RequestContextStore.get();
    const version = await this.versions.nextVersion(
      input.subject,
      input.subjectId,
      input.aspect,
    );

    const previous =
      input.previous ?? (await this.readCurrent(input.subject, input.subjectId, Object.keys(input.payload)));

    const created = await this.versions.create({
      subject: input.subject,
      subjectId: input.subjectId,
      aspect: input.aspect,
      version,
      payload: input.payload as never,
      previous: previous as never,
      label: input.label ?? null,
      notes: input.notes ?? null,
      origin: input.origin ?? VersionOrigin.MANUAL,
      candidateId: input.candidateId ?? null,
      benchmarkId: input.benchmarkId ?? null,
      createdById: ctx?.userId ?? null,
    });

    await this.events.publish(DomainEvent.EvolutionVersionCreated, {
      versionId: created.id,
      subject: input.subject,
      subjectId: input.subjectId,
      aspect: input.aspect,
      version,
    });

    return created;
  }

  /**
   * Ensures a lineage has a version representing what production runs now.
   *
   * Without this, the first evolution of a worker would have nothing to roll
   * back to — its original configuration would exist only as the live row,
   * which the deployment is about to overwrite.
   */
  async ensureBaseline(
    subject: EvolutionSubject,
    subjectId: string,
    aspect: VersionAspect,
  ): Promise<EntityVersion> {
    const active = await this.versions.findActive(subject, subjectId, aspect);
    if (active) return active;

    const fields = VersionService.fieldsFor(subject, aspect);
    const payload = await this.readCurrent(subject, subjectId, fields);

    const baseline = await this.capture({
      subject,
      subjectId,
      aspect,
      payload,
      previous: {},
      label: 'baseline',
      notes: 'Captured automatically as the state before any evolution.',
      origin: VersionOrigin.IMPORT,
    });

    return this.versions.activate(baseline.id);
  }

  // ----------------------------------------------------------------
  // Reading
  // ----------------------------------------------------------------

  async lineage(
    subject: EvolutionSubject,
    subjectId: string,
    aspect: VersionAspect,
  ): Promise<EntityVersion[]> {
    return this.versions.lineage(subject, subjectId, aspect);
  }

  async active(
    subject: EvolutionSubject,
    subjectId: string,
    aspect: VersionAspect,
  ): Promise<EntityVersion | null> {
    return this.versions.findActive(subject, subjectId, aspect);
  }

  async historyFor(subject: EvolutionSubject, subjectId: string): Promise<EntityVersion[]> {
    return this.versions.aspectsFor(subject, subjectId);
  }

  /** Field-by-field difference between two versions of the same lineage. */
  async diff(fromId: string, toId: string): Promise<{ diff: VersionDiff[]; from: EntityVersion; to: EntityVersion }> {
    const [from, to] = await Promise.all([
      this.versions.findByIdOrFail(fromId),
      this.versions.findByIdOrFail(toId),
    ]);

    if (from.subjectId !== to.subjectId || from.aspect !== to.aspect) {
      throw new BadRequestException(
        'Those versions belong to different lineages and cannot be compared',
      );
    }

    return { diff: VersionService.diffPayloads(from.payload, to.payload), from, to };
  }

  /** Activates a version. The only way production changes which one it runs. */
  async activate(id: string): Promise<EntityVersion> {
    const activated = await this.versions.activate(id);

    await this.events.publish(DomainEvent.EvolutionVersionActivated, {
      versionId: id,
      subject: activated.subject,
      subjectId: activated.subjectId,
      aspect: activated.aspect,
      version: activated.version,
    });

    return activated;
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  /** Reads the live values of the given fields from the subject record. */
  async readCurrent(
    subject: EvolutionSubject,
    subjectId: string,
    fields: string[],
  ): Promise<Record<string, unknown>> {
    const state: Record<string, unknown> = {};

    if (subject === EvolutionSubject.WORKER) {
      const worker = await this.workers.findById(subjectId);
      if (!worker) return state;
      for (const field of fields) {
        state[field] = (worker as unknown as Record<string, unknown>)[field];
      }
      return state;
    }

    if (subject === EvolutionSubject.WORKFLOW) {
      const workflow = await this.workflows.findById(subjectId);
      if (!workflow) return state;

      // A workflow's evolvable state is its graph, which lives on the
      // published version rather than on the workflow row.
      if (fields.includes('steps') && workflow.activeVersionId) {
        const version = await this.workflowVersions.findById(workflow.activeVersionId);
        state.steps = version?.steps ?? [];
        state.activeVersionId = workflow.activeVersionId;
      }
      for (const field of fields.filter((f) => f !== 'steps')) {
        state[field] = (workflow as unknown as Record<string, unknown>)[field];
      }
      return state;
    }

    return state;
  }

  /** Which fields make up an aspect, for baseline capture. */
  static fieldsFor(subject: EvolutionSubject, aspect: VersionAspect): string[] {
    if (subject === EvolutionSubject.WORKER) {
      return Object.entries(VersionService.WORKER_ASPECTS)
        .filter(([, a]) => a === aspect)
        .map(([field]) => field);
    }
    if (subject === EvolutionSubject.WORKFLOW) {
      return aspect === VersionAspect.GRAPH ? ['steps', 'activeVersionId'] : [];
    }
    return [];
  }

  /**
   * Which aspect a set of changed fields belongs to.
   *
   * A change spanning two aspects is refused rather than assigned to one:
   * it would produce a version whose lineage is ambiguous, and rolling it
   * back would restore half of what it changed.
   */
  static aspectForChange(
    subject: EvolutionSubject,
    change: Record<string, unknown>,
  ): VersionAspect {
    if (subject === EvolutionSubject.WORKFLOW) return VersionAspect.GRAPH;
    if (subject === EvolutionSubject.PLANNING) return VersionAspect.STRATEGY;

    const aspects = new Set(
      Object.keys(change)
        .map((field) => VersionService.WORKER_ASPECTS[field])
        .filter(Boolean),
    );

    if (aspects.size === 0) {
      throw new BadRequestException(
        `None of [${Object.keys(change).join(', ')}] is a versioned field`,
      );
    }
    if (aspects.size > 1) {
      throw new BadRequestException(
        `A change must belong to one aspect; this spans ${[...aspects].join(', ')}. ` +
          'Split it so each part can be rolled back on its own.',
      );
    }

    return [...aspects][0];
  }

  static diffPayloads(from: unknown, to: unknown): VersionDiff[] {
    const before = (from ?? {}) as Record<string, unknown>;
    const after = (to ?? {}) as Record<string, unknown>;
    const fields = new Set([...Object.keys(before), ...Object.keys(after)]);

    return [...fields]
      .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
      .map((field) => ({ field, from: before[field], to: after[field] }));
  }

  /** A short human-readable label for what a change does. */
  static describeChange(change: Record<string, unknown>): string {
    return Object.entries(change)
      .map(([field, value]) => {
        const rendered =
          typeof value === 'string'
            ? value.length > 40
              ? `${value.slice(0, 40)}…`
              : value
            : JSON.stringify(value);
        return `${field} → ${rendered}`;
      })
      .join(', ');
  }
}
