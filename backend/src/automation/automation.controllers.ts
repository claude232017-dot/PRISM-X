import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation,
  ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags,
} from '@nestjs/swagger';
import {
  IsArray, IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, IsUrl, Min, MinLength,
} from 'class-validator';
import { ApprovalStatus, IntegrationCategory, RiskLevel, WorkflowStatus } from '@prisma/client';
import { IntegrationManager } from '../integrations/integration-manager.service';
import { WorkflowService } from '../workflows/workflow.service';
import { WorkflowEngine } from '../workflows/workflow-engine.service';
import { TriggerEngine } from '../triggers/trigger-engine.service';
import { ApprovalService } from '../approvals/approval.service';
import { NotificationService } from '../notifications/notification.service';
import { ApiKeyService } from '../public-api/api-key.service';
import { WebhookDispatcher } from '../public-api/webhook-dispatcher.service';
import { AutomationAnalyticsService } from './automation-analytics.service';
import {
  DeadLetterRepository, TriggerRepository, WebhookEndpointRepository,
} from '../database/repositories/automation.repositories';
import { Public, RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';
import type { WorkflowStep } from '../workflows/execution/execution-adapter.contract';

// ============================================================ DTOs

export class CreateWorkflowDto {
  @ApiProperty({ example: 'Lead triage' })
  @IsString() @MinLength(2) name!: string;

  @ApiPropertyOptional({ example: 'Score inbound leads and route the good ones.' })
  @IsOptional() @IsString() description?: string;

  @ApiPropertyOptional({
    description: 'Ordered step graph. See GET /workflows/step-types for the vocabulary.',
    example: [
      { id: 'score', type: 'worker', config: { workerId: 'clx0worker001', instruction: 'Score this lead.' } },
      { id: 'notify', type: 'integration', config: { integrationId: 'clx0int001', action: 'send', input: { to: 'sales', message: 'New lead' } } },
    ],
  })
  @IsOptional() @IsArray() steps?: WorkflowStep[];

  @ApiPropertyOptional({ default: false, description: 'Mark as a reusable template.' })
  @IsOptional() @IsBoolean() isTemplate?: boolean;

  @ApiPropertyOptional({ example: 'sales' })
  @IsOptional() @IsString() category?: string;

  @ApiPropertyOptional({ type: [String], example: ['leads', 'crm'] })
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];

  @ApiPropertyOptional({ default: 5, description: 'Concurrent runs allowed.' })
  @IsOptional() @IsInt() @Min(1) maxConcurrentRuns?: number;

  @ApiPropertyOptional({ default: 2 }) @IsOptional() @IsInt() @Min(0) maxRetries?: number;
}

export class AddVersionDto {
  @ApiProperty({ description: 'Replacement step graph. Creates a new immutable version.' })
  @IsArray() steps!: WorkflowStep[];

  @ApiPropertyOptional({ example: 'Added an approval before sending.' })
  @IsOptional() @IsString() notes?: string;
}

export class StartRunDto {
  @ApiPropertyOptional({ example: { leadId: 'L-4471', score: 82 } })
  @IsOptional() @IsObject() input?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Repeating a key within the dedupe window returns the original run instead of running again.',
    example: 'lead-4471-triage',
  })
  @IsOptional() @IsString() idempotencyKey?: string;
}

export class CreateTriggerDto {
  @ApiProperty({ example: 'On mission completed' })
  @IsString() @MinLength(2) name!: string;

  @ApiProperty({ example: 'clx0workflow01' })
  @IsString() workflowId!: string;

  @ApiProperty({ enum: ['EVENT', 'WEBHOOK', 'SCHEDULE', 'MANUAL', 'API'] })
  @IsEnum({ EVENT: 'EVENT', WEBHOOK: 'WEBHOOK', SCHEDULE: 'SCHEDULE', MANUAL: 'MANUAL', API: 'API' })
  type!: 'EVENT' | 'WEBHOOK' | 'SCHEDULE' | 'MANUAL' | 'API';

  @ApiPropertyOptional({ example: 'mission.completed', description: 'Required for EVENT triggers.' })
  @IsOptional() @IsString() eventName?: string;

  @ApiPropertyOptional({ example: '0 9 * * 1', description: 'Cron (UTC), for SCHEDULE triggers.' })
  @IsOptional() @IsString() cron?: string;

  @ApiPropertyOptional({ example: 3600, description: 'Interval alternative to cron, in seconds.' })
  @IsOptional() @IsInt() @Min(30) intervalSeconds?: number;

  @ApiPropertyOptional({ description: 'Predicate over the payload; the trigger only fires when it holds.' })
  @IsOptional() @IsObject() conditions?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Maps the payload onto workflow inputs.', example: { leadId: '{{data.id}}' } })
  @IsOptional() @IsObject() inputMapping?: Record<string, unknown>;

