import { Injectable } from '@nestjs/common';
import { ToolDefinition, ToolExecutionError } from './tool.contract';
import { Permissions } from '../auth/permissions';
import {
  KnowledgeRepository,
  MissionRepository,
  TaskRepository,
  WorkerRepository,
} from '../database/repositories/tenant.repositories';
import { OrganizationRepository } from '../database/repositories/identity.repositories';
import { ExecutionLogRepository } from '../database/repositories/execution.repositories';
import { KnowledgeRetrievalService } from '../knowledge/retrieval/knowledge-retrieval.service';
import { StorageService } from '../storage/storage.module';
import { NotificationService } from '../notifications/notification.service';

/**
 * The built-in tool set.
 *
 * These are how a worker reaches the rest of PRISM-X. Each goes through the
 * repository layer like any other caller, so tool access inherits the same
 * organization scoping — a worker cannot read another tenant's knowledge
 * through a tool any more than an HTTP client could.
 */
@Injectable()
export class BuiltinTools {
  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly missions: MissionRepository,
    private readonly tasks: TaskRepository,
    private readonly workers: WorkerRepository,
    private readonly organizations: OrganizationRepository,
    private readonly executionLogs: ExecutionLogRepository,
    private readonly storage: StorageService,
    private readonly notifications: NotificationService,
  ) {}

  all(): ToolDefinition[] {
    return [
      this.knowledgeSearch(),
      this.knowledgeStore(),
      this.missionInspect(),
      this.taskUpdate(),
      this.workerDirectory(),
      this.organizationProfile(),
      this.storageList(),
      this.notify(),
      this.analyticsSummary(),
    ];
  }

  // ------------------------------------------------------------- knowledge

  private knowledgeSearch(): ToolDefinition {
    return {
      key: 'knowledge.search',
      name: 'Search knowledge',
      description:
        'Search the organization’s knowledge base. Returns ranked excerpts with ' +
        'relevance scores. Use before answering questions that depend on ' +
        'organization-specific facts.',
      requiredPermission: Permissions.KnowledgeRead,
      mutates: false,
      parameters: {
        query: { type: 'string', description: 'What to look for.', required: true },
        limit: { type: 'number', description: 'Maximum results (default 5).' },
      },
      execute: async (input, context) => {
        const query = String(input.query ?? '').trim();
        if (!query) throw new ToolExecutionError('`query` is required');

        const documents = await this.retrieval.retrieve({
          query,
          limit: Math.min(Number(input.limit ?? 5), 20),
          workerId: context.workerId,
          missionId: context.missionId,
        });

        return {
          count: documents.length,
          documents: documents.map((d) => ({
            id: d.knowledge.id,
            title: d.knowledge.title,
            type: d.knowledge.type,
            score: Number(d.score.toFixed(3)),
            excerpt: d.excerpt,
          })),
        };
      },
    };
  }

  private knowledgeStore(): ToolDefinition {
    return {
      key: 'knowledge.store',
      name: 'Store knowledge',
      description:
        'Save a finding so it is available to every worker in future missions. ' +
        'Use for durable conclusions, not for working notes.',
      requiredPermission: Permissions.KnowledgeCreate,
      mutates: true,
      parameters: {
        title: { type: 'string', description: 'Short headline.', required: true },
        content: { type: 'string', description: 'The finding itself.', required: true },
        tags: { type: 'array', description: 'Lower-case topic tags.' },
        type: {
          type: 'string',
          description: 'Knowledge classification.',
          enum: ['NOTE', 'DOCUMENT', 'INSIGHT', 'PATTERN', 'ARTIFACT'],
        },
      },
      execute: async (input, context) => {
        const title = String(input.title ?? '').trim();
        const content = String(input.content ?? '').trim();
        if (!title || !content) {
          throw new ToolExecutionError('`title` and `content` are both required');
        }

        const entry = await this.knowledge.create({
          title,
          content,
          type: (input.type as string) ?? 'INSIGHT',
          tags: Array.isArray(input.tags)
            ? [...new Set(input.tags.map((t) => String(t).toLowerCase()))]
            : [],
          workerId: context.workerId,
          source: context.missionId ? `mission:${context.missionId}` : 'worker',
        });

        return { id: entry.id, title: entry.title, stored: true };
      },
    };
  }

  // -------------------------------------------------------------- missions

  private missionInspect(): ToolDefinition {
    return {
      key: 'mission.inspect',
      name: 'Inspect mission',
      description:
        'Read a mission’s objective, status, progress and task list — including ' +
        'what sibling tasks have already produced.',
      requiredPermission: Permissions.MissionRead,
      mutates: false,
      parameters: {
        missionId: {
          type: 'string',
          description: 'Mission to inspect. Defaults to the current mission.',
        },
      },
      execute: async (input, context) => {
        const missionId = String(input.missionId ?? context.missionId ?? '');
        if (!missionId) throw new ToolExecutionError('No mission in scope');

        const mission = await this.missions.findByIdOrFail(missionId);
        const tasks = await this.tasks.findByMission(missionId);

        return {
          id: mission.id,
          title: mission.title,
          objective: mission.objective,
          status: mission.status,
          progress: mission.progress,
          tasks: tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            // Truncated: a sibling's full output can be enormous and would
            // crowd out the worker's own context.
            output: t.output ? t.output.slice(0, 500) : null,
          })),
        };
      },
    };
  }

  private taskUpdate(): ToolDefinition {
    return {
      key: 'task.update',
      name: 'Update task',
      description:
        'Record progress or a result on a task. Use to hand structured output ' +
        'to tasks that depend on this one.',
      requiredPermission: Permissions.MissionUpdate,
      mutates: true,
      parameters: {
        taskId: { type: 'string', description: 'Defaults to the current task.' },
        output: { type: 'string', description: 'Result text.' },
        result: { type: 'object', description: 'Structured result.' },
      },
      execute: async (input, context) => {
        const taskId = String(input.taskId ?? context.taskId ?? '');
        if (!taskId) throw new ToolExecutionError('No task in scope');

        const task = await this.tasks.findByIdOrFail(taskId);

        // A worker may only write to tasks inside its own mission.
        if (context.missionId && task.missionId !== context.missionId) {
          throw new ToolExecutionError('That task belongs to a different mission');
        }

        const patch: Record<string, unknown> = {};
        if (input.output !== undefined) patch.output = String(input.output);
        if (input.result !== undefined) patch.result = input.result;
        if (!Object.keys(patch).length) {
          throw new ToolExecutionError('Provide `output` or `result`');
        }

        await this.tasks.update(taskId, patch);
        return { taskId, updated: Object.keys(patch) };
      },
    };
  }

  // --------------------------------------------------------------- workers

  private workerDirectory(): ToolDefinition {
    return {
      key: 'worker.directory',
      name: 'List workers',
      description:
        'See which workers exist, their roles and skills — for deciding whom to ' +
        'hand a piece of work to.',
      requiredPermission: Permissions.WorkerRead,
      mutates: false,
      parameters: {
        role: { type: 'string', description: 'Filter by role.' },
      },
      execute: async (input) => {
        const workers = await this.workers.findMany(
          input.role ? { role: String(input.role) } : {},
          { take: 50 },
        );
        return {
          count: workers.length,
          workers: workers.map((w) => ({
            id: w.id,
            name: w.name,
            role: w.role,
            status: w.status,
            skills: w.skills,
            capabilities: w.capabilities,
          })),
        };
      },
    };
  }

  private organizationProfile(): ToolDefinition {
    return {
      key: 'organization.profile',
      name: 'Organization profile',
      description: 'Read the current organization’s name, plan and settings.',
      requiredPermission: Permissions.OrganizationRead,
      mutates: false,
      parameters: {},
      execute: async (_input, context) => {
        const organization = await this.organizations.findById(context.organizationId);
        if (!organization) throw new ToolExecutionError('Organization not found');
        return {
          id: organization.id,
          name: organization.name,
          plan: organization.plan,
          settings: organization.settings,
        };
      },
    };
  }

  // --------------------------------------------------------------- support

  private storageList(): ToolDefinition {
    return {
      key: 'storage.list',
      name: 'List files',
      description: 'List files stored under a folder in the organization’s storage.',
      requiredPermission: Permissions.StorageRead,
      mutates: false,
      parameters: {
        prefix: { type: 'string', description: 'Folder prefix (default "uploads").' },
      },
      execute: async (input) => {
        const objects = await this.storage.list(String(input.prefix ?? 'uploads'));
        return {
          count: objects.length,
          files: objects.map((o) => ({
            path: o.path,
            size: o.size,
            contentType: o.contentType,
          })),
        };
      },
    };
  }

  private notify(): ToolDefinition {
    return {
      key: 'notification.send',
      name: 'Send notification',
      description:
        'Raise a notification to the organization — for results that need human ' +
        'attention rather than merely being recorded.',
      requiredPermission: Permissions.AnalyticsRead,
      mutates: true,
      parameters: {
        subject: { type: 'string', description: 'Short subject.', required: true },
        body: { type: 'string', description: 'Message body.', required: true },
      },
      execute: async (input, context) => {
        const subject = String(input.subject ?? '').trim();
        const body = String(input.body ?? '').trim();
        if (!subject || !body) {
          throw new ToolExecutionError('`subject` and `body` are both required');
        }

        await this.notifications.send({
          organizationId: context.organizationId,
          category: 'worker',
          subject,
          body,
          metadata: { workerId: context.workerId, missionId: context.missionId },
        });
        return { sent: true, subject };
      },
    };
  }

  private analyticsSummary(): ToolDefinition {
    return {
      key: 'analytics.summary',
      name: 'Execution analytics',
      description:
        'Aggregate execution statistics — request counts, tokens, cost and ' +
        'latency for this organization.',
      requiredPermission: Permissions.AnalyticsRead,
      mutates: false,
      parameters: {
        missionId: { type: 'string', description: 'Scope to one mission.' },
      },
      execute: async (input, context) => {
        const missionId = input.missionId ?? context.missionId;
        return this.executionLogs.summarize(missionId ? { missionId } : {});
      },
    };
  }
}
