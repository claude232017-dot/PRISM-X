import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { CacheService } from '../shared/cache/cache.service';
import { EventBusService } from '../events/event-bus.service';
import { Public } from '../auth/decorators/permissions.decorator';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly events: EventBusService,
  ) {}

  async check() {
    const [database, redis] = await Promise.all([
      this.prisma.isHealthy(),
      this.cache.ping(),
    ]);

    return {
      // Redis degrades gracefully, so its absence is "degraded", not "down".
      status: database ? (redis ? 'ok' : 'degraded') : 'down',
      checks: {
        database: database ? 'up' : 'down',
        cache: redis ? 'up' : 'down',
        eventBus: { subscribers: this.events.subscriberCount() },
      },
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Liveness and dependency check',
    description:
      'Reports database and cache reachability. `degraded` means the API is serving ' +
      'requests but the cache is unavailable — the system runs without it, more slowly.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        status: 'ok',
        checks: { database: 'up', cache: 'up', eventBus: { subscribers: 6 } },
        uptimeSeconds: 1284,
        timestamp: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  @ApiServiceUnavailableResponse({ description: 'The database is unreachable.' })
  check() {
    return this.health.check();
  }
}

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
