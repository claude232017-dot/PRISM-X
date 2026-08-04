import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  AlertSeverity,
  BackupKind,
  ComplianceReportKind,
  DeploymentEnvironment,
  RestoreMode,
  RotationScope,
} from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  CurrentUser,
  Public,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.service';
import { Permissions } from '../auth/permissions';
import { SchemaRepository } from '../database/repositories/production.repositories';
import { CacheService } from '../shared/cache/cache.service';
import { InstanceService } from './instance.service';
import { MetricsService } from './metrics.service';
import { AlertingService } from './alerting.service';
import { BackupService } from './backup.service';
import { BillingService } from './billing.service';
import { SecurityService } from './security.service';
import { AdminService } from './admin.service';
import { ReadinessService } from './readiness.service';
import { RateLimit } from './rate-limit.guard';

// ================================================================= DTOs

export class BackupDto {
  @ApiPropertyOptional({ enum: BackupKind, default: BackupKind.DATABASE })
  @IsOptional()
  @IsEnum(BackupKind)
  kind?: BackupKind;

  @ApiPropertyOptional({ default: 30, description: 'Days to keep this backup.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  encrypt?: boolean;
}

export class RestoreDto {
  @ApiPropertyOptional({ enum: RestoreMode, default: RestoreMode.VERIFY_ONLY })
  @IsOptional()
  @IsEnum(RestoreMode)
  mode?: RestoreMode;

  @ApiPropertyOptional({
    default: true,
    description: 'Validates everything and writes nothing. Defaults to true on purpose.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({ example: '2026-08-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  targetTime?: string;
}

export class PointInTimeDto {
  @ApiProperty({ example: '2026-08-01T00:00:00Z' })
  @IsISO8601()
  targetTime!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class SubscribeDto {
  @ApiProperty({ example: 'team' })
  @IsString()
  planKey!: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  seats?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  startTrial?: boolean;
}

export class SeatsDto {
  @ApiProperty({ example: 25 })
  @IsInt()
  @Min(1)
  @Max(100_000)
  seats!: number;
}

export class MfaCodeDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code!: string;
}

export class AllowIpDto {
  @ApiProperty({ example: '203.0.113.0/24' })
  @IsString()
  @Matches(/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/, {
    message: 'cidr must be an IPv4 address or CIDR block',
  })
  cidr!: string;

  @ApiPropertyOptional({ example: 'London office' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class RotateDto {
  @ApiProperty({ enum: RotationScope, example: RotationScope.CREDENTIAL_KEY })
  @IsEnum(RotationScope)
  scope!: RotationScope;

  @ApiPropertyOptional({ default: 24, description: 'Hours the old material keeps verifying.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720)
  overlapHours?: number;
}

export class AlertRuleDto {
  @ApiProperty({ example: 'api_error_rate' })
  @IsString()
  key!: string;

  @ApiPropertyOptional({ example: 'API error rate' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 0.05 })
  @IsOptional()
  threshold?: number;

  @ApiPropertyOptional({ enum: AlertSeverity })
  @IsOptional()
  @IsEnum(AlertSeverity)
  severity?: AlertSeverity;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 120 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400)
  forSeconds?: number;
}

export class ComplianceDto {
  @ApiProperty({ enum: ComplianceReportKind })
  @IsEnum(ComplianceReportKind)
  kind!: ComplianceReportKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  periodStart?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  periodEnd?: string;
}

export class ReleaseDto {
  @ApiProperty({ enum: DeploymentEnvironment })
  @IsEnum(DeploymentEnvironment)
  environment!: DeploymentEnvironment;

  @ApiProperty({ example: '1.4.2' })
  @IsString()
  version!: string;

  @ApiPropertyOptional({ example: 'a91f3c2' })
  @IsOptional()
  @IsString()
  commitSha?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  migrationsApplied?: number;
}

export class ReleaseOutcomeDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  succeeded!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  error?: string;
}

export class ReasonDto {
  @ApiProperty({ example: 'Error rate spiked after the deploy.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

// ================================================= Health probes

@ApiTags('Operations / Health')
@Controller('ops/health')
export class ProbeController {
  constructor(
    private readonly schema: SchemaRepository,
    private readonly cache: CacheService,
    private readonly instances: InstanceService,
  ) {}

  @Get('live')
  @Public()
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Answers whether the process is running. Deliberately checks nothing else: ' +
      'a liveness probe that fails on a database blip gets the orchestrator to ' +
      'restart a perfectly healthy instance, turning a dependency wobble into an outage.',
  })
  @ApiOkResponse({
    schema: { example: { status: 'alive', instanceId: 'host-1234-a91f', uptimeSeconds: 842 } },
  })
  live() {
    return {
      status: 'alive',
      instanceId: this.instances.instanceId,
      version: this.instances.version,
      environment: this.instances.environment,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  @Get('ready')
  @Public()
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Answers whether this instance should receive traffic. Checks the ' +
      'dependencies a request actually needs, and returns 503 when one is ' +
      'missing so the load balancer routes elsewhere instead of failing requests.',
  })
  @ApiOkResponse({ schema: { example: { status: 'ready', checks: { database: true, cache: true } } } })
  async ready() {
    const [database, cache] = await Promise.all([
      this.schema.healthy(),
      this.cache.ping().catch(() => false),
    ]);

    // The cache degrades gracefully everywhere it is used, so its absence does
    // not make an instance unready — only the database does.
    if (!database) {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        checks: { database, cache },
      });
    }
    return { status: 'ready', instanceId: this.instances.instanceId, checks: { database, cache } };
  }

  @Get('deep')
  @Public()
  @RateLimit(20, 60)
  @ApiOperation({
    summary: 'Deep health check',
    description:
      'Everything the readiness probe checks, plus the cluster view. Rate limited ' +
      'because it is more expensive than a probe should be and is meant for people, not orchestrators.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        status: 'ok',
        checks: { database: true, cache: true },
        cluster: { healthy: 2, leader: 'host-1234-a91f' },
      },
    },
  })
  async deep() {
    const [database, cache, cluster] = await Promise.all([
      this.schema.healthy(),
      this.cache.ping().catch(() => false),
      this.instances.cluster(),
    ]);
    return {
      status: database ? 'ok' : 'degraded',
      checks: { database, cache },
      cluster: {
        healthy: cluster.healthy,
        leader: cluster.leader,
        isLeader: cluster.isLeader,
        environment: cluster.environment,
        version: cluster.version,
      },
    };
  }
}

// ================================================= Observability

@ApiTags('Operations / Observability')
@ApiBearerAuth()
@Controller('ops')
export class ObservabilityController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly alerting: AlertingService,
    private readonly instances: InstanceService,
  ) {}

  @Get('metrics')
  @Public()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiProduces('text/plain')
  @ApiOperation({
    summary: 'Metrics in Prometheus exposition format',
    description:
      'Public because a scraper has no session. It exposes counts and timings, ' +
      'never tenant data — no label carries an organization, a user or a payload.',
  })
  @ApiOkResponse({
    schema: {
      type: 'string',
      example:
        '# TYPE prismx_http_requests_total counter\nprismx_http_requests_total{method="GET",route="/missions",status="2xx"} 41\n',
    },
  })
  prometheus(): string {
    // Sampled at scrape time rather than on a timer: a gauge is only worth
    // what it said when someone looked.
    const memory = process.memoryUsage();
    this.metrics.set(
      'prismx_process_memory_mb',
      Number((memory.rss / 1024 / 1024).toFixed(1)),
      { instance: this.instances.instanceId },
      'Resident memory for this process',
    );
    return this.metrics.prometheus();
  }

  @Get('metrics/json')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({ summary: 'Metrics as structured JSON, with percentiles' })
  @ApiOkResponse({
    schema: {
      example: {
        uptimeSeconds: 842,
        metrics: {
          prismx_http_request_duration_ms: { kind: 'histogram', count: 412, p50: 14, p95: 96, p99: 210 },
        },
      },
    },
  })
  snapshot() {
    return this.metrics.snapshot();
  }

  @Get('instances')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({
    summary: 'The cluster',
    description: 'Every instance, which one holds the scheduler lease, and what each is doing.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        self: 'host-1234-a91f',
        leader: 'host-1234-a91f',
        healthy: 2,
        instances: [
          { instanceId: 'host-1234-a91f', status: 'HEALTHY', isLeader: true, activeRequests: 3 },
        ],
      },
    },
  })
  cluster() {
    return this.instances.cluster();
  }

