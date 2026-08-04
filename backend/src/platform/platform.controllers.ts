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
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  AdvisorySeverity,
  ContributionKind,
  GovernanceReviewStatus,
  ListingStatus,
  MarketplaceAssetKind,
  PublisherTrust,
} from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';
import { ExtensionRuntimeService } from './extension-runtime.service';
import { ContributionService } from './contribution.service';
import { MarketplaceService } from './marketplace.service';
import { GovernanceService } from './governance.service';
import { DeveloperPortalService } from './developer-portal.service';
import {
  CAPABILITY_CATALOGUE_VERSION,
  REVIEW_THRESHOLD,
  catalogue,
  guardedSurface,
} from './capabilities';
import { PLATFORM_API_VERSION, validate } from './manifest';
import {
  ExtensionHostCallRepository,
  ExtensionLifecycleRepository,
} from '../database/repositories/platform.repositories';

// ================================================================= DTOs

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class InstallFromManifestDto {
  @ApiProperty({
    description: 'The extension manifest. Validated before anything is written.',
    example: {
      slug: 'daily-digest',
      name: 'Daily Digest',
      version: '1.0.0',
      capabilities: ['can_read_missions', 'can_persist_state'],
    },
  })
  @IsObject()
  manifest!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Settings the manifest declares.', example: { channel: '#ops' } })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Run the whole install path without persisting anything.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class ValidateManifestDto {
  @ApiProperty({ description: 'Manifest to check.' })
  @IsObject()
  manifest!: Record<string, unknown>;
}

export class UpgradeDto {
  @ApiProperty({ description: 'The candidate manifest.' })
  @IsObject()
  manifest!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Consent to a breaking change up front, skipping the confirmation step.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  consent?: boolean;
}

