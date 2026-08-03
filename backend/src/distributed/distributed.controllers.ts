import {
  Body, Controller, Get, Param, Patch, Post, Query, Req, Sse, UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiCreatedResponse, ApiExcludeEndpoint, ApiOkResponse, ApiOperation,
  ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags,
} from '@nestjs/swagger';
import {
  IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUrl,
  Max, Min, MinLength,
} from 'class-validator';
import { CapabilityKind, MemoryScope, NodeType, Priority, SyncOpKind } from '@prisma/client';
import { Observable, map } from 'rxjs';

import { NodeService } from '../nodes/node.service';
import { NodeSecurityService } from '../nodes/node-security.service';
import { NodeAgentGuard, NodeAgentRequest } from '../nodes/node-agent.guard';
import { TaskHandlerRegistry } from '../nodes/task-handler.registry';
import { NodeTransportRegistry } from '../nodes/transport/node-transports';
import { CapabilityReport, HeartbeatReport } from '../nodes/node.contract';
import { NodeScheduler } from './node-scheduler.service';
import { DistributedExecutionService } from './distributed-execution.service';
import { QueueCoordinator } from './queue-coordinator.service';
import { FailoverService } from './failover.service';
import { ClusterMonitorService } from './cluster-monitor.service';
import { MemorySyncService } from './memory-sync.service';
import { FederationService, FEDERATION_RESOURCES } from './federation.service';
import {
  DistributedTaskRepository,
  NodeRepository,
} from '../database/repositories/distributed.repositories';
import { Public, RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';
import { RequestContextStore } from '../shared/context/request-context';

// ============================================================ DTOs

export class NodeResourcesDto {
  @ApiPropertyOptional({ example: 16 }) @IsOptional() @IsInt() @Min(0) cpuCores?: number;
  @ApiPropertyOptional({ example: 'AMD Ryzen 9 5950X' }) @IsOptional() @IsString() cpuModel?: string;
  @ApiPropertyOptional({ example: 65536 }) @IsOptional() @IsInt() @Min(0) memoryMb?: number;
  @ApiPropertyOptional({ example: 1048576 }) @IsOptional() @IsInt() @Min(0) diskMb?: number;
  @ApiPropertyOptional({ example: 1 }) @IsOptional() @IsInt() @Min(0) gpuCount?: number;
  @ApiPropertyOptional({ example: 'NVIDIA RTX 4090' }) @IsOptional() @IsString() gpuModel?: string;
  @ApiPropertyOptional({ example: 24576 }) @IsOptional() @IsInt() @Min(0) gpuMemoryMb?: number;
}

export class CapabilityReportDto {
  @ApiProperty({ enum: CapabilityKind, example: 'PROVIDER' })
  @IsEnum(CapabilityKind) kind!: CapabilityKind;

  @ApiProperty({ example: 'OLLAMA' }) @IsString() key!: string;
  @ApiPropertyOptional({ example: 'Local Ollama' }) @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional({ example: '0.3.14' }) @IsOptional() @IsString() version?: string;
  @ApiPropertyOptional({ example: { models: ['llama3'] } })
  @IsOptional() @IsObject() detail?: Record<string, unknown>;
}

export class RegisterNodeDto {
  @ApiProperty({ example: 'Home GPU box' })
  @IsString() @MinLength(2) name!: string;

  @ApiPropertyOptional({ example: 'home-gpu', description: 'Defaults to a slug of the name.' })
  @IsOptional() @IsString() slug?: string;

  @ApiPropertyOptional({ enum: NodeType, example: 'DEDICATED_AI_SERVER' })
  @IsOptional() @IsEnum(NodeType) type?: NodeType;

  @ApiPropertyOptional({
    example: 'https://gpu.example.internal',
    description: 'Required for any node that is not the control plane itself.',
  })
  @IsOptional() @IsUrl({ require_tld: false }) endpointUrl?: string;

  @ApiPropertyOptional({ example: 'eu-west' }) @IsOptional() @IsString() region?: string;

  @ApiPropertyOptional({ type: [String], example: ['gpu', 'inference'] })
  @IsOptional() @IsArray() @IsString({ each: true }) labels?: string[];

  @ApiPropertyOptional({ example: '1.0.0' }) @IsOptional() @IsString() version?: string;

  @ApiPropertyOptional({ default: 4, description: 'Concurrent tasks this node accepts.' })
  @IsOptional() @IsInt() @Min(1) @Max(1024) maxConcurrency?: number;

  @ApiPropertyOptional({ example: 0.45, description: 'Running cost per hour, for tie-breaking.' })
  @IsOptional() @IsNumber() @Min(0) costPerHourUsd?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional() @IsBoolean() allowRemoteExecution?: boolean;

  @ApiPropertyOptional({ type: NodeResourcesDto })
  @IsOptional() @IsObject() resources?: NodeResourcesDto;

  @ApiPropertyOptional({ type: [CapabilityReportDto] })
  @IsOptional() @IsArray() capabilities?: CapabilityReportDto[];

  @ApiPropertyOptional({
    default: false,
    description:
      'Trust the node immediately. An untrusted node is registered but never scheduled, ' +
      'which is the safe default for a machine that has not yet proved its identity.',
  })
  @IsOptional() @IsBoolean() trusted?: boolean;

  @ApiPropertyOptional({
    description:
      'Free-form. Setting `simulate` marks the node as stood-in rather than real, ' +
      'e.g. `{ "simulate": { "latencyMs": 40 } }`.',
    example: { simulate: { latencyMs: 25 } },
  })
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class HeartbeatDto {
  @ApiPropertyOptional({ example: 0.32 }) @IsOptional() @IsNumber() @Min(0) @Max(1) cpuUsage?: number;
  @ApiPropertyOptional({ example: 0.51 }) @IsOptional() @IsNumber() @Min(0) @Max(1) memoryUsage?: number;
  @ApiPropertyOptional({ example: 0.18 }) @IsOptional() @IsNumber() @Min(0) @Max(1) diskUsage?: number;
  @ApiPropertyOptional({ example: 0.0 }) @IsOptional() @IsNumber() @Min(0) @Max(1) gpuUsage?: number;
  @ApiPropertyOptional({ example: 2 }) @IsOptional() @IsInt() @Min(0) activeTasks?: number;
  @ApiPropertyOptional({ example: 0 }) @IsOptional() @IsInt() @Min(0) queueDepth?: number;
  @ApiPropertyOptional({ example: 86400 }) @IsOptional() @IsInt() @Min(0) uptimeSeconds?: number;
  @ApiPropertyOptional({ example: 24 }) @IsOptional() @IsNumber() @Min(0) latencyMs?: number;

  @ApiPropertyOptional({ type: NodeResourcesDto })
  @IsOptional() @IsObject() resources?: NodeResourcesDto;

  @ApiPropertyOptional({ type: [CapabilityReportDto] })
  @IsOptional() @IsArray() capabilities?: CapabilityReportDto[];

  @ApiPropertyOptional({ example: { agentBuild: '1.0.0' } })
  @IsOptional() @IsObject() details?: Record<string, unknown>;
}

export class UpdateNodeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(1024) maxConcurrency?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) costPerHourUsd?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowRemoteExecution?: boolean;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true }) labels?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() region?: string;
}