  @Get('alerts')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({ summary: 'Firing alerts and the rules behind them' })
  @ApiOkResponse({
    schema: {
      example: {
        summary: { rules: 8, firing: 1, worst: 'WARNING' },
        firing: [{ ruleKey: 'api_latency_p95', value: 2400, threshold: 2000 }],
      },
    },
  })
  async alerts() {
    const [summary, firing, rules] = await Promise.all([
      this.alerting.summary(),
      this.alerting.firing(),
      this.alerting.listRules(),
    ]);
    return { summary, firing, rules };
  }

  @Get('alerts/history')
  @RequirePermissions(Permissions.AnalyticsRead)
  @ApiOperation({ summary: 'Alert history' })
  @ApiOkResponse({
    schema: { example: [{ ruleKey: 'dead_letters', status: 'RESOLVED', firedAt: '2026-08-04T09:00:00Z' }] },
  })
  alertHistory() {
    return this.alerting.history();
  }

  @Post('alerts/rules')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @ApiOperation({ summary: 'Create or tune an alert rule' })
  @ApiCreatedResponse({ schema: { example: { key: 'api_error_rate', threshold: 0.02 } } })
  upsertRule(@Body() dto: AlertRuleDto) {
    const { key, ...rest } = dto;
    return this.alerting.upsertRule(key, rest);
  }