export class RejectDto {
  @ApiProperty({ example: 'Requests worker deletion, which we do not grant to extensions.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class RegisterPublisherDto {
  @ApiProperty({ example: 'prism-labs' })
  @Matches(SLUG, { message: 'slug must be lower-case words separated by single hyphens' })
  slug!: string;

  @ApiProperty({ example: 'Prism Labs' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName!: string;

  @ApiPropertyOptional({ example: 'dev@prismlabs.example' })
  @IsOptional()
  @IsString()
  contactEmail?: string;

  @ApiPropertyOptional({ example: 'https://prismlabs.example' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  website?: string;
}

export class CreateListingDto {
  @ApiProperty({ enum: MarketplaceAssetKind, example: MarketplaceAssetKind.EXTENSION })
  @IsEnum(MarketplaceAssetKind)
  assetKind!: MarketplaceAssetKind;

  @ApiProperty({ example: 'daily-digest' })
  @Matches(SLUG)
  slug!: string;

  @ApiProperty({ example: 'Daily Digest' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'A short summary of yesterday, where your team reads.' })
  @IsString()
  @MinLength(10)
  @MaxLength(300)
  summary!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'Publisher this listing belongs to.' })
  @IsString()
  publisherId!: string;

  @ApiPropertyOptional({ example: 'MIT' })
  @IsOptional()
  @IsString()
  license?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  homepage?: string;

  @ApiPropertyOptional({ description: 'Long-form documentation, markdown.' })
  @IsOptional()
  @IsString()
  documentation?: string;

  @ApiPropertyOptional({ type: [String], example: ['reporting', 'slack'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class PublishVersionDto {
  @ApiProperty({ description: 'The manifest for this release.' })
  @IsObject()
  manifest!: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'Adds cost figures to the digest.' })
  @IsOptional()
  @IsString()
  changelog?: string;

  @ApiPropertyOptional({
    description:
      'The publisher’s Ed25519 private key, in PKCS8 PEM. Used to sign and then discarded — it is never stored.',
  })
  @IsOptional()
  @IsString()
  signingKey?: string;
}

export class InstallListingDto {
  @ApiPropertyOptional({ description: 'Defaults to the listing’s latest version.', example: '1.2.0' })
  @IsOptional()
  @IsString()
  version?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class RateListingDto {
  @ApiProperty({ minimum: 1, maximum: 5, example: 4 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;
}

export class DecideReviewDto {
  @ApiProperty({ enum: GovernanceReviewStatus, example: GovernanceReviewStatus.APPROVED })
  @IsEnum(GovernanceReviewStatus)
  status!: GovernanceReviewStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ReasonDto {
  @ApiProperty({ example: 'Exfiltrates knowledge to an undisclosed endpoint.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class TrustDto {
  @ApiProperty({ enum: PublisherTrust, example: PublisherTrust.VERIFIED })
  @IsEnum(PublisherTrust)
  trust!: PublisherTrust;
}

export class AdvisoryDto {
  @ApiProperty({ example: 'daily-digest' })
  @IsString()
  affectedSlug!: string;

  @ApiProperty({ enum: AdvisorySeverity, example: AdvisorySeverity.HIGH })
  @IsEnum(AdvisorySeverity)
  severity!: AdvisorySeverity;

  @ApiProperty({ example: 'Digest leaks mission titles to a third party' })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ example: 'Versions 1.0.0 through 1.1.3 send mission titles to an undisclosed endpoint.' })
  @IsString()
  summary!: string;

  @ApiProperty({ description: 'Semver range of affected versions.', example: '>=1.0.0 <1.2.0' })
  @IsString()
  affectedRange!: string;

  @ApiPropertyOptional({ example: '1.2.0' })
  @IsOptional()
  @IsString()
  patchedVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  listingId?: string;
}

export class CompatibilityDto {
  @ApiProperty()
  @IsString()
  listingId!: string;

  @ApiProperty({ example: '1.2.0' })
  @IsString()
  version!: string;

  @ApiPropertyOptional({
    description: 'Platform API version to test against. Defaults to the current one.',
    example: '2.0.0',
  })
  @IsOptional()
  @IsString()
  apiVersion?: string;
}

export class CreateDeveloperAppDto {
  @ApiProperty({ example: 'Ops Console' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'ops-console' })
  @Matches(SLUG)
  slug!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  homepage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  publisherId?: string;

  @ApiPropertyOptional({ example: 'https://ops.example/prismx/hooks' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  webhookUrl?: string;
}

export class IssueKeyDto {
  @ApiProperty({ example: 'production' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ type: [String], example: ['missions:read'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional({ example: 240 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  rateLimitPerMinute?: number;

  @ApiPropertyOptional({ example: 90 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;
}

// ================================================= Capabilities

@ApiTags('Platform / Capabilities')
@ApiBearerAuth()
@Controller('platform/capabilities')
export class CapabilityController {
  @Get()
  @RequirePermissions(Permissions.ExtensionRead)
  @ApiOperation({
    summary: 'The capability catalogue',
    description:
      'Every capability the platform grants, what it means, what it implies and which host ' +
      'methods it unlocks. This is the same frozen catalogue the sandbox enforces — the ' +
      'documentation cannot drift from the runtime because it is the runtime.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        version: '3f2a91c4b7e05d18',
        reviewThreshold: 'HIGH',
        capabilities: [
          {
            id: 'can_access_knowledge',
            title: 'Read knowledge',
            description: 'Search and read everything in your knowledge base.',
            risk: 'MEDIUM',
            reviewRequired: false,
            implies: ['knowledge:read'],
            surface: ['knowledge.search', 'knowledge.get'],
          },
        ],
        guardedMethods: ['analytics.summary', 'credentials.list'],
      },
    },
  })
  list() {
    return {
      version: CAPABILITY_CATALOGUE_VERSION,
      apiVersion: PLATFORM_API_VERSION,
      reviewThreshold: REVIEW_THRESHOLD,
      capabilities: catalogue(),
      guardedMethods: guardedSurface(),
    };
  }
}

// ================================================= Extensions

@ApiTags('Platform / Extensions')
@ApiBearerAuth()
@Controller('platform/extensions')
export class PlatformExtensionController {
  constructor(
    private readonly runtime: ExtensionRuntimeService,
    private readonly contributions: ContributionService,
    private readonly lifecycle: ExtensionLifecycleRepository,
    private readonly hostCalls: ExtensionHostCallRepository,
  ) {}

  // Declared before `:id` routes: Nest matches in declaration order, so a
  // literal path below a wildcard would be swallowed by it.
  @Post('validate')
  @RequirePermissions(Permissions.ExtensionRead)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validate a manifest',
    description: 'Checks a manifest and reports its errors, warnings and risk. Writes nothing.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        ok: true,
        risk: 'MEDIUM',
        digest: 'a91f…',
        errors: [],
        warnings: [{ field: 'engine', message: 'No engine range declared' }],
      },
    },
  })
  validateManifest(@Body() dto: ValidateManifestDto) {
    const result = validate(dto.manifest);
    return {
      ok: result.ok,
      risk: result.risk,
      digest: result.digest,
      errors: result.errors,
      warnings: result.warnings,
      manifest: result.manifest,
    };
  }

  @Post()
  @RequirePermissions(Permissions.ExtensionInstall)
  @ApiOperation({
    summary: 'Install an extension from a manifest',
    description:
      'Validates, grants capabilities, registers contributions and initializes. The grant is ' +
      'the intersection of what the manifest requests and what you personally hold — anything ' +
      'you cannot do yourself is withheld and reported rather than granted.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        extension: { id: 'clx0ext1', slug: 'daily-digest', version: '1.0.0', status: 'INSTALLED' },
        grant: {
          granted: ['can_read_missions', 'can_persist_state'],
          withheld: [{ capability: 'can_manage_workers', missing: ['worker:delete'] }],
          risk: 'LOW',
          reviewRequired: false,
        },
        contributions: { registered: 1, skipped: [] },
        consentRequired: false,
      },
    },
  })
  install(@Body() dto: InstallFromManifestDto) {
    return this.runtime.install(dto);
  }

  @Get()
  @RequirePermissions(Permissions.ExtensionRead)
  @ApiOperation({ summary: 'Extensions with their grants' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0ext1',
          slug: 'daily-digest',
          version: '1.0.0',
          status: 'ENABLED',
          riskLevel: 'LOW',
          capabilities: ['can_read_missions'],
        },
      ],
    },
  })
  findAll() {
    return this.runtime.list();
  }

  @Get(':id')
  @RequirePermissions(Permissions.ExtensionRead)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({ summary: 'One extension, with contributions and grant' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0ext1',
        slug: 'daily-digest',
        status: 'ENABLED',
        grant: { granted: [], withheld: [] },
        contributions: { workers: 0, tools: 1, triggers: 0, invocations: 12, failures: 0 },
      },
    },
  })
  findOne(@Param('id') id: string) {
    return this.runtime.describe(id);
  }

  @Get(':id/grant')
  @RequirePermissions(Permissions.ExtensionRead)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({
    summary: 'The consent screen',
    description:
      'What this extension may do, in plain sentences, plus what was withheld and why. ' +
      '`catalogueCurrent` is false when the capability catalogue has changed since the grant ' +
      'was issued, which means the meaning of a granted capability may have moved.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        risk: 'MEDIUM',
        granted: [
          {
            id: 'can_access_knowledge',
            title: 'Read knowledge',
            description: 'Search and read everything in your knowledge base.',
            risk: 'MEDIUM',
          },
        ],
        withheld: [{ capability: 'can_manage_workers', missing: ['worker:delete'] }],
        permissions: ['knowledge:read'],
        catalogueCurrent: true,
      },
    },
  })
  grant(@Param('id') id: string) {
    return this.runtime.describeGrant(id);
  }

  @Get(':id/history')
  @RequirePermissions(Permissions.ExtensionRead)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({
    summary: 'Lifecycle history',
    description: 'Every transition attempted on this extension, and how each one ended.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        { phase: 'INITIALIZE', outcome: 'SUCCEEDED', durationMs: 14, createdAt: '2026-08-04T09:12:00Z' },
        { phase: 'INSTALL', outcome: 'SUCCEEDED', version: '1.0.0', createdAt: '2026-08-04T09:11:58Z' },
      ],
    },
  })
  history(@Param('id') id: string) {
    return this.lifecycle.history(id);
  }

  @Get(':id/calls')
  @RequirePermissions(Permissions.ExtensionRead)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({
    summary: 'Debug console — every host call',
    description:
      'What the extension asked the platform to do, and what the sandbox decided. Denials are ' +
      'kept: an extension repeatedly reaching for a capability it lacks is the signal that it ' +
      'is doing something other than what its listing said.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        { method: 'knowledge.search', capability: 'can_access_knowledge', decision: 'ALLOWED', durationMs: 6 },
        {
          method: 'workers.delete',
          capability: 'can_manage_workers',
          decision: 'DENIED',
          reason: '"workers.delete" requires the "can_manage_workers" capability, which this extension was not granted',
        },
      ],
    },
  })
  calls(@Param('id') id: string) {
    return this.hostCalls.recent(id);
  }

