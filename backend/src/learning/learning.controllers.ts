import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam,
  ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags,
} from '@nestjs/swagger';
import {
  IsArray, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min, MinLength,
} from 'class-validator';
import {
  LearningEntryKind, MetricPeriod, MetricSubject, RecommendationStatus,
} from '@prisma/client';

import { MissionReviewService } from './mission-review.service';
import { PerformanceAnalyticsService } from './performance-analytics.service';
import { RecommendationService } from './recommendation.service';
import { KnowledgeEvolutionService } from './knowledge-evolution.service';
import { WorkerOptimizerService } from './worker-optimizer.service';
import { WorkflowOptimizerService } from './workflow-optimizer.service';
import { PatternRecognitionService } from './pattern-recognition.service';
import { LearningDashboardService } from './learning-dashboard.service';
import * as Confidence from './confidence';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

// ============================================================ DTOs

export class RejectDto {
  @ApiProperty({
    example: 'We deliberately keep this worker on GPT-4 for consistency with the client.',
    description:
      'Required. A rejection without a reason teaches the system nothing, and the ' +
      'reason is stored in the learning repository as evidence about the analyser.',
  })
  @IsString() @MinLength(3) reason!: string;
}

export class AcceptDto {
  @ApiPropertyOptional({ example: 'Agreed — trialling for two weeks.' })
  @IsOptional() @IsString() notes?: string;
}

export class ApplyDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Apply without a prior human acceptance. Refused unless the organization has ' +
      'switched on `learning.autoApply`, the kind is low-risk, and confidence clears 85%.',
  })
  @IsOptional() viaAutopilot?: boolean;
}

export class ResolveFindingDto {
  @ApiProperty({ example: 'Merged into the onboarding guide and deleted the duplicate.' })
  @IsString() @MinLength(3) resolution!: string;
}

export class DismissPatternDto {
  @ApiProperty({ example: 'These two workers share missions by roster, not by affinity.' })
  @IsString() @MinLength(3) reason!: string;
}

export class StartExperimentDto {
  @ApiProperty({ example: 'clx0workflow01' }) @IsString() workflowId!: string;
  @ApiProperty({ example: 'clx0version02' }) @IsString() variantVersionId!: string;
  @ApiProperty({ example: 'Parallel enrichment' }) @IsString() @MinLength(2) name!: string;

  @ApiProperty({
    example: 'Running enrichment and scoring concurrently cuts run time without hurting accuracy.',
  })
  @IsString() @MinLength(10) hypothesis!: string;

  @ApiPropertyOptional({ default: 0.5, description: 'Share of runs sent to the variant.' })
  @IsOptional() @IsNumber() @Min(0.1) @Max(0.9) allocation?: number;

  @ApiPropertyOptional({
    default: 20,
    description: 'Runs each arm needs before a winner may be declared.',
  })
  @IsOptional() @IsInt() @Min(5) minRunsPerArm?: number;
}

export class RecordLessonDto {
  @ApiProperty({ enum: LearningEntryKind, example: 'LESSON' })
  @IsEnum(LearningEntryKind) kind!: LearningEntryKind;

  @ApiProperty({ example: 'Rate limits bite hardest on Monday mornings' })
  @IsString() @MinLength(3) title!: string;

  @ApiProperty({
    example: 'Three separate incidents traced back to the weekly CRM sync colliding with peak load.',
  })
  @IsString() @MinLength(10) body!: string;

  @ApiPropertyOptional({ type: [String], example: ['incident', 'rate-limit'] })
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];

  @ApiPropertyOptional({ example: { incidents: ['INC-1', 'INC-2'] } })
  @IsOptional() @IsObject() data?: Record<string, unknown>;
}

// ============================================================ Reviews

@ApiTags('Learning')
@ApiBearerAuth('bearer')
@Controller('learning/reviews')
export class MissionReviewController {
  constructor(private readonly reviews: MissionReviewService) {}