export class TrustNodeDto {
  @ApiProperty({ example: true, description: 'False revokes trust and every signing key.' })
  @IsBoolean() trusted!: boolean;
}

export class DrainNodeDto {
  @ApiPropertyOptional({ example: 'kernel upgrade' })
  @IsOptional() @IsString() reason?: string;
}

export class NodeRequirementsDto {
  @ApiPropertyOptional({ type: [String], example: ['PROVIDER:OPENAI'] })
  @IsOptional() @IsArray() @IsString({ each: true }) capabilities?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresGpu?: boolean;
  @ApiPropertyOptional({ example: 8192 }) @IsOptional() @IsInt() @Min(0) minMemoryMb?: number;
  @ApiPropertyOptional({ example: 4 }) @IsOptional() @IsInt() @Min(0) minCpuCores?: number;
  @ApiPropertyOptional({ example: 20480 }) @IsOptional() @IsInt() @Min(0) minDiskMb?: number;
  @ApiPropertyOptional({ type: [String], example: ['gpu'] })
  @IsOptional() @IsArray() @IsString({ each: true }) labels?: string[];
  @ApiPropertyOptional({ example: 'eu-west' }) @IsOptional() @IsString() region?: string;
  @ApiPropertyOptional({ description: 'Pin to one node.' })
  @IsOptional() @IsString() nodeId?: string;
  @ApiPropertyOptional({ example: 2.5 })
  @IsOptional() @IsNumber() @Min(0) maxCostPerHourUsd?: number;
}

export class SubmitTaskDto {
  @ApiProperty({
    example: 'echo',
    description: 'Handler key. See GET /distributed/task-kinds for what this fleet can run.',
  })
  @IsString() kind!: string;

  @ApiPropertyOptional({ example: { message: 'hello fleet' } })
  @IsOptional() @IsObject() payload?: Record<string, unknown>;

  @ApiPropertyOptional({ type: NodeRequirementsDto })
  @IsOptional() @IsObject() requirements?: NodeRequirementsDto;

  @ApiPropertyOptional({ enum: Priority, default: 'MEDIUM' })
  @IsOptional() @IsEnum(Priority) priority?: Priority;

  @ApiPropertyOptional({ default: 3 }) @IsOptional() @IsInt() @Min(1) @Max(10) maxAttempts?: number;
  @ApiPropertyOptional({ default: 120000 })
  @IsOptional() @IsInt() @Min(1000) timeoutMs?: number;

  @ApiPropertyOptional({
    example: 'nightly-report-2026-08-03',
    description: 'Resubmitting the same key returns the original task instead of running twice.',
  })
  @IsOptional() @IsString() idempotencyKey?: string;

  @ApiPropertyOptional({ default: false, description: 'Wait for the result instead of queueing.' })
  @IsOptional() @IsBoolean() wait?: boolean;
}

export class MigrateTaskDto {
  @ApiPropertyOptional({ description: 'Target node. Omit to let the scheduler choose.' })
  @IsOptional() @IsString() toNodeId?: string;
  @ApiPropertyOptional({ example: 'draining node-3' })
  @IsOptional() @IsString() reason?: string;
}

export class PutShardDto {
  @ApiProperty({ enum: MemoryScope, example: 'SHARED' })
  @IsEnum(MemoryScope) scope!: MemoryScope;

  @ApiProperty({ example: 'fleet.settings' }) @IsString() key!: string;

  @ApiProperty({ example: { maxParallelMissions: 4 } })
  @IsObject() value!: Record<string, unknown>;

  @ApiPropertyOptional({ default: 'default' }) @IsOptional() @IsString() namespace?: string;

  @ApiPropertyOptional({ description: 'Required for LOCAL and CACHED scopes.' })
  @IsOptional() @IsString() nodeId?: string;

  @ApiPropertyOptional({ type: [String], example: ['config'] })
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}

export class ApplyOpDto {
  @ApiProperty({ enum: MemoryScope, example: 'SHARED' })
  @IsEnum(MemoryScope) scope!: MemoryScope;

  @ApiProperty({ example: 'fleet.settings' }) @IsString() key!: string;

  @ApiProperty({ enum: SyncOpKind, example: 'PUT' })
  @IsEnum(SyncOpKind) op!: SyncOpKind;

