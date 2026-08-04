import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam,
  ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags,
} from '@nestjs/swagger';
import {
  IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString,
  Max, Min, MinLength,
} from 'class-validator';
import {
  CandidateStatus, EvolutionKind, EvolutionSubject, ExperimentMode,
  RiskLevel, VersionAspect,
} from '@prisma/client';

import { CandidateService } from './candidate.service';
import { ExperimentService } from './experiment.service';
import { BenchmarkService } from './benchmark.service';
import { VersionService } from './version.service';
import { DeploymentService } from './deployment.service';
import { EvolutionPolicyService } from './policy.service';
import { PlanningEvolutionService } from './planning-evolution.service';
import { EvolutionDashboardService } from './evolution-dashboard.service';
import * as Constitution from './constitution';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

// ============================================================ DTOs

export class CreateCandidateDto {
  @ApiProperty({ enum: EvolutionKind, example: 'PROMPT_OPTIMIZATION' })
  @IsEnum(EvolutionKind) kind!: EvolutionKind;

  @ApiProperty({ enum: EvolutionSubject, example: 'WORKER' })
  @IsEnum(EvolutionSubject) subject!: EvolutionSubject;

  @ApiProperty({ example: 'clx0worker01' }) @IsString() subjectId!: string;

  @ApiPropertyOptional({ example: 'Research Worker' })
  @IsOptional() @IsString() subjectLabel?: string;

  @ApiProperty({ example: 'Give the research worker explicit sourcing instructions' })
  @IsString() @MinLength(5) description!: string;

  @ApiProperty({
    example: 'Executions without sourcing instructions fail review 31% more often (48 runs).',
  })
  @IsString() @MinLength(10) reason!: string;

  @ApiProperty({ example: 'roughly 30% fewer rejected outputs' })
  @IsString() @MinLength(3) expectedBenefit!: string;

  @ApiProperty({
    description: 'The change itself. Field names must belong to one version aspect.',
    example: { systemPrompt: 'You are a research analyst. Always cite your sources.' },
  })
  @IsObject() proposedChange!: Record<string, unknown>;

  @ApiProperty({
    description:
      'State to restore. Required — the Constitution refuses irreversible deployments, ' +
      'so a candidate without one could never be deployed.',
    example: { systemPrompt: 'You are a research analyst.' },
  })
  @IsObject() rollback!: Record<string, unknown>;

  @ApiProperty({ example: 0.72, description: '0..1 evidence behind the change.' })
  @IsNumber() @Min(0) @Max(1) confidence!: number;

  @ApiPropertyOptional({ example: 48 }) @IsOptional() @IsInt() @Min(0) sampleSize?: number;

  @ApiPropertyOptional({ enum: RiskLevel })
  @IsOptional() @IsEnum(RiskLevel) risk?: RiskLevel;
}

export class RejectDto {
  @ApiProperty({ example: 'The prompt change conflicts with the client style guide.' })
  @IsString() @MinLength(3) reason!: string;
}

export class StartExperimentDto {
  @ApiProperty({ example: 'clx0cand01' }) @IsString() candidateId!: string;

  @ApiPropertyOptional({
    enum: ExperimentMode,
    default: 'SANDBOX',
    description:
      'SANDBOX touches nothing real, SHADOW runs alongside production without its results ' +
      'being used, CANARY takes a small share of real work, AB splits it evenly.',
  })
  @IsOptional() @IsEnum(ExperimentMode) mode?: ExperimentMode;

  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() hypothesis?: string;

  @ApiPropertyOptional({ default: 0.5 })
  @IsOptional() @IsNumber() @Min(0.1) @Max(0.9) allocation?: number;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional() @IsInt() @Min(1) minTrialsPerArm?: number;
}

export class RunTrialsDto {
  @ApiPropertyOptional({ default: 12, description: 'Trials to run. Capped at 50.' })
  @IsOptional() @IsInt() @Min(1) @Max(50) trials?: number;