  @Get(':id/contributions')
  @RequirePermissions(Permissions.ExtensionRead)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({ summary: 'Workers, tools and triggers this extension contributed' })
  @ApiOkResponse({
    schema: {
      example: [
        { kind: 'TOOL', key: 'daily-digest.summarise', name: 'Summarise missions', enabled: true, invocations: 12 },
      ],
    },
  })
  contributionsOf(@Param('id') id: string) {
    return this.contributions.byExtension(id);
  }

  @Post(':id/approve')
  @RequirePermissions(Permissions.ExtensionInstall)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({
    summary: 'Approve a pending capability grant',
    description: 'Extensions requesting HIGH or CRITICAL capabilities stay inert until approved.',
  })
  @ApiOkResponse({ schema: { example: { id: 'clx0ext1', status: 'INSTALLED' } } })
  approve(@Param('id') id: string) {
    return this.runtime.approveCapabilities(id);
  }

  @Post(':id/reject')
  @RequirePermissions(Permissions.ExtensionInstall)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({
    summary: 'Refuse a pending grant',
    description: 'Records the refusal and removes the extension rather than leaving it half-installed.',
  })
  @ApiNoContentResponse({ description: 'Refused and removed.' })
  reject(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.runtime.rejectCapabilities(id, dto.reason);
  }