  @Post('alerts/evaluate')
  @RequirePermissions(Permissions.AnalyticsRead)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Evaluate every rule now',
    description: 'What the scheduler does on the lease holder; exposed so the behaviour is testable.',
  })
  @ApiOkResponse({ schema: { example: { evaluated: 8, fired: 0, resolved: 1 } } })
  evaluate() {
    return this.alerting.evaluateAll();
  }

  @Post('alerts/:id/acknowledge')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0alr1' })
  @ApiOperation({ summary: 'Acknowledge a firing alert' })
  @ApiOkResponse({ schema: { example: { id: 'clx0alr1', status: 'ACKNOWLEDGED' } } })
  acknowledge(@Param('id') id: string, @CurrentUser() user: AuthenticatedPrincipal) {
    return this.alerting.acknowledge(id, user.userId);
  }
}

// ================================================= Backup & recovery

@ApiTags('Operations / Recovery')
@ApiBearerAuth()
@Controller('ops/backups')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Get()
  @RequirePermissions(Permissions.OrganizationUpdate)
  @ApiOperation({ summary: 'Backup history' })
  @ApiOkResponse({
    schema: {
      example: [
        { id: 'clx0bak1', kind: 'DATABASE', status: 'VERIFIED', sizeBytes: 148_221, encrypted: true },
      ],
    },
  })
  list() {
    return this.backups.list();
  }

  @Get('posture')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @ApiOperation({
    summary: 'Recovery posture',
    description:
      'Backup age is the upper bound on how much work an incident can destroy — the ' +
      'only number in recovery planning that is not a guess.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        lastSucceededAt: '2026-08-04T09:00:00Z',
        ageHours: 0.4,
        count: 6,
        allEncrypted: true,
        restoreExercised: true,
        recoveryPointObjectiveHours: 0.4,
      },
    },
  })
  posture() {
    return this.backups.posture();
  }

  @Post()
  @RequirePermissions(Permissions.OrganizationUpdate)
  @RateLimit(10, 3600)
  @ApiOperation({
    summary: 'Take a backup',
    description: 'Encrypted with a fresh data key, checksummed over the plaintext.',
  })
  @ApiCreatedResponse({
    schema: {
      example: { id: 'clx0bak1', kind: 'DATABASE', status: 'SUCCEEDED', sizeBytes: 148_221, checksum: 'a91f…' },
    },
  })
  create(@Body() dto: BackupDto) {
    return this.backups.run(dto);
  }

  @Post(':id/verify')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0bak1' })
  @ApiOperation({
    summary: 'Verify a backup',
    description:
      'Decrypts, decompresses and re-hashes — the whole restore path, so that ' +
      'verification proves the data survived rather than that the file did.',
  })
  @ApiOkResponse({ schema: { example: { ok: true, detail: 'Checksum matched; 28 table(s) readable' } } })
  verify(@Param('id') id: string) {
    return this.backups.verify(id);
  }

  @Post(':id/restore')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0bak1' })
  @ApiOperation({
    summary: 'Restore from a backup',
    description:
      'Defaults to a dry run. A restore overwrites live data with older data at the ' +
      'exact moment nobody is thinking clearly, so destroying requires saying so.',
  })
  @ApiOkResponse({
    schema: {
      example: { id: 'clx0rst1', status: 'SUCCEEDED', dryRun: true, tablesRestored: 28, rowsRestored: 1_204 },
    },
  })
  restore(@Param('id') id: string, @Body() dto: RestoreDto) {
    return this.backups.restore({
      backupId: id,
      mode: dto.mode,
      dryRun: dto.dryRun,
      targetTime: dto.targetTime ? new Date(dto.targetTime) : undefined,
    });
  }

  @Post('point-in-time')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore to a moment in time',
    description:
      'Uses the newest backup at or before the target. This reconstructs to the ' +
      'nearest backup rather than to the exact second; true point-in-time recovery ' +
      'needs WAL archiving at the database, and the response says so.',
  })
  @ApiOkResponse({
    schema: { example: { id: 'clx0rst2', mode: 'POINT_IN_TIME', status: 'SUCCEEDED', dryRun: true } },
  })
  pointInTime(@Body() dto: PointInTimeDto) {
    return this.backups.pointInTime(new Date(dto.targetTime), dto.dryRun !== false);
  }

  @Get('restores')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @ApiOperation({ summary: 'Restore history' })
  @ApiOkResponse({
    schema: { example: [{ id: 'clx0rst1', mode: 'VERIFY_ONLY', status: 'SUCCEEDED', dryRun: true }] },
  })
  restores() {
    return this.backups.restores_();
  }
}