  @ApiPropertyOptional({
    type: [String],
    description: 'Instructions to exercise the subject with. Defaults to a standard set.',
    example: ['Summarise the current state in two sentences.'],
  })
  @IsOptional() @IsArray() @IsString({ each: true }) probes?: string[];
}

export class ApproveDto {
  @ApiPropertyOptional({ example: 'Agreed — the benchmark is convincing.' })
  @IsOptional() @IsString() notes?: string;
}

export class DeployDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Deploy a candidate that has not been validated by an experiment. The Constitution ' +
      'still applies — this skips the workflow check, never the laws.',
  })
  @IsOptional() @IsBoolean() force?: boolean;
}

export class RollbackDto {
  @ApiProperty({ example: 'Latency regressed sharply after deployment.' })
  @IsString() @MinLength(3) reason!: string;
}

export class ObserveDto {
  @ApiProperty({ example: true }) @IsBoolean() succeeded!: boolean;
}

export class UpdatePolicyDto {
  @ApiPropertyOptional({ description: 'Master switch for deployment.' })
  @IsOptional() @IsBoolean() enabled?: boolean;

  @ApiPropertyOptional({ enum: EvolutionKind, isArray: true })
  @IsOptional() @IsArray() @IsEnum(EvolutionKind, { each: true }) allowedKinds?: EvolutionKind[];

  @ApiPropertyOptional({ enum: EvolutionKind, isArray: true })
  @IsOptional() @IsArray() @IsEnum(EvolutionKind, { each: true }) requireApproval?: EvolutionKind[];

  @ApiPropertyOptional({ enum: ExperimentMode, isArray: true })
  @IsOptional() @IsArray() @IsEnum(ExperimentMode, { each: true }) allowedModes?: ExperimentMode[];

  @ApiPropertyOptional({ example: 0.95 })
  @IsOptional() @IsNumber() @Min(0) @Max(1) autoApproveThreshold?: number;

  @ApiPropertyOptional({ enum: RiskLevel })
  @IsOptional() @IsEnum(RiskLevel) maxUnattendedRisk?: RiskLevel;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional() @IsInt() @Min(1) minTrialsPerArm?: number;

  @ApiPropertyOptional({ example: 9, description: 'UTC hour deployment may start.' })
  @IsOptional() @IsInt() @Min(0) @Max(23) businessHoursStart?: number;

  @ApiPropertyOptional({
    example: 17,
    description:
      'UTC hour deployment must stop, exclusive. 24 means midnight, so 0–24 is ' +
      'a window that is always open.',
  })
  // Up to 24, not 23. The comparison is `hour < end`, so a ceiling of 23 made
  // the 23:00 hour unreachable by any configuration — deployments were blocked
  // for one hour a day with a message that read as if a window were closed on
  // purpose.
  @IsOptional() @IsInt() @Min(0) @Max(24) businessHoursEnd?: number;

  @ApiPropertyOptional({ type: [Number], example: [1, 2, 3, 4, 5], description: '0 = Sunday.' })
  @IsOptional() @IsArray() @IsInt({ each: true }) businessDays?: number[];

  @ApiPropertyOptional({ example: 3 })
  @IsOptional() @IsInt() @Min(1) maxConcurrentExperiments?: number;

  @ApiPropertyOptional({ example: 5, description: 'Zero disables the cap.' })
  @IsOptional() @IsInt() @Min(0) maxDeploymentsPerDay?: number;

  @ApiPropertyOptional({ example: 60 })
  @IsOptional() @IsInt() @Min(1) monitorWindowMinutes?: number;

  @ApiPropertyOptional({ example: 0.3 })
  @IsOptional() @IsNumber() @Min(0) @Max(1) autoRollbackThreshold?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional() @IsBoolean() autoRollbackEnabled?: boolean;
}

export class CreateStrategyDto {
  @ApiProperty({ example: 'parallel-first' }) @IsString() @MinLength(2) name!: string;

  @ApiProperty({ example: 'Runs more independent tasks at once and decomposes long ones sooner.' })
  @IsString() @MinLength(10) description!: string;