  @ApiPropertyOptional({ default: true, description: 'Sign inbound webhooks (WEBHOOK triggers).' })
  @IsOptional() @IsBoolean() requireSignature?: boolean;
}

export class CreateIntegrationV3Dto {
  @ApiProperty({ example: 'Ops Slack' }) @IsString() @MinLength(2) name!: string;
  @ApiProperty({ example: 'simulated', description: 'Connector kind. See GET /integrations/catalogue.' })
  @IsString() kind!: string;
  @ApiPropertyOptional({ enum: IntegrationCategory }) @IsOptional() @IsEnum(IntegrationCategory) category?: IntegrationCategory;
  @ApiPropertyOptional({ description: 'Secret. Encrypted at rest; never returned.' })
  @IsOptional() @IsString() secret?: string;
  @ApiPropertyOptional({ example: { baseUrl: 'https://api.example.com' } })
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @ApiPropertyOptional({ type: [String], example: ['send', 'read'], description: 'Granted operations. Empty means the connector default.' })
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
  @ApiPropertyOptional({ example: 'api_key' }) @IsOptional() @IsString() authMethod?: string;
}

export class ExecuteIntegrationDto {
  @ApiProperty({ example: 'send' }) @IsString() action!: string;
  @ApiPropertyOptional({ example: { to: 'ops', message: 'Deploy finished' } })
  @IsOptional() @IsObject() input?: Record<string, unknown>;
}

export class ApprovalDecisionDto {
  @ApiPropertyOptional({ example: 'Looks right, proceed.' })
  @IsOptional() @IsString() comment?: string;
  @ApiPropertyOptional({ description: 'Required when delegating.' })
  @IsOptional() @IsString() delegateToUserId?: string;
}

export class CreateApiKeyDto {
  @ApiProperty({ example: 'CI pipeline' }) @IsString() @MinLength(2) name!: string;
  @ApiPropertyOptional({ type: [String], example: ['workflow:execute', 'mission:read'] })
  @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
  @ApiPropertyOptional({ default: 120 }) @IsOptional() @IsInt() @Min(1) rateLimitPerMinute?: number;
  @ApiPropertyOptional({ example: 90 }) @IsOptional() @IsInt() @Min(1) expiresInDays?: number;
}

export class CreateWebhookEndpointDto {
  @ApiProperty({ example: 'Ops dashboard' }) @IsString() @MinLength(2) name!: string;
  @ApiProperty({ example: 'https://ops.example.com/hooks/prismx' }) @IsUrl() url!: string;
  @ApiProperty({ type: [String], example: ['mission.completed', 'workflow.run_failed'] })
  @IsArray() @IsString({ each: true }) events!: string[];
}

// ============================================================ Workflows