  @Get()
  @RequirePermissions(Permissions.LearningRead)
  @ApiOperation({
    summary: 'List mission reviews',
    description:
      'Every completed mission produces one, automatically. Reviews are computed from ' +
      'the mission’s own record — tasks, execution logs, approvals — so every number ' +
      'traces back to the rows that produced it.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0review01', missionId: 'clx0mission01', outcome: 'PARTIAL',
          successScore: 0.72, completionMs: 48210, costUsd: 0.0412,
          summary: 'Enrich inbound leads — partial (72%), 4/5 tasks, 48s, $0.0412, 1 bottleneck.',
          confidence: 0.61,
        },
      ],
    },
  })
  list(@Query('take') take?: string) {
    return this.reviews.list(Math.min(200, Number(take) || 50));
  }

  @Get('search')
  @RequirePermissions(Permissions.LearningRead)
  @ApiQuery({ name: 'q', example: 'crm sync slow' })
  @ApiOperation({
    summary: 'Search reviews',
    description: 'Tokenised across objective, summary and tags, so past lessons are findable.',
  })
  @ApiOkResponse({
    schema: { example: [{ id: 'clx0review01', objective: 'Sync CRM contacts', outcome: 'FAILURE' }] },
  })
  search(@Query('q') q: string, @Query('take') take?: string) {
    return this.reviews.search(q ?? '', Math.min(100, Number(take) || 25));
  }

  @Get(':missionId')
  @RequirePermissions(Permissions.LearningRead)
  @ApiParam({ name: 'missionId', example: 'clx0mission01' })
  @ApiOperation({ summary: 'Get the review for one mission' })
  @ApiOkResponse({
    schema: {
      example: {
        missionId: 'clx0mission01', outcome: 'SUCCESS', successScore: 0.94,
        bottlenecks: [{ taskId: 'clx0task03', title: 'Enrich', durationMs: 31000, share: 0.62 }],
        missedOpportunities: [
          { kind: 'unused_parallelism', detail: '3 tasks had no dependencies but ran in sequence.' },
        ],
        recommendations: [{ kind: 'address_bottleneck', detail: '"Enrich" took 62% of task time.' }],
      },
    },
  })
  get(@Param('missionId') missionId: string) {
    return this.reviews.get(missionId);
  }

  @Post(':missionId/rebuild')
  @RequirePermissions(Permissions.LearningRun)
  @ApiParam({ name: 'missionId', example: 'clx0mission01' })
  @ApiOperation({
    summary: 'Rebuild a review',
    description: 'Idempotent — recomputing overwrites rather than duplicating.',
  })
  @ApiCreatedResponse({ schema: { example: { missionId: 'clx0mission01', outcome: 'SUCCESS' } } })
  rebuild(@Param('missionId') missionId: string) {
    return this.reviews.review(missionId);
  }
}

// ============================================================ Analytics

@ApiTags('Learning')
@ApiBearerAuth('bearer')
@Controller('learning/analytics')
export class LearningAnalyticsController {
  constructor(private readonly analytics: PerformanceAnalyticsService) {}

  @Post('rollup')
  @RequirePermissions(Permissions.LearningRun)
  @ApiQuery({ name: 'period', required: false, enum: MetricPeriod })
  @ApiOperation({
    summary: 'Recompute metrics for a period',
    description:
      'Rolls up workers, providers, workflows and the organization. Converges rather ' +
      'than accumulating — running it twice for a window produces the same numbers.',
  })
  @ApiCreatedResponse({
    schema: { example: { written: 12, period: 'DAY', periodStart: '2026-08-03T00:00:00.000Z' } },
  })
  rollup(@Query('period') period?: MetricPeriod) {
    return this.analytics.rollup(period ?? MetricPeriod.DAY);
  }