  @ApiProperty({
    example: { maxParallelism: 4, ordering: 'longest_first' },
    description: 'Merged onto the baseline, so a partial set of rules is still runnable.',
  })
  @IsObject() rules!: Record<string, unknown>;
}

// ============================================================ Constitution

@ApiTags('Evolution')
@ApiBearerAuth('bearer')
@Controller('evolution/constitution')
export class ConstitutionController {
  @Get()
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiOperation({
    summary: 'The immutable laws',
    description:
      'The boundary the Evolution Engine cannot move. These live in code rather than in ' +
      'the database — a constitution stored in a row is one the system could evolve, and ' +
      'a constitution the system can evolve is not one. Amending a law requires a code ' +
      'change, a review and a deploy, which is exactly the human process the laws protect.\n\n' +
      'The version is a hash of the law text, recorded with every deployment decision, so ' +
      'an archive entry from six months ago can be checked against the constitution that ' +
      'was in force when it was written.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        version: 'a3f19c22b7e04d51',
        laws: [
          {
            id: 'REVERSIBILITY',
            statement: 'Never deploy a change that cannot be undone.',
            rationale:
              'Every evolution is a bet. Bets are acceptable when losing them is recoverable; ' +
              'an irreversible bet on an automated inference is not.',
          },
        ],
      },
    },
  })
  laws() {
    return { version: Constitution.CONSTITUTION_VERSION, laws: Constitution.describe() };
  }
}

// ============================================================ Candidates

@ApiTags('Evolution')
@ApiBearerAuth('bearer')
@Controller('evolution/candidates')
export class CandidateController {
  constructor(private readonly candidates: CandidateService) {}

  @Post()
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiOperation({
    summary: 'Propose a change',
    description:
      'A candidate is a concrete, testable change — unlike a Phase 5 recommendation, ' +
      'which is advice for a person. Proposing the same change twice reinforces one ' +
      'candidate rather than creating a second.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0cand01', kind: 'PROMPT_OPTIMIZATION', status: 'DRAFT',
        confidence: 0.72, risk: 'LOW', proposalCount: 1,
      },
    },
  })
  create(@Body() dto: CreateCandidateDto) {
    return this.candidates.create(dto);
  }

  @Post('generate')
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiOperation({
    summary: 'Generate candidates from learning',
    description:
      'Sweeps open recommendations for anything promotable. Runs automatically when a ' +
      'recommendation is proposed; this is for backfilling and for recommendations that ' +
      'predate the engine.',
  })
  @ApiCreatedResponse({ schema: { example: { scanned: 12, created: 3, skipped: 9 } } })
  generate() {
    return this.candidates.generate();
  }

  @Get()
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiQuery({ name: 'status', required: false, enum: CandidateStatus })
  @ApiOperation({ summary: 'List candidates' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0cand01', description: 'Give the research worker sourcing instructions',
          status: 'VALIDATED', confidence: 0.72, risk: 'LOW', proposalCount: 2,
        },
      ],
    },
  })
  list(@Query('status') status?: CandidateStatus, @Query('take') take?: string) {
    return this.candidates.list(status, Math.min(200, Number(take) || 50));
  }

  @Get('queue')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiOperation({ summary: 'The optimization queue, best-evidenced first' })
  @ApiOkResponse({ schema: { example: [{ id: 'clx0cand01', confidence: 0.72, status: 'QUEUED' }] } })
  queue(@Query('take') take?: string) {
    return this.candidates.queue(Math.min(200, Number(take) || 50));
  }

  @Get(':id')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiParam({ name: 'id', example: 'clx0cand01' })
  @ApiOperation({ summary: 'Get a candidate with its change and rollback' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0cand01',
        proposedChange: { systemPrompt: 'You are a research analyst. Always cite your sources.' },
        rollback: { systemPrompt: 'You are a research analyst.' },
        reason: 'Executions without sourcing instructions fail review 31% more often (48 runs).',
      },
    },
  })
  get(@Param('id') id: string) {
    return this.candidates.get(id);
  }

  @Post(':id/queue')
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiParam({ name: 'id', example: 'clx0cand01' })
  @ApiOperation({ summary: 'Queue a candidate for testing' })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0cand01', status: 'QUEUED' } } })
  queueOne(@Param('id') id: string) {
    return this.candidates.queueForTesting(id);
  }

  @Post(':id/reject')
  @RequirePermissions(Permissions.EvolutionApprove)
  @ApiParam({ name: 'id', example: 'clx0cand01' })
  @ApiOperation({ summary: 'Reject a candidate with a reason' })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0cand01', status: 'REJECTED' } } })
  reject(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.candidates.reject(id, dto.reason);
  }
}

