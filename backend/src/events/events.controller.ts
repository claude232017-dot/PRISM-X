import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EventRepository } from '../database/repositories/tenant.repositories';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';
import { paginate } from '../shared/dto/pagination.dto';
import { QueryEventsDto } from './dto/query-events.dto';

@ApiTags('Events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventRepository) {}

  @Get()
  @RequirePermissions(Permissions.EventRead)
  @ApiOperation({
    summary: 'List domain events',
    description:
      'Returns the durable event log for the caller’s organization, newest first. ' +
      'Every state-changing action in PRISM-X appends here.',
  })
  @ApiOkResponse({
    description: 'A page of events.',
    schema: {
      example: {
        data: [
          {
            id: 'clx1a2b3c0000abcd',
            name: 'mission.started',
            payload: { missionId: 'clx9z8y7x', title: 'Q3 competitive sweep' },
            actorId: 'clx0user0001',
            correlationId: '3f9a1c2e-55b1-4f2a-9a1e-77c0d2b8e410',
            createdAt: '2026-08-02T11:44:51.312Z',
          },
        ],
        meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrevious: false },
      },
    },
  })
  async list(@Query() query: QueryEventsDto) {
    const where = query.name ? { name: query.name } : {};
    const { rows, total } = await this.events.paginate(where, {
      skip: query.skip,
      take: query.limit,
      orderBy: { createdAt: 'desc' },
    });
    return paginate(rows, total, query.page, query.limit);
  }
}