  @Get('leaderboard')
  @RequirePermissions(Permissions.LearningRead)
  @ApiQuery({ name: 'subject', enum: MetricSubject, example: 'WORKER' })
  @ApiQuery({ name: 'period', required: false, enum: MetricPeriod })
  @ApiOperation({
    summary: 'Rank subjects by reliability',
    description:
      'Ranked on the Wilson lower bound of the success rate, not the raw proportion — ' +
      'three successes out of three does not outrank 480 out of 500. Rows with too few ' +
      'samples are returned but flagged `rankable: false`.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          subjectLabel: 'Research Worker', successRate: 0.81, observedRate: 0.94,
          samples: 48, qualityScore: 0.88, rankable: true,
        },
      ],
    },
  })
  leaderboard(
    @Query('subject') subject: MetricSubject,
    @Query('period') period?: MetricPeriod,
    @Query('take') take?: string,
  ) {
    return this.analytics.leaderboard(
      subject ?? MetricSubject.WORKER,
      period ?? MetricPeriod.DAY,
      Math.min(50, Number(take) || 10),
    );
  }

  @Get('trend')
  @RequirePermissions(Permissions.LearningRead)
  @ApiQuery({ name: 'subject', enum: MetricSubject })
  @ApiQuery({ name: 'subjectId', example: 'clx0worker01' })
  @ApiQuery({ name: 'period', required: false, enum: MetricPeriod })
  @ApiOperation({
    summary: 'Trend for one subject',
    description:
      'Derived from stored snapshots rather than stored as its own figure, so it can ' +
      'never disagree with the measurements it summarises. Reports `unknown` — not ' +
      '`steady` — when there is too little history to compare.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        subjectLabel: 'Research Worker', direction: 'improving', change: 0.12, confidence: 0.74,
        summary: 'Research Worker: success rate improving by 12.0 points across 9 periods.',
        points: [{ periodStart: '2026-07-28T00:00:00.000Z', successRate: 0.62, samples: 11 }],
      },
    },
  })
  trend(
    @Query('subject') subject: MetricSubject,
    @Query('subjectId') subjectId: string,
    @Query('period') period?: MetricPeriod,
    @Query('windows') windows?: string,
  ) {
    return this.analytics.trend(
      subject ?? MetricSubject.WORKER,
      subjectId,
      period ?? MetricPeriod.DAY,
      Math.min(90, Number(windows) || 14),
    );
  }

  @Get('series')
  @RequirePermissions(Permissions.LearningRead)
  @ApiQuery({ name: 'subject', enum: MetricSubject })
  @ApiQuery({ name: 'subjectId', example: 'clx0worker01' })
  @ApiQuery({ name: 'period', required: false, enum: MetricPeriod })
  @ApiOperation({ summary: 'Raw snapshot series for one subject' })
  @ApiOkResponse({
    schema: {
      example: [
        { periodStart: '2026-08-03T00:00:00.000Z', samples: 14, successRate: 0.71, avgCostUsd: 0.003 },
      ],
    },
  })
  series(
    @Query('subject') subject: MetricSubject,
    @Query('subjectId') subjectId: string,
    @Query('period') period?: MetricPeriod,
    @Query('take') take?: string,
  ) {
    return this.analytics.series(
      subject ?? MetricSubject.WORKER,
      subjectId,
      period ?? MetricPeriod.DAY,
      Math.min(200, Number(take) || 30),
    );
  }
}

// ============================================================ Recommendations

@ApiTags('Learning')
@ApiBearerAuth('bearer')
@Controller('learning/recommendations')
export class RecommendationController {
  constructor(private readonly recommendations: RecommendationService) {}