// ============================================================ Experiments

@ApiTags('Evolution')
@ApiBearerAuth('bearer')
@Controller('evolution/experiments')
export class EvolutionExperimentController {
  constructor(
    private readonly experiments: ExperimentService,
    private readonly benchmarks: BenchmarkService,
  ) {}

  @Post()
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiOperation({
    summary: 'Start an experiment',
    description:
      'Captures a version for each arm before anything runs, so the comparison is between ' +
      'two named, inspectable states. The candidate is never applied to production in ' +
      'order to be tested — a change deployed for measurement has already skipped the pipeline.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0exp01', mode: 'SANDBOX', status: 'RUNNING',
        controlVersionId: 'clx0ver01', variantVersionId: 'clx0ver02', minTrialsPerArm: 10,
      },
    },
  })
  start(@Body() dto: StartExperimentDto) {
    return this.experiments.start(dto);
  }

  @Get()
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiOperation({ summary: 'List experiments' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0exp01', name: 'Sourcing instructions', mode: 'SANDBOX',
          controlTrials: 12, variantTrials: 12, verdict: 'BETTER', winner: 'variant',
        },
      ],
    },
  })
  list(@Query('take') take?: string) {
    return this.experiments.list(Math.min(200, Number(take) || 50));
  }

  @Get(':id')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiParam({ name: 'id', example: 'clx0exp01' })
  @ApiOperation({ summary: 'Get an experiment' })
  @ApiOkResponse({ schema: { example: { id: 'clx0exp01', status: 'RUNNING', mode: 'SANDBOX' } } })
  get(@Param('id') id: string) {
    return this.experiments.get(id);
  }

  @Post(':id/run')
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiParam({ name: 'id', example: 'clx0exp01' })
  @ApiOperation({
    summary: 'Run trials against both arms',
    description:
      'The variant executes with the candidate applied in memory only — the stored record ' +
      'is never written. A failed trial is a data point, not an error.',
  })
  @ApiCreatedResponse({
    schema: { example: { control: 12, variant: 12, verdict: 'BETTER' } },
  })
  run(@Param('id') id: string, @Body() dto: RunTrialsDto) {
    return this.experiments.runTrials({ experimentId: id, ...dto });
  }

  @Get(':id/benchmarks')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiParam({ name: 'id', example: 'clx0exp01' })
  @ApiOperation({
    summary: 'The nine metrics, per arm',
    description:
      'Recorded per arm rather than collapsed into one score, because collapsing early ' +
      'hides the trade-offs: a variant that is faster and worse is a different situation ' +
      'from one that is faster and cheaper.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          arm: 'control', trials: 12, successRate: 0.62, observedRate: 0.83,
          avgCompletionMs: 1840, avgCostUsd: 0.0021, reliability: 0.83, roi: 396, userRating: null,
        },
      ],
    },
  })
  listBenchmarks(@Param('id') id: string) {
    return this.benchmarks.forExperiment(id);
  }

  @Get(':id/comparison')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiParam({ name: 'id', example: 'clx0exp01' })
  @ApiOperation({
    summary: 'Compare the arms',
    description:
      'Reliability decides the verdict; cost and speed break ties. A change that is cheaper ' +
      'and quicker while succeeding less often has not improved anything.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        verdict: 'INCONCLUSIVE', winner: null, confidence: 0,
        summary: 'No measurable difference. The two results overlap within their margins of error.',
        regressions: [{ metric: 'avgCostUsd', control: 0.002, variant: 0.004, delta: 1.0 }],
      },
    },
  })
  comparison(@Param('id') id: string) {
    return this.benchmarks.compare(id);
  }

  @Post(':id/evaluate')
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiParam({ name: 'id', example: 'clx0exp01' })
  @ApiOperation({
    summary: 'Conclude the experiment',
    description:
      'Validates or rejects the candidate. A losing candidate is rejected here without a ' +
      'human ever reading it — most proposed changes are not improvements, and measurement ' +
      'should be what discovers that.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        experiment: { status: 'CONCLUDED', winner: 'variant', verdict: 'BETTER' },
        comparison: { summary: 'Variant is more reliable: 74.0% against 41.0%.' },
      },
    },
  })
  evaluate(@Param('id') id: string) {
    return this.experiments.evaluate(id);
  }

  @Post(':id/abandon')
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiParam({ name: 'id', example: 'clx0exp01' })
  @ApiOperation({ summary: 'Abandon an experiment' })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0exp01', status: 'ABANDONED' } } })
  abandon(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.experiments.abandon(id, dto.reason);
  }
}

