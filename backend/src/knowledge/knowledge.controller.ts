import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { KnowledgeService } from './knowledge.service';
import {
  CreateKnowledgeDto,
  KnowledgeResponseDto,
  QueryKnowledgeDto,
  UpdateKnowledgeDto,
} from './dto/knowledge.dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

@ApiTags('Knowledge')
@ApiBearerAuth()
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Post()
  @RequirePermissions(Permissions.KnowledgeCreate)
  @ApiOperation({
    summary: 'Store a knowledge entry',
    description:
      'Tags are normalised to lower case and de-duplicated so filters stay reliable. ' +
      'Emits `knowledge.stored`.',
  })
  @ApiCreatedResponse({ type: KnowledgeResponseDto })
  create(@Body() dto: CreateKnowledgeDto) {
    return this.knowledge.create(dto);
  }

  @Get()
  @RequirePermissions(Permissions.KnowledgeRead)
  @ApiOperation({
    summary: 'List or search knowledge',
    description:
      'Supply `search` for a case-insensitive match across title, content and tags; ' +
      'otherwise filter by `type` and `tags`.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        data: [
          {
            id: 'clx0know0001',
            title: 'Competitor pricing moved 12% in Q2',
            type: 'INSIGHT',
            tags: ['pricing', 'competitive'],
            confidence: 0.9,
            createdAt: '2026-08-02T11:44:51.312Z',
          },
        ],
        meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrevious: false },
      },
    },
  })
  findAll(@Query() query: QueryKnowledgeDto) {
    return this.knowledge.findAll(query);
  }

  @Get('statistics')
  @RequirePermissions(Permissions.KnowledgeRead)
  @ApiOperation({ summary: 'Knowledge counts by type' })
  @ApiOkResponse({ schema: { example: { total: 148, insights: 31, documents: 44 } } })
  statistics() {
    return this.knowledge.statistics();
  }

  @Get(':id')
  @RequirePermissions(Permissions.KnowledgeRead)
  @ApiParam({ name: 'id', example: 'clx0know0001' })
  @ApiOperation({ summary: 'Get a knowledge entry' })
  @ApiOkResponse({ type: KnowledgeResponseDto })
  @ApiNotFoundResponse({ description: 'No such entry in this organization.' })
  findOne(@Param('id') id: string) {
    return this.knowledge.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(Permissions.KnowledgeUpdate)
  @ApiParam({ name: 'id', example: 'clx0know0001' })
  @ApiOperation({ summary: 'Update a knowledge entry' })
  @ApiOkResponse({ type: KnowledgeResponseDto })
  update(@Param('id') id: string, @Body() dto: UpdateKnowledgeDto) {
    return this.knowledge.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permissions.KnowledgeDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0know0001' })
  @ApiOperation({ summary: 'Delete a knowledge entry', description: 'Soft delete.' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  remove(@Param('id') id: string) {
    return this.knowledge.remove(id);
  }
}