  @Post(':id/enable')
  @RequirePermissions(Permissions.ExtensionUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({ summary: 'Enable an extension' })
  @ApiOkResponse({ schema: { example: { id: 'clx0ext1', status: 'ENABLED' } } })
  enable(@Param('id') id: string) {
    return this.runtime.enable(id);
  }

  @Post(':id/disable')
  @RequirePermissions(Permissions.ExtensionUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({ summary: 'Disable an extension' })
  @ApiOkResponse({ schema: { example: { id: 'clx0ext1', status: 'DISABLED' } } })
  disable(@Param('id') id: string) {
    return this.runtime.disable(id);
  }

  @Post(':id/upgrade/analyse')
  @RequirePermissions(Permissions.ExtensionRead)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({
    summary: 'Analyse an upgrade without applying it',
    description:
      'Compares the installed manifest with a candidate and reports every change. BLOCKING ' +
      'means the upgrade is impossible; BREAKING means it changes the deal you agreed to and ' +
      'needs consent. Nothing is written.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        analysis: {
          from: '1.0.0',
          to: '2.0.0',
          release: 'MAJOR',
          blocked: false,
          breaking: true,
          addedCapabilities: ['can_invoke_external_apis'],
          changes: [
            {
              severity: 'BREAKING',
              code: 'capability_added',
              message: 'Now asks for "can_invoke_external_apis" — Make network requests to services outside PRISM-X.',
            },
          ],
          migrations: [{ to: '2.0.0', description: 'Moves stored settings into config.' }],
        },
      },
    },
  })
  analyse(@Param('id') id: string, @Body() dto: ValidateManifestDto) {
    return this.runtime.analyse(id, dto.manifest);
  }

  @Post(':id/upgrade')
  @RequirePermissions(Permissions.ExtensionUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({
    summary: 'Upgrade an extension',
    description:
      'Applies immediately when nothing about the deal changed. A breaking upgrade is recorded ' +
      'and waits for consent unless `consent` is set.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        applied: false,
        analysis: { from: '1.0.0', to: '2.0.0', breaking: true },
        upgrade: { id: 'clx0upg1', outcome: 'AWAITING_CONSENT' },
      },
    },
  })
  upgrade(@Param('id') id: string, @Body() dto: UpgradeDto) {
    return this.runtime.proposeUpgrade(id, dto.manifest, { consent: dto.consent });
  }

  @Get(':id/upgrades')
  @RequirePermissions(Permissions.ExtensionRead)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({ summary: 'Version history for an extension' })
  @ApiOkResponse({
    schema: {
      example: [
        { fromVersion: '1.0.0', toVersion: '2.0.0', outcome: 'APPLIED', breaking: true, appliedAt: '2026-08-04T10:00:00Z' },
      ],
    },
  })
  upgradeHistory(@Param('id') id: string) {
    return this.runtime.upgradeHistory(id);
  }

  @Post(':id/rollback')
  @RequirePermissions(Permissions.ExtensionUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({
    summary: 'Roll back the last applied upgrade',
    description:
      'Restores the manifest, grant, limits and configuration captured before the upgrade — a ' +
      'restore rather than a reinstall.',
  })
  @ApiOkResponse({ schema: { example: { id: 'clx0ext1', version: '1.0.0' } } })
  rollback(@Param('id') id: string) {
    return this.runtime.rollback(id);
  }

  @Delete(':id')
  @RequirePermissions(Permissions.ExtensionDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0ext1' })
  @ApiOperation({
    summary: 'Uninstall',
    description:
      'Deactivates, removes contributions and the extension’s private keyspace, then removes ' +
      'the extension itself.',
  })
  @ApiNoContentResponse({ description: 'Uninstalled.' })
  uninstall(@Param('id') id: string) {
    return this.runtime.uninstall(id);
  }
}

// ================================================= Upgrades (consent)

@ApiTags('Platform / Extensions')
@ApiBearerAuth()
@Controller('platform/upgrades')
export class UpgradeController {
  constructor(private readonly runtime: ExtensionRuntimeService) {}

  @Post(':id/consent')
  @RequirePermissions(Permissions.ExtensionUpdate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0upg1' })
  @ApiOperation({
    summary: 'Consent to a breaking upgrade',
    description: 'Applies the version that was analysed and shown, not a freshly fetched one.',
  })
  @ApiOkResponse({ schema: { example: { id: 'clx0ext1', version: '2.0.0', status: 'INSTALLED' } } })
  consent(@Param('id') id: string) {
    return this.runtime.consentToUpgrade(id);
  }
}

// ================================================= Contributions

@ApiTags('Platform / Contributions')
@ApiBearerAuth()
@Controller('platform/contributions')
export class ContributionController {
  constructor(private readonly contributions: ContributionService) {}

  @Get()
  @RequirePermissions(Permissions.ExtensionRead)
  @ApiQuery({ name: 'kind', enum: ContributionKind, required: false })
  @ApiOperation({
    summary: 'Everything extensions have contributed',
    description:
      'Contributed workers, tools and triggers. Nothing here distinguishes a contributed ' +
      'worker from a native one downstream — the platform asks what a component may do, not ' +
      'what kind of thing it is.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          kind: 'TOOL',
          key: 'daily-digest.summarise',
          name: 'Summarise missions',
          capabilities: ['can_read_missions'],
          enabled: true,
          invocations: 12,
          failures: 0,
        },
      ],
    },
  })
  list(@Query('kind') kind?: ContributionKind) {
    return this.contributions.list(kind);
  }
}

// ================================================= Marketplace