// ============================================================ Versions

@ApiTags('Evolution')
@ApiBearerAuth('bearer')
@Controller('evolution/versions')
export class VersionController {
  constructor(private readonly versions: VersionService) {}

  // Declared before the `:subject/:subjectId/:aspect` route below: Nest
  // matches in declaration order, and the wildcard would otherwise capture
  // `diff/<id>/<id>` as a subject named "diff".
  @Get('diff/:fromId/:toId')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiParam({ name: 'fromId', example: 'clx0ver01' })
  @ApiParam({ name: 'toId', example: 'clx0ver02' })
  @ApiOperation({ summary: 'Compare two versions of one lineage' })
  @ApiOkResponse({
    schema: {
      example: {
        diff: [
          { field: 'systemPrompt', from: 'You are a research analyst.', to: 'You are a research analyst. Always cite your sources.' },
        ],
      },
    },
  })
  diff(@Param('fromId') fromId: string, @Param('toId') toId: string) {
    return this.versions.diff(fromId, toId);
  }

  @Get(':subject/:subjectId')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiParam({ name: 'subject', enum: EvolutionSubject })
  @ApiParam({ name: 'subjectId', example: 'clx0worker01' })
  @ApiOperation({
    summary: 'Version history',
    description:
      'Versions are immutable and never deleted — a new one supersedes its predecessor. ' +
      'That is what makes rollback a matter of re-activating a row that already exists ' +
      'rather than reconstructing a past state from diffs.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          aspect: 'PROMPT', version: 2, isActive: true, origin: 'CANDIDATE',
          label: 'deployed 2026-08-03', payload: { systemPrompt: 'You are a research analyst…' },
        },
      ],
    },
  })
  history(@Param('subject') subject: EvolutionSubject, @Param('subjectId') subjectId: string) {
    return this.versions.historyFor(subject, subjectId);
  }

  @Get(':subject/:subjectId/:aspect')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiParam({ name: 'subject', enum: EvolutionSubject })
  @ApiParam({ name: 'subjectId', example: 'clx0worker01' })
  @ApiParam({ name: 'aspect', enum: VersionAspect })
  @ApiOperation({
    summary: 'One lineage',
    description:
      'Prompt, model, tools, limits and graph version independently, because they change ' +
      'for different reasons — versioning them together would mean a prompt tweak ' +
      'invalidating a benchmarked model choice.',
  })
  @ApiOkResponse({ schema: { example: [{ version: 2, isActive: true, label: 'deployed' }] } })
  lineage(
    @Param('subject') subject: EvolutionSubject,
    @Param('subjectId') subjectId: string,
    @Param('aspect') aspect: VersionAspect,
  ) {
    return this.versions.lineage(subject, subjectId, aspect);
  }
}

// ============================================================ Deployment