@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('workflows')
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowService,
    private readonly engine: WorkflowEngine,
  ) {}

  @Get('step-types')
  @RequirePermissions(Permissions.MissionRead)
  @ApiOperation({
    summary: 'Step vocabulary and execution adapters',
    description:
      'PRISM-X orchestrates; adapters execute. A step names a type, and the engine ' +
      'routes it to an adapter — internal, n8n, Make.com, or any future runtime — so ' +
      'adopting an external automation platform never means rewriting orchestration.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        stepTypes: [
          { type: 'worker', description: 'Run a PRISM-X worker.' },
          { type: 'integration', description: 'Call an external service.' },
          { type: 'condition', description: 'Branch on a predicate.' },
          { type: 'parallel', description: 'Run children concurrently.' },
          { type: 'loop', description: 'Repeat children over a collection.' },
          { type: 'approval', description: 'Suspend for a human decision.' },
          { type: 'ai_decision', description: 'Let a worker choose among allowed options.' },
          { type: 'n8n', description: 'Delegate to an n8n workflow.' },
        ],
        adapters: [
          { key: 'internal', displayName: 'PRISM-X Internal', supports: ['worker', 'integration', 'mission', 'http'] },
          { key: 'n8n', displayName: 'n8n', supports: ['n8n'] },
          { key: 'make', displayName: 'Make.com', supports: ['make'] },
        ],
      },
    },
  })
  stepTypes() {
    return {
      stepTypes: [
        { type: 'worker', description: 'Run a PRISM-X worker.' },
        { type: 'integration', description: 'Call an external service through the Integration Manager.' },
        { type: 'mission', description: 'Start or drive a PRISM-X mission.' },
        { type: 'http', description: 'Call an arbitrary HTTP endpoint.' },
        { type: 'condition', description: 'Branch on a predicate.' },
        { type: 'parallel', description: 'Run child steps concurrently.' },
        { type: 'loop', description: 'Repeat child steps over a collection.' },
        { type: 'delay', description: 'Wait; long waits suspend the run.' },
        { type: 'approval', description: 'Suspend for a human decision.' },
        { type: 'ai_decision', description: 'Let a worker choose among allowed options.' },
        { type: 'transform', description: 'Shape data with template resolution.' },
        { type: 'n8n', description: 'Delegate to an n8n workflow.' },
        { type: 'make', description: 'Delegate to a Make.com scenario.' },
      ],
      adapters: this.engine.listAdapters(),
    };
  }

  @Post()
  @RequirePermissions(Permissions.MissionCreate)
  @ApiOperation({
    summary: 'Create a workflow',
    description: 'Creates a DRAFT workflow and, when steps are supplied, its first version. Publish before running.',
  })
  @ApiCreatedResponse({
    schema: { example: { id: 'clx0workflow01', name: 'Lead triage', status: 'DRAFT', isTemplate: false } },
  })
  create(@Body() dto: CreateWorkflowDto) { return this.workflows.create(dto); }

  @Get()
  @RequirePermissions(Permissions.MissionRead)
  @ApiQuery({ name: 'status', required: false, enum: WorkflowStatus })
  @ApiQuery({ name: 'isTemplate', required: false, type: Boolean })
  @ApiOperation({ summary: 'List workflows' })
  @ApiOkResponse({
    schema: { example: [{ id: 'clx0workflow01', name: 'Lead triage', status: 'ACTIVE', tags: ['leads'] }] },
  })
  findAll(@Query('status') status?: WorkflowStatus, @Query('isTemplate') isTemplate?: string) {
    return this.workflows.findAll({
      status,
      isTemplate: isTemplate === undefined ? undefined : isTemplate === 'true',
    });
  }

  @Get('runs')
  @RequirePermissions(Permissions.MissionRead)
  @ApiQuery({ name: 'workflowId', required: false })
  @ApiOperation({ summary: 'List workflow runs' })
  @ApiOkResponse({
    schema: {
      example: [{ id: 'clx0run0001', workflowId: 'clx0workflow01', status: 'SUCCEEDED', stepsRun: 4, costUsd: 0, durationMs: 812 }],
    },
  })
  listRuns(@Query('workflowId') workflowId?: string) { return this.workflows.listRuns(workflowId); }

  @Get('runs/:runId')
  @RequirePermissions(Permissions.MissionRead)
  @ApiParam({ name: 'runId', example: 'clx0run0001' })
  @ApiOperation({ summary: 'Get a run with its per-step detail' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0run0001', status: 'SUCCEEDED', stepsRun: 2,
        stepRuns: [{ stepId: 'score', stepType: 'worker', status: 'SUCCEEDED', adapter: 'internal', durationMs: 640 }],
      },
    },
  })
  runDetail(@Param('runId') runId: string) { return this.workflows.runDetail(runId); }

  @Get(':id')
  @RequirePermissions(Permissions.MissionRead)
  @ApiParam({ name: 'id', example: 'clx0workflow01' })
  @ApiOperation({ summary: 'Get a workflow with its active version' })
  @ApiOkResponse({ schema: { example: { id: 'clx0workflow01', name: 'Lead triage', status: 'ACTIVE', activeVersion: { version: 2 } } } })
  findOne(@Param('id') id: string) { return this.workflows.findOne(id); }

  @Get(':id/versions')
  @RequirePermissions(Permissions.MissionRead)
  @ApiParam({ name: 'id', example: 'clx0workflow01' })
  @ApiOperation({ summary: 'List versions', description: 'Versions are immutable; editing creates a new one.' })
  @ApiOkResponse({ schema: { example: [{ id: 'clx0ver0002', version: 2, publishedAt: '2026-08-02T21:00:00.000Z' }] } })
  versions(@Param('id') id: string) { return this.workflows.listVersions(id); }

  @Post(':id/versions')
  @RequirePermissions(Permissions.MissionUpdate)
  @ApiParam({ name: 'id', example: 'clx0workflow01' })
  @ApiOperation({
    summary: 'Add a version',
    description: 'Creates a new immutable version. Runs already in flight keep executing the version they started with.',
  })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0ver0002', version: 2, workflowId: 'clx0workflow01' } } })
  addVersion(@Param('id') id: string, @Body() dto: AddVersionDto) {
    return this.workflows.addVersion(id, dto.steps, dto.notes);
  }

  @Post(':id/publish')
  @RequirePermissions(Permissions.MissionUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0workflow01' })
  @ApiOperation({ summary: 'Publish a version and activate the workflow' })
  @ApiOkResponse({ schema: { example: { id: 'clx0workflow01', status: 'ACTIVE', activeVersionId: 'clx0ver0002' } } })
  publish(@Param('id') id: string, @Query('versionId') versionId?: string) {
    return this.workflows.publish(id, versionId);
  }

  @Post(':id/run')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0workflow01' })
  @ApiOperation({
    summary: 'Run a workflow',
    description:
      'Executes the published version. Supplying `idempotencyKey` makes the call safe to repeat — ' +
      'a duplicate returns the original run rather than performing the side effects twice.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        runId: 'clx0run0001', status: 'SUCCEEDED', stepsRun: 3, stepsTotal: 3,
        costUsd: 0, durationMs: 740, output: { notify: { ok: true } },
      },
    },
  })
  run(@Param('id') id: string, @Body() dto: StartRunDto) {
    return this.engine.start({ workflowId: id, input: dto.input, idempotencyKey: dto.idempotencyKey });
  }

  @Post('runs/:runId/resume')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'runId', example: 'clx0run0001' })
  @ApiOperation({ summary: 'Resume a suspended run' })
  @ApiOkResponse({ schema: { example: { runId: 'clx0run0001', status: 'SUCCEEDED', stepsRun: 4 } } })
  resume(@Param('runId') runId: string) { return this.engine.resume(runId); }

  @Post('runs/:runId/retry')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'runId', example: 'clx0run0001' })
  @ApiOperation({ summary: 'Retry a failed run' })
  @ApiOkResponse({ schema: { example: { runId: 'clx0run0001', status: 'SUCCEEDED', stepsRun: 3 } } })
  retry(@Param('runId') runId: string) { return this.engine.retry(runId); }

  @Post('runs/:runId/cancel')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'runId', example: 'clx0run0001' })
  @ApiOperation({ summary: 'Cancel a run' })
  @ApiOkResponse({ schema: { example: { cancelled: true } } })
  async cancel(@Param('runId') runId: string) {
    await this.engine.cancel(runId);
    return { cancelled: true };
  }

  @Post(':id/instantiate')
  @RequirePermissions(Permissions.MissionCreate)
  @ApiParam({ name: 'id', example: 'clx0template01' })
  @ApiOperation({ summary: 'Create a workflow from a template' })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0workflow09', name: 'Lead triage (EMEA)', status: 'DRAFT' } } })
  instantiate(@Param('id') id: string, @Body() body: { name: string }) {
    return this.workflows.instantiateTemplate(id, body.name);
  }

  @Patch(':id')
  @RequirePermissions(Permissions.MissionUpdate)
  @ApiParam({ name: 'id', example: 'clx0workflow01' })
  @ApiOperation({ summary: 'Update workflow metadata', description: 'Steps are versioned separately.' })
  @ApiOkResponse({ schema: { example: { id: 'clx0workflow01', name: 'Lead triage v2' } } })
  update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.workflows.update(id, dto);
  }

  @Post(':id/pause')
  @RequirePermissions(Permissions.MissionUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0workflow01' })
  @ApiOperation({ summary: 'Pause a workflow' })
  @ApiOkResponse({ schema: { example: { id: 'clx0workflow01', status: 'PAUSED' } } })
  pause(@Param('id') id: string) { return this.workflows.pause(id); }

  @Delete(':id')
  @RequirePermissions(Permissions.MissionDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0workflow01' })
  @ApiOperation({ summary: 'Delete a workflow', description: 'Rejected while runs are in flight.' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  remove(@Param('id') id: string) { return this.workflows.remove(id); }
}

// ============================================================ Integrations (v3)

@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('connectors')
export class ConnectorsController {
  constructor(private readonly manager: IntegrationManager) {}

  @Get()
  @RequirePermissions(Permissions.IntegrationRead)
  @ApiOperation({
    summary: 'Connector catalogue',
    description:
      'Every service PRISM-X can talk to, with its category, auth method and available ' +
      'actions. Connectors are declarative, so adding a service is a spec, not a subsystem.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          kind: 'slack', displayName: 'Slack', category: 'MESSAGING', authMethod: 'bearer',
          actions: [{ key: 'send_message', description: 'Post a message to a channel.', requires: 'send', mutates: true }],
        },
      ],
    },
  })
  catalogue() { return this.manager.catalogue(); }
}