  @ApiProperty({ example: 2, description: 'Version the writing node believes it produced.' })
  @IsInt() @Min(1) version!: number;

  @ApiProperty({ example: 'clx0node0001' }) @IsString() nodeId!: string;

  @ApiPropertyOptional({ example: { maxParallelMissions: 6 } })
  @IsOptional() @IsObject() value?: Record<string, unknown>;

  @ApiPropertyOptional({ default: 'default' }) @IsOptional() @IsString() namespace?: string;

  @ApiPropertyOptional({
    example: { 'clx0node0001': 2 },
    description: 'Writer’s vector clock. Omitted clocks are inferred from the version.',
  })
  @IsOptional() @IsObject() vectorClock?: Record<string, number>;
}

export class IssueGrantDto {
  @ApiProperty({ example: 'clx0org000002' }) @IsString() peerOrganizationId!: string;

  @ApiProperty({
    type: [String],
    example: ['nodes:execute', 'nodes:read'],
    description: `One or more of: ${FEDERATION_RESOURCES.join(', ')}. Nothing is shared implicitly.`,
  })
  @IsArray() @IsString({ each: true }) resources!: string[];

  @ApiPropertyOptional({ example: 'Overflow capacity for Acme' })
  @IsOptional() @IsString() name?: string;

  @ApiPropertyOptional({ type: [String], description: 'Narrow the grant to specific nodes.' })
  @IsOptional() @IsArray() @IsString({ each: true }) allowedNodeIds?: string[];

  @ApiPropertyOptional({ default: 1, description: 'Ceiling on simultaneous borrowed tasks.' })
  @IsOptional() @IsInt() @Min(1) maxConcurrentTasks?: number;

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59.000Z' })
  @IsOptional() @IsString() expiresAt?: string;
}

export class AgentExecuteDto {
  @ApiProperty() @IsString() taskId!: string;
  @ApiProperty() @IsString() kind!: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() payload?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() correlationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() timeoutMs?: number;
}

// ============================================================ Nodes

@ApiTags('Nodes')
@ApiBearerAuth('bearer')
@Controller('nodes')
export class NodesController {
  constructor(
    private readonly nodes: NodeService,
    private readonly repository: NodeRepository,
    private readonly transportRegistry: NodeTransportRegistry,
  ) {}