// ================================================= Billing

@ApiTags('Operations / Billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'Available plans' })
  @ApiOkResponse({
    schema: {
      example: [
        { key: 'team', name: 'Team', priceCents: 9900, seatsIncluded: 5, includedKTokens: 5000 },
      ],
    },
  })
  plans() {
    return this.billing.listPlans();
  }

  @Get()
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'Subscription, seats, usage and invoices' })
  @ApiOkResponse({
    schema: {
      example: {
        plan: { key: 'team', name: 'Team', status: 'TRIALING', licensed: true },
        seats: { purchased: 5, used: 2 },
        usage: { kTokens: 120, includedKTokens: 5000, overageKTokens: 0 },
      },
    },
  })
  overview() {
    return this.billing.overview();
  }

  @Get('entitlements')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({
    summary: 'What this organization may do',
    description:
      'An organization with no subscription is *unlicensed*, not restricted — billing ' +
      'is something an operator turns on, not something they must turn off.',
  })
  @ApiOkResponse({
    schema: {
      example: { planKey: 'team', features: ['missions', 'workflows'], limits: { workers: 25 }, licensed: true },
    },
  })
  entitlements() {
    return this.billing.entitlements();
  }

  @Post('subscribe')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start or change a subscription' })
  @ApiOkResponse({ schema: { example: { planKey: 'team', status: 'TRIALING', seats: 5 } } })
  subscribe(@Body() dto: SubscribeDto) {
    return this.billing.subscribe(dto);
  }

  @Post('seats')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change the seat count',
    description: 'Refuses to drop below the number of members, rather than silently overselling.',
  })
  @ApiOkResponse({ schema: { example: { seats: 25 } } })
  seats(@Body() dto: SeatsDto) {
    return this.billing.changeSeats(dto.seats);
  }

  @Post('cancel')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel',
    description: 'At the end of the paid period by default — a customer who has paid keeps the period.',
  })
  @ApiOkResponse({ schema: { example: { status: 'ACTIVE', cancelAtPeriodEnd: true } } })
  cancel() {
    return this.billing.cancel(false);
  }

  @Get('invoices')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'Invoice history' })
  @ApiOkResponse({
    schema: { example: [{ number: 'INV-00001', status: 'OPEN', totalCents: 9900 }] },
  })
  invoices() {
    return this.billing.invoiceHistory();
  }

  @Post('invoices')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @ApiOperation({
    summary: 'Issue an invoice for the current period',
    description: 'Every line carries the numbers it came from, so a customer can reconstruct the total.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        number: 'INV-00001',
        subtotalCents: 9900,
        usageCents: 0,
        totalCents: 9900,
        lines: [{ kind: 'plan', description: 'Team (monthly)', amountCents: 9900 }],
      },
    },
  })
  issue() {
    return this.billing.issueInvoice();
  }

  @Post('invoices/:id/paid')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0inv1' })
  @ApiOperation({ summary: 'Mark an invoice paid' })
  @ApiOkResponse({ schema: { example: { id: 'clx0inv1', status: 'PAID' } } })
  markPaid(@Param('id') id: string) {
    return this.billing.markPaid(id);
  }
}

