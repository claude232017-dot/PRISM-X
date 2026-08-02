import { Global, Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ToolRegistry } from './tool-registry.service';
import { BuiltinTools } from './builtin-tools';
import { ToolCallRepository } from '../database/repositories/execution.repositories';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';
import { KnowledgeRetrievalModule } from '../knowledge/retrieval/knowledge-retrieval.module';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';

@ApiTags('Tools')
@ApiBearerAuth()
@Controller('tools')
export class ToolsController {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly toolCalls: ToolCallRepository,
  ) {}

  @Get()
  @RequirePermissions(Permissions.WorkerRead)
  @ApiOperation({
    summary: 'List available tools',
    description:
      'The catalogue workers can be granted. A worker may only invoke keys listed ' +
      'in its `toolPermissions`, and the caller must additionally hold the tool’s ' +
      '`requiredPermission` — both checks are enforced on every invocation.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          key: 'knowledge.search',
          name: 'Search knowledge',
          description: 'Search the organization’s knowledge base…',
          requiredPermission: 'knowledge:read',
          mutates: false,
          parameters: {
            query: { type: 'string', description: 'What to look for.', required: true },
          },
        },
      ],
    },
  })
  list() {
    return this.registry.describeAll();
  }

  @Get('invocations')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({
    summary: 'Recent tool invocations',
    description: 'Includes denied attempts, which are recorded rather than dropped.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0tool0001',
          tool: 'knowledge.search',
          status: 'SUCCESS',
          denied: false,
          durationMs: 14,
          createdAt: '2026-08-02T12:44:51.312Z',
        },
      ],
    },
  })
  invocations() {
    return this.toolCalls.findRecent(100);
  }
}

/**
 * Global: the tool registry is consumed by the worker runtime, which sits in a
 * different module tree from the tools' own dependencies.
 */
@Global()
@Module({
  imports: [KnowledgeRetrievalModule, StorageModule, NotificationsModule],
  controllers: [ToolsController],
  providers: [ToolRegistry, BuiltinTools],
  exports: [ToolRegistry],
})
export class ToolsModule {}