@ApiTags('Platform / Marketplace')
@ApiBearerAuth()
@Controller('platform/marketplace')
export class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Get('overview')
  @RequirePermissions(Permissions.MarketplaceRead)
  @ApiOperation({ summary: 'Marketplace at a glance' })
  @ApiOkResponse({
    schema: {
      example: {
        listings: 42,
        assetKinds: 10,
        byKind: { EXTENSION: 18, WORKER: 9, TOOL: 15 },
        publishers: 7,
        verifiedPublishers: 3,
        installs: 260,
        topRated: [{ slug: 'daily-digest', name: 'Daily Digest', rating: 4.6, ratings: 18 }],
      },
    },
  })
  overview() {
    return this.marketplace.overview();
  }

  @Get('publishers')
  @RequirePermissions(Permissions.MarketplaceRead)
  @ApiOperation({ summary: 'Publishers' })
  @ApiOkResponse({
    schema: {
      example: [{ id: 'clx0pub1', slug: 'prism-labs', displayName: 'Prism Labs', trust: 'VERIFIED', listingCount: 4 }],
    },
  })
  publishers() {
    return this.marketplace.listPublishers();
  }

  @Post('publishers')
  @RequirePermissions(Permissions.MarketplacePublish)
  @ApiOperation({
    summary: 'Register a publisher',
    description:
      'Generates an Ed25519 key pair. The private key is returned once and never stored — the ' +
      'platform keeps only the public half, so it can verify a release but never produce one.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        publisher: { id: 'clx0pub1', slug: 'prism-labs', trust: 'UNVERIFIED' },
        signingKey: '-----BEGIN PRIVATE KEY-----\n… shown once …\n-----END PRIVATE KEY-----\n',
      },
    },
  })
  registerPublisher(@Body() dto: RegisterPublisherDto) {
    return this.marketplace.registerPublisher(dto);
  }

  @Get('listings')
  @RequirePermissions(Permissions.MarketplaceRead)
  @ApiQuery({ name: 'assetKind', enum: MarketplaceAssetKind, required: false })
  @ApiQuery({ name: 'status', enum: ListingStatus, required: false })
  @ApiQuery({ name: 'q', required: false, description: 'Free-text over name, summary and slug.' })
  @ApiQuery({ name: 'tag', required: false })
  @ApiQuery({ name: 'capability', required: false, description: 'Only assets requesting this capability.' })
  @ApiOperation({ summary: 'Browse the catalogue' })
  @ApiOkResponse({
    schema: {
      example: {
        rows: [
          {
            slug: 'daily-digest',
            name: 'Daily Digest',
            assetKind: 'EXTENSION',
            latestVersion: '1.2.0',
            riskLevel: 'LOW',
            installCount: 31,
          },
        ],
        total: 1,
      },
    },
  })
  search(
    @Query('assetKind') assetKind?: MarketplaceAssetKind,
    @Query('status') status?: ListingStatus,
    @Query('q') q?: string,
    @Query('tag') tag?: string,
    @Query('capability') capability?: string,
  ) {
    return this.marketplace.search({ assetKind, status, query: q, tag, capability });
  }

  @Post('listings')
  @RequirePermissions(Permissions.MarketplacePublish)
  @ApiOperation({ summary: 'Create a listing' })
  @ApiCreatedResponse({
    schema: { example: { id: 'clx0lst1', slug: 'daily-digest', assetKind: 'EXTENSION', status: 'DRAFT' } },
  })
  createListing(@Body() dto: CreateListingDto) {
    return this.marketplace.createListing(dto);
  }

  @Get('listings/:id')
  @RequirePermissions(Permissions.MarketplaceRead)
  @ApiParam({ name: 'id', example: 'clx0lst1' })
  @ApiOperation({ summary: 'A listing with its versions, advisories and rating' })
  @ApiOkResponse({
    schema: {
      example: {
        slug: 'daily-digest',
        latestVersion: '1.2.0',
        rating: 4.6,
        publisher: { slug: 'prism-labs', trust: 'VERIFIED' },
        versions: [{ version: '1.2.0', breaking: false, signed: true, reviewStatus: 'APPROVED' }],
        advisories: [],
      },
    },
  })
  getListing(@Param('id') id: string) {
    return this.marketplace.getListing(id);
  }

  @Patch('listings/:id')
  @RequirePermissions(Permissions.MarketplacePublish)
  @ApiParam({ name: 'id', example: 'clx0lst1' })
  @ApiOperation({ summary: 'Edit a listing', description: 'Slug, kind and status are not editable here.' })
  @ApiOkResponse({ schema: { example: { id: 'clx0lst1', summary: 'A shorter summary.' } } })
  updateListing(@Param('id') id: string, @Body() patch: Record<string, unknown>) {
    return this.marketplace.updateListing(id, patch);
  }

  @Post('listings/:id/versions')
  @RequirePermissions(Permissions.MarketplacePublish)
  @ApiParam({ name: 'id', example: 'clx0lst1' })
  @ApiOperation({
    summary: 'Publish a version',
    description:
      'Versions are immutable. Breaking changes are computed by diffing against the previous ' +
      'release rather than taken from the version number. Anything requesting a HIGH or ' +
      'CRITICAL capability opens a governance review before it becomes installable.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        version: { version: '1.2.0', digest: 'a91f…', signed: true, reviewStatus: 'APPROVED' },
        breaking: false,
        reviewOpened: false,
      },
    },
  })
  publishVersion(@Param('id') id: string, @Body() dto: PublishVersionDto) {
    return this.marketplace.publishVersion({ listingId: id, ...dto });
  }

  @Post('listings/:id/install')
  @RequirePermissions(Permissions.ExtensionInstall)
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({ name: 'id', example: 'clx0lst1' })
  @ApiOperation({
    summary: 'Install from the marketplace',
    description:
      'Checks the listing’s status, the publisher’s standing, the version’s review state, ' +
      'whether it was yanked, whether a live advisory covers it and whether its signature still ' +
      'verifies — before the manifest reaches the lifecycle.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        extension: { id: 'clx0ext1', slug: 'daily-digest', status: 'INSTALLED' },
        grant: { granted: ['can_read_missions'], withheld: [] },
        version: '1.2.0',
      },
    },
  })
  install(@Param('id') id: string, @Body() dto: InstallListingDto) {
    return this.marketplace.install({ listingId: id, ...dto });
  }

  @Get('listings/:id/upgrades')
  @RequirePermissions(Permissions.MarketplaceRead)
  @ApiParam({ name: 'id', example: 'clx0lst1' })
  @ApiQuery({ name: 'from', required: true, example: '1.0.0' })
  @ApiOperation({ summary: 'Versions newer than the one installed' })
  @ApiOkResponse({
    schema: { example: [{ version: '1.2.0', breaking: false, changelog: 'Adds cost figures.' }] },
  })
  upgrades(@Param('id') id: string, @Query('from') from: string) {
    return this.marketplace.availableUpgrades(id, from);
  }

  @Post('listings/:id/rate')
  @RequirePermissions(Permissions.MarketplaceRead)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0lst1' })
  @ApiOperation({
    summary: 'Rate a listing',
    description: 'One rating per organization. Rating again replaces the previous one.',
  })
  @ApiOkResponse({ schema: { example: { rating: 4, title: 'Solid', version: '1.2.0' } } })
  rate(@Param('id') id: string, @Body() dto: RateListingDto) {
    return this.marketplace.rate({ listingId: id, ...dto });
  }
}