  @Get()
  @RequirePermissions(Permissions.LearningRead)
  @ApiQuery({ name: 'status', required: false, enum: RecommendationStatus })
  @ApiOperation({
    summary: 'List recommendations',
    description:
      'Ordered by priority, which is estimated impact **multiplied by confidence**. ' +
      'Ranking on impact alone would put confident nonsense at the top of the list, ' +
      'which is exactly where a busy person’s attention goes.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0rec01', kind: 'PROVIDER_SWITCH', title: 'Move Research Worker to Claude Sonnet',
          reasoning: 'Succeeds 91% on Sonnet (34 runs) against 71% on GPT-4 (28 runs).',
          estimatedImpact: 0.28, impactSummary: '28% higher success rate',
          confidence: 0.79, sampleSize: 62, priority: 0.2212, risk: 'LOW', status: 'PROPOSED',
        },
      ],
    },
  })
  list(@Query('status') status?: RecommendationStatus, @Query('take') take?: string) {
    return this.recommendations.list(status, Math.min(200, Number(take) || 50));
  }

  @Get(':id')
  @RequirePermissions(Permissions.LearningRead)
  @ApiParam({ name: 'id', example: 'clx0rec01' })
  @ApiOperation({
    summary: 'Get one recommendation with its evidence and rollback',
    description: 'Everything needed to argue with it: the numbers, the change, and the way back.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'clx0rec01', proposedChange: { providerId: 'clx0prov02' },
        rollback: { providerId: 'clx0prov01', defaultModel: 'gpt-4' },
        evidence: { arms: [{ label: 'ANTHROPIC/claude-sonnet', runs: 34, successes: 31 }] },
      },
    },
  })
  get(@Param('id') id: string) {
    return this.recommendations.get(id);
  }

  @Post(':id/accept')
  @RequirePermissions(Permissions.LearningApprove)
  @ApiParam({ name: 'id', example: 'clx0rec01' })
  @ApiOperation({
    summary: 'Accept a recommendation',
    description: 'Marks it approved. Accepting does not apply it — that is a separate call.',
  })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0rec01', status: 'ACCEPTED' } } })
  accept(@Param('id') id: string, @Body() dto: AcceptDto) {
    return this.recommendations.accept(id, dto.notes);
  }

  @Post(':id/reject')
  @RequirePermissions(Permissions.LearningApprove)
  @ApiParam({ name: 'id', example: 'clx0rec01' })
  @ApiOperation({
    summary: 'Reject a recommendation',
    description:
      'The reason is required and is written into the learning repository — a rejection ' +
      'is evidence about the analyser, and "no" without a reason teaches nothing.',
  })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0rec01', status: 'REJECTED' } } })
  reject(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.recommendations.reject(id, dto.reason);
  }

  @Post(':id/apply')
  @RequirePermissions(Permissions.LearningApply)
  @ApiParam({ name: 'id', example: 'clx0rec01' })
  @ApiOperation({
    summary: 'Apply an accepted recommendation to production',
    description:
      'Refused unless a person has accepted it. The state being overwritten is captured ' +
      'immediately beforehand, so a rollback restores what was actually there rather ' +
      'than what the proposal assumed.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        applied: true, changed: { providerId: 'clx0prov02' },
        message: 'Applied to Research Worker.',
      },
    },
  })
  apply(@Param('id') id: string, @Body() dto: ApplyDto) {
    return this.recommendations.apply(id, { viaAutopilot: dto?.viaAutopilot === true });
  }

  @Post(':id/rollback')
  @RequirePermissions(Permissions.LearningApply)
  @ApiParam({ name: 'id', example: 'clx0rec01' })
  @ApiOperation({
    summary: 'Undo an applied recommendation',
    description: 'Restores the snapshot captured at apply time.',
  })
  @ApiCreatedResponse({
    schema: { example: { applied: false, message: 'Rolled back on Research Worker.' } },
  })
  rollback(@Param('id') id: string) {
    return this.recommendations.rollback(id);
  }
}

// ============================================================ Optimizers

@ApiTags('Learning')
@ApiBearerAuth('bearer')
@Controller('learning/optimize')
export class OptimizerController {
  constructor(
    private readonly workers: WorkerOptimizerService,
    private readonly workflows: WorkflowOptimizerService,
    private readonly knowledge: KnowledgeEvolutionService,
    private readonly patterns: PatternRecognitionService,
  ) {}

  @Post('workers')
  @RequirePermissions(Permissions.LearningRun)
  @ApiOperation({
    summary: 'Rebuild every worker profile and propose improvements',
    description:
      'Profiles are rebuilt from execution history rather than edited, so a profile ' +
      'always agrees with the logs it summarises. Nothing is written to a worker.',
  })
  @ApiCreatedResponse({ schema: { example: { profiled: 6, recommended: 4 } } })
  optimizeWorkers() {
    return this.workers.analyseAll();
  }

  @Get('workers/:workerId')
  @RequirePermissions(Permissions.LearningRead)
  @ApiParam({ name: 'workerId', example: 'clx0worker01' })
  @ApiOperation({ summary: 'Get one worker’s performance profile' })
  @ApiOkResponse({
    schema: {
      example: {
        workerId: 'clx0worker01', executions: 62, successRate: 0.79, avgCostUsd: 0.0031,
        preferredModel: 'claude-sonnet-4', bestPromptStyle: 'moderate (500-2000 chars) — 88% over 22 runs',
        strengths: ['reliable (79% floor on success rate)', 'fast'],
        weaknesses: ['reaches for tools it lacks access to (5 times)'],
        confidence: 0.72,
      },
    },
  })
  workerProfile(@Param('workerId') workerId: string) {
    return this.workers.get(workerId);
  }