// ================================================= Security

@ApiTags('Operations / Security')
@ApiBearerAuth()
@Controller('security')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @Get('posture')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'Security posture' })
  @ApiOkResponse({
    schema: {
      example: {
        administrators: 2,
        administratorsWithMfa: 2,
        mfaCoverage: 1,
        staleApiKeys: 0,
        activeSessions: 3,
      },
    },
  })
  posture() {
    return this.security.posture();
  }

  @Get('mfa')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'Second-factor status for the current user' })
  @ApiOkResponse({
    schema: { example: { enrolled: true, method: 'TOTP', recoveryCodesRemaining: 9 } },
  })
  mfaStatus(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.security.mfaStatus(user.userId);
  }

  @Post('mfa/enrol')
  @RequirePermissions(Permissions.OrganizationRead)
  @RateLimit(10, 3600)
  @ApiOperation({
    summary: 'Begin enrolment',
    description: 'Returns the shared secret once. The enrolment is inactive until a code confirms it.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUrl: 'otpauth://totp/PRISM-X:you@example.com?secret=…',
        digits: 6,
        period: 30,
      },
    },
  })
  enrol(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.security.beginMfaEnrolment(user.userId, user.email);
  }

  @Post('mfa/confirm')
  @RequirePermissions(Permissions.OrganizationRead)
  @RateLimit(10, 300)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm enrolment',
    description: 'Returns recovery codes exactly once. They are stored hashed and consumed on use.',
  })
  @ApiOkResponse({ schema: { example: { recoveryCodes: ['A1B2C-3D4E5', '…'] } } })
  confirm(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: MfaCodeDto) {
    return this.security.confirmMfaEnrolment(user.userId, dto.code);
  }

  @Post('mfa/verify')
  @RequirePermissions(Permissions.OrganizationRead)
  @RateLimit(10, 300)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a code', description: 'Accepts a recovery code, which is then consumed.' })
  @ApiOkResponse({ schema: { example: { ok: true, method: 'TOTP' } } })
  verify(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: MfaCodeDto) {
    return this.security.verifySecondFactor(user.userId, dto.code);
  }

  @Post('mfa/disable')
  @RequirePermissions(Permissions.OrganizationRead)
  @RateLimit(5, 3600)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Disable the second factor',
    description: 'Requires the factor itself — otherwise a stolen session removes the control it would meet.',
  })
  @ApiNoContentResponse({ description: 'Disabled.' })
  disable(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: MfaCodeDto) {
    return this.security.disableMfa(user.userId, dto.code);
  }

  @Get('sessions')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'Active sessions' })
  @ApiOkResponse({
    schema: { example: [{ id: 'clx0ses1', ip: '203.0.113.4', lastSeenAt: '2026-08-04T09:00:00Z' }] },
  })
  sessions(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.security.listSessions(user.userId);
  }

  @Delete('sessions/:id')
  @RequirePermissions(Permissions.OrganizationRead)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0ses1' })
  @ApiOperation({ summary: 'End one session' })
  @ApiOkResponse({ schema: { example: { revoked: true } } })
  revokeSession(@Param('id') id: string) {
    return this.security.revokeSession(id);
  }

  @Post('sessions/revoke-all')
  @RequirePermissions(Permissions.OrganizationRead)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End every session', description: 'What a compromised password requires.' })
  @ApiOkResponse({ schema: { example: { revoked: 4 } } })
  revokeAll(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.security.revokeAllSessions(user.userId);
  }

  @Get('ip-allowlist')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({
    summary: 'Network restrictions',
    description: 'An empty list means no restriction, not "deny everything".',
  })
  @ApiOkResponse({ schema: { example: [{ cidr: '203.0.113.0/24', label: 'London office' }] } })
  allowlist() {
    return this.security.listAllowEntries();
  }

  @Post('ip-allowlist')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @ApiOperation({ summary: 'Permit an address or block' })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0ip1', cidr: '203.0.113.0/24' } } })
  addAllow(@Body() dto: AllowIpDto) {
    return this.security.addAllowEntry(dto.cidr, dto.label);
  }

  @Delete('ip-allowlist/:id')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0ip1' })
  @ApiOperation({ summary: 'Remove a restriction' })
  @ApiNoContentResponse({ description: 'Removed.' })
  removeAllow(@Param('id') id: string) {
    return this.security.removeAllowEntry(id);
  }

  @Post('rotate')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @RateLimit(5, 3600)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate a class of secret',
    description:
      'Old material keeps verifying for the overlap window. A rotation that invalidates ' +
      'everything the instant it runs is one nobody performs twice.',
  })
  @ApiOkResponse({
    schema: { example: { scope: 'CREDENTIAL_KEY', status: 'OVERLAPPING', itemsRotated: 12 } },
  })
  rotate(@Body() dto: RotateDto) {
    return this.security.rotate(dto.scope, { overlapHours: dto.overlapHours });
  }

  @Get('rotations')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'Rotation history' })
  @ApiOkResponse({
    schema: { example: [{ scope: 'CREDENTIAL_KEY', status: 'OVERLAPPING', itemsRotated: 12 }] },
  })
  rotations() {
    return this.security.rotationHistory();
  }
}