  @Post()
  @RequirePermissions(Permissions.NodeRegister)
  @ApiOperation({
    summary: 'Register a node',
    description:
      'Adds a machine to the fleet. This is the whole of adding capacity: the node ' +
      'reports its own hardware and capabilities, and scheduling begins as soon as it ' +
      'is trusted and heartbeating. No other configuration is required anywhere.\n\n' +
      'The response carries the node’s signing secret **once**. It is stored ' +
      'encrypted and cannot be read back; a lost secret is replaced by rotating.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        node: { id: 'clx0node0001', slug: 'home-gpu', status: 'PENDING', trust: 'TRUSTED' },
        credentials: { nodeId: 'clx0node0001', keyVersion: 1, secret: 'wCq3…', fingerprint: 'a91f…' },
      },
    },
  })
  async register(@Body() dto: RegisterNodeDto) {
    const registered = await this.nodes.register({
      ...dto,
      capabilities: dto.capabilities as CapabilityReport[] | undefined,
    });
    return {
      node: registered.node,
      credentials: registered.credentials
        ? {
            ...registered.credentials,
            fingerprint: NodeSecurityService.fingerprint(registered.credentials.secret),
          }
        : undefined,
    };
  }

  @Post('local')
  @RequirePermissions(Permissions.NodeRegister)
  @ApiOperation({
    summary: 'Ensure the control-plane node exists',
    description:
      'Registers this process as a node if it is not already one, measuring its own ' +
      'hardware and discovering its own capabilities. Idempotent, and normally ' +
      'unnecessary — an organization gets its local node when it is created. This is ' +
      'here for workspaces that predate the fleet.',
  })
  @ApiCreatedResponse({
    schema: { example: { id: 'clx0node0001', slug: 'control-plane', isLocal: true, status: 'ONLINE' } },
  })
  ensureLocal() {
    return this.nodes.ensureLocalNode();
  }

  @Get()
  @RequirePermissions(Permissions.NodeRead)
  @ApiOperation({ summary: 'List nodes', description: 'The fleet, healthiest first.' })
  @ApiQuery({ name: 'status', required: false, example: 'ONLINE' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0node0001', slug: 'control-plane', type: 'LOCAL_MACHINE', status: 'ONLINE',
          healthScore: 0.94, activeTasks: 0, maxConcurrency: 8, transport: 'local',
        },
      ],
    },
  })
  async list(@Query('status') status?: string) {
    const nodes = await this.nodes.list(status ? { status } : {});
    return nodes.map((node) => ({
      ...node,
      transport: NodeTransportRegistry.transportKeyFor(node),
    }));
  }

  @Get('transports')
  @RequirePermissions(Permissions.NodeRead)
  @ApiOperation({
    summary: 'List transports',
    description:
      'How the control plane can reach a node. `local` is this process, `http` is another ' +
      'machine, `simulated` stands in for one that is not there so fleet behaviour can be ' +
      'exercised without extra hardware.',
  })
  @ApiOkResponse({ schema: { example: { transports: ['http', 'local', 'simulated'] } } })
  listTransports() {
    return { transports: this.transportRegistry.keys() };
  }

  @Get(':id')
  @RequirePermissions(Permissions.NodeRead)
  @ApiParam({ name: 'id', example: 'clx0node0001' })
  @ApiOperation({ summary: 'Get a node with its capabilities' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0node0001', slug: 'home-gpu', status: 'ONLINE', healthScore: 0.88,
        capabilities: [{ kind: 'PROVIDER', key: 'OLLAMA', available: true }],
      },
    },
  })
  get(@Param('id') id: string) {
    return this.nodes.get(id);
  }

  @Patch(':id')
  @RequirePermissions(Permissions.NodeUpdate)
  @ApiParam({ name: 'id', example: 'clx0node0001' })
  @ApiOperation({ summary: 'Update node settings' })
  @ApiOkResponse({ schema: { example: { id: 'clx0node0001', maxConcurrency: 12 } } })
  update(@Param('id') id: string, @Body() dto: UpdateNodeDto) {
    return this.repository.update(id, { ...dto });
  }

  @Post(':id/heartbeat')
  @RequirePermissions(Permissions.NodeUpdate)
  @ApiParam({ name: 'id', example: 'clx0node0001' })
  @ApiOperation({
    summary: 'Record a heartbeat',
    description:
      'Refreshes load, resources and capabilities, and re-derives health and status. ' +
      'A node that stops heartbeating is presumed gone and its work is moved.',
  })
  @ApiOkResponse({
    schema: { example: { id: 'clx0node0001', status: 'ONLINE', healthScore: 0.91 } },
  })
  heartbeat(@Param('id') id: string, @Body() dto: HeartbeatDto) {
    return this.nodes.heartbeat(id, dto as HeartbeatReport);
  }

  @Post(':id/discover')
  @RequirePermissions(Permissions.NodeUpdate)
  @ApiParam({ name: 'id', example: 'clx0node0001' })
  @ApiOperation({
    summary: 'Re-run capability discovery',
    description:
      'Replaces the node’s advertised capabilities with what it currently reports. ' +
      'Anything no longer present stops winning placements.',
  })
  @ApiOkResponse({ schema: { example: { nodeId: 'clx0node0001', capabilities: 14 } } })
  async discover(@Param('id') id: string, @Body() dto: { capabilities?: CapabilityReportDto[] }) {
    const node = await this.repository.findByIdOrFail(id);
    const reported = (dto?.capabilities as CapabilityReport[] | undefined) ??
      (node.isLocal ? await this.nodes.discoverLocal() : []);
    const count = await this.nodes.syncCapabilities(id, reported);
    return { nodeId: id, capabilities: count };
  }

  @Post(':id/trust')
  @RequirePermissions(Permissions.NodeUpdate)
  @ApiParam({ name: 'id', example: 'clx0node0001' })
  @ApiOperation({
    summary: 'Trust or revoke a node',
    description: 'Revoking also revokes every signing key, so the node cannot re-authenticate.',
  })
  @ApiOkResponse({ schema: { example: { id: 'clx0node0001', trust: 'TRUSTED' } } })
  trust(@Param('id') id: string, @Body() dto: TrustNodeDto) {
    return this.nodes.trust(id, dto.trusted);
  }

  @Post(':id/rotate-key')
  @RequirePermissions(Permissions.NodeUpdate)
  @ApiParam({ name: 'id', example: 'clx0node0001' })
  @ApiOperation({
    summary: 'Rotate the node signing key',
    description:
      'Issues a new key version. The previous one keeps verifying for fifteen minutes so ' +
      'a node holding in-flight work is not cut off mid-task.',
  })
  @ApiCreatedResponse({
    schema: { example: { nodeId: 'clx0node0001', keyVersion: 2, secret: 'F7t…', fingerprint: 'c40e…' } },
  })
  async rotate(@Param('id') id: string) {
    const issued = await this.nodes.rotateKey(id);
    return { ...issued, fingerprint: NodeSecurityService.fingerprint(issued.secret) };
  }

  @Post(':id/drain')
  @RequirePermissions(Permissions.NodeUpdate)
  @ApiParam({ name: 'id', example: 'clx0node0001' })
  @ApiOperation({
    summary: 'Drain a node',
    description: 'Stops new placements. Work already running is allowed to finish.',
  })
  @ApiOkResponse({ schema: { example: { id: 'clx0node0001', status: 'DRAINING' } } })
  drain(@Param('id') id: string, @Body() dto: DrainNodeDto) {
    return this.nodes.drain(id, dto.reason);
  }

  @Post(':id/resume')
  @RequirePermissions(Permissions.NodeUpdate)
  @ApiParam({ name: 'id', example: 'clx0node0001' })
  @ApiOperation({ summary: 'Return a drained node to service' })
  @ApiOkResponse({ schema: { example: { id: 'clx0node0001', status: 'ONLINE' } } })
  resume(@Param('id') id: string) {
    return this.nodes.resume(id);
  }

  @Post(':id/decommission')
  @RequirePermissions(Permissions.NodeDelete)
  @ApiParam({ name: 'id', example: 'clx0node0001' })
  @ApiOperation({
    summary: 'Decommission a node',
    description: 'Permanently removes it from scheduling and revokes its keys.',
  })
  @ApiOkResponse({ schema: { example: { id: 'clx0node0001', status: 'DECOMMISSIONED' } } })
  decommission(@Param('id') id: string) {
    return this.nodes.decommission(id);
  }
}

// ============================================================ Node agent

@ApiTags('Node Agent')
@Controller('nodes/agent')
@UseGuards(NodeAgentGuard)
export class NodeAgentController {
  constructor(
    private readonly handlers: TaskHandlerRegistry,
    private readonly nodes: NodeService,
  ) {}