@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('integrations/:id')
export class IntegrationOperationsController {
  constructor(private readonly manager: IntegrationManager) {}

  @Get('actions')
  @RequirePermissions(Permissions.IntegrationRead)
  @ApiParam({ name: 'id', example: 'clx0int00001' })
  @ApiOperation({ summary: 'Actions this integration can perform', description: 'Includes whether each is permitted by the granted scope.' })
  @ApiOkResponse({
    schema: { example: [{ key: 'send', description: 'Send a message.', requires: 'send', mutates: true, permitted: true }] },
  })
  actions(@Param('id') id: string) { return this.manager.actions(id); }

  @Post('execute')
  @RequirePermissions(Permissions.IntegrationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0int00001' })
  @ApiOperation({
    summary: 'Execute a connector action',
    description:
      'Runs through the Integration Manager, which supplies retries, circuit breaking, ' +
      'rate limiting and usage accounting. Actions outside the granted permissions are refused.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        ok: true, integrationId: 'clx0int00001', action: 'send', attempts: 1, durationMs: 42,
        externalId: 'a1b2c3d4e5f6', data: { simulated: true, deliveredAt: '2026-08-02T21:00:00.000Z' },
      },
    },
  })
  execute(@Param('id') id: string, @Body() dto: ExecuteIntegrationDto) {
    return this.manager.execute(id, dto.action, dto.input ?? {});
  }

  @Post('validate')
  @RequirePermissions(Permissions.IntegrationRead)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0int00001' })
  @ApiOperation({ summary: 'Validate configuration', description: 'Checks configuration without contacting the service.' })
  @ApiOkResponse({ schema: { example: { valid: true, errors: [] } } })
  validate(@Param('id') id: string) { return this.manager.validate(id); }

  @Post('health-check')
  @RequirePermissions(Permissions.IntegrationRead)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0int00001' })
  @ApiOperation({ summary: 'Probe the service and record the verdict' })
  @ApiOkResponse({
    schema: { example: { integrationId: 'clx0int00001', healthy: true, latencyMs: 38, checkedAt: '2026-08-02T21:00:00.000Z' } },
  })
  health(@Param('id') id: string) { return this.manager.healthCheck(id); }
}