@ApiTags('Evolution')
@ApiBearerAuth('bearer')
@Controller('evolution/deployments')
export class DeploymentController {
  constructor(private readonly deployments: DeploymentService) {}

  @Post('candidates/:candidateId/approve')
  @RequirePermissions(Permissions.EvolutionApprove)
  @ApiParam({ name: 'candidateId', example: 'clx0cand01' })
  @ApiOperation({
    summary: 'Approve a validated candidate',
    description:
      'Separate from deploying, because approval says the change is acceptable while ' +
      'deployment says now is the moment — an organization with a deployment window needs ' +
      'to approve at 3pm and deploy at 2am.',
  })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0cand01', status: 'VALIDATED' } } })
  approve(@Param('candidateId') candidateId: string, @Body() dto: ApproveDto) {
    return this.deployments.approve(candidateId, dto.notes);
  }

  @Get('candidates/:candidateId/preflight')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiParam({ name: 'candidateId', example: 'clx0cand01' })
  @ApiOperation({
    summary: 'What would happen, without doing it',
    description:
      'Runs the full Constitution and policy check and changes nothing. Every law is ' +
      'evaluated rather than stopping at the first refusal, so all the reasons arrive at once.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        permitted: false,
        constitution: {
          version: 'a3f19c22b7e04d51',
          violations: [
            { lawId: 'HUMAN_CONSENT', passed: false, reason: 'this change requires human approval and has none' },
          ],
        },
        policy: { satisfied: true, requiresApproval: true },
      },
    },
  })
  preflight(@Param('candidateId') candidateId: string) {
    return this.deployments.preflight(candidateId);
  }

  @Post('candidates/:candidateId/deploy')
  @RequirePermissions(Permissions.EvolutionDeploy)
  @ApiParam({ name: 'candidateId', example: 'clx0cand01' })
  @ApiOperation({
    summary: 'Deploy to production',
    description:
      'The only route from the Evolution Engine to production. Reads the current state, ' +
      'asks the policy, submits the intent to the Constitution, writes the deployment row ' +
      '*before* touching production, applies the change, then watches it. A refusal is ' +
      'recorded as a deployment with status REFUSED plus one violation row per law that objected.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        deployed: false,
        refusal: { laws: ['HUMAN_CONSENT'], reasons: ['this change requires human approval and has none'] },
        deployment: { id: 'clx0dep01', status: 'REFUSED', constitutionVersion: 'a3f19c22b7e04d51' },
      },
    },
  })
  deploy(@Param('candidateId') candidateId: string, @Body() dto: DeployDto) {
    return this.deployments.deploy(candidateId, { force: dto?.force === true });
  }

  @Get()
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiOperation({
    summary: 'Deployment history',
    description: 'Every attempt, including the refused ones. Nothing is removed.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0dep01', kind: 'PROMPT_OPTIMIZATION', status: 'SETTLED',
          subjectLabel: 'Research Worker', constitutionPassed: true, healthy: true,
        },
      ],
    },
  })
  history(@Query('take') take?: string) {
    return this.deployments.history(Math.min(500, Number(take) || 100));
  }

  @Get(':id')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiParam({ name: 'id', example: 'clx0dep01' })
  @ApiOperation({ summary: 'Get one deployment, with its law verdicts and rollback state' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0dep01', status: 'MONITORING',
        applied: { systemPrompt: 'You are a research analyst. Always cite your sources.' },
        rollback: { systemPrompt: 'You are a research analyst.' },
        lawVerdicts: [{ lawId: 'REVERSIBILITY', passed: true }],
      },
    },
  })
  get(@Param('id') id: string) {
    return this.deployments.get(id);
  }

  @Post(':id/observe')
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiParam({ name: 'id', example: 'clx0dep01' })
  @ApiOperation({
    summary: 'Report how a deployed change is behaving',
    description:
      'Deployment finishes when the change survives real use, not when the write lands. ' +
      'Once the failure rate is clearly bad the system rolls back early rather than waiting ' +
      'out the window.',
  })
  @ApiCreatedResponse({ schema: { example: { recorded: true } } })
  async observe(@Param('id') id: string, @Body() dto: ObserveDto) {
    await this.deployments.observe(id, { succeeded: dto.succeeded });
    return { recorded: true };
  }

  @Post(':id/rollback')
  @RequirePermissions(Permissions.EvolutionDeploy)
  @ApiParam({ name: 'id', example: 'clx0dep01' })
  @ApiOperation({
    summary: 'Roll a deployment back',
    description:
      'Restores the state captured immediately before the write. The restored state becomes ' +
      'a version of its own rather than reactivating the old row, so the lineage reads as ' +
      'what actually happened instead of pretending the deployment never occurred.',
  })
  @ApiCreatedResponse({
    schema: { example: { id: 'clx0dep01', status: 'ROLLED_BACK', automatic: false } },
  })
  rollback(@Param('id') id: string, @Body() dto: RollbackDto) {
    return this.deployments.rollback(id, dto.reason);
  }

  @Post('sweep')
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiOperation({
    summary: 'Settle deployments whose monitoring window has closed',
    description:
      'Runs on a timer; exposed for diagnosis. A deployment with no observations settles ' +
      'with `healthy: null` rather than claiming a verdict nobody measured.',
  })
  @ApiCreatedResponse({ schema: { example: { settled: ['clx0dep01'], rolledBack: [] } } })
  sweep() {
    return this.deployments.sweep();
  }
}