  @Public()
  @Post('execute')
  @ApiOperation({
    summary: 'Execute work sent by a control plane',
    description:
      'Machine-to-machine. Authenticated by an HMAC signature over `<timestamp>.<body>` ' +
      'using the node’s shared secret, not by a user token — the organization is ' +
      'established by the key, never by the request body.',
  })
  @ApiOkResponse({
    schema: { example: { taskId: 'clx0task0001', status: 'SUCCEEDED', result: {}, durationMs: 412 } },
  })
  async execute(@Body() dto: AgentExecuteDto, @Req() request: NodeAgentRequest) {
    const caller = request.nodeCaller!;
    const startedAt = Date.now();

    try {
      const outcome = await this.handlers.invoke({
        taskId: dto.taskId,
        kind: dto.kind,
        payload: dto.payload ?? {},
        organizationId: caller.organizationId,
        timeoutMs: dto.timeoutMs ?? 120_000,
        correlationId: dto.correlationId,
      });

      return {
        taskId: dto.taskId,
        status: 'SUCCEEDED',
        result: outcome.result ?? {},
        costUsd: outcome.costUsd ?? 0,
        totalTokens: outcome.totalTokens ?? 0,
        durationMs: Date.now() - startedAt,
        nodeId: caller.nodeId,
      };
    } catch (error) {
      // Reported as a failed result rather than an HTTP error: the request
      // was well-formed and authenticated, it is the *work* that failed, and
      // the control plane needs that distinction to decide about retrying.
      return {
        taskId: dto.taskId,
        status: 'FAILED',
        error: (error as Error).message,
        durationMs: Date.now() - startedAt,
        nodeId: caller.nodeId,
      };
    }
  }

  @Public()
  @Post('status')
  @ApiOperation({
    summary: 'Report load and capabilities',
    description: 'The probe a control plane uses to measure a node it already knows about.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        cpuUsage: 0.21, memoryUsage: 0.44, uptimeSeconds: 91244,
        capabilities: [{ kind: 'TOOL', key: 'http_request' }],
      },
    },
  })
  async status(@Req() request: NodeAgentRequest) {
    const caller = request.nodeCaller!;
    return {
      ...NodeService.measureLocalLoad(),
      resources: NodeService.measureLocalResources(),
      capabilities: await this.nodes.discoverLocal(),
      nodeId: caller.nodeId,
      handlers: this.handlers.kinds(),
    };
  }

  @Public()
  @Post('cancel')
  @ApiExcludeEndpoint()
  cancel(@Body() dto: { taskId: string }) {
    // Advisory only. Nothing here can interrupt a handler mid-call; the
    // control plane's lease is what actually bounds a runaway task.
    return { taskId: dto.taskId, accepted: true };
  }
}

// ============================================================ Distributed execution

@ApiTags('Distributed Execution')
@ApiBearerAuth('bearer')
@Controller('distributed')
export class DistributedController {
  constructor(
    private readonly execution: DistributedExecutionService,
    private readonly queue: QueueCoordinator,
    private readonly scheduler: NodeScheduler,
    private readonly failover: FailoverService,
    private readonly monitor: ClusterMonitorService,
    private readonly handlers: TaskHandlerRegistry,
    private readonly tasks: DistributedTaskRepository,
  ) {}

  @Get('task-kinds')
  @RequirePermissions(Permissions.NodeRead)
  @ApiOperation({
    summary: 'List runnable task kinds',
    description: 'What this fleet knows how to execute. Registered by the modules that own each kind.',
  })
  @ApiOkResponse({ schema: { example: { kinds: ['echo', 'tool.invoke', 'worker.execute'] } } })
  kinds() {
    return { kinds: this.handlers.kinds() };
  }

