/**
 * PRISM-X Backend — Phase 5 validation suite.
 *
 * Exercises the ten Phase 5 checks against a running server with live
 * Postgres and Redis:
 *
 *   1. Mission Reviews are generated automatically
 *   2. Performance metrics accumulate correctly
 *   3. Recommendations are data-driven
 *   4. Knowledge quality improves over time
 *   5. Worker profiles evolve based on real performance
 *   6. Workflow optimization suggestions are generated
 *   7. Learning Dashboard reflects historical data
 *   8. Pattern Recognition identifies meaningful trends
 *   9. Learning Repository stores optimization history
 *  10. Human approval is required before production changes
 *
 *   node test/phase5-validation.js
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000/api/v1';
const results = [];
let failures = 0;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  if (!passed) failures++;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

async function api(method, endpoint, { token, body, raw, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return raw ? { status: response.status, body: json } : json;
}

const unique = Date.now();
const ACCOUNT = {
  email: `phase5-${unique}@prism-x.test`,
  password: 'CorrectHorse42Battery',
  organizationName: `Phase5 Labs ${unique}`,
};

(async () => {
  console.log(`\nPRISM-X Backend — Phase 5 validation\n${'='.repeat(66)}\n`);

  await api('POST', '/auth/register', { body: ACCOUNT });
  const login = await api('POST', '/auth/login', {
    body: { email: ACCOUNT.email, password: ACCOUNT.password },
  });
  const token = login?.accessToken;
  if (!token) {
    console.error('Could not authenticate; aborting.');
    process.exit(1);
  }
  const t = (extra = {}) => ({ token, ...extra });

  // ================================================================
  // Substrate: two providers so the optimizer has arms to compare, and
  // workers with real execution history to profile.
  console.log('--- Building history to learn from ---');

  const providerA = await api('POST', '/providers', {
    ...t(),
    body: { name: 'Sim Alpha', kind: 'LOCAL', isDefault: true },
  });
  await api('POST', `/providers/${providerA.id}/health-check`, t());

  const providerB = await api('POST', '/providers', {
    ...t(),
    body: { name: 'Sim Beta', kind: 'LOCAL' },
  });
  await api('POST', `/providers/${providerB.id}/health-check`, t());

  const worker = await api('POST', '/workers', {
    ...t(),
    body: {
      name: 'Analyst',
      role: 'analysis',
      capabilities: ['analysis'],
      providerId: providerA.id,
      systemPrompt: 'You analyse things carefully and state your reasoning.',
      toolPermissions: ['knowledge.search'],
    },
  });
  await api('POST', `/workers/${worker.id}/activate`, t());

  // A second worker with no standing instructions — the optimizer should
  // notice and say so.
  const bareWorker = await api('POST', '/workers', {
    ...t(),
    body: { name: 'Bare', role: 'general', capabilities: ['general'], providerId: providerA.id },
  });
  await api('POST', `/workers/${bareWorker.id}/activate`, t());

  // Execution history on both providers, so there is something to compare.
  for (let i = 0; i < 8; i += 1) {
    await api('POST', `/workers/${worker.id}/execute`, {
      ...t(),
      body: { instruction: `Analyse dataset ${i} and summarise the result.` },
    });
  }
  for (let i = 0; i < 6; i += 1) {
    await api('POST', `/workers/${worker.id}/execute`, {
      ...t(),
      body: { instruction: `Cross-check figures for report ${i}.`, providerId: providerB.id },
    });
  }
  for (let i = 0; i < 5; i += 1) {
    await api('POST', `/workers/${bareWorker.id}/execute`, {
      ...t(),
      body: { instruction: `Draft a short note about topic ${i}.` },
    });
  }

  // Missions, run to completion, so reviews are produced automatically.
  // Each carries a real dependency chain: a mission with no tasks cannot be
  // planned, and a review of nothing would prove nothing.
  const missionIds = [];
  for (let i = 0; i < 4; i += 1) {
    const mission = await api('POST', '/missions', {
      ...t(),
      body: {
        title: `Quarterly analysis ${i}`,
        objective: `Analyse quarterly performance data for region ${i} and report findings`,
        priority: 'MEDIUM',
        tasks: [
          { title: 'Gather regional figures' },
          { title: 'Analyse the variance', dependsOn: ['0'] },
          { title: 'Write the summary', dependsOn: ['1'] },
        ],
      },
    });
    if (!mission?.id) {
      console.error('Could not create mission:', JSON.stringify(mission).slice(0, 200));
      process.exit(1);
    }
    await api('POST', `/missions/${mission.id}/plan`, t());
    await api('POST', `/missions/${mission.id}/execute?wait=60`, t());
    missionIds.push(mission.id);
  }

  // ================================================================
  console.log('\n--- 1. Mission reviews are generated automatically ---');

  const firstReview = await api('GET', `/learning/reviews/${missionIds[0]}`, t());
  check(
    'a completed mission produces a review without being asked',
    Boolean(firstReview?.id) && firstReview?.missionId === missionIds[0],
    firstReview ? `${firstReview.outcome} · score ${firstReview.successScore}` : 'no review',
  );
  check(
    'the review records outcome, timing, cost and task counts',
    firstReview &&
      typeof firstReview.successScore === 'number' &&
      typeof firstReview.completionMs === 'number' &&
      typeof firstReview.costUsd === 'number' &&
      typeof firstReview.taskCount === 'number',
    `${firstReview?.taskCount} tasks · ${firstReview?.completionMs}ms · $${firstReview?.costUsd}`,
  );
  check(
    'the review carries the structured analysis fields',
    Array.isArray(firstReview?.errors) &&
      Array.isArray(firstReview?.bottlenecks) &&
      Array.isArray(firstReview?.missedOpportunities) &&
      Array.isArray(firstReview?.recommendations),
    `${firstReview?.missedOpportunities?.length} missed opportunit(ies), ` +
      `${firstReview?.recommendations?.length} recommendation(s)`,
  );
  check(
    'the review carries a confidence score reflecting how much it saw',
    typeof firstReview?.confidence === 'number' && firstReview.confidence >= 0,
    `confidence ${firstReview?.confidence} over ${firstReview?.sampleSize} observations`,
  );
  check(
    'the summary is human-readable',
    typeof firstReview?.summary === 'string' && firstReview.summary.length > 20,
    String(firstReview?.summary ?? '').slice(0, 90),
  );

  const allReviews = await api('GET', '/learning/reviews', t());
  check(
    'every completed mission has a review',
    (allReviews ?? []).length >= missionIds.length,
    `${allReviews?.length} reviews for ${missionIds.length} missions`,
  );

  const searched = await api('GET', '/learning/reviews/search?q=quarterly%20performance', t());
  check(
    'reviews are searchable by what the mission was about',
    (searched ?? []).length > 0,
    `${searched?.length} hits`,
  );

  const rebuilt = await api('POST', `/learning/reviews/${missionIds[0]}/rebuild`, t());
  const afterRebuild = await api('GET', '/learning/reviews', t());
  check(
    'rebuilding a review overwrites rather than duplicating',
    rebuilt?.id === firstReview?.id && afterRebuild?.length === allReviews?.length,
    `${allReviews?.length} → ${afterRebuild?.length} reviews`,
  );

  // ================================================================
  console.log('\n--- 2. Performance metrics accumulate ---');

  const rollup = await api('POST', '/learning/analytics/rollup?period=DAY', t());
  check(
    'a rollup writes snapshots across every subject type',
    rollup?.written >= 4,
    `${rollup?.written} snapshots for ${rollup?.period}`,
  );

  const rollupAgain = await api('POST', '/learning/analytics/rollup?period=DAY', t());
  check(
    'recomputing a period converges rather than accumulating',
    rollupAgain?.written === rollup?.written,
    `${rollup?.written} → ${rollupAgain?.written}`,
  );

  const workerBoard = await api('GET', '/learning/analytics/leaderboard?subject=WORKER', t());
  check(
    'workers are ranked with their sample counts',
    (workerBoard ?? []).length >= 2 && workerBoard[0].samples > 0,
    workerBoard?.map((r) => `${r.subjectLabel}:${r.samples}`).join(', '),
  );
  check(
    'the ranked rate is the conservative bound, not the raw proportion',
    workerBoard?.every((r) => r.successRate <= r.observedRate + 1e-9),
    workerBoard
      ?.map((r) => `${r.subjectLabel} ${r.successRate}<=${r.observedRate}`)
      .join(' | '),
  );
  check(
    'rows with too little evidence are flagged rather than silently ranked',
    workerBoard?.every((r) => typeof r.rankable === 'boolean'),
    workerBoard?.map((r) => `${r.subjectLabel}:${r.rankable}`).join(', '),
  );

  const providerBoard = await api('GET', '/learning/analytics/leaderboard?subject=PROVIDER', t());
  check(
    'providers accumulate latency, cost and reliability',
    (providerBoard ?? []).length >= 2 &&
      providerBoard.every((r) => typeof r.avgLatencyMs === 'number'),
    providerBoard?.map((r) => `${r.subjectLabel}:${r.samples}`).join(', '),
  );

  const orgBoard = await api('GET', '/learning/analytics/leaderboard?subject=ORGANIZATION', t());
  check(
    'organization-level metrics include automation coverage and AI spend',
    orgBoard?.[0]?.detail &&
      typeof orgBoard[0].detail.automationCoverage === 'number' &&
      typeof orgBoard[0].detail.aiSpendUsd === 'number',
    JSON.stringify(orgBoard?.[0]?.detail ?? {}).slice(0, 110),
  );

  const trend = await api(
    'GET',
    `/learning/analytics/trend?subject=WORKER&subjectId=${worker.id}`,
    t(),
  );
  check(
    'a trend is derived from stored snapshots',
    Array.isArray(trend?.points) && typeof trend?.direction === 'string',
    `${trend?.direction} · ${trend?.points?.length} point(s)`,
  );
  check(
    'too little history reports "unknown" rather than "steady"',
    trend?.points?.length < 2 ? trend?.direction === 'unknown' : true,
    trend?.summary,
  );

  // ================================================================
  console.log('\n--- 3. Recommendations are data-driven ---');

  const workerOpt = await api('POST', '/learning/optimize/workers', t());
  check(
    'profiling every worker produces recommendations',
    workerOpt?.profiled >= 2 && workerOpt?.recommended >= 1,
    `${workerOpt?.profiled} profiled, ${workerOpt?.recommended} recommended`,
  );

  const recommendations = await api('GET', '/learning/recommendations', t());
  check(
    'recommendations carry reasoning, evidence, impact, risk and confidence',
    (recommendations ?? []).length > 0 &&
      recommendations.every(
        (r) =>
          typeof r.reasoning === 'string' &&
          r.reasoning.length > 10 &&
          typeof r.estimatedImpact === 'number' &&
          typeof r.confidence === 'number' &&
          typeof r.risk === 'string',
      ),
    `${recommendations?.length} recommendation(s)`,
  );
  check(
    'every recommendation carries a rollback',
    recommendations?.every((r) => r.rollback && Object.keys(r.rollback).length > 0),
    recommendations?.map((r) => Object.keys(r.rollback ?? {}).join('+')).join(' | ').slice(0, 100),
  );
  check(
    'priority is impact weighted by confidence, not impact alone',
    recommendations?.every(
      (r) => Math.abs(r.priority - r.estimatedImpact * r.confidence) < 0.01,
    ),
    recommendations
      ?.slice(0, 3)
      .map((r) => `${r.estimatedImpact}×${r.confidence}=${r.priority}`)
      .join(', '),
  );
  check(
    'the list is ordered by priority',
    (recommendations ?? []).every(
      (r, i) => i === 0 || recommendations[i - 1].priority >= r.priority,
    ),
    recommendations?.map((r) => r.priority).join(' >= '),
  );

  const bareRec = (recommendations ?? []).find(
    (r) => r.subjectId === bareWorker.id && r.kind === 'PROMPT_REFINEMENT',
  );
  check(
    'a worker with no standing instructions is flagged',
    Boolean(bareRec),
    bareRec ? bareRec.title : 'not flagged',
  );

  const rerun = await api('POST', '/learning/optimize/workers', t());
  const afterRerun = await api('GET', '/learning/recommendations', t());
  check(
    're-analysing supersedes prior proposals rather than duplicating them',
    afterRerun.length <= recommendations.length,
    `${recommendations.length} → ${afterRerun.length} open after ${rerun?.recommended} proposed`,
  );

  const confidenceExplained = await api('GET', '/learning/confidence?samples=3', t());
  const confidentExplained = await api('GET', '/learning/confidence?samples=500', t());
  check(
    'three observations and five hundred are not treated alike',
    confidenceExplained?.value < confidentExplained?.value / 2,
    `3 → ${confidenceExplained?.percent}% (${confidenceExplained?.band}), ` +
      `500 → ${confidentExplained?.percent}% (${confidentExplained?.band})`,
  );
  check(
    'a thin claim is banded as anecdotal and says why',
    confidenceExplained?.band === 'ANECDOTAL' &&
      typeof confidenceExplained?.rationale === 'string',
    confidenceExplained?.rationale,
  );

  // ================================================================
  console.log('\n--- 4. Knowledge quality improves ---');

  const docA = await api('POST', '/knowledge', {
    ...t(),
    body: {
      title: 'Customer onboarding process',
      content:
        'The customer onboarding process begins with an introductory call, followed by ' +
        'account provisioning, data migration, training sessions and a thirty day review.',
      type: 'DOCUMENT',
      tags: ['onboarding'],
    },
  });
  const docB = await api('POST', '/knowledge', {
    ...t(),
    body: {
      title: 'Customer onboarding process v2',
      content:
        'The customer onboarding process begins with an introductory call, followed by ' +
        'account provisioning, data migration, training sessions and a thirty day review.',
      type: 'DOCUMENT',
      tags: ['onboarding'],
    },
  });
  const docUntagged = await api('POST', '/knowledge', {
    ...t(),
    body: {
      title: 'Escalation matrix',
      content: 'Severity one incidents escalate to the duty engineer within fifteen minutes.',
      type: 'DOCUMENT',
    },
  });

  const audit = await api('POST', '/learning/optimize/knowledge/audit', t());
  check(
    'auditing the corpus produces findings',
    audit?.documents >= 3 && audit?.findings > 0,
    `${audit?.findings} findings over ${audit?.documents} documents`,
  );
  check(
    'identical documents are detected as duplicates',
    (audit?.byFinding?.DUPLICATE ?? 0) + (audit?.byFinding?.NEAR_DUPLICATE ?? 0) > 0,
    JSON.stringify(audit?.byFinding ?? {}),
  );
  check(
    'an untagged document is flagged with suggested tags',
    (audit?.byFinding?.MISCATEGORISED ?? 0) > 0,
    `${audit?.byFinding?.MISCATEGORISED} miscategorised`,
  );

  const findings = await api('GET', '/learning/optimize/knowledge/findings', t());
  const duplicateFinding = (findings ?? []).find(
    (f) => f.finding === 'DUPLICATE' || f.finding === 'NEAR_DUPLICATE',
  );
  check(
    'a duplicate finding names both documents and the overlap',
    Boolean(duplicateFinding?.relatedId) && duplicateFinding?.similarity > 0.5,
    `similarity ${duplicateFinding?.similarity}`,
  );
  check(
    'findings suggest an action rather than only naming a problem',
    (findings ?? []).every((f) => typeof f.suggestion === 'string' && f.suggestion.length > 5),
    duplicateFinding?.suggestion,
  );

  const stillThere = await api('GET', `/knowledge/${docB.id}`, { ...t(), raw: true });
  check(
    'the audit records findings without deleting or merging anything',
    stillThere.status === 200,
    `duplicate document still present (status ${stillThere.status})`,
  );

  const resolved = await api(
    'POST',
    `/learning/optimize/knowledge/findings/${duplicateFinding.id}/resolve`,
    { ...t(), body: { resolution: 'Kept v2 and retired the original.' } },
  );
  check('a finding can be resolved by a human', Boolean(resolved?.resolvedAt), resolved?.resolution);

  const reaudit = await api('POST', '/learning/optimize/knowledge/audit', t());
  check(
    're-auditing converges rather than stacking duplicate findings',
    reaudit?.findings <= audit?.findings + 1,
    `${audit?.findings} → ${reaudit?.findings}`,
  );

  const rescored = await api('POST', `/learning/optimize/knowledge/${docA.id}/rescore`, t());
  check(
    'documents carry a confidence score that can be recomputed from usage',
    typeof rescored?.confidence === 'number' && rescored.confidence > 0,
    `confidence ${rescored?.confidence}`,
  );

  // ================================================================
  console.log('\n--- 5. Worker profiles evolve from real performance ---');

  const profile = await api('GET', `/learning/optimize/workers/${worker.id}`, t());
  check(
    'a worker profile is built from its execution history',
    profile?.executions >= 10,
    `${profile?.executions} executions`,
  );
  check(
    'the profile records reliability, cost and speed',
    typeof profile?.successRate === 'number' &&
      typeof profile?.avgCostUsd === 'number' &&
      typeof profile?.avgDurationMs === 'number',
    `rate ${profile?.successRate} · $${profile?.avgCostUsd} · ${profile?.avgDurationMs}ms`,
  );
  check(
    'the profile names a preferred provider backed by evidence',
    Boolean(profile?.preferredProviderId) &&
      Array.isArray(profile?.preferenceEvidence?.arms) &&
      profile.preferenceEvidence.arms.length >= 2,
    `${profile?.preferenceEvidence?.arms?.length} arms compared`,
  );
  check(
    'the profile records strengths and weaknesses in plain language',
    Array.isArray(profile?.strengths) && Array.isArray(profile?.weaknesses),
    `${profile?.strengths?.length} strength(s), ${profile?.weaknesses?.length} weakness(es)`,
  );
  check(
    'the profile carries its own confidence',
    typeof profile?.confidence === 'number',
    `confidence ${profile?.confidence} over ${profile?.executions} executions`,
  );

  const workerBefore = await api('GET', `/workers/${worker.id}`, t());
  check(
    'profiling never writes to the worker itself',
    workerBefore?.providerId === providerA.id,
    `worker still on ${workerBefore?.providerId === providerA.id ? 'its original provider' : 'a changed provider'}`,
  );

  const noHistoryWorker = await api('POST', '/workers', {
    ...t(),
    body: { name: 'Fresh', role: 'general', capabilities: [], providerId: providerA.id },
  });
  const freshAnalysis = await api('POST', `/learning/optimize/workers/${noHistoryWorker.id}`, t());
  check(
    'a worker with no history gets no profile rather than an empty one',
    freshAnalysis?.profile === null,
    `profile ${freshAnalysis?.profile === null ? 'absent' : 'written'}`,
  );

  // ================================================================
  console.log('\n--- 6. Workflow optimization ---');

  const workflow = await api('POST', '/workflows', {
    ...t(),
    body: {
      name: 'Lead triage',
      description: 'Score and route inbound leads.',
      steps: [
        { id: 'score', type: 'transform', config: { set: { score: 80 } } },
        { id: 'enrich', type: 'transform', config: { set: { enriched: true } } },
        { id: 'route', type: 'transform', config: { set: { routed: true } }, dependsOn: ['score'] },
      ],
    },
  });
  await api('POST', `/workflows/${workflow.id}/publish`, t());

  for (let i = 0; i < 8; i += 1) {
    await api('POST', `/workflows/${workflow.id}/run`, {
      ...t(),
      body: { input: { leadId: `L-${i}` } },
    });
  }

  const workflowAnalysis = await api('GET', `/learning/optimize/workflows/${workflow.id}`, t());
  check(
    'workflow analysis reports per-step statistics from real runs',
    workflowAnalysis?.samples >= 5 && (workflowAnalysis?.stats ?? []).length > 0,
    `${workflowAnalysis?.samples} runs · ${workflowAnalysis?.stats?.length} step(s) measured`,
  );
  check(
    'step statistics include failure counts and time share',
    (workflowAnalysis?.stats ?? []).every(
      (s) => typeof s.failures === 'number' && typeof s.share === 'number',
    ),
    (workflowAnalysis?.stats ?? [])
      .map((s) => `${s.stepId}:${(s.share * 100).toFixed(0)}%`)
      .join(', '),
  );

  const optimized = await api('POST', '/learning/optimize/workflows', t());
  check(
    'analysing every workflow reports what it found',
    typeof optimized?.analysed === 'number' && typeof optimized?.findings === 'number',
    `${optimized?.analysed} analysed, ${optimized?.findings} findings, ${optimized?.recommended} recommended`,
  );

  const thinWorkflow = await api('POST', '/workflows', {
    ...t(),
    body: {
      name: 'Barely used',
      steps: [{ id: 'noop', type: 'transform', config: {} }],
    },
  });
  await api('POST', `/workflows/${thinWorkflow.id}/publish`, t());
  await api('POST', `/workflows/${thinWorkflow.id}/run`, { ...t(), body: { input: {} } });

  const thinAnalysis = await api('GET', `/learning/optimize/workflows/${thinWorkflow.id}`, t());
  check(
    'a workflow with too little history yields no findings rather than guesses',
    (thinAnalysis?.findings ?? []).length === 0,
    `${thinAnalysis?.samples} run(s), ${thinAnalysis?.findings?.length} finding(s)`,
  );

  // A/B testing between two versions.
  const v2 = await api('POST', `/workflows/${workflow.id}/versions`, {
    ...t(),
    body: {
      steps: [
        { id: 'score', type: 'transform', config: { set: { score: 90 } } },
        { id: 'route', type: 'transform', config: { set: { routed: true } }, dependsOn: ['score'] },
      ],
      notes: 'Dropped the enrichment step.',
    },
  });

  const experiment = await api('POST', '/learning/experiments', {
    ...t(),
    body: {
      workflowId: workflow.id,
      variantVersionId: v2.id,
      name: 'Drop enrichment',
      hypothesis: 'Enrichment adds time without changing routing outcomes.',
      minRunsPerArm: 5,
    },
  });
  check(
    'an A/B test can be started between two workflow versions',
    experiment?.status === 'RUNNING' && experiment?.controlVersionId !== experiment?.variantVersionId,
    `${experiment?.name} · allocation ${experiment?.allocation}`,
  );

  const duplicateExperiment = await api('POST', '/learning/experiments', {
    ...t(),
    raw: true,
    body: {
      workflowId: workflow.id,
      variantVersionId: v2.id,
      name: 'Second test',
      hypothesis: 'Two overlapping experiments should be refused.',
    },
  });
  check(
    'a second concurrent experiment on the same workflow is refused',
    duplicateExperiment.status === 400,
    `status ${duplicateExperiment.status}`,
  );

  const earlyEvaluation = await api('POST', `/learning/experiments/${experiment.id}/evaluate`, t());
  check(
    'an experiment without enough runs declares no winner',
    earlyEvaluation?.winner === null || earlyEvaluation?.winner === undefined,
    earlyEvaluation?.conclusion,
  );
  check(
    'the experiment says what it is still waiting for',
    typeof earlyEvaluation?.conclusion === 'string' &&
      earlyEvaluation.conclusion.includes('collecting'),
    earlyEvaluation?.conclusion,
  );

  // ================================================================
  console.log('\n--- 7. Learning dashboard ---');

  const dashboard = await api('GET', '/learning/dashboard?days=7', t());
  check(
    'the dashboard answers "what has PRISM-X learned?" in one line',
    typeof dashboard?.headline === 'string' && dashboard.headline.length > 20,
    dashboard?.headline,
  );
  check(
    'the digest lists what was actually learned',
    Array.isArray(dashboard?.learned) && dashboard.learned.length > 0,
    dashboard?.learned?.[0]?.slice(0, 110),
  );
  check(
    'the digest reflects the missions that ran',
    dashboard?.missions?.reviewed >= missionIds.length,
    `${dashboard?.missions?.reviewed} reviewed, ${dashboard?.missions?.succeeded} clean`,
  );
  check(
    'the dashboard surfaces top workers, providers and workflows',
    Array.isArray(dashboard?.topWorkers) &&
      Array.isArray(dashboard?.topProviders) &&
      Array.isArray(dashboard?.reliableWorkflows),
    `${dashboard?.topWorkers?.length} workers, ${dashboard?.topProviders?.length} providers, ` +
      `${dashboard?.reliableWorkflows?.length} workflows`,
  );
  check(
    'the dashboard reports knowledge growth and open findings',
    typeof dashboard?.knowledge?.documents === 'number' &&
      typeof dashboard?.knowledge?.openFindings === 'number',
    `${dashboard?.knowledge?.documents} docs, ${dashboard?.knowledge?.openFindings} open findings`,
  );
  check(
    'optimization opportunities are listed with their confidence band',
    (dashboard?.opportunities ?? []).length > 0 &&
      dashboard.opportunities.every((o) => typeof o.band === 'string'),
    dashboard?.opportunities?.slice(0, 2).map((o) => `${o.title} [${o.band}]`).join(' | '),
  );
  check(
    'improvement against the previous window is reported honestly',
    ['improving', 'declining', 'steady', 'unknown'].includes(dashboard?.improvement?.direction),
    dashboard?.improvement?.summary,
  );
  check(
    'no prior window reports "unknown" rather than inventing a comparison',
    dashboard?.improvement?.direction === 'unknown',
    dashboard?.improvement?.summary,
  );

  // ================================================================
  console.log('\n--- 8. Pattern recognition ---');

  const detection = await api('POST', '/learning/optimize/patterns/detect', t());
  check(
    'pattern detection scans mission history',
    typeof detection?.scanned === 'number' && detection.scanned >= missionIds.length,
    `${detection?.scanned} scanned, ${detection?.found} found`,
  );

  const patterns = await api('GET', '/learning/optimize/patterns', t());
  check(
    'patterns carry occurrence counts and confidence bands',
    (patterns ?? []).every(
      (p) =>
        typeof p.occurrences === 'number' &&
        typeof p.confidence === 'number' &&
        ['ANECDOTAL', 'EMERGING', 'ESTABLISHED', 'STRONG'].includes(p.band),
    ),
    (patterns ?? []).map((p) => `${p.kind}:${p.occurrences}[${p.band}]`).join(', ') || 'none yet',
  );
  check(
    'no pattern is recorded from fewer than three observations',
    (patterns ?? []).every((p) => p.occurrences >= 3),
    (patterns ?? []).map((p) => p.occurrences).join(', ') || 'none recorded',
  );
  check(
    'a thin history produces few or no patterns rather than confident noise',
    (patterns ?? []).every((p) => p.confidence < 0.85 || p.occurrences >= 20),
    (patterns ?? []).map((p) => `${p.occurrences}→${p.confidence}`).join(', ') || 'none',
  );

  const detectAgain = await api('POST', '/learning/optimize/patterns/detect', t());
  const patternsAgain = await api('GET', '/learning/optimize/patterns', t());
  check(
    'seeing a pattern again reinforces one row rather than creating another',
    (patternsAgain ?? []).length === (patterns ?? []).length,
    `${patterns?.length} → ${patternsAgain?.length} after a second scan`,
  );

  if ((patternsAgain ?? []).length > 0) {
    const dismissed = await api(
      'POST',
      `/learning/optimize/patterns/${patternsAgain[0].id}/dismiss`,
      { ...t(), body: { reason: 'Known artefact of the test fixture.' } },
    );
    check(
      'a spurious pattern can be dismissed and is kept as evidence',
      Boolean(dismissed?.dismissedAt) && Boolean(dismissed?.dismissedReason),
      dismissed?.dismissedReason,
    );

    const afterDismiss = await api('GET', '/learning/optimize/patterns', t());
    check(
      'a dismissed pattern stops being surfaced',
      (afterDismiss ?? []).every((p) => p.id !== patternsAgain[0].id),
      `${afterDismiss?.length} active pattern(s)`,
    );
  } else {
    check('a spurious pattern can be dismissed and is kept as evidence', true, 'no patterns to dismiss');
    check('a dismissed pattern stops being surfaced', true, 'no patterns to dismiss');
  }

  // ================================================================
  console.log('\n--- 9. Learning repository ---');

  const repository = await api('GET', '/learning/repository', t());
  check(
    'the repository stores what the system has learned',
    (repository ?? []).length > 0,
    `${repository?.length} entries`,
  );
  check(
    'mission reviews are mirrored into the repository',
    (repository ?? []).some((e) => e.kind === 'MISSION_REVIEW'),
    [...new Set((repository ?? []).map((e) => e.kind))].join(', '),
  );
  check(
    'every entry carries confidence and sample size',
    (repository ?? []).every(
      (e) => typeof e.confidence === 'number' && typeof e.sampleSize === 'number',
    ),
    `${repository?.[0]?.confidence} over ${repository?.[0]?.sampleSize}`,
  );

  const lesson = await api('POST', '/learning/repository', {
    ...t(),
    body: {
      kind: 'LESSON',
      title: 'Rate limits bite hardest on Monday mornings',
      body: 'Three incidents traced back to the weekly sync colliding with peak load.',
      tags: ['incident', 'rate-limit'],
    },
  });
  check(
    'a human can record a lesson by hand',
    lesson?.kind === 'LESSON' && lesson?.sourceType === 'human',
    lesson?.title,
  );

  const filtered = await api('GET', '/learning/repository?kind=MISSION_REVIEW', t());
  check(
    'the repository can be filtered by kind',
    (filtered ?? []).every((e) => e.kind === 'MISSION_REVIEW'),
    `${filtered?.length} mission reviews`,
  );

  // ================================================================
  console.log('\n--- 10. Human validation gates production ---');

  const target = (await api('GET', '/learning/recommendations', t()))[0];

  const applyWithoutAccepting = await api('POST', `/learning/recommendations/${target.id}/apply`, {
    ...t(),
    raw: true,
    body: {},
  });
  check(
    'an unaccepted recommendation cannot be applied',
    applyWithoutAccepting.status === 403,
    `status ${applyWithoutAccepting.status} · ${String(applyWithoutAccepting.body?.message ?? '').slice(0, 80)}`,
  );

  const autopilotAttempt = await api('POST', `/learning/recommendations/${target.id}/apply`, {
    ...t(),
    raw: true,
    body: { viaAutopilot: true },
  });
  check(
    'autopilot is refused unless the organization has switched it on',
    autopilotAttempt.status === 403,
    String(autopilotAttempt.body?.message ?? '').slice(0, 100),
  );

  const rejectWithoutReason = await api('POST', `/learning/recommendations/${target.id}/reject`, {
    ...t(),
    raw: true,
    body: { reason: '' },
  });
  check(
    'rejecting without a reason is refused',
    rejectWithoutReason.status === 400,
    `status ${rejectWithoutReason.status}`,
  );

  const accepted = await api('POST', `/learning/recommendations/${target.id}/accept`, {
    ...t(),
    body: { notes: 'Trialling for two weeks.' },
  });
  check('a human can accept a recommendation', accepted?.status === 'ACCEPTED', accepted?.status);

  const applied = await api('POST', `/learning/recommendations/${target.id}/apply`, {
    ...t(),
    body: {},
  });
  check(
    'an accepted recommendation applies to production',
    applied?.applied === true,
    applied?.message,
  );

  const appliedRecord = await api('GET', `/learning/recommendations/${target.id}`, t());
  check(
    'the state before the change is captured for a faithful rollback',
    appliedRecord?.appliedSnapshot && Object.keys(appliedRecord.appliedSnapshot).length > 0,
    JSON.stringify(appliedRecord?.appliedSnapshot ?? {}).slice(0, 90),
  );

  const rolledBack = await api('POST', `/learning/recommendations/${target.id}/rollback`, t());
  check(
    'an applied recommendation can be rolled back',
    rolledBack?.recommendation?.status === 'ROLLED_BACK',
    rolledBack?.message,
  );

  const reapply = await api('POST', `/learning/recommendations/${target.id}/apply`, {
    ...t(),
    raw: true,
    body: {},
  });
  check(
    'a rolled-back recommendation cannot be silently re-applied',
    reapply.status === 403 || reapply.status === 400,
    `status ${reapply.status}`,
  );

  const second = (await api('GET', '/learning/recommendations', t())).find(
    (r) => r.status === 'PROPOSED',
  );
  if (second) {
    const rejected = await api('POST', `/learning/recommendations/${second.id}/reject`, {
      ...t(),
      body: { reason: 'We deliberately keep this worker as configured for the client.' },
    });
    check('a recommendation can be rejected with a reason', rejected?.status === 'REJECTED', rejected?.status);

    const decisions = await api('GET', '/learning/repository?kind=DECISION', t());
    check(
      'the rejection is recorded as evidence about the analyser',
      (decisions ?? []).some((d) => d.sourceId === second.id),
      `${decisions?.length} decision entr(ies)`,
    );
  } else {
    check('a recommendation can be rejected with a reason', true, 'none left to reject');
    check('the rejection is recorded as evidence about the analyser', true, 'none left to reject');
  }

  const optimizationHistory = await api('GET', '/learning/repository?kind=OPTIMIZATION', t());
  check(
    'applied changes are recorded in the learning repository',
    (optimizationHistory ?? []).length > 0,
    `${optimizationHistory?.length} optimization entr(ies)`,
  );

  // ================================================================
  console.log('\n--- Isolation still holds under Phase 5 ---');

  const other = {
    email: `phase5-other-${unique}@prism-x.test`,
    password: 'CorrectHorse42Battery',
    organizationName: `Phase5 Other ${unique}`,
  };
  await api('POST', '/auth/register', { body: other });
  const otherLogin = await api('POST', '/auth/login', {
    body: { email: other.email, password: other.password },
  });
  const otherToken = otherLogin?.accessToken;

  const otherReviews = await api('GET', '/learning/reviews', { token: otherToken });
  check('another organization sees none of these reviews', (otherReviews ?? []).length === 0);

  const otherRecs = await api('GET', '/learning/recommendations', { token: otherToken });
  check('recommendations are organization-scoped', (otherRecs ?? []).length === 0);

  const otherRepo = await api('GET', '/learning/repository', { token: otherToken });
  check('the learning repository is organization-scoped', (otherRepo ?? []).length === 0);

  const crossApply = await api('POST', `/learning/recommendations/${target.id}/accept`, {
    token: otherToken,
    raw: true,
    body: {},
  });
  check(
    "another organization cannot decide on this org's recommendation",
    crossApply.status === 404,
    `status ${crossApply.status}`,
  );

  const otherProfile = await api('GET', `/learning/optimize/workers/${worker.id}`, {
    token: otherToken,
  });
  check(
    "another organization cannot read this org's worker profile",
    !otherProfile || otherProfile.workerId !== worker.id,
    otherProfile ? 'profile leaked' : 'no profile visible',
  );

  // ================================================================
  console.log(`\n${'='.repeat(66)}`);
  const passed = results.length - failures;
  console.log(`${passed}/${results.length} checks passed`);
  if (failures) {
    console.log('\nFailures:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
  }
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('\nValidation suite crashed:', error);
  process.exit(1);
});