  @Post('workers/:workerId')
  @RequirePermissions(Permissions.LearningRun)
  @ApiParam({ name: 'workerId', example: 'clx0worker01' })
  @ApiOperation({ summary: 'Re-analyse one worker' })
  @ApiCreatedResponse({ schema: { example: { profile: { executions: 62 }, recommendations: 2 } } })
  analyseWorker(@Param('workerId') workerId: string) {
    return this.workers.analyse(workerId);
  }

  @Post('workflows')
  @RequirePermissions(Permissions.LearningRun)
  @ApiOperation({
    summary: 'Analyse every workflow’s run history',
    description:
      'Findings come from step-level history, not from reading the graph: a step that ' +
      'looks redundant may be load-bearing, and only the runs can tell.',
  })
  @ApiCreatedResponse({ schema: { example: { analysed: 3, findings: 5, recommended: 5 } } })
  optimizeWorkflows() {
    return this.workflows.analyseAll();
  }

  @Get('workflows/:workflowId')
  @RequirePermissions(Permissions.LearningRead)
  @ApiParam({ name: 'workflowId', example: 'clx0workflow01' })
  @ApiOperation({ summary: 'Findings and step statistics for one workflow' })
  @ApiOkResponse({
    schema: {
      example: {
        samples: 47,
        findings: [
          {
            kind: 'parallelisable', stepIds: ['enrich', 'score'],
            detail: '2 steps have no dependencies on one another but run in sequence, costing about 4.2s per run.',
            estimatedImpact: 0.38, confidence: 0.76, samples: 47,
          },
        ],
        stats: [{ stepId: 'enrich', runs: 47, failures: 0, avgDurationMs: 3100, share: 0.44 }],
      },
    },
  })
  analyseWorkflow(@Param('workflowId') workflowId: string) {
    return this.workflows.analyse(workflowId);
  }

  @Post('knowledge/audit')
  @RequirePermissions(Permissions.LearningRun)
  @ApiOperation({
    summary: 'Audit the knowledge base',
    description:
      'Finds duplicates, stale and unused documents, missing tags and gaps. Records ' +
      'findings only — merging or deleting stays with a human, because both destroy ' +
      'information and a similarity score is a proxy, not a judgement about meaning.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        documents: 42, findings: 9, corpusConfidence: 0.86,
        byFinding: { NEAR_DUPLICATE: 2, OUTDATED: 3, UNUSED: 3, GAP: 1 },
      },
    },
  })
  auditKnowledge() {
    return this.knowledge.audit();
  }

  @Get('knowledge/findings')
  @RequirePermissions(Permissions.LearningRead)
  @ApiOperation({ summary: 'Open knowledge quality findings' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'clx0audit01', finding: 'NEAR_DUPLICATE', similarity: 0.71,
          detail: '"Onboarding" and "Onboarding v2" share 71% of their vocabulary.',
          suggestion: 'Review whether these should be one document.',
        },
      ],
    },
  })
  knowledgeFindings(@Query('take') take?: string) {
    return this.knowledge.findings(Math.min(500, Number(take) || 100));
  }

  @Post('knowledge/findings/:id/resolve')
  @RequirePermissions(Permissions.LearningApprove)
  @ApiParam({ name: 'id', example: 'clx0audit01' })
  @ApiOperation({
    summary: 'Mark a finding handled',
    description:
      'Records that a person considered it. The merge or deletion itself goes through ' +
      'the ordinary knowledge endpoints, where it is audited like any other write.',
  })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0audit01', resolvedAt: '2026-08-03T12:00:00.000Z' } } })
  resolveFinding(@Param('id') id: string, @Body() dto: ResolveFindingDto) {
    return this.knowledge.resolve(id, dto.resolution);
  }

  @Post('knowledge/:knowledgeId/rescore')
  @RequirePermissions(Permissions.LearningRun)
  @ApiParam({ name: 'knowledgeId', example: 'clx0know01' })
  @ApiOperation({
    summary: 'Recompute a document’s confidence from how it is used',
    description: 'Anchored on the stored value; usage nudges it rather than replacing a human’s assessment.',
  })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0know01', confidence: 0.82 } } })
  rescore(@Param('knowledgeId') knowledgeId: string) {
    return this.knowledge.rescore(knowledgeId);
  }

  @Post('patterns/detect')
  @RequirePermissions(Permissions.LearningRun)
  @ApiOperation({
    summary: 'Scan history for recurring patterns',
    description:
      'A candidate needs at least three occurrences, contradictions are counted ' +
      'alongside them, and every pattern carries a confidence band — so a regularity ' +
      'that holds eight times and fails seven is visibly not one.',
  })
  @ApiCreatedResponse({ schema: { example: { scanned: 118, found: 4 } } })
  detectPatterns() {
    return this.patterns.detect();
  }

  @Get('patterns')
  @RequirePermissions(Permissions.LearningRead)
  @ApiOperation({ summary: 'List detected patterns, strongest first' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          kind: 'FAILURE_MODE', occurrences: 11, confidence: 0.71, band: 'ESTABLISHED',
          statement: '"rate limit exceeded" has occurred in 11 missions. It is a recurring fault.',
        },
      ],
    },
  })
  listPatterns(@Query('take') take?: string) {
    return this.patterns.list(Math.min(200, Number(take) || 50));
  }

  @Post('patterns/:id/dismiss')
  @RequirePermissions(Permissions.LearningApprove)
  @ApiParam({ name: 'id', example: 'clx0pat01' })
  @ApiOperation({
    summary: 'Dismiss a pattern as spurious',
    description: 'Kept rather than deleted — a human saying "that is not real" is itself evidence.',
  })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0pat01', dismissedAt: '2026-08-03T12:00:00.000Z' } } })
  dismissPattern(@Param('id') id: string, @Body() dto: DismissPatternDto) {
    return this.patterns.dismiss(id, dto.reason);
  }
}