// ================================================= Administration

@ApiTags('Operations / Administration')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'Administration overview' })
  @ApiOkResponse({
    schema: {
      example: {
        members: { total: 4, byRole: { OWNER: 1, OPERATOR: 3 }, seats: { purchased: 5, used: 4 } },
        extensions: { total: 3, enabled: 2, quarantined: 0 },
        platform: { environment: 'production', instances: 2, leader: 'host-1234-a91f' },
      },
    },
  })
  overview() {
    return this.admin.overview();
  }

  @Get('members')
  @RequirePermissions(Permissions.MemberRead)
  @ApiOperation({ summary: 'Members with roles and sign-in history' })
  @ApiOkResponse({
    schema: {
      example: [{ email: 'ada@example.com', role: 'OWNER', status: 'ACTIVE', lastLoginAt: null }],
    },
  })
  members() {
    return this.admin.members();
  }

  @Get('access')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'The role and permission model' })
  @ApiOkResponse({
    schema: {
      example: {
        permissionCount: 60,
        roles: [{ key: 'OWNER', permissions: ['*'], permissionCount: 60 }],
      },
    },
  })
  access() {
    return this.admin.accessModel();
  }

  @Get('compliance')
  @RequirePermissions(Permissions.AuditRead)
  @ApiQuery({ name: 'kind', enum: ComplianceReportKind, required: false })
  @ApiOperation({ summary: 'Generated compliance reports' })
  @ApiOkResponse({
    schema: { example: [{ id: 'clx0cmp1', kind: 'ACCESS_REVIEW', summary: { members: 4, privileged: 1 } }] },
  })
  reports(@Query('kind') kind?: ComplianceReportKind) {
    return this.admin.listReports(kind);
  }

  @Post('compliance')
  @RequirePermissions(Permissions.AuditRead)
  @ApiOperation({
    summary: 'Generate a compliance report',
    description:
      'Stored rather than streamed: an auditor asking what was reported in March needs ' +
      'March’s answer, not a re-derivation from today’s data.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0cmp1',
        kind: 'ACCESS_REVIEW',
        summary: { members: 4, privileged: 1, dormant: 2, activeKeys: 1 },
      },
    },
  })
  generate(@Body() dto: ComplianceDto) {
    return this.admin.generateReport({
      kind: dto.kind,
      periodStart: dto.periodStart ? new Date(dto.periodStart) : undefined,
      periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : undefined,
    });
  }

  @Get('compliance/:id')
  @RequirePermissions(Permissions.AuditRead)
  @ApiParam({ name: 'id', example: 'clx0cmp1' })
  @ApiOperation({ summary: 'One report, whole' })
  @ApiOkResponse({ schema: { example: { id: 'clx0cmp1', kind: 'ACCESS_REVIEW', findings: {} } } })
  report(@Param('id') id: string) {
    return this.admin.getReport(id);
  }

  @Get('releases')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiQuery({ name: 'environment', enum: DeploymentEnvironment, required: false })
  @ApiOperation({ summary: 'Deployment history' })
  @ApiOkResponse({
    schema: {
      example: [{ environment: 'PRODUCTION', version: '1.4.2', status: 'SUCCEEDED', previousVersion: '1.4.1' }],
    },
  })
  releases(@Query('environment') environment?: DeploymentEnvironment) {
    return this.admin.releaseHistory(environment);
  }

  @Post('releases')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @ApiOperation({
    summary: 'Record a deployment',
    description: 'Called by the pipeline. Recording is separate from deploying so the record survives a failure.',
  })
  @ApiCreatedResponse({
    schema: { example: { id: 'clx0rel1', version: '1.4.2', status: 'RUNNING', previousVersion: '1.4.1' } },
  })
  recordRelease(@Body() dto: ReleaseDto) {
    return this.admin.recordRelease(dto);
  }

  @Post('releases/:id/complete')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0rel1' })
  @ApiOperation({ summary: 'Close out a deployment' })
  @ApiOkResponse({ schema: { example: { id: 'clx0rel1', status: 'SUCCEEDED', durationMs: 41_200 } } })
  completeRelease(@Param('id') id: string, @Body() dto: ReleaseOutcomeDto) {
    return this.admin.completeRelease(id, dto);
  }

  @Post('releases/:id/rollback')
  @RequirePermissions(Permissions.OrganizationUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0rel1' })
  @ApiOperation({
    summary: 'Roll back a deployment',
    description:
      'Recorded as a new release pointing at what it undid. Production did run that ' +
      'version, and rewriting the original to say otherwise loses that fact.',
  })
  @ApiOkResponse({
    schema: { example: { version: '1.4.1', previousVersion: '1.4.2', status: 'SUCCEEDED' } },
  })
  rollback(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.admin.rollback(id, dto.reason);
  }
}