// ============================================================ Policy

@ApiTags('Evolution')
@ApiBearerAuth('bearer')
@Controller('evolution/policy')
export class EvolutionPolicyController {
  constructor(private readonly policy: EvolutionPolicyService) {}

  @Get()
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiOperation({
    summary: 'This organization’s evolution policy',
    description:
      'The Constitution is the floor nobody can lower; the policy is this organization’s ' +
      'own ceiling. Created with conservative defaults on first access — an organization ' +
      'that has never configured evolution should not thereby be evolving freely.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        enabled: true,
        allowedKinds: ['PROMPT_OPTIMIZATION', 'EXECUTION_LIMITS', 'MEMORY_STRATEGY', 'MODEL_CHANGE'],
        requireApproval: ['PROVIDER_CHANGE', 'MODEL_CHANGE', 'TOOL_PERMISSION'],
        autoApproveThreshold: 0.95, maxUnattendedRisk: 'LOW', minTrialsPerArm: 10,
        autoRollbackEnabled: true, autoRollbackThreshold: 0.3,
      },
    },
  })
  get() {
    return this.policy.get();
  }

  @Post()
  @RequirePermissions(Permissions.EvolutionPolicyManage)
  @ApiOperation({
    summary: 'Amend the policy',
    description:
      'A policy can only be as permissive as the Constitution allows — tightening always ' +
      'works, loosening is capped by the laws.',
  })
  @ApiCreatedResponse({ schema: { example: { enabled: true, autoApproveThreshold: 0.99 } } })
  update(@Body() dto: UpdatePolicyDto) {
    return this.policy.update(dto as never);
  }
}

// ============================================================ Planning

@ApiTags('Evolution')
@ApiBearerAuth('bearer')
@Controller('evolution/planning')
export class PlanningEvolutionController {
  constructor(private readonly planning: PlanningEvolutionService) {}