// ============================================================ Triggers

@ApiTags('Triggers')
@ApiBearerAuth()
@Controller('triggers')
export class TriggersController {
  constructor(
    private readonly triggers: TriggerRepository,
    private readonly engine: TriggerEngine,
  ) {}

  @Post()
  @RequirePermissions(Permissions.MissionCreate)
  @ApiOperation({
    summary: 'Create a trigger',
    description:
      'EVENT triggers fire on a domain event; SCHEDULE triggers on cron or interval; ' +
      'WEBHOOK triggers are issued an unguessable path and a signing secret, returned once.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0trig0001', name: 'On mission completed', type: 'WEBHOOK', enabled: true,
        webhookPath: 'k3Jd9xQm2pLbN7vR', webhookUrl: '/api/v1/hooks/k3Jd9xQm2pLbN7vR',
        webhookSecret: 'shown once — store it now',
      },
    },
  })
  async create(@Body() dto: CreateTriggerDto) {
    const isWebhook = dto.type === 'WEBHOOK';
    const path = isWebhook ? TriggerEngine.generateWebhookPath() : null;
    const secret = isWebhook && dto.requireSignature !== false ? TriggerEngine.generateWebhookSecret() : null;

    const trigger = await this.triggers.create({
      name: dto.name,
      workflowId: dto.workflowId,
      type: dto.type,
      eventName: dto.eventName ?? null,
      cron: dto.cron ?? null,
      intervalSeconds: dto.intervalSeconds ?? null,
      conditions: (dto.conditions ?? {}) as never,
      inputMapping: (dto.inputMapping ?? {}) as never,
      webhookPath: path,
      webhookSecret: secret,
      nextRunAt: dto.type === 'SCHEDULE'
        ? TriggerEngine.nextRun({ cron: dto.cron ?? null, intervalSeconds: dto.intervalSeconds ?? null })
        : null,
    });

    return {
      ...trigger,
      // The secret is returned once, at creation, and never again.
      webhookSecret: secret ?? undefined,
      webhookUrl: path ? `/api/v1/hooks/${path}` : undefined,
    };
  }

  @Get()
  @RequirePermissions(Permissions.MissionRead)
  @ApiOperation({ summary: 'List triggers' })
  @ApiOkResponse({
    schema: { example: [{ id: 'clx0trig0001', name: 'Nightly digest', type: 'SCHEDULE', cron: '0 6 * * *', fireCount: 12, enabled: true }] },
  })
  list() { return this.triggers.findMany({}, { orderBy: { createdAt: 'desc' } }); }

  @Post(':id/fire')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0trig0001' })
  @ApiOperation({ summary: 'Fire a trigger manually', description: 'Runs the condition and mapping exactly as a real firing would.' })
  @ApiOkResponse({ schema: { example: { fired: true, runId: 'clx0run0002' } } })
  async fire(@Param('id') id: string, @Body() payload: Record<string, unknown>) {
    const trigger = await this.triggers.findByIdOrFail(id);
    return this.engine.fire(trigger, payload ?? {}, 'manual');
  }

  @Post('tick')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Evaluate due schedules now',
    description: 'The engine ticks automatically; this forces an immediate pass, which makes schedules testable.',
  })
  @ApiOkResponse({ schema: { example: { fired: 2 } } })
  async tick() { return { fired: await this.engine.tickSchedules() }; }

  @Patch(':id')
  @RequirePermissions(Permissions.MissionUpdate)
  @ApiParam({ name: 'id', example: 'clx0trig0001' })
  @ApiOperation({ summary: 'Update a trigger' })
  @ApiOkResponse({ schema: { example: { id: 'clx0trig0001', enabled: false } } })
  update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.triggers.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permissions.MissionDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0trig0001' })
  @ApiOperation({ summary: 'Delete a trigger' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  remove(@Param('id') id: string) { return this.triggers.remove(id); }
}

@ApiTags('Triggers')
@Controller('hooks')
export class InboundWebhookController {
  constructor(private readonly engine: TriggerEngine) {}

  @Post(':path')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'path', example: 'k3Jd9xQm2pLbN7vR' })
  @ApiOperation({
    summary: 'Inbound webhook endpoint',
    description:
      'Public by necessity — external services cannot hold a bearer token. Security rests on ' +
      'an unguessable path plus, when configured, an HMAC-SHA256 signature in `x-prismx-signature` ' +
      'compared in constant time. An unsigned or mis-signed request is rejected without running anything.',
  })
  @ApiOkResponse({ schema: { example: { accepted: true, runId: 'clx0run0003' } } })
  async receive(
    @Param('path') path: string,
    @Body() payload: Record<string, unknown>,
    @Req() req: { headers: Record<string, string | undefined> },
  ) {
    return this.engine.handleWebhook(path, payload ?? {}, {
      signature: req.headers['x-prismx-signature'] ?? req.headers['x-hub-signature-256'],
    });
  }
}