  @Post('tasks')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiOperation({
    summary: 'Submit work to the fleet',
    description:
      'Queues a task and, with `wait: true`, sees it through — placing it, retrying on ' +
      'other nodes if one fails, and returning the final outcome.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        task: { id: 'clx0task0001', kind: 'echo', status: 'SUCCEEDED', queue: 'COMPLETED' },
        placement: { explanation: 'Chose home-gpu at 0.8123 on health 0.94, capacity 1' },
      },
    },
  })
  async submit(@Body() dto: SubmitTaskDto) {
    if (dto.wait) {
      const outcome = await this.execution.run({ ...dto, requirements: dto.requirements });
      return {
        task: outcome.task,
        placement: outcome.placement
          ? { explanation: outcome.placement.explanation, candidates: outcome.placement.candidates }
          : undefined,
      };
    }
    return { task: await this.execution.submit({ ...dto, requirements: dto.requirements }) };
  }

  @Get('tasks/:id')
  @RequirePermissions(Permissions.NodeRead)
  @ApiParam({ name: 'id', example: 'clx0task0001' })
  @ApiOperation({ summary: 'Get a distributed task' })
  @ApiOkResponse({
    schema: {
      example: { id: 'clx0task0001', status: 'SUCCEEDED', nodeId: 'clx0node0001', migrations: 0 },
    },
  })
  task(@Param('id') id: string) {
    return this.execution.get(id);
  }

  @Post('tasks/:id/migrate')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiParam({ name: 'id', example: 'clx0task0001' })
  @ApiOperation({
    summary: 'Move a task to another node',
    description: 'Keeps the task identity and records where it came from.',
  })
  @ApiOkResponse({
    schema: { example: { id: 'clx0task0001', status: 'QUEUED', migrations: 1, previousNodeId: 'clx0node0001' } },
  })
  migrate(@Param('id') id: string, @Body() dto: MigrateTaskDto) {
    return this.queue.migrate(id, dto);
  }

  @Post('tasks/:id/requeue')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiParam({ name: 'id', example: 'clx0task0001' })
  @ApiOperation({ summary: 'Put a failed task back on the incoming queue' })
  @ApiOkResponse({ schema: { example: { id: 'clx0task0001', status: 'QUEUED', attempts: 0 } } })
  requeue(@Param('id') id: string) {
    return this.queue.requeue(id);
  }

  @Post('tasks/:id/cancel')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiParam({ name: 'id', example: 'clx0task0001' })
  @ApiOperation({ summary: 'Cancel a task' })
  @ApiOkResponse({ schema: { example: { id: 'clx0task0001', status: 'CANCELLED' } } })
  cancel(@Param('id') id: string) {
    return this.execution.cancel(id);
  }

  @Get('queues')
  @RequirePermissions(Permissions.NodeRead)
  @ApiOperation({
    summary: 'Queue depths',
    description: 'The four queues plus a per-node breakdown and the oldest waiting task.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        incoming: 2, active: 1, completed: 47, failed: 0,
        byStatus: { QUEUED: 2, RUNNING: 1, SUCCEEDED: 47 }, oldestWaitingMs: 1840,
        perNode: [{ slug: 'home-gpu', utilisation: 0.25, queued: 0, running: 1 }],
      },
    },
  })
  async queues() {
    const [snapshot, perNode] = await Promise.all([this.queue.snapshot(), this.queue.perNode()]);
    return { ...snapshot, perNode };
  }

  @Get('queues/:queue')
  @RequirePermissions(Permissions.NodeRead)
  @ApiParam({ name: 'queue', enum: ['INCOMING', 'ACTIVE', 'COMPLETED', 'FAILED'] })
  @ApiOperation({ summary: 'List the contents of one queue' })
  @ApiOkResponse({ schema: { example: [{ id: 'clx0task0001', kind: 'echo', status: 'QUEUED' }] } })
  listQueue(
    @Param('queue') queue: 'INCOMING' | 'ACTIVE' | 'COMPLETED' | 'FAILED',
    @Query('take') take?: string,
  ) {
    return this.queue.listQueue(queue, Math.min(200, Number(take) || 50));
  }

  @Post('tick')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiOperation({
    summary: 'Drain the incoming queue',
    description:
      'Places and dispatches whatever is waiting. Runs on a timer in normal operation; ' +
      'exposed so an operator can force a pass after adding capacity.',
  })
  @ApiOkResponse({ schema: { example: { placed: 3, deferred: 0 } } })
  async tick(@Query('limit') limit?: string) {
    const result = await this.queue.tick(Math.min(100, Number(limit) || 25));
    return { placed: result.placed, deferred: result.deferred };
  }

  @Post('rebalance')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiOperation({
    summary: 'Even out load across nodes',
    description: 'Moves queued work off saturated nodes. Running work is never interrupted.',
  })
  @ApiOkResponse({
    schema: { example: { moved: [], considered: 4, explanation: 'No node is hot enough to warrant moving work.' } },
  })
  rebalance() {
    return this.queue.rebalance();
  }

  @Post('sweep')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiOperation({
    summary: 'Run the failover sweep',
    description:
      'Marks silent nodes offline, reclaims expired leases, moves orphaned work and lifts ' +
      'elapsed quarantines. Runs on a timer; exposed for diagnosis.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        nodesMarkedOffline: ['clx0node0002'], tasksReassigned: ['clx0task0009'],
        leasesExpired: [], quarantinesLifted: [],
      },
    },
  })
  sweep() {
    return this.failover.sweep();
  }

  @Post('nodes/:id/recover')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiParam({ name: 'id', example: 'clx0node0002' })
  @ApiOperation({
    summary: 'Bring a node back after an outage',
    description:
      'Clears anything it was holding — that work has already been placed elsewhere — and ' +
      'returns it to service empty.',
  })
  @ApiOkResponse({ schema: { example: { node: 'home-gpu', clearedTasks: 2 } } })
  recover(@Param('id') id: string) {
    return this.failover.recoverNode(id);
  }

  @Post('plan')
  @RequirePermissions(Permissions.NodeRead)
  @ApiOperation({
    summary: 'Explain a placement without running anything',
    description:
      'Returns the ranked candidates, the per-factor scores and the reason every rejected ' +
      'node was rejected. The scheduler’s reasoning, on demand.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        chosen: 'home-gpu',
        explanation: 'Chose home-gpu at 0.8123 on health 0.94, capacity 1 (ahead of control-plane by 0.041)',
        candidates: [{ slug: 'home-gpu', score: 0.8123, factors: [{ name: 'health', weight: 0.3, score: 0.94 }] }],
        rejected: [{ slug: 'edge-pi', reason: 'missing capability PROVIDER:OPENAI' }],
      },
    },
  })
  async plan(@Body() dto: NodeRequirementsDto) {
    const placement = await this.scheduler.place(dto);
    return {
      chosen: placement.node?.slug ?? null,
      explanation: placement.explanation,
      candidates: placement.candidates,
      rejected: placement.rejected,
    };
  }

  @Get('cluster')
  @RequirePermissions(Permissions.NodeRead)
  @ApiOperation({
    summary: 'Fleet overview',
    description:
      'Everything an operator needs to answer "is anything wrong" in one payload: node ' +
      'counts, total capacity, health, queue depths and memory sync lag.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        generatedAt: '2026-08-03T09:40:00.000Z',
        nodesByStatus: { ONLINE: 3, OFFLINE: 1 },
        capacity: { nodes: 3, cpuCores: 40, memoryMb: 131072, gpuCount: 1, maxConcurrency: 20, activeTasks: 4, utilisation: 0.2 },
        health: { average: 0.87, weakest: { slug: 'edge-pi', healthScore: 0.52 }, unreachable: ['vps-2'] },
        memory: { maxLag: 0, recovering: 0 },
      },
    },
  })
  cluster() {
    return this.monitor.overview();
  }

  @Get('nodes/:id/metrics')
  @RequirePermissions(Permissions.NodeRead)
  @ApiParam({ name: 'id', example: 'clx0node0001' })
  @ApiOperation({ summary: 'Heartbeat time series for one node' })
  @ApiOkResponse({
    schema: {
      example: {
        slug: 'home-gpu',
        points: [{ at: '2026-08-03T09:39:00.000Z', cpuUsage: 0.31, healthScore: 0.9, activeTasks: 1 }],
      },
    },
  })
  metrics(@Param('id') id: string, @Query('take') take?: string) {
    return this.monitor.metrics(id, Math.min(500, Number(take) || 60));
  }

  @Sse('stream')
  @RequirePermissions(Permissions.NodeRead)
  @ApiOperation({
    summary: 'Live fleet events (server-sent events)',
    description:
      'Node, task, cluster, memory and federation events as they happen, filtered to the ' +
      'calling organization. Fed from the same event bus the rest of the system uses, so a ' +
      'dashboard learns about a node going offline at the moment everything else does.',
  })
  @ApiOkResponse({
    description:
      'A `text/event-stream` of JSON events. Each `data:` line is one event envelope.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'data: {"name":"node.offline","payload":{"nodeId":"clx0node0002",' +
            '"reason":"no heartbeat since 2026-08-03T09:38:12.000Z"},' +
            '"occurredAt":"2026-08-03T09:39:44.000Z"}\n\n',
        },
      },
    },
  })
  stream(): Observable<{ data: string }> {
    const organizationId = RequestContextStore.require().organizationId;
    return this.monitor.streamFor(organizationId).pipe(
      map((event) => ({
        data: JSON.stringify({
          name: event.name,
          payload: event.payload,
          occurredAt: event.occurredAt,
        }),
      })),
    );
  }
}