  @Get('active')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiOperation({
    summary: 'The active planning strategy',
    description: 'Creates the baseline on first access, so later strategies have something to beat.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        name: 'baseline', version: 1, isActive: true,
        rules: { maxParallelism: 2, workerSelection: 'best_available', ordering: 'as_declared' },
        missionsPlanned: 24, successRate: 0.71,
      },
    },
  })
  active() {
    return this.planning.active();
  }

  @Get()
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiOperation({ summary: 'List planning strategies' })
  @ApiOkResponse({ schema: { example: [{ name: 'baseline', version: 1, successRate: 0.71 }] } })
  list(@Query('take') take?: string) {
    return this.planning.list(Math.min(200, Number(take) || 50));
  }

  @Get('analysis')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiOperation({
    summary: 'What mission history says planning should change',
    description:
      'Every observation names the signal it came from, so a suggestion can be checked ' +
      'rather than taken on faith.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        missions: 24, successRate: 0.68, avgTasksPerMission: 3.2, confidence: 0.63,
        observations: [
          {
            signal: 'unused parallelism',
            detail: '11 of 24 missions had independent tasks that ran one after another.',
            suggests: { maxParallelism: 4, ordering: 'longest_first' },
          },
        ],
      },
    },
  })
  analysis() {
    return this.planning.analyse();
  }

  @Post()
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiOperation({ summary: 'Create a planning strategy' })
  @ApiCreatedResponse({ schema: { example: { name: 'parallel-first', version: 1, isActive: false } } })
  create(@Body() dto: CreateStrategyDto) {
    return this.planning.create(dto as never);
  }

  @Post('propose')
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiOperation({
    summary: 'Derive a strategy from history',
    description:
      'Created, not activated. A proposed strategy is a hypothesis that has to earn its ' +
      'place against the one currently running.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        strategy: { name: 'derived', version: 1, rules: { maxParallelism: 4 } },
        analysis: { missions: 24, observations: [{ signal: 'unused parallelism' }] },
      },
    },
  })
  propose() {
    return this.planning.propose();
  }

  @Post('measure')
  @RequirePermissions(Permissions.EvolutionRun)
  @ApiOperation({ summary: 'Attribute recent mission outcomes to the active strategy' })
  @ApiCreatedResponse({
    schema: { example: { name: 'baseline', missionsPlanned: 24, successRate: 0.71, confidence: 0.64 } },
  })
  measure() {
    return this.planning.measure();
  }

  @Post(':id/activate')
  @RequirePermissions(Permissions.EvolutionDeploy)
  @ApiParam({ name: 'id', example: 'clx0strat02' })
  @ApiOperation({
    summary: 'Make a strategy active',
    description:
      'Refuses to promote an unproven strategy over a proven one. Planning is the ' +
      'highest-leverage change in the system, and switching it on a hunch undoes whatever ' +
      'the previous strategy had earned.',
  })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0strat02', isActive: true } } })
  activate(@Param('id') id: string, @Query('force') force?: string) {
    return this.planning.activate(id, { force: force === 'true' });
  }
}

// ============================================================ Dashboard

@ApiTags('Evolution')
@ApiBearerAuth('bearer')
@Controller('evolution')
export class EvolutionDashboardController {
  constructor(private readonly dashboard: EvolutionDashboardService) {}

  @Get('dashboard')
  @RequirePermissions(Permissions.EvolutionRead)
  @ApiQuery({ name: 'days', required: false, example: 30 })
  @ApiOperation({
    summary: 'How has PRISM-X improved?',
    description:
      'Refusals and rollbacks are given the same prominence as successes — an evolution ' +
      'dashboard that only shows wins is a marketing page. When nothing improved, the ' +
      'digest says so rather than filling the space with charts.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        headline: '4 experiment(s) concluded, 2 change(s) deployed, 1 refused over 30 days.',
        improvements: [
          'Research Worker: prompt optimization deployed after benchmarking.',
          '3 proposed change(s) were rejected by measurement before reaching production.',
          '1 deployment(s) were refused by the Constitution or policy.',
        ],
        candidates: { total: 7, queued: 1, testing: 1, validated: 1, deployed: 2, rejected: 2 },
        deployments: { total: 4, succeeded: 2, rolledBack: 1, refused: 1, successRate: 0.6667 },
        constitution: { version: 'a3f19c22b7e04d51', laws: 9, violations: 1, byLaw: [{ lawId: 'HUMAN_CONSENT', count: 1 }] },
        confidenceTrend: { direction: 'improving', average: 0.64, summary: 'Candidate confidence is improving — 52% to 71% across 7 candidates.' },
      },
    },
  })
  digest(@Query('days') days?: string) {
    return this.dashboard.digest(Math.min(365, Number(days) || 30));
  }
}