// ============================================================ Approvals

@ApiTags('Approvals')
@ApiBearerAuth()
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalService) {}

  @Get()
  @RequirePermissions(Permissions.MissionRead)
  @ApiQuery({ name: 'status', required: false, enum: ApprovalStatus })
  @ApiOperation({ summary: 'List approval requests' })
  @ApiOkResponse({
    schema: {
      example: [{
        id: 'clx0appr0001', title: 'Send outbound campaign', reason: 'Confidence 0.42 is below the 0.7 threshold.',
        suggestedAction: 'send', riskLevel: 'HIGH', status: 'PENDING', runId: 'clx0run0004',
      }],
    },
  })
  list(@Query('status') status?: ApprovalStatus) { return this.approvals.list(status); }

  @Get('statistics')
  @RequirePermissions(Permissions.MissionRead)
  @ApiOperation({ summary: 'Approval counts and approval rate' })
  @ApiOkResponse({ schema: { example: { pending: 2, approved: 14, rejected: 3, approvalRate: 82 } } })
  statistics() { return this.approvals.statistics(); }

  @Get(':id')
  @RequirePermissions(Permissions.MissionRead)
  @ApiParam({ name: 'id', example: 'clx0appr0001' })
  @ApiOperation({ summary: 'Get an approval request with its full context' })
  @ApiOkResponse({ schema: { example: { id: 'clx0appr0001', title: 'Send outbound campaign', riskLevel: 'HIGH', context: { proposed: 'send', confidence: 0.42 } } } })
  findOne(@Param('id') id: string) { return this.approvals.findOne(id); }

  @Post(':id/approve')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0appr0001' })
  @ApiOperation({ summary: 'Approve', description: 'Records the decision and resumes the suspended run.' })
  @ApiOkResponse({ schema: { example: { approval: { id: 'clx0appr0001', status: 'APPROVED' }, resumed: true } } })
  approve(@Param('id') id: string, @Body() dto: ApprovalDecisionDto) { return this.approvals.approve(id, dto); }

  @Post(':id/reject')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0appr0001' })
  @ApiOperation({ summary: 'Reject', description: 'The run stays suspended and is not resumed.' })
  @ApiOkResponse({ schema: { example: { approval: { id: 'clx0appr0001', status: 'REJECTED' }, resumed: false } } })
  reject(@Param('id') id: string, @Body() dto: ApprovalDecisionDto) { return this.approvals.reject(id, dto); }

  @Post(':id/request-changes')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0appr0001' })
  @ApiOperation({ summary: 'Request changes', description: 'Feedback rather than a decision; a comment is required and the run stays suspended.' })
  @ApiOkResponse({ schema: { example: { approval: { id: 'clx0appr0001', status: 'CHANGES_REQUESTED' }, resumed: false } } })
  requestChanges(@Param('id') id: string, @Body() dto: ApprovalDecisionDto) { return this.approvals.requestChanges(id, dto); }

  @Post(':id/delegate')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0appr0001' })
  @ApiOperation({ summary: 'Delegate', description: 'Stays PENDING with a recorded delegate — delegating is not deciding.' })
  @ApiOkResponse({ schema: { example: { approval: { id: 'clx0appr0001', status: 'PENDING', delegatedToId: 'clx0user0002' }, resumed: false } } })
  delegate(@Param('id') id: string, @Body() dto: ApprovalDecisionDto) { return this.approvals.delegate(id, dto); }

  @Post('expire-stale')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Expire overdue requests', description: 'An approval that sits forever silently blocks a run; expiring makes the stall visible.' })
  @ApiOkResponse({ schema: { example: { expired: 1 } } })
  async expire() { return { expired: await this.approvals.expireStale() }; }
}