// ============================================================ Distributed memory

@ApiTags('Distributed Memory')
@ApiBearerAuth('bearer')
@Controller('distributed/memory')
export class DistributedMemoryController {
  constructor(private readonly memory: MemorySyncService) {}

  @Post('shards')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiOperation({
    summary: 'Write a shard',
    description:
      'Bumps the version, recomputes the checksum and appends a replication op in one step. ' +
      'LOCAL and CACHED scopes require a `nodeId`; SHARED and GLOBAL are organization-wide.',
  })
  @ApiCreatedResponse({
    schema: {
      example: { id: 'clx0shard001', scope: 'SHARED', key: 'fleet.settings', version: 3, checksum: '9f2c…' },
    },
  })
  put(@Body() dto: PutShardDto) {
    return this.memory.put({ ...dto, value: dto.value });
  }

  @Get('shards')
  @RequirePermissions(Permissions.NodeRead)
  @ApiQuery({ name: 'scope', enum: MemoryScope, required: true })
  @ApiQuery({ name: 'namespace', required: false })
  @ApiOperation({ summary: 'List shards in a scope' })
  @ApiOkResponse({
    schema: { example: [{ key: 'fleet.settings', version: 3, scope: 'SHARED', updatedAt: '2026-08-03T09:12:00.000Z' }] },
  })
  list(
    @Query('scope') scope: MemoryScope,
    @Query('namespace') namespace?: string,
    @Query('take') take?: string,
  ) {
    return this.memory.list(scope, namespace, Math.min(500, Number(take) || 100));
  }

  @Get('shards/:scope/:key')
  @RequirePermissions(Permissions.NodeRead)
  @ApiParam({ name: 'scope', enum: MemoryScope })
  @ApiParam({ name: 'key', example: 'fleet.settings' })
  @ApiQuery({ name: 'nodeId', required: false })
  @ApiQuery({ name: 'namespace', required: false })
  @ApiOperation({
    summary: 'Read a shard',
    description:
      'For SHARED reads with a `nodeId`, a fresh node-local cache is preferred; a stale one ' +
      'is skipped rather than returned with a caveat.',
  })
  @ApiOkResponse({ schema: { example: { key: 'fleet.settings', version: 3, value: { maxParallelMissions: 4 } } } })
  read(
    @Param('scope') scope: MemoryScope,
    @Param('key') key: string,
    @Query('nodeId') nodeId?: string,
    @Query('namespace') namespace?: string,
  ) {
    return this.memory.read(scope, key, { nodeId, namespace });
  }

  @Post('sync/:nodeId/pull')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiParam({ name: 'nodeId', example: 'clx0node0001' })
  @ApiOperation({
    summary: 'Pull replication ops for a node',
    description:
      'Everything after the node’s cursor, then advances it. A node offline for a week ' +
      'asks the same question as one offline for a second and simply gets more back.',
  })
  @ApiOkResponse({
    schema: { example: { cursor: 128, latest: 128, remaining: 0, ops: [{ sequence: 128, op: 'PUT', key: 'fleet.settings' }] } },
  })
  pull(@Param('nodeId') nodeId: string, @Query('scopes') scopes?: string) {
    const parsed = (scopes ?? 'SHARED,GLOBAL')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is MemoryScope => s in MemoryScope);
    return this.memory.pull(nodeId, parsed.length > 0 ? parsed : undefined);
  }

  @Post('sync/apply')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiOperation({
    summary: 'Apply a write from another node',
    description:
      'Resolves against what is already stored: a fast-forward is applied, a stale write is ' +
      'marked superseded, and two genuinely concurrent writes are resolved deterministically ' +
      'with the losing version kept in the op log.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        outcome: 'conflict', winner: 'incoming',
        reason: 'concurrent writes on "fleet.settings"; incoming won',
      },
    },
  })
  apply(@Body() dto: ApplyOpDto) {
    return this.memory.apply({ ...dto, writtenAt: new Date() });
  }

  @Post('sync/:nodeId/recover')
  @RequirePermissions(Permissions.NodeExecute)
  @ApiParam({ name: 'nodeId', example: 'clx0node0001' })
  @ApiOperation({
    summary: 'Replay everything a node missed',
    description: 'An ordinary pull that happens to return a lot — recovery is not a separate protocol.',
  })
  @ApiOkResponse({ schema: { example: { delivered: 412, remaining: 0 } } })
  recover(@Param('nodeId') nodeId: string) {
    return this.memory.recover(nodeId);
  }

  @Get('sync/status')
  @RequirePermissions(Permissions.NodeRead)
  @ApiOperation({ summary: 'Replication lag per node and scope' })
  @ApiOkResponse({
    schema: { example: [{ slug: 'home-gpu', scope: 'SHARED', lastSequence: 128, latestSequence: 128, lag: 0 }] },
  })
  status() {
    return this.memory.status();
  }

  @Get('sync/conflicts')
  @RequirePermissions(Permissions.NodeRead)
  @ApiOperation({
    summary: 'Writes that lost a conflict',
    description: 'Kept rather than discarded, so a human can see what was overwritten and by whom.',
  })
  @ApiOkResponse({
    schema: {
      example: [{ key: 'fleet.settings', version: 4, nodeId: 'clx0node0002', resolution: 'concurrent write from clx0node0002 lost to local version 5' }],
    },
  })
  conflicts(@Query('take') take?: string) {
    return this.memory.conflicts(Math.min(200, Number(take) || 50));
  }
}