// ============================================================ Experiments

@ApiTags('Learning')
@ApiBearerAuth('bearer')
@Controller('learning/experiments')
export class ExperimentController {
  constructor(private readonly workflows: WorkflowOptimizerService) {}

  @Post()
  @RequirePermissions(Permissions.LearningRun)
  @ApiOperation({
    summary: 'Start an A/B test between two workflow versions',
    description:
      'Allocation is deterministic on the run id, so an assignment can be recomputed ' +
      'from the record later. One running experiment per workflow — two overlapping ' +
      'ones make both uninterpretable.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'clx0exp01', name: 'Parallel enrichment', status: 'RUNNING',
        allocation: 0.5, minRunsPerArm: 20,
      },
    },
  })
  start(@Body() dto: StartExperimentDto) {
    return this.workflows.startExperiment(dto);
  }

  @Get()
  @RequirePermissions(Permissions.LearningRead)
  @ApiOperation({ summary: 'List experiments' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          name: 'Parallel enrichment', status: 'CONCLUDED', winner: 'variant', confidence: 0.68,
          conclusion: 'variant wins: 92.0% against 78.0%. The results separate cleanly across 61 observations.',
        },
      ],
    },
  })
  list() {
    return this.workflows.listExperiments();
  }

  @Post(':id/evaluate')
  @RequirePermissions(Permissions.LearningRun)
  @ApiParam({ name: 'id', example: 'clx0exp01' })
  @ApiOperation({
    summary: 'Evaluate an experiment',
    description:
      'Declares a winner only when both arms have enough runs **and** their intervals ' +
      'separate. Stopping at the first favourable number is worse than not measuring.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        status: 'RUNNING', winner: null, confidence: 0,
        conclusion: 'No winner: the two arms overlap within their margins of error.',
      },
    },
  })
  evaluate(@Param('id') id: string) {
    return this.workflows.evaluate(id);
  }

  @Post(':id/abandon')
  @RequirePermissions(Permissions.LearningRun)
  @ApiParam({ name: 'id', example: 'clx0exp01' })
  @ApiOperation({ summary: 'Abandon an experiment' })
  @ApiCreatedResponse({ schema: { example: { id: 'clx0exp01', status: 'ABANDONED' } } })
  abandon(@Param('id') id: string, @Body() dto: DismissPatternDto) {
    return this.workflows.abandon(id, dto.reason);
  }
}

// ============================================================ Dashboard & repository