// ============================================================ Notifications

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiQuery({ name: 'unread', required: false, type: Boolean })
  @ApiOperation({
    summary: 'List notifications',
    description:
      'Every notification is persisted in-app regardless of external delivery, and each ' +
      'row carries its per-channel outcome — a failed Slack post is visible, not silent.',
  })
  @ApiOkResponse({
    schema: {
      example: [{
        id: 'clx0note0001', category: 'approval', severity: 'WARNING',
        subject: 'Approval needed: Send outbound campaign', readAt: null,
        deliveries: [
          { channel: 'in_app', ok: true, at: '2026-08-02T21:00:00.000Z' },
          { channel: 'integration:clx0int001', ok: false, error: 'Rate limit reached', at: '2026-08-02T21:00:00.000Z' },
        ],
      }],
    },
  })
  list(@Query('unread') unread?: string) { return this.notifications.list(unread === 'true'); }

  @Get('statistics')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({ summary: 'Read/unread counts' })
  @ApiOkResponse({ schema: { example: { total: 41, unread: 6, read: 35 } } })
  statistics() { return this.notifications.statistics(); }

  @Post(':id/read')
  @RequirePermissions(Permissions.AnalyticsRead)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0note0001' })
  @ApiOperation({ summary: 'Mark one as read' })
  @ApiOkResponse({ schema: { example: { id: 'clx0note0001', readAt: '2026-08-02T21:05:00.000Z' } } })
  markRead(@Param('id') id: string) { return this.notifications.markRead(id); }

  @Post('read-all')
  @RequirePermissions(Permissions.AnalyticsRead)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all as read' })
  @ApiOkResponse({ schema: { example: { marked: 6 } } })
  async readAll() { return { marked: await this.notifications.markAllRead() }; }
}

// ============================================================ Automation analytics

@ApiTags('Automation')
@ApiBearerAuth()
@Controller('automation')
export class AutomationAnalyticsController {
  constructor(
    private readonly automation: AutomationAnalyticsService,
    private readonly deadLetters: DeadLetterRepository,
  ) {}

  @Get('analytics')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({
    summary: 'Automation analytics',
    description:
      'Execution counts, success and failure rates, duration, AI cost, and an estimate of ' +
      'human hours saved. The savings figure is derived from an operator-configured ' +
      'minutes-per-run assumption — it is an estimate and is labelled as one.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        executions: 128, succeeded: 121, failed: 7, successRate: 95, failureRate: 5,
        averageDurationMs: 940, aiCostUsd: 0.4182, totalTokens: 118_400,
        humanHoursSaved: 21.3, estimatedSavingsUsd: 1065, roi: 2447,
        assumptions: { minutesSavedPerRun: 10, hourlyRateUsd: 50 },
        mostUsedIntegrations: [{ integrationId: 'clx0int001', name: 'Ops Slack', calls: 96 }],
        mostUsedWorkers: [{ workerId: 'clx0worker001', executions: 74 }],
      },
    },
  })
  analytics(@Query('minutesPerRun') minutesPerRun?: string, @Query('hourlyRate') hourlyRate?: string) {
    return this.automation.overview({
      minutesSavedPerRun: minutesPerRun ? Number(minutesPerRun) : undefined,
      hourlyRateUsd: hourlyRate ? Number(hourlyRate) : undefined,
    });
  }

  @Get('reliability')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({
    summary: 'Reliability posture',
    description: 'Dead letters, suspended runs and webhook delivery health — everything that failed and was not silently dropped.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        deadLetters: { unresolved: 2, total: 5 },
        suspendedRuns: 1,
        webhooks: { total: 40, delivered: 37, pendingRetry: 1, exhausted: 2, deliveryRate: 95 },
      },
    },
  })
  reliability() { return this.automation.reliability(); }

  @Get('dead-letters')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({ summary: 'List unresolved dead letters', description: 'Nothing fails silently — exhausted work lands here with its payload for replay.' })
  @ApiOkResponse({
    schema: {
      example: [{ id: 'clx0dl0001', source: 'workflow_run', reference: 'clx0run0009', reason: 'Step "notify": HTTP 500', attempts: 3 }],
    },
  })
  deadLetterList() { return this.deadLetters.findUnresolved(); }

  @Post('dead-letters/:id/resolve')
  @RequirePermissions(Permissions.MissionExecute)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0dl0001' })
  @ApiOperation({ summary: 'Mark a dead letter resolved' })
  @ApiOkResponse({ schema: { example: { id: 'clx0dl0001', resolvedAt: '2026-08-02T21:10:00.000Z' } } })
  resolve(@Param('id') id: string) {
    return this.deadLetters.update(id, { resolvedAt: new Date() });
  }
}