// ============================================================ Federation

@ApiTags('Federation')
@ApiBearerAuth('bearer')
@Controller('federation')
export class FederationController {
  constructor(private readonly federation: FederationService) {}

  @Get('resources')
  @RequirePermissions(Permissions.FederationRead)
  @ApiOperation({
    summary: 'List shareable resources',
    description: 'The complete vocabulary a grant may name. Anything not listed cannot be shared.',
  })
  @ApiOkResponse({
    schema: { example: { resources: ['nodes:execute', 'nodes:read', 'memory:read', 'memory:write', 'knowledge:read', 'workers:invoke'] } },
  })
  resources() {
    return { resources: FEDERATION_RESOURCES };
  }

  @Post('grants')
  @RequirePermissions(Permissions.FederationGrant)
  @ApiOperation({
    summary: 'Offer a peer access to named resources',
    description:
      'The grant starts PENDING and confers nothing until the peer accepts, so an ' +
      'organization cannot be enrolled into a federation it did not agree to. Grants are ' +
      'one-directional; mutual sharing is two grants.',
  })
  @ApiCreatedResponse({
    schema: {
      example: { id: 'clx0grant001', status: 'PENDING', resources: ['nodes:execute'], maxConcurrentTasks: 2 },
    },
  })
  issue(@Body() dto: IssueGrantDto) {
    return this.federation.issue({
      ...dto,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });
  }

  @Get('grants/issued')
  @RequirePermissions(Permissions.FederationRead)
  @ApiOperation({ summary: 'Grants this organization has issued' })
  @ApiOkResponse({ schema: { example: [{ id: 'clx0grant001', peerOrganizationId: 'clx0org2', status: 'ACTIVE' }] } })
  issued() {
    return this.federation.listIssued();
  }

  @Get('grants/received')
  @RequirePermissions(Permissions.FederationRead)
  @ApiOperation({ summary: 'Grants other organizations have issued to this one' })
  @ApiOkResponse({ schema: { example: [{ id: 'clx0grant002', organizationId: 'clx0org3', status: 'PENDING' }] } })
  received() {
    return this.federation.listReceived();
  }

  @Post('grants/:id/accept')
  @RequirePermissions(Permissions.FederationGrant)
  @ApiParam({ name: 'id', example: 'clx0grant002' })
  @ApiOperation({
    summary: 'Accept a grant offered to this organization',
    description: 'Access begins here, not when the grant was issued.',
  })
  @ApiOkResponse({ schema: { example: { id: 'clx0grant002', status: 'ACTIVE', acceptedAt: '2026-08-03T09:44:00.000Z' } } })
  accept(@Param('id') id: string) {
    return this.federation.accept(id);
  }

  @Post('grants/:id/revoke')
  @RequirePermissions(Permissions.FederationRevoke)
  @ApiParam({ name: 'id', example: 'clx0grant001' })
  @ApiOperation({
    summary: 'Withdraw a grant',
    description: 'Available to either party, and effective immediately rather than after borrowed work finishes.',
  })
  @ApiOkResponse({ schema: { example: { id: 'clx0grant001', status: 'REVOKED' } } })
  revoke(@Param('id') id: string) {
    return this.federation.revoke(id);
  }

  @Get('peers/:organizationId/nodes')
  @RequirePermissions(Permissions.FederationRead)
  @ApiParam({ name: 'organizationId', example: 'clx0org000002' })
  @ApiOperation({
    summary: 'Nodes a peer has made available',
    description:
      'Refused unless an active grant from that organization names `nodes:execute`. ' +
      'Filtered again by the grant’s node allow-list and by each node’s own ' +
      'willingness to take remote work.',
  })
  @ApiOkResponse({ schema: { example: [{ slug: 'partner-gpu', status: 'ONLINE', healthScore: 0.9 }] } })
  peerNodes(@Param('organizationId') organizationId: string) {
    return this.federation.borrowableNodes(organizationId);
  }

  @Get('peers/:organizationId/check')
  @RequirePermissions(Permissions.FederationRead)
  @ApiParam({ name: 'organizationId', example: 'clx0org000002' })
  @ApiQuery({ name: 'resource', example: 'nodes:execute' })
  @ApiOperation({
    summary: 'Test access without using it',
    description: 'Answers with a reason, because "no grant" and "grant expired" call for different responses.',
  })
  @ApiOkResponse({
    schema: { example: { allowed: false, reason: 'no active grant from that organization — nothing is shared by default' } },
  })
  async check(
    @Param('organizationId') organizationId: string,
    @Query('resource') resource: string,
  ) {
    const result = await this.federation.check(organizationId, resource ?? 'nodes:execute');
    return { allowed: result.allowed, reason: result.reason };
  }
}