// ================================================= Readiness

@ApiTags('Operations / Readiness')
@ApiBearerAuth()
@Controller('ops/readiness')
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({
    summary: 'Run the production readiness review',
    description:
      'Every check is a predicate over gathered evidence — the database, the cache, the ' +
      'metrics registry, the backup history, the filesystem. Nobody can mark it green by ' +
      'editing a document. A failing BLOCKER makes `readyForProduction` false whatever else passes.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        environment: 'production',
        readyForProduction: false,
        score: 0.87,
        summary: { PASS: 20, WARN: 2, FAIL: 1, UNKNOWN: 3 },
        blockers: [
          { id: 'RECENT_BACKUP', severity: 'BLOCKER', outcome: 'FAIL', detail: 'No backup has ever succeeded' },
        ],
      },
    },
  })
  review() {
    return this.readiness.review({ record: true });
  }

  @Get('preview')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'Run the review without recording it' })
  @ApiOkResponse({ schema: { example: { readyForProduction: true, score: 0.95 } } })
  preview() {
    return this.readiness.review({ record: false });
  }

  @Get('checks')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'The bar itself, without evaluating it' })
  @ApiOkResponse({
    schema: {
      example: {
        version: 'c2f0a91b7e0d5138',
        checks: [
          {
            id: 'STATELESS_INSTANCES',
            dimension: 'SCALABILITY',
            severity: 'BLOCKER',
            statement: 'Backend instances hold no request-scoped state in process memory.',
          },
        ],
      },
    },
  })
  checks() {
    return this.readiness.checks();
  }

  @Get('evidence')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({
    summary: 'The evidence the review reads',
    description: 'Exposed so a failing check can be argued with rather than merely believed.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        environment: 'development',
        database: { reachable: true, rlsTables: 82, tenantTables: 74, pendingMigrations: 0 },
        instances: { healthy: 1, leader: 'host-1234-a91f', stateless: true },
      },
    },
  })
  evidence() {
    return this.readiness.gather();
  }

  @Get('history')
  @RequirePermissions(Permissions.OrganizationRead)
  @ApiOperation({ summary: 'Recorded reviews' })
  @ApiOkResponse({
    schema: { example: [{ environment: 'PRODUCTION', ready: true, score: 0.96, blockers: 0 }] },
  })
  history() {
    return this.readiness.history();
  }
}