// ============================================================ Public API

@ApiTags('Public API')
@ApiBearerAuth()
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeyService) {}

  @Post()
  @RequirePermissions(Permissions.OrganizationUpdate)
  @ApiOperation({
    summary: 'Issue an API key',
    description:
      'Only a SHA-256 hash is stored. The plaintext key is returned exactly once, here — ' +
      'it cannot be recovered afterwards, so store it now.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0key0001', name: 'CI pipeline', key: 'px_9fJ2kQ...shown-once', prefix: 'px_9fJ2kQ',
        scopes: ['workflow:execute'], expiresAt: '2026-11-02T00:00:00.000Z',
      },
    },
  })
  issue(@Body() dto: CreateApiKeyDto) { return this.keys.issue(dto); }

  @Get()
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'List API keys', description: 'Prefixes only; the keys themselves are unrecoverable.' })
  @ApiOkResponse({
    schema: { example: [{ id: 'clx0key0001', name: 'CI pipeline', prefix: 'px_9fJ2kQ', requestCount: 412, revokedAt: null }] },
  })
  list() { return this.keys.list(); }

  @Get('usage')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({ summary: 'API key usage analytics' })
  @ApiOkResponse({
    schema: {
      example: {
        total: 3, active: 2, revoked: 1, totalRequests: 1284,
        byKey: [{ id: 'clx0key0001', name: 'CI pipeline', prefix: 'px_9fJ2kQ', requests: 412, revoked: false }],
      },
    },
  })
  usage() { return this.keys.statistics(); }

  @Delete(':id')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0key0001' })
  @ApiOperation({ summary: 'Revoke an API key', description: 'Takes effect immediately, including cached resolutions.' })
  @ApiOkResponse({ schema: { example: { revoked: true } } })
  revoke(@Param('id') id: string) { return this.keys.revoke(id); }
}

@ApiTags('Public API')
@ApiBearerAuth()
@Controller('webhook-endpoints')
export class WebhookEndpointsController {
  constructor(
    private readonly endpoints: WebhookEndpointRepository,
    private readonly dispatcher: WebhookDispatcher,
  ) {}

  @Post()
  @RequirePermissions(Permissions.IntegrationCreate)
  @ApiOperation({
    summary: 'Subscribe to outbound webhooks',
    description:
      'Deliveries are signed `t=<ts>,v1=<hmac>` over `<timestamp>.<body>` in `x-prismx-signature`, ' +
      'retried with exponential backoff, and dead-lettered once exhausted. The signing secret is returned once.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0wh0001', name: 'Ops dashboard', url: 'https://ops.example.com/hooks/prismx',
        events: ['mission.completed'], secret: 'shown once — store it now', enabled: true,
      },
    },
  })
  async create(@Body() dto: CreateWebhookEndpointDto) {
    const secret = WebhookDispatcher.generateSecret();
    const endpoint = await this.endpoints.create({
      name: dto.name, url: dto.url, events: dto.events, secret,
    });
    return { ...endpoint, secret };
  }

  @Get()
  @RequirePermissions(Permissions.IntegrationRead)
  @ApiOperation({ summary: 'List webhook endpoints' })
  @ApiOkResponse({
    schema: { example: [{ id: 'clx0wh0001', name: 'Ops dashboard', url: 'https://ops.example.com/hooks/prismx', enabled: true, failureStreak: 0 }] },
  })
  list() { return this.endpoints.findMany({}, { orderBy: { createdAt: 'desc' } }); }

  @Get('deliveries')
  @RequirePermissions(Permissions.IntegrationRead)
  @ApiOperation({ summary: 'Delivery statistics' })
  @ApiOkResponse({ schema: { example: { total: 40, delivered: 37, pendingRetry: 1, exhausted: 2, deliveryRate: 95 } } })
  deliveries() { return this.dispatcher.statistics(); }

  @Post('retry-pending')
  @RequirePermissions(Permissions.IntegrationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry deliveries whose backoff has elapsed' })
  @ApiOkResponse({ schema: { example: { delivered: 1 } } })
  async retry() { return { delivered: await this.dispatcher.retryPending() }; }

  @Delete(':id')
  @RequirePermissions(Permissions.IntegrationDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0wh0001' })
  @ApiOperation({ summary: 'Delete a webhook endpoint' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  remove(@Param('id') id: string) { return this.endpoints.remove(id); }
}