// ================================================= Governance

@ApiTags('Platform / Governance')
@ApiBearerAuth()
@Controller('platform/governance')
export class GovernanceController {
  constructor(private readonly governance: GovernanceService) {}

  @Get('overview')
  @RequirePermissions(Permissions.MarketplaceRead)
  @ApiOperation({ summary: 'Ecosystem standing' })
  @ApiOkResponse({
    schema: {
      example: {
        pendingReviews: 3,
        pendingByRisk: { CRITICAL: 1, HIGH: 2 },
        publishers: { total: 7, verified: 3, suspended: 0 },
        listings: { total: 42, published: 40, suspended: 1, deprecated: 1 },
        advisories: { total: 2, bySeverity: { HIGH: 1, MODERATE: 1 } },
      },
    },
  })
  overview() {
    return this.governance.overview();
  }

  @Get('audit')
  @RequirePermissions(Permissions.MarketplaceModerate)
  @ApiOperation({
    summary: 'Platform audit log',
    description:
      'Assembled from the decision rows themselves rather than a parallel log table — a log ' +
      'that can disagree with the decisions it describes is worse than no log.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          at: '2026-08-04T10:00:00Z',
          action: 'review_approved',
          subject: 'LISTING_VERSION',
          subjectLabel: 'daily-digest@1.2.0',
          risk: 'HIGH',
          reviewerId: 'clx0usr1',
        },
      ],
    },
  })
  audit() {
    return this.governance.auditLog();
  }

  @Get('reviews')
  @RequirePermissions(Permissions.MarketplaceModerate)
  @ApiQuery({ name: 'status', enum: GovernanceReviewStatus, required: false })
  @ApiOperation({ summary: 'The review queue, riskiest first' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0rev1',
          subject: 'LISTING_VERSION',
          subjectLabel: 'daily-digest@2.0.0',
          riskLevel: 'HIGH',
          capabilities: ['can_invoke_external_apis'],
          status: 'PENDING',
        },
      ],
    },
  })
  queue(@Query('status') status?: GovernanceReviewStatus) {
    return this.governance.queue(status);
  }

  @Get('reviews/:id')
  @RequirePermissions(Permissions.MarketplaceModerate)
  @ApiParam({ name: 'id', example: 'clx0rev1' })
  @ApiOperation({ summary: 'One review, with the capabilities spelled out' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0rev1',
        riskLevel: 'HIGH',
        capabilities: [
          {
            id: 'can_invoke_external_apis',
            title: 'Call external services',
            description: 'Make network requests to services outside PRISM-X. Anything it can read, it can send.',
            risk: 'HIGH',
          },
        ],
        findings: [{ code: 'unsigned', message: 'Published without a signature' }],
      },
    },
  })
  review(@Param('id') id: string) {
    return this.governance.review(id);
  }

  @Post('reviews/:id/decide')
  @RequirePermissions(Permissions.MarketplaceModerate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0rev1' })
  @ApiOperation({
    summary: 'Decide a review',
    description: 'Approving a listing version is what makes it installable — the two happen together.',
  })
  @ApiOkResponse({ schema: { example: { id: 'clx0rev1', status: 'APPROVED', decidedAt: '2026-08-04T10:00:00Z' } } })
  decide(@Param('id') id: string, @Body() dto: DecideReviewDto) {
    return this.governance.decide(id, dto);
  }

  @Post('publishers/:id/verification')
  @RequirePermissions(Permissions.MarketplacePublish)
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({ name: 'id', example: 'clx0pub1' })
  @ApiOperation({ summary: 'Request publisher verification' })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0rev2', subject: 'PUBLISHER', status: 'PENDING' } } })
  requestVerification(@Param('id') id: string) {
    return this.governance.requestVerification(id);
  }

  @Post('publishers/:id/trust')
  @RequirePermissions(Permissions.MarketplaceModerate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0pub1' })
  @ApiOperation({ summary: 'Set a publisher’s trust level' })
  @ApiOkResponse({ schema: { example: { id: 'clx0pub1', trust: 'VERIFIED', verifiedAt: '2026-08-04T10:00:00Z' } } })
  setTrust(@Param('id') id: string, @Body() dto: TrustDto) {
    return this.governance.verifyPublisher(id, dto.trust);
  }

  @Post('publishers/:id/suspend')
  @RequirePermissions(Permissions.MarketplaceModerate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0pub1' })
  @ApiOperation({
    summary: 'Suspend a publisher',
    description: 'Withdraws every listing they own. Existing installs keep running until an advisory says otherwise.',
  })
  @ApiOkResponse({ schema: { example: { id: 'clx0pub1', suspendedAt: '2026-08-04T10:00:00Z' } } })
  suspendPublisher(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.governance.suspendPublisher(id, dto.reason);
  }

  @Post('listings/:id/suspend')
  @RequirePermissions(Permissions.MarketplaceModerate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0lst1' })
  @ApiOperation({ summary: 'Suspend a listing' })
  @ApiOkResponse({ schema: { example: { id: 'clx0lst1', status: 'SUSPENDED' } } })
  suspendListing(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.governance.suspendListing(id, dto.reason);
  }

  @Post('listings/:id/deprecate')
  @RequirePermissions(Permissions.MarketplacePublish)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0lst1' })
  @ApiOperation({
    summary: 'Deprecate a listing',
    description:
      'Still installable. Pulling an asset out from under everyone mid-migration is how a ' +
      'deprecation becomes an outage.',
  })
  @ApiOkResponse({ schema: { example: { id: 'clx0lst1', status: 'DEPRECATED', deprecationNotice: 'Use daily-digest-2.' } } })
  deprecate(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.governance.deprecateListing(id, dto.reason);
  }

  @Post('listings/:id/versions/:version/yank')
  @RequirePermissions(Permissions.MarketplaceModerate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0lst1' })
  @ApiParam({ name: 'version', example: '1.1.3' })
  @ApiOperation({
    summary: 'Withdraw one release',
    description: 'Stays visible to anyone already on it — so they can see why — but cannot be newly installed.',
  })
  @ApiOkResponse({ schema: { example: { version: '1.1.3', yankedAt: '2026-08-04T10:00:00Z' } } })
  yank(
    @Param('id') id: string,
    @Param('version') version: string,
    @Body() dto: ReasonDto,
  ) {
    return this.governance.yankVersion(id, version, dto.reason);
  }

  @Get('advisories')
  @RequirePermissions(Permissions.MarketplaceRead)
  @ApiOperation({ summary: 'Live security advisories' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0adv1',
          affectedSlug: 'daily-digest',
          severity: 'HIGH',
          title: 'Digest leaks mission titles',
          affectedRange: '>=1.0.0 <1.2.0',
          patchedVersion: '1.2.0',
        },
      ],
    },
  })
  advisories() {
    return this.governance.listAdvisories();
  }

  @Post('advisories')
  @RequirePermissions(Permissions.MarketplaceModerate)
  @ApiOperation({
    summary: 'Publish a security advisory',
    description:
      'Quarantines every affected install across every organization. Enforcement is what makes ' +
      'an advisory more than a note: the organizations most at risk are the least likely to be ' +
      'reading the catalogue.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        advisory: { id: 'clx0adv1', severity: 'HIGH', affectedRange: '>=1.0.0 <1.2.0' },
        quarantined: 4,
      },
    },
  })
  publishAdvisory(@Body() dto: AdvisoryDto) {
    return this.governance.publishAdvisory(dto);
  }

  @Post('advisories/:id/withdraw')
  @RequirePermissions(Permissions.MarketplaceModerate)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: 'clx0adv1' })
  @ApiOperation({ summary: 'Withdraw an advisory' })
  @ApiOkResponse({ schema: { example: { id: 'clx0adv1', withdrawnAt: '2026-08-04T11:00:00Z' } } })
  withdrawAdvisory(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.governance.withdrawAdvisory(id, dto.reason);
  }

  @Post('compatibility')
  @RequirePermissions(Permissions.MarketplaceRead)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compatibility test',
    description:
      'Every static check on a published version. Run against a future API version, it answers ' +
      '"what would break if we moved to 2.0.0" while there is still time to change the answer.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        version: '1.2.0',
        apiVersion: '1.0.0',
        compatible: true,
        checks: [
          { check: 'manifest_valid', ok: true, detail: 'Manifest parses and every field is well-formed' },
          { check: 'engine_range', ok: true, detail: 'Declares ^1.0.0; testing against 1.0.0' },
          { check: 'digest_matches', ok: true, detail: 'The stored digest is recomputed from the stored manifest' },
        ],
      },
    },
  })
  compatibility(@Body() dto: CompatibilityDto) {
    return this.governance.testCompatibility(dto.listingId, dto.version, dto.apiVersion);
  }
}

