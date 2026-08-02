import { BadRequestException, Injectable } from '@nestjs/common';
import { Workflow, WorkflowStatus } from '@prisma/client';
import {
  WorkflowRepository,
  WorkflowRunRepository,
  WorkflowStepRunRepository,
  WorkflowVersionRepository,
} from '../database/repositories/automation.repositories';
import { WorkflowStep } from './execution/execution-adapter.contract';
import { countSteps } from './workflow-engine.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';

/**
 * Workflow definitions and their versions.
 *
 * The rule this service exists to enforce: a published version is immutable.
 * Editing a workflow creates a new version and repoints the head, so an
 * in-flight run keeps executing exactly the definition it started with and an
 * audit can always answer "what did this run actually do".
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly versions: WorkflowVersionRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: WorkflowStepRunRepository,
    private readonly events: EventBusService,
  ) {}

  async create(dto: {
    name: string;
    description?: string;
    steps?: WorkflowStep[];
    isTemplate?: boolean;
    category?: string;
    tags?: string[];
    maxConcurrentRuns?: number;
    timeoutMs?: number;
    maxRetries?: number;
  }): Promise<Workflow> {
    const steps = dto.steps ?? [];
    if (steps.length) WorkflowService.validateSteps(steps);

    const workflow = await this.workflows.create({
      name: dto.name,
      description: dto.description ?? null,
      isTemplate: dto.isTemplate ?? false,
      category: dto.category ?? null,
      tags: dto.tags ?? [],
      status: WorkflowStatus.DRAFT,
      ...(dto.maxConcurrentRuns !== undefined
        ? { maxConcurrentRuns: dto.maxConcurrentRuns }
        : {}),
      ...(dto.timeoutMs !== undefined ? { timeoutMs: dto.timeoutMs } : {}),
      ...(dto.maxRetries !== undefined ? { maxRetries: dto.maxRetries } : {}),
    });

    if (steps.length) await this.addVersion(workflow.id, steps);

    await this.events.publish(DomainEvent.WorkflowCreated, {
      workflowId: workflow.id,
      name: workflow.name,
      steps: steps.length,
    });

    return this.workflows.findByIdOrFail(workflow.id);
  }

  /** Creates a new immutable version. Never mutates an existing one. */
  async addVersion(workflowId: string, steps: WorkflowStep[], notes?: string) {
    await this.workflows.findByIdOrFail(workflowId);
    WorkflowService.validateSteps(steps);

    return this.versions.create({
      workflowId,
      version: await this.versions.nextVersion(workflowId),
      steps: steps as never,
      notes: notes ?? null,
    });
  }

  /**
   * Publishes a version and activates the workflow.
   *
   * Publishing repoints the head; runs already executing an older version are
   * untouched.
   */
  async publish(workflowId: string, versionId?: string): Promise<Workflow> {
    const workflow = await this.workflows.findByIdOrFail(workflowId);

    const versions = await this.versions.listForWorkflow(workflowId);
    if (!versions.length) {
      throw new BadRequestException('This workflow has no versions to publish');
    }

    const target = versionId
      ? versions.find((v) => v.id === versionId)
      : versions[0]; // listForWorkflow is newest-first

    if (!target) throw new BadRequestException('No such version for this workflow');

    const steps = (target.steps ?? []) as unknown as WorkflowStep[];
    if (!steps.length) {
      throw new BadRequestException('Cannot publish a version with no steps');
    }

    await this.versions.update(target.id, { publishedAt: new Date() });
    const published = await this.workflows.update(workflowId, {
      activeVersionId: target.id,
      status: WorkflowStatus.ACTIVE,
    });

    await this.events.publish(DomainEvent.WorkflowPublished, {
      workflowId,
      versionId: target.id,
      version: target.version,
      steps: countSteps(steps),
    });

    return published;
  }

  findAll(filters: { status?: WorkflowStatus; isTemplate?: boolean } = {}) {
    const where: Record<string, unknown> = {};
    if (filters.status) where.status = filters.status;
    if (filters.isTemplate !== undefined) where.isTemplate = filters.isTemplate;
    return this.workflows.findMany(where, { orderBy: { createdAt: 'desc' } });
  }

  findOne(id: string) {
    return this.workflows.findWithActiveVersion(id);
  }

  listVersions(workflowId: string) {
    return this.versions.listForWorkflow(workflowId);
  }

  async update(id: string, dto: Record<string, unknown>): Promise<Workflow> {
    await this.workflows.findByIdOrFail(id);
    const { steps: _steps, ...rest } = dto;
    return this.workflows.update(id, rest);
  }

  async pause(id: string): Promise<Workflow> {
    await this.workflows.findByIdOrFail(id);
    return this.workflows.update(id, { status: WorkflowStatus.PAUSED });
  }

  async archive(id: string): Promise<Workflow> {
    await this.workflows.findByIdOrFail(id);
    return this.workflows.update(id, { status: WorkflowStatus.ARCHIVED });
  }

  async remove(id: string): Promise<void> {
    const active = await this.runs.countActive(id);
    if (active > 0) {
      throw new BadRequestException(
        `This workflow has ${active} run(s) in flight; pause it and wait for them to finish`,
      );
    }
    await this.workflows.remove(id);
  }

  /**
   * Clones a template into a new draft workflow.
   *
   * Templates are the reuse mechanism: an organization builds one good
   * approval-and-notify flow and instantiates it repeatedly, rather than
   * copying JSON by hand and diverging.
   */
  async instantiateTemplate(templateId: string, name: string): Promise<Workflow> {
    const template = await this.workflows.findByIdOrFail(templateId);
    if (!template.isTemplate) {
      throw new BadRequestException(`Workflow "${template.name}" is not a template`);
    }
    if (!template.activeVersionId) {
      throw new BadRequestException('This template has no published version to copy');
    }

    const source = await this.versions.findByIdOrFail(template.activeVersionId);
    return this.create({
      name,
      description: template.description ?? undefined,
      steps: (source.steps ?? []) as unknown as WorkflowStep[],
      category: template.category ?? undefined,
      tags: template.tags,
    });
  }

  listRuns(workflowId?: string) {
    return this.runs.findMany(workflowId ? { workflowId } : {}, {
      take: 100,
      orderBy: { startedAt: 'desc' },
    });
  }

  async runDetail(runId: string) {
    const run = await this.runs.findByIdOrFail(runId);
    const steps = await this.stepRuns.findByRun(runId);
    return { ...run, stepRuns: steps };
  }

  /**
   * Structural validation, performed before a version is stored.
   *
   * Catching a duplicate id or a dangling dependency at authoring time is far
   * cheaper than discovering it halfway through a production run.
   */
  static validateSteps(steps: WorkflowStep[], seen = new Set<string>()): void {
    for (const step of steps) {
      if (!step.id) throw new BadRequestException('Every step needs an `id`');
      if (!step.type) throw new BadRequestException(`Step "${step.id}" needs a \`type\``);

      if (seen.has(step.id)) {
        throw new BadRequestException(`Duplicate step id "${step.id}"`);
      }
      seen.add(step.id);

      if (step.type === 'condition' && !step.config?.condition && !step.condition) {
        throw new BadRequestException(
          `Condition step "${step.id}" needs a \`condition\``,
        );
      }
      if (step.type === 'loop' && !step.steps?.length) {
        throw new BadRequestException(`Loop step "${step.id}" needs child steps`);
      }
      if (step.type === 'parallel' && !step.steps?.length) {
        throw new BadRequestException(`Parallel step "${step.id}" needs child steps`);
      }
      if (step.onError === 'fallback' && !step.fallback) {
        throw new BadRequestException(
          `Step "${step.id}" sets onError=fallback but defines no \`fallback\``,
        );
      }

      WorkflowService.validateSteps(step.steps ?? [], seen);
      WorkflowService.validateSteps(step.onTrue ?? [], seen);
      WorkflowService.validateSteps(step.onFalse ?? [], seen);
    }

    // Dependencies must name steps that exist, and only at the top level —
    // referring into a nested branch would create an edge the scheduler cannot
    // honour.
    for (const step of steps) {
      for (const dependency of step.dependsOn ?? []) {
        if (!seen.has(dependency)) {
          throw new BadRequestException(
            `Step "${step.id}" depends on "${dependency}", which does not exist`,
          );
        }
      }
    }
  }
}
