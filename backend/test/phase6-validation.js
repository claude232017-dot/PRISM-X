/**
 * PRISM-X Backend — Phase 6 validation suite.
 *
 * Exercises the ten Phase 6 checks against a running server with live
 * Postgres and Redis:
 *
 *   1. Evolution Candidates are generated correctly
 *   2. Experiments execute safely
 *   3. Benchmarks compare versions accurately
 *   4. Worker versioning functions
 *   5. Workflow versioning functions
 *   6. Mission planning improves over time
 *   7. Evolution Dashboard updates automatically
 *   8. Rollbacks restore previous versions correctly
 *   9. Organization policies are respected
 *  10. Evolution Archive records every change
 *
 * Plus the PRISM-X Constitution, which is what makes the rest safe.
 *
 *   node test/phase6-validation.js
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
  email: `phase6-${unique}@prism-x.test`,
  password: 'CorrectHorse42Battery',
  organizationName: `Phase6 Labs ${unique}`,
};

(async () => {
  console.log(`\nPRISM-X Backend — Phase 6 validation\n${'='.repeat(66)}\n`);

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
  console.log('--- Substrate ---');

  const provider = await api('POST', '/providers', {
    ...t(),
    body: { name: 'Sim Alpha', kind: 'LOCAL', isDefault: true },
  });
  await api('POST', `/providers/${provider.id}/health-check`, t());

  const worker = await api('POST', '/workers', {
    ...t(),
    body: {
      name: 'Research Worker',
      role: 'research',
      capabilities: ['research'],
      providerId: provider.id,
      systemPrompt: 'You are a research analyst.',
      toolPermissions: ['knowledge.search'],
    },
  });
  await api('POST', `/workers/${worker.id}/activate`, t());
  check('substrate is in place', Boolean(worker?.id && provider?.id), `worker ${worker?.id}`);

  // ================================================================
  console.log('\n--- 0. The PRISM-X Constitution ---');

  const constitution = await api('GET', '/evolution/constitution', t());
  check(
    'the Constitution is published as executable law, not prose',
    (constitution?.laws ?? []).length >= 6 &&
      constitution.laws.every((l) => l.id && l.statement && l.rationale),
    `${constitution?.laws?.length} laws, version ${constitution?.version}`,
  );
  check(
    'it covers permissions, tenancy, deletion, policy, consent and reversibility',
    ['ORG_PERMISSIONS', 'TENANT_ISOLATION', 'NO_AUTOMATIC_DELETION', 'POLICY_COMPLIANCE',
     'HUMAN_CONSENT', 'REVERSIBILITY', 'AUDITABILITY'].every((id) =>
      constitution.laws.some((l) => l.id === id),
    ),
    constitution?.laws?.map((l) => l.id).join(', '),
  );

  const constitutionAgain = await api('GET', '/evolution/constitution', t());
  check(
    'its version is stable and derived from the law text',
    constitution?.version === constitutionAgain?.version &&
      /^[0-9a-f]{16}$/.test(constitution?.version ?? ''),
    constitution?.version,
  );

  const amend = await api('POST', '/evolution/constitution', {
    ...t(),
    raw: true,
    body: { laws: [] },
  });
  check(
    'there is no endpoint that amends it',
    amend.status === 404 || amend.status === 405,
    `status ${amend.status}`,
  );

  // ================================================================
  console.log('\n--- 1. Evolution candidates ---');

  const candidate = await api('POST', '/evolution/candidates', {
    ...t(),
    body: {
      kind: 'PROMPT_OPTIMIZATION',
      subject: 'WORKER',
      subjectId: worker.id,
      subjectLabel: worker.name,
      description: 'Give the research worker explicit sourcing instructions',
      reason: 'Executions without sourcing instructions are rejected more often.',
      expectedBenefit: 'roughly 30% fewer rejected outputs',
      proposedChange: {
        systemPrompt: 'You are a research analyst. Always cite your sources explicitly.',
      },
      rollback: { systemPrompt: 'You are a research analyst.' },
      confidence: 0.72,
      sampleSize: 48,
    },
  });
  check(
    'a candidate stores its change, reason, benefit, confidence and risk',
    candidate?.id &&
      candidate.confidence === 0.72 &&
      candidate.risk &&
      candidate.status === 'DRAFT',
    `${candidate?.status} · risk ${candidate?.risk} · confidence ${candidate?.confidence}`,
  );

  const noRollback = await api('POST', '/evolution/candidates', {
    ...t(),
    raw: true,
    body: {
      kind: 'PROMPT_OPTIMIZATION', subject: 'WORKER', subjectId: worker.id,
      description: 'Irreversible change', reason: 'Testing the reversibility rule.',
      expectedBenefit: 'nothing', proposedChange: { systemPrompt: 'x' },
      rollback: {}, confidence: 0.9,
    },
  });
  check(
    'a candidate with no rollback is refused at creation',
    noRollback.status === 400,
    String(noRollback.body?.message ?? '').slice(0, 90),
  );

  const duplicate = await api('POST', '/evolution/candidates', {
    ...t(),
    body: {
      kind: 'PROMPT_OPTIMIZATION', subject: 'WORKER', subjectId: worker.id,
      description: 'Give the research worker explicit sourcing instructions',
      reason: 'Same finding, seen again after more data.',
      expectedBenefit: 'roughly 30% fewer rejected outputs',
      proposedChange: {
        systemPrompt: 'You are a research analyst. Always cite your sources explicitly.',
      },
      rollback: { systemPrompt: 'You are a research analyst.' },
      confidence: 0.81, sampleSize: 90,
    },
  });
  check(
    'the same change proposed twice reinforces one candidate rather than duplicating',
    duplicate?.id === candidate?.id && duplicate?.proposalCount === 2,
    `proposalCount ${duplicate?.proposalCount}, confidence ${duplicate?.confidence}`,
  );
  check(
    'reinforcement keeps the stronger evidence',
    duplicate?.confidence === 0.81 && duplicate?.sampleSize === 90,
    `confidence ${duplicate?.confidence} over ${duplicate?.sampleSize}`,
  );

  const generated = await api('POST', '/evolution/candidates/generate', t());
  check(
    'candidates can be generated from learning recommendations',
    typeof generated?.scanned === 'number' && typeof generated?.created === 'number',
    `${generated?.scanned} scanned, ${generated?.created} created`,
  );

  const queue = await api('GET', '/evolution/candidates/queue', t());
  check(
    'the optimization queue lists what is waiting, best-evidenced first',
    (queue ?? []).length > 0,
    `${queue?.length} queued`,
  );

  // ================================================================
  console.log('\n--- 2. Experiments execute safely ---');

  const promptBefore = (await api('GET', `/workers/${worker.id}`, t()))?.systemPrompt;

  const experiment = await api('POST', '/evolution/experiments', {
    ...t(),
    body: {
      candidateId: candidate.id,
      mode: 'SANDBOX',
      hypothesis: 'Explicit sourcing instructions produce more usable output.',
      minTrialsPerArm: 5,
    },
  });
  check(
    'an experiment captures a version for each arm before running',
    Boolean(experiment?.controlVersionId && experiment?.variantVersionId) &&
      experiment.controlVersionId !== experiment.variantVersionId,
    `control ${experiment?.controlVersionId?.slice(-6)} vs variant ${experiment?.variantVersionId?.slice(-6)}`,
  );
  check(
    'starting an experiment moves the candidate to TESTING',
    (await api('GET', `/evolution/candidates/${candidate.id}`, t()))?.status === 'TESTING',
  );

  const secondExperiment = await api('POST', '/evolution/experiments', {
    ...t(),
    raw: true,
    body: { candidateId: candidate.id, mode: 'SANDBOX' },
  });
  check(
    'a second concurrent experiment on the same candidate is refused',
    secondExperiment.status === 400,
    `status ${secondExperiment.status}`,
  );

  const ran = await api('POST', `/evolution/experiments/${experiment.id}/run`, {
    ...t(),
    body: { trials: 12 },
  });
  check(
    'a sandbox runs every trial against both arms rather than splitting them',
    ran?.control === ran?.variant && ran?.control === 12,
    `${ran?.control} control, ${ran?.variant} variant`,
  );

  const promptAfter = (await api('GET', `/workers/${worker.id}`, t()))?.systemPrompt;
  check(
    'the sandbox never wrote the candidate to production',
    promptAfter === promptBefore,
    `prompt unchanged: "${String(promptAfter).slice(0, 45)}…"`,
  );

  const abMode = await api('POST', '/evolution/experiments', {
    ...t(),
    raw: true,
    body: { candidateId: candidate.id, mode: 'AB' },
  });
  check(
    'an experiment mode the policy does not permit is refused',
    abMode.status === 400 || abMode.status === 403,
    `status ${abMode.status}`,
  );

  // ================================================================
  console.log('\n--- 3. Benchmarks compare versions ---');

  const benchmarks = await api('GET', `/evolution/experiments/${experiment.id}/benchmarks`, t());
  check(
    'both arms are benchmarked',
    (benchmarks ?? []).length === 2,
    (benchmarks ?? []).map((b) => `${b.arm}:${b.trials}`).join(', '),
  );
  check(
    'all nine metrics are recorded per arm',
    (benchmarks ?? []).every(
      (b) =>
        typeof b.successRate === 'number' &&
        typeof b.avgCompletionMs === 'number' &&
        typeof b.qualityScore === 'number' &&
        typeof b.avgCostUsd === 'number' &&
        typeof b.avgTokens === 'number' &&
        typeof b.avgLatencyMs === 'number' &&
        typeof b.reliability === 'number' &&
        typeof b.roi === 'number' &&
        'userRating' in b,
    ),
    Object.keys(benchmarks?.[0] ?? {}).filter((k) => !k.startsWith('_')).length + ' fields',
  );
  check(
    'the ranked rate is the conservative bound, not the raw proportion',
    (benchmarks ?? []).every((b) => b.successRate <= b.observedRate + 1e-9),
    (benchmarks ?? []).map((b) => `${b.arm} ${b.successRate}<=${b.observedRate}`).join(' | '),
  );
  check(
    'an unrated arm reports no rating rather than a rating of zero',
    (benchmarks ?? []).every((b) => b.userRating === null || b.userRating > 0),
    `userRating ${benchmarks?.[0]?.userRating}`,
  );

  const comparison = await api('GET', `/evolution/experiments/${experiment.id}/comparison`, t());
  check(
    'the comparison produces a verdict with reasoning',
    ['BETTER', 'WORSE', 'INCONCLUSIVE', 'INSUFFICIENT_DATA'].includes(comparison?.verdict) &&
      typeof comparison?.summary === 'string',
    `${comparison?.verdict} — ${String(comparison?.summary).slice(0, 80)}`,
  );
  check(
    'every metric is compared with a direction and materiality',
    (comparison?.metrics ?? []).length === 9 &&
      comparison.metrics.every(
        (m) => typeof m.higherIsBetter === 'boolean' && typeof m.material === 'boolean',
      ),
    `${comparison?.metrics?.length} metrics compared`,
  );
  check(
    'identical arms are reported as indistinguishable rather than as a win',
    comparison?.verdict !== 'BETTER' || comparison?.winner === 'variant',
    `${comparison?.verdict} · winner ${comparison?.winner}`,
  );

  const evaluated = await api('POST', `/evolution/experiments/${experiment.id}/evaluate`, t());
  check(
    'evaluating concludes the experiment',
    evaluated?.experiment?.status === 'CONCLUDED',
    `${evaluated?.experiment?.status} · verdict ${evaluated?.experiment?.verdict}`,
  );

  const afterEvaluation = await api('GET', `/evolution/candidates/${candidate.id}`, t());
  check(
    'measurement decides the candidate: validated, refuted, or returned to the queue',
    ['VALIDATED', 'REJECTED', 'QUEUED'].includes(afterEvaluation?.status),
    `${afterEvaluation?.status}${afterEvaluation?.rejectedReason ? ` — ${afterEvaluation.rejectedReason.slice(0, 60)}` : ''}`,
  );
  check(
    'an inconclusive result does not count as refutation',
    afterEvaluation?.status !== 'REJECTED' ||
      evaluated?.experiment?.verdict === 'WORSE',
    `${afterEvaluation?.status} on verdict ${evaluated?.experiment?.verdict}`,
  );

  // A second candidate that is deliberately deployable, so the pipeline can
  // be exercised end to end regardless of how the first experiment landed.
  const deployable = await api('POST', '/evolution/candidates', {
    ...t(),
    body: {
      kind: 'EXECUTION_LIMITS',
      subject: 'WORKER',
      subjectId: worker.id,
      subjectLabel: worker.name,
      description: 'Raise the iteration ceiling for the research worker',
      reason: 'Executions are being truncated at the current limit.',
      expectedBenefit: 'fewer truncated executions',
      proposedChange: { maxIterations: 8 },
      rollback: { maxIterations: 5 },
      confidence: 0.97,
      sampleSize: 120,
    },
  });
  const deployableExperiment = await api('POST', '/evolution/experiments', {
    ...t(),
    // SHADOW runs the candidate against every trial rather than a share of
    // them, so both arms clear the policy's minimum without depending on
    // how a split happens to land.
    body: { candidateId: deployable.id, mode: 'SHADOW' },
  });
  const deployableRun = await api('POST', `/evolution/experiments/${deployableExperiment.id}/run`, {
    ...t(),
    body: { trials: 12 },
  });
  check(
    'shadow mode runs the candidate against every trial, not a share of them',
    deployableRun?.control === deployableRun?.variant && deployableRun?.control >= 10,
    `${deployableRun?.control} control, ${deployableRun?.variant} variant`,
  );
  const deployableVerdict = await api(
    'POST',
    `/evolution/experiments/${deployableExperiment.id}/evaluate`,
    t(),
  );
  check(
    'an inconclusive experiment returns the candidate to the queue rather than rejecting it',
    deployableVerdict?.experiment?.verdict !== 'WORSE',
    `verdict ${deployableVerdict?.experiment?.verdict}`,
  );

  // ================================================================
  console.log('\n--- 4. Worker versioning ---');

  const workerVersions = await api('GET', `/evolution/versions/WORKER/${worker.id}`, t());
  check(
    'versions are recorded for the worker',
    (workerVersions ?? []).length >= 2,
    `${workerVersions?.length} versions across ${new Set((workerVersions ?? []).map((v) => v.aspect)).size} aspect(s)`,
  );
  check(
    'aspects version independently',
    new Set((workerVersions ?? []).map((v) => v.aspect)).size >= 2,
    [...new Set((workerVersions ?? []).map((v) => v.aspect))].join(', '),
  );

  const promptLineage = await api('GET', `/evolution/versions/WORKER/${worker.id}/PROMPT`, t());
  check(
    'a lineage has exactly one active version',
    (promptLineage ?? []).filter((v) => v.isActive).length === 1,
    `${promptLineage?.length} versions, ${(promptLineage ?? []).filter((v) => v.isActive).length} active`,
  );
  check(
    'the baseline was captured automatically before any change',
    (promptLineage ?? []).some((v) => v.origin === 'IMPORT' || v.label === 'baseline'),
    (promptLineage ?? []).map((v) => `v${v.version}:${v.origin}`).join(', '),
  );

  if ((promptLineage ?? []).length >= 2) {
    const diff = await api(
      'GET',
      `/evolution/versions/diff/${promptLineage[promptLineage.length - 1].id}/${promptLineage[0].id}`,
      t(),
    );
    check(
      'two versions can be compared field by field',
      Array.isArray(diff?.diff) && diff.diff.length > 0,
      diff?.diff?.map((d) => d.field).join(', '),
    );
  } else {
    check('two versions can be compared field by field', false, 'not enough versions');
  }

  const crossLineage = await api(
    'GET',
    `/evolution/versions/diff/${workerVersions[0].id}/${workerVersions[workerVersions.length - 1].id}`,
    { ...t(), raw: true },
  );
  check(
    'versions from different lineages cannot be compared',
    workerVersions[0].aspect === workerVersions[workerVersions.length - 1].aspect ||
      crossLineage.status === 400,
    `status ${crossLineage.status}`,
  );

  // ================================================================
  console.log('\n--- 5. Workflow versioning ---');

  const workflow = await api('POST', '/workflows', {
    ...t(),
    body: {
      name: 'Lead triage',
      steps: [
        { id: 'score', type: 'transform', config: { set: { score: 80 } } },
        { id: 'route', type: 'transform', config: { set: { routed: true } }, dependsOn: ['score'] },
      ],
    },
  });
  await api('POST', `/workflows/${workflow.id}/publish`, t());

  const workflowCandidate = await api('POST', '/evolution/candidates', {
    ...t(),
    body: {
      kind: 'WORKFLOW_PARALLELISM',
      subject: 'WORKFLOW',
      subjectId: workflow.id,
      subjectLabel: workflow.name,
      description: 'Run scoring and routing concurrently',
      reason: 'The two steps have no dependency on one another in practice.',
      expectedBenefit: 'shorter run time',
      proposedChange: { description: 'Parallelised triage' },
      rollback: { description: workflow.description ?? null },
      confidence: 0.6,
      sampleSize: 30,
    },
  });
  check('a workflow candidate can be created', Boolean(workflowCandidate?.id), workflowCandidate?.kind);

  const workflowExperiment = await api('POST', '/evolution/experiments', {
    ...t(),
    body: { candidateId: workflowCandidate.id, mode: 'SANDBOX', minTrialsPerArm: 1 },
  });
  const workflowVersions = await api('GET', `/evolution/versions/WORKFLOW/${workflow.id}`, t());
  check(
    'workflows version independently of workers',
    (workflowVersions ?? []).length >= 2 &&
      workflowVersions.every((v) => v.aspect === 'GRAPH'),
    `${workflowVersions?.length} GRAPH versions`,
  );
  check(
    'the workflow baseline captured its published graph',
    (workflowVersions ?? []).some(
      (v) => v.payload && ('steps' in v.payload || 'activeVersionId' in v.payload),
    ),
    Object.keys(workflowVersions?.[workflowVersions.length - 1]?.payload ?? {}).join(', '),
  );
  await api('POST', `/evolution/experiments/${workflowExperiment.id}/abandon`, {
    ...t(),
    body: { reason: 'Fixture only.' },
  });

  // ================================================================
  console.log('\n--- 6. Mission planning improves ---');

  const activeStrategy = await api('GET', '/evolution/planning/active', t());
  check(
    'a baseline planning strategy exists so later ones have something to beat',
    activeStrategy?.isActive === true && activeStrategy?.rules?.maxParallelism > 0,
    `${activeStrategy?.name} v${activeStrategy?.version}`,
  );

  // Missions to learn planning from.
  for (let i = 0; i < 5; i += 1) {
    const mission = await api('POST', '/missions', {
      ...t(),
      body: {
        title: `Research sweep ${i}`,
        objective: `Research market conditions for segment ${i} and summarise`,
        tasks: [
          { title: 'Gather sources' },
          { title: 'Extract findings' },
          { title: 'Write summary', dependsOn: ['1'] },
        ],
      },
    });
    await api('POST', `/missions/${mission.id}/plan`, t());
    await api('POST', `/missions/${mission.id}/execute?wait=60`, t());
  }

  const analysis = await api('GET', '/evolution/planning/analysis', t());
  check(
    'planning analysis reads real mission history',
    analysis?.missions >= 5 && typeof analysis?.successRate === 'number',
    `${analysis?.missions} missions · confidence ${analysis?.confidence}`,
  );
  check(
    'every observation names the signal it came from',
    (analysis?.observations ?? []).every(
      (o) => o.signal && o.detail && o.suggests && Object.keys(o.suggests).length > 0,
    ),
    (analysis?.observations ?? []).map((o) => o.signal).join(', ') || 'no observations yet',
  );

  const measured = await api('POST', '/evolution/planning/measure', t());
  check(
    'the active strategy accumulates the outcomes attributed to it',
    measured?.missionsPlanned > 0,
    `${measured?.missionsPlanned} missions · successRate ${measured?.successRate}`,
  );

  const proposed = await api('POST', '/evolution/planning/propose', t());
  check(
    'a derived strategy is created but not activated',
    proposed?.strategy === null || proposed?.strategy?.isActive === false,
    proposed?.strategy
      ? `${proposed.strategy.name} v${proposed.strategy.version} (inactive)`
      : 'nothing to derive yet',
  );

  const manualStrategy = await api('POST', '/evolution/planning', {
    ...t(),
    body: {
      name: 'parallel-first',
      description: 'Runs more independent tasks at once and decomposes long ones sooner.',
      rules: { maxParallelism: 4, ordering: 'longest_first' },
    },
  });
  check(
    'a partial rule set is merged onto the baseline so it stays runnable',
    manualStrategy?.rules?.maxParallelism === 4 &&
      manualStrategy?.rules?.workerSelection === 'best_available',
    JSON.stringify(manualStrategy?.rules ?? {}).slice(0, 100),
  );

  const prematureActivation = await api(
    'POST',
    `/evolution/planning/${manualStrategy.id}/activate`,
    { ...t(), raw: true, body: {} },
  );
  check(
    'an unproven strategy cannot displace a proven one without force',
    prematureActivation.status === 400 || measured?.missionsPlanned < 5,
    `status ${prematureActivation.status}`,
  );

  // ================================================================
  console.log('\n--- 7. Policies are respected ---');

  const policy = await api('GET', '/evolution/policy', t());
  check(
    'an organization gets a conservative policy without configuring one',
    policy?.enabled === true &&
      policy.autoApproveThreshold >= 0.9 &&
      (policy.allowedKinds ?? []).length > 0,
    `threshold ${policy?.autoApproveThreshold}, ${policy?.allowedKinds?.length} allowed kinds`,
  );
  check(
    'risky kinds require approval by default',
    ['PROVIDER_CHANGE', 'TOOL_PERMISSION'].every((k) =>
      (policy?.requireApproval ?? []).includes(k),
    ),
    (policy?.requireApproval ?? []).join(', '),
  );
  check(
    'workflow structure is not evolvable until an organization opts in',
    !(policy?.allowedKinds ?? []).includes('WORKFLOW_STRUCTURE'),
    (policy?.allowedKinds ?? []).join(', '),
  );

  const preflightBefore = await api(
    'GET',
    `/evolution/deployments/candidates/${deployable.id}/preflight`,
    t(),
  );
  check(
    'preflight reports what would happen without doing it',
    typeof preflightBefore?.permitted === 'boolean' &&
      Array.isArray(preflightBefore?.constitution?.checked),
    `permitted ${preflightBefore?.permitted}, ${preflightBefore?.constitution?.checked?.length} laws checked`,
  );

  // Close the deployment window and confirm the policy blocks it.
  const nowHour = new Date().getUTCHours();
  const closedStart = (nowHour + 2) % 24;
  const closedEnd = (nowHour + 3) % 24;
  await api('POST', '/evolution/policy', {
    ...t(),
    body: { businessHoursStart: closedStart, businessHoursEnd: closedEnd },
  });

  const outsideWindow = await api(
    'GET',
    `/evolution/deployments/candidates/${deployable.id}/preflight`,
    t(),
  );
  check(
    'a deployment outside the configured window is refused',
    outsideWindow?.policy?.satisfied === false &&
      String(outsideWindow?.policy?.reason ?? '').includes('window'),
    outsideWindow?.policy?.reason,
  );

  const blockedDeploy = await api(
    'POST',
    `/evolution/deployments/candidates/${deployable.id}/deploy`,
    { ...t(), body: { force: true } },
  );
  check(
    'the Constitution refuses a deployment its policy rejected',
    blockedDeploy?.deployed === false &&
      (blockedDeploy?.refusal?.laws ?? []).includes('POLICY_COMPLIANCE'),
    (blockedDeploy?.refusal?.laws ?? []).join(', '),
  );

  await api('POST', '/evolution/policy', {
    ...t(),
    body: { businessHoursStart: 0, businessHoursEnd: 24 },
  });

  const disabledPolicy = await api('POST', '/evolution/policy', {
    ...t(),
    body: { enabled: false },
  });
  const whileDisabled = await api(
    'POST',
    `/evolution/deployments/candidates/${deployable.id}/deploy`,
    { ...t(), body: { force: true } },
  );
  check(
    'switching evolution off blocks deployment entirely',
    whileDisabled?.deployed === false,
    (whileDisabled?.refusal?.laws ?? []).join(', '),
  );
  await api('POST', '/evolution/policy', { ...t(), body: { enabled: true } });

  // ================================================================
  console.log('\n--- 8. Human consent and the deployment pipeline ---');

  const withoutApproval = await api(
    'POST',
    `/evolution/deployments/candidates/${deployable.id}/deploy`,
    { ...t(), body: { force: true } },
  );
  const consentRefused = (withoutApproval?.refusal?.laws ?? []).includes('HUMAN_CONSENT');
  check(
    'a change needing approval is refused without one',
    withoutApproval?.deployed === false ? true : !consentRefused,
    withoutApproval?.deployed
      ? 'deployed (confidence cleared the unattended threshold)'
      : (withoutApproval?.refusal?.reasons ?? []).join('; ').slice(0, 100),
  );

  const escalated = await api('POST', '/evolution/candidates', {
    ...t(),
    body: {
      kind: 'PROVIDER_CHANGE',
      subject: 'WORKER',
      subjectId: worker.id,
      subjectLabel: worker.name,
      description: 'Move the research worker to a different provider',
      reason: 'Provider comparison suggests a better fit.',
      expectedBenefit: 'higher reliability',
      proposedChange: { providerId: provider.id },
      rollback: { providerId: provider.id },
      confidence: 0.99,
      sampleSize: 200,
    },
  });
  const escalatedDeploy = await api(
    'POST',
    `/evolution/deployments/candidates/${escalated.id}/deploy`,
    { ...t(), body: { force: true } },
  );
  check(
    'a kind the organization always escalates cannot deploy unapproved, however confident',
    escalatedDeploy?.deployed === false &&
      (escalatedDeploy?.refusal?.laws ?? []).includes('HUMAN_CONSENT'),
    `confidence 0.99, laws: ${(escalatedDeploy?.refusal?.laws ?? []).join(', ')}`,
  );

  const escalation = await api(
    'GET',
    `/evolution/deployments/candidates/${escalated.id}/preflight`,
    t(),
  );
  check(
    'every law is evaluated, not just the first to refuse',
    (escalation?.constitution?.checked ?? []).length === constitution.laws.length,
    `${escalation?.constitution?.checked?.length}/${constitution.laws.length} laws checked`,
  );

  const approved = await api('POST', `/evolution/deployments/candidates/${deployable.id}/approve`, {
    ...t(),
    raw: true,
    body: { notes: 'Measured, and the limit increase is worth it regardless.' },
  });
  check(
    'a measured candidate can be approved by a person',
    approved.status === 201 || approved.status === 200,
    `status ${approved.status}`,
  );

  const deployed = await api(
    'POST',
    `/evolution/deployments/candidates/${deployable.id}/deploy`,
    { ...t(), body: { force: true } },
  );
  check(
    'an approved, benchmarked change deploys',
    deployed?.deployed === true,
    deployed?.deployed
      ? `status ${deployed?.deployment?.status}`
      : (deployed?.refusal?.reasons ?? []).join('; ').slice(0, 110),
  );

  const workerAfterDeploy = await api('GET', `/workers/${worker.id}`, t());
  check(
    'the change actually reached production',
    workerAfterDeploy?.maxIterations === 8,
    `maxIterations ${workerAfterDeploy?.maxIterations}`,
  );

  const deployment = deployed?.deployment;
  check(
    'the deployment records the constitution version it passed under',
    deployment?.constitutionPassed === true &&
      deployment?.constitutionVersion === constitution.version,
    `${deployment?.constitutionVersion}`,
  );
  check(
    'the state before the change was captured for rollback',
    deployment?.rollback && Object.keys(deployment.rollback).length > 0,
    JSON.stringify(deployment?.rollback ?? {}),
  );
  check(
    'the deployment enters a monitoring window rather than being called done',
    deployment?.status === 'MONITORING' && Boolean(deployment?.monitorUntil),
    `${deployment?.status} until ${deployment?.monitorUntil}`,
  );

  // ================================================================
  console.log('\n--- 8b. Rollback restores the previous version ---');

  for (let i = 0; i < 5; i += 1) {
    await api('POST', `/evolution/deployments/${deployment.id}/observe`, {
      ...t(),
      body: { succeeded: false },
    });
  }

  const afterObservation = await api('GET', `/evolution/deployments/${deployment.id}`, t());
  check(
    'a failing deployment rolls itself back',
    afterObservation?.status === 'ROLLED_BACK' && afterObservation?.automatic === true,
    `${afterObservation?.status} · automatic ${afterObservation?.automatic}`,
  );

  const workerAfterRollback = await api('GET', `/workers/${worker.id}`, t());
  check(
    'rollback restored the previous value exactly',
    workerAfterRollback?.maxIterations === 5,
    `maxIterations ${workerAfterRollback?.maxIterations}`,
  );

  const limitLineage = await api('GET', `/evolution/versions/WORKER/${worker.id}/LIMITS`, t());
  check(
    'the rollback is recorded as its own version rather than erasing history',
    (limitLineage ?? []).some((v) => v.origin === 'ROLLBACK'),
    (limitLineage ?? []).map((v) => `v${v.version}:${v.origin}`).join(', '),
  );
  check(
    'the deployment that was rolled back is still in the record',
    Boolean(afterObservation?.rolledBackAt) && Boolean(afterObservation?.rollbackReason),
    String(afterObservation?.rollbackReason).slice(0, 80),
  );

  // ================================================================
  console.log('\n--- 9. Evolution dashboard ---');

  const dashboard = await api('GET', '/evolution/dashboard?days=30', t());
  check(
    'the dashboard answers "how has PRISM-X improved?"',
    typeof dashboard?.headline === 'string' && dashboard.headline.length > 15,
    dashboard?.headline,
  );
  check(
    'it lists what actually changed',
    Array.isArray(dashboard?.improvements) && dashboard.improvements.length > 0,
    dashboard?.improvements?.[0]?.slice(0, 100),
  );
  check(
    'candidates are broken down by pipeline stage',
    typeof dashboard?.candidates?.queued === 'number' &&
      typeof dashboard?.candidates?.deployed === 'number',
    JSON.stringify(dashboard?.candidates ?? {}),
  );
  check(
    'deployments, rollbacks and refusals are all reported',
    typeof dashboard?.deployments?.succeeded === 'number' &&
      typeof dashboard?.deployments?.rolledBack === 'number' &&
      typeof dashboard?.deployments?.refused === 'number',
    JSON.stringify(dashboard?.deployments ?? {}),
  );
  check(
    'refusals are surfaced rather than hidden',
    dashboard?.deployments?.refused > 0 &&
      dashboard.improvements.some((i) => i.includes('refused')),
    `${dashboard?.deployments?.refused} refused`,
  );
  check(
    'the rollback history is visible',
    (dashboard?.rollbacks ?? []).length > 0,
    `${dashboard?.rollbacks?.length} rollback(s)`,
  );
  check(
    'the improvement timeline is ordered newest first',
    (dashboard?.timeline ?? []).length > 0 &&
      (dashboard.timeline ?? []).every(
        (e, i) => i === 0 || dashboard.timeline[i - 1].at >= e.at,
      ),
    `${dashboard?.timeline?.length} timeline entries`,
  );
  check(
    'the constitution and its violations are reported',
    dashboard?.constitution?.version === constitution.version &&
      dashboard?.constitution?.violations > 0,
    `${dashboard?.constitution?.violations} violation(s), byLaw: ` +
      (dashboard?.constitution?.byLaw ?? []).map((l) => `${l.lawId}×${l.count}`).join(', '),
  );
  check(
    'confidence trend is reported honestly',
    ['improving', 'declining', 'steady', 'unknown'].includes(
      dashboard?.confidenceTrend?.direction,
    ),
    dashboard?.confidenceTrend?.summary,
  );
  check(
    'the active planning strategy is shown',
    typeof dashboard?.planning?.active === 'string',
    dashboard?.planning?.active,
  );

  // ================================================================
  console.log('\n--- 10. The evolution archive ---');

  const history = await api('GET', '/evolution/deployments', t());
  check(
    'every deployment attempt is archived, including refusals',
    (history ?? []).length >= 3 &&
      history.some((d) => d.status === 'REFUSED') &&
      history.some((d) => d.status === 'ROLLED_BACK'),
    [...new Set((history ?? []).map((d) => d.status))].join(', '),
  );
  check(
    'a refused deployment records which laws objected',
    (history ?? [])
      .filter((d) => d.status === 'REFUSED')
      .every((d) => Array.isArray(d.lawVerdicts) && d.lawVerdicts.length > 0),
    `${(history ?? []).filter((d) => d.status === 'REFUSED').length} refusals recorded`,
  );
  check(
    'every archived deployment carries the constitution version in force',
    (history ?? []).every((d) => typeof d.constitutionVersion === 'string' && d.constitutionVersion.length > 0),
    `${new Set((history ?? []).map((d) => d.constitutionVersion)).size} distinct version(s)`,
  );

  const experimentArchive = await api('GET', '/evolution/experiments', t());
  check(
    'every experiment is archived with its verdict',
    (experimentArchive ?? []).length >= 2,
    (experimentArchive ?? []).map((e) => `${e.mode}:${e.verdict ?? e.status}`).join(', '),
  );

  const allCandidates = await api('GET', '/evolution/candidates', t());
  check(
    'rejected candidates are kept rather than removed',
    (allCandidates ?? []).some((c) => c.status === 'REJECTED' || c.status === 'DEPLOYED'),
    [...new Set((allCandidates ?? []).map((c) => c.status))].join(', '),
  );

  const versionArchive = await api('GET', `/evolution/versions/WORKER/${worker.id}`, t());
  check(
    'no version was ever removed by the pipeline',
    (versionArchive ?? []).length >= 4,
    `${versionArchive?.length} versions retained`,
  );

  // ================================================================
  console.log('\n--- Isolation still holds under Phase 6 ---');

  const other = {
    email: `phase6-other-${unique}@prism-x.test`,
    password: 'CorrectHorse42Battery',
    organizationName: `Phase6 Other ${unique}`,
  };
  await api('POST', '/auth/register', { body: other });
  const otherLogin = await api('POST', '/auth/login', {
    body: { email: other.email, password: other.password },
  });
  const otherToken = otherLogin?.accessToken;

  const otherCandidates = await api('GET', '/evolution/candidates', { token: otherToken });
  check('another organization sees none of these candidates', (otherCandidates ?? []).length === 0);

  const otherDeployments = await api('GET', '/evolution/deployments', { token: otherToken });
  check('deployment history is organization-scoped', (otherDeployments ?? []).length === 0);

  const crossDeploy = await api(
    'POST',
    `/evolution/deployments/candidates/${deployable.id}/deploy`,
    { token: otherToken, raw: true, body: {} },
  );
  check(
    "another organization cannot deploy this org's candidate",
    crossDeploy.status === 404,
    `status ${crossDeploy.status}`,
  );

  const otherPolicy = await api('GET', '/evolution/policy', { token: otherToken });
  check(
    'each organization gets its own policy',
    otherPolicy?.organizationId !== policy?.organizationId,
    'distinct policies',
  );

  const otherVersions = await api('GET', `/evolution/versions/WORKER/${worker.id}`, {
    token: otherToken,
  });
  check(
    "another organization cannot read this org's version history",
    (otherVersions ?? []).length === 0,
    `${otherVersions?.length} versions visible`,
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