// ================================================= Developer portal

@ApiTags('Platform / Developer Portal')
@ApiBearerAuth()
@Controller('platform/developer')
export class DeveloperPortalController {
  constructor(private readonly portal: DeveloperPortalService) {}

  @Get()
  @RequirePermissions(Permissions.DeveloperRead)
  @ApiOperation({
    summary: 'The developer portal',
    description: 'Documentation links, guides, the testing surface, release notes and migration guides.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        apiVersion: '1.0.0',
        documentation: { openapi: '/api/docs-json', sdk: '/api/v1/platform/developer/sdk' },
        guides: [{ title: 'Build your first extension', steps: ['Write a manifest…'] }],
        testing: { validate: 'POST /platform/extensions/validate — manifest checks and the capability grant, no writes.' },
      },
    },
  })
  index() {
    return this.portal.portal();
  }

  @Get('sdk')
  @RequirePermissions(Permissions.DeveloperRead)
  @ApiOperation({
    summary: 'SDK reference',
    description:
      'Generated from the capability catalogue the sandbox enforces, so it cannot drift from ' +
      'the platform the way a hand-written page does.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        apiVersion: '1.0.0',
        catalogueVersion: '3f2a91c4b7e05d18',
        capabilities: [{ id: 'can_persist_state', risk: 'LOW', unlocks: ['state.get', 'state.set'] }],
        limits: { default: { callsPerMinute: 120 }, maximum: { callsPerMinute: 600 } },
        hooks: [{ name: 'onToolCall', when: 'When a contributed tool is invoked by a worker.' }],
      },
    },
  })
  sdk() {
    return this.portal.sdkReference();
  }

  @Get('manifest')
  @RequirePermissions(Permissions.DeveloperRead)
  @ApiOperation({
    summary: 'Manifest reference',
    description: 'Field-by-field, with an example that is validated on the way out.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        fields: { slug: 'Required. Lower-case words separated by single hyphens. Immutable.' },
        configFieldTypes: ['string', 'number', 'boolean', 'secret', 'enum'],
        exampleIsValid: true,
      },
    },
  })
  manifest() {
    return this.portal.manifestReference();
  }

  @Get('analytics')
  @RequirePermissions(Permissions.DeveloperRead)
  @ApiQuery({ name: 'days', required: false, example: 30 })
  @ApiOperation({ summary: 'Public API usage' })
  @ApiOkResponse({
    schema: {
      example: {
        window: { from: '2026-07-05', to: '2026-08-04', days: 30 },
        totals: { requests: 12_400, errors: 61, throttled: 3, errorRate: 0.0049, averageDurationMs: 87 },
        topEndpoints: [{ endpoint: 'GET /missions', requests: 5100, errors: 12, averageDurationMs: 64 }],
      },
    },
  })
  analytics(@Query('days') days?: string) {
    return this.portal.analytics(days ? Number(days) : 30);
  }

  @Get('apps')
  @RequirePermissions(Permissions.DeveloperRead)
  @ApiOperation({ summary: 'Registered apps' })
  @ApiOkResponse({
    schema: { example: [{ id: 'clx0app1', slug: 'ops-console', name: 'Ops Console', enabled: true }] },
  })
  listApps() {
    return this.portal.listApps();
  }

  @Post('apps')
  @RequirePermissions(Permissions.DeveloperManage)
  @ApiOperation({
    summary: 'Register an app',
    description: 'The webhook secret is generated here and shown once; it is stored sealed.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        app: { id: 'clx0app1', slug: 'ops-console', webhookSecret: '[sealed]' },
        webhookSecret: 'shown once — store it now',
      },
    },
  })
  createApp(@Body() dto: CreateDeveloperAppDto) {
    return this.portal.createApp(dto);
  }

  @Get('apps/:id')
  @RequirePermissions(Permissions.DeveloperRead)
  @ApiParam({ name: 'id', example: 'clx0app1' })
  @ApiOperation({ summary: 'An app and its keys' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0app1',
        slug: 'ops-console',
        keys: [{ id: 'clx0key1', name: 'Ops Console: production', prefix: 'prx_ab12', requestCount: 4021 }],
      },
    },
  })
  getApp(@Param('id') id: string) {
    return this.portal.getApp(id);
  }

  @Patch('apps/:id')
  @RequirePermissions(Permissions.DeveloperManage)
  @ApiParam({ name: 'id', example: 'clx0app1' })
  @ApiOperation({ summary: 'Edit an app', description: 'The slug and the webhook secret are not editable.' })
  @ApiOkResponse({ schema: { example: { id: 'clx0app1', name: 'Ops Console v2' } } })
  updateApp(@Param('id') id: string, @Body() patch: Record<string, unknown>) {
    return this.portal.updateApp(id, patch);
  }

  @Post('apps/:id/keys')
  @RequirePermissions(Permissions.DeveloperManage)
  @ApiParam({ name: 'id', example: 'clx0app1' })
  @ApiOperation({
    summary: 'Issue an API key for an app',
    description: 'Attributing keys to an app is what makes the usage analytics answer "which integration".',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0key1',
        name: 'Ops Console: production',
        key: 'prx_… shown once …',
        prefix: 'prx_ab12',
        appId: 'clx0app1',
      },
    },
  })
  issueKey(@Param('id') id: string, @Body() dto: IssueKeyDto) {
    return this.portal.issueKey(id, dto);
  }

  @Get('apps/:id/webhook-secret')
  @RequirePermissions(Permissions.DeveloperManage)
  @ApiParam({ name: 'id', example: 'clx0app1' })
  @ApiOperation({ summary: 'Reveal the webhook signing secret' })
  @ApiOkResponse({ schema: { example: { webhookSecret: 'a1b2c3…' } } })
  webhookSecret(@Param('id') id: string) {
    return this.portal.revealWebhookSecret(id);
  }

  @Delete('apps/:id')
  @RequirePermissions(Permissions.DeveloperManage)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', example: 'clx0app1' })
  @ApiOperation({
    summary: 'Delete an app',
    description: 'Revokes its keys first — credentials that outlive their integration are credentials nobody is watching.',
  })
  @ApiNoContentResponse({ description: 'Deleted, keys revoked.' })
  deleteApp(@Param('id') id: string) {
    return this.portal.deleteApp(id);
  }
}