@ApiTags('Learning')
@ApiBearerAuth('bearer')
@Controller('learning')
export class LearningDashboardController {
  constructor(private readonly dashboard: LearningDashboardService) {}

  @Get('dashboard')
  @RequirePermissions(Permissions.LearningRead)
  @ApiQuery({ name: 'days', required: false, example: 7 })
  @ApiOperation({
    summary: 'What has PRISM-X learned?',
    description:
      'The digest. `learned` is the part that matters: only genuinely new findings go ' +
      'in it, and when nothing recurs often enough to conclude anything, it says so ' +
      'rather than padding the list with standing facts.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        headline: '23 mission(s) reviewed, 78% clean, $1.4120 spent — improving. 4 thing(s) learned.',
        learned: [
          '"rate limit exceeded" has occurred in 11 missions. It is a recurring fault. (established, 11 observations)',
          'Experiment "Parallel enrichment": variant wins: 92.0% against 78.0%.',
          '2 improvement(s) are backed by enough evidence to act on, starting with: Move Research Worker to Claude Sonnet — 28% higher success rate.',
          'Success score improving by 9.0 points against the previous 7 days, cost per mission down $0.0021.',
        ],
        missions: { reviewed: 23, succeeded: 18, partial: 3, failed: 2, avgSuccessScore: 0.81 },
        improvement: { direction: 'improving', successRateChange: 0.09, costChange: -0.0021 },
      },
    },
  })
  digest(@Query('days') days?: string) {
    return this.dashboard.digest(Math.min(90, Number(days) || 7));
  }

  @Get('repository')
  @RequirePermissions(Permissions.LearningRead)
  @ApiQuery({ name: 'kind', required: false, enum: LearningEntryKind })
  @ApiOperation({
    summary: 'Browse the learning repository',
    description:
      'Institutional memory, deliberately separate from operational knowledge. Nothing ' +
      'here is fed to a worker as context — the system’s notes about its own weaknesses ' +
      'have no business appearing in an answer to a customer’s question.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          kind: 'DECISION', title: 'Rejected: Move Research Worker to Claude Sonnet',
          body: 'A human rejected this recommendation. Reason: client requires GPT-4 for consistency.',
          confidence: 0.79, sampleSize: 62,
        },
      ],
    },
  })
  repository(@Query('kind') kind?: LearningEntryKind, @Query('take') take?: string) {
    return this.dashboard.history(kind, Math.min(200, Number(take) || 50));
  }

  @Post('repository')
  @RequirePermissions(Permissions.LearningRun)
  @ApiOperation({
    summary: 'Record a lesson by hand',
    description:
      'The repository is not only machine-written. A person who has just worked out why ' +
      'something kept failing records it in the same place the system records what it noticed.',
  })
  @ApiCreatedResponse({
    schema: { example: { id: 'clx0entry01', kind: 'LESSON', title: 'Rate limits bite on Monday mornings' } },
  })
  recordLesson(@Body() dto: RecordLessonDto) {
    return this.dashboard.record(dto);
  }

  @Get('confidence')
  @RequirePermissions(Permissions.LearningRead)
  @ApiQuery({ name: 'samples', example: 12 })
  @ApiQuery({ name: 'consistency', required: false, example: 0.9 })
  @ApiQuery({ name: 'ageDays', required: false, example: 0 })
  @ApiOperation({
    summary: 'Explain a confidence score',
    description:
      'The scale every claim in the Learning Engine is scored on: volume × quality × ' +
      'recency, multiplied rather than averaged so any one of them being near zero sinks ' +
      'the claim. Three consistent data points are what coincidence looks like.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        value: 0.4, percent: 40, band: 'EMERGING', samples: 12,
        factors: { volume: 0.5, quality: 0.8, recency: 1 },
        rationale: 'Suggested by 12 observations, but 12 observations is a thin basis — worth watching.',
      },
    },
  })
  explainConfidence(
    @Query('samples') samples: string,
    @Query('consistency') consistency?: string,
    @Query('ageDays') ageDays?: string,
  ) {
    return Confidence.score({
      samples: Number(samples) || 0,
      consistency: consistency === undefined ? undefined : Number(consistency),
      ageDays: ageDays === undefined ? undefined : Number(ageDays),
    });
  }
}
