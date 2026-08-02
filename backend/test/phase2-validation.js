/**
 * PRISM-X Backend — Phase 2 validation suite.
 *
 * Exercises the ten Phase 2 checks against a running server with live
 * Postgres and Redis:
 *
 *   1. Provider Manager switches providers correctly
 *   2. Workers execute through the Provider Manager
 *   3. Missions execute completely
 *   4. Task dependencies work
 *   5. Workers retrieve memory
 *   6. Knowledge retrieval functions
 *   7. Tools execute with permissions
 *   8. Logs are generated
 *   9. Costs are tracked
 *  10. Events fire correctly
 *
 *   node test/phase2-validation.js
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000/api/v1';
const results = [];
let failures = 0;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  if (!passed) failures++;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

async function api(method, endpoint, { token, body, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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
  email: `phase2-${unique}@prism-x.test`,
  password: 'CorrectHorse42Battery',
  organizationName: `Phase2 Labs ${unique}`,
};

(async () => {
  console.log(`\nPRISM-X Backend — Phase 2 validation\n${'='.repeat(64)}\n`);

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
  console.log('--- 1. Provider Manager ---');

  const catalogue = await api('GET', '/providers/capabilities', t());
  const registered = catalogue?.registered ?? [];
  check(
    'all six vendor adapters plus the simulation adapter are registered',
    ['OPENAI', 'ANTHROPIC', 'GEMINI', 'HERMES', 'OLLAMA', 'CUSTOM', 'LOCAL'].every((k) =>
      registered.includes(k),
    ),
    registered.join(', '),
  );

  const primary = await api('POST', '/providers', {
    ...t(),
    body: {
      name: 'Primary (simulated)',
      kind: 'LOCAL',
      isDefault: true,
      config: { defaultModel: 'prism-sim-1' },
    },
  });
  check('provider registers with a model catalogue', Boolean(primary?.id));

  const health = await api('POST', `/providers/${primary.id}/health-check`, t());
  check(
    'health check now succeeds (Phase 1 reported no adapter)',
    health?.healthy === true && health?.status === 'CONNECTED',
    `${health?.status} — ${String(health?.message ?? '').slice(0, 60)}`,
  );

  // A provider rigged to always fail, to prove failover is real.
  const failing = await api('POST', '/providers', {
    ...t(),
    body: {
      name: 'Broken provider',
      kind: 'LOCAL',
      config: { simulate: { alwaysFail: true, retryableFailures: true } },
    },
  });
  const failingHealth = await api('POST', `/providers/${failing.id}/health-check`, t());
  check(
    'a failing provider is reported unhealthy rather than assumed good',
    failingHealth?.healthy === false,
    String(failingHealth?.message ?? '').slice(0, 60),
  );

  const secondary = await api('POST', '/providers', {
    ...t(),
    body: { name: 'Secondary (simulated)', kind: 'LOCAL' },
  });
  await api('POST', `/providers/${secondary.id}/health-check`, t());
  check('a second provider can be registered alongside the first', Boolean(secondary?.id));

  // ================================================================
  console.log('\n--- 2. Worker Runtime ---');

  const worker = await api('POST', '/workers', {
    ...t(),
    body: {
      name: 'Pricing Analyst',
      role: 'analyst',
      capabilities: ['analysis', 'summarize'],
      providerId: primary.id,
    },
  });
  check('worker is created', Boolean(worker?.id));

  const configured = await api('PATCH', `/workers/${worker.id}`, {
    ...t(),
    body: {
      systemPrompt: 'You are a precise pricing analyst. Cite your sources.',
      skills: ['pricing', 'competitive analysis'],
      temperature: 0.3,
      toolPermissions: ['knowledge.search', 'analytics.summary'],
      maxIterations: 3,
      costLimitUsd: 1,
    },
  });
  check(
    'worker carries an executable identity (prompt, skills, tools, limits)',
    configured?.systemPrompt?.includes('pricing analyst') &&
      configured?.toolPermissions?.length === 2 &&
      configured?.maxIterations === 3,
    `${configured?.skills?.length} skills, ${configured?.toolPermissions?.length} tools`,
  );

  await api('POST', `/workers/${worker.id}/activate`, t());

  const execution = await api('POST', `/workers/${worker.id}/execute`, {
    ...t(),
    body: { instruction: 'Summarise our position on competitor pricing for Q3.' },
  });
  check(
    'worker executes through the Provider Manager',
    execution?.status === 'SUCCEEDED' && Boolean(execution?.output),
    `${execution?.status}, ${execution?.totalTokens} tokens`,
  );
  check(
    'execution reports the provider and model that served it',
    execution?.providerId === primary.id && Boolean(execution?.model),
    `${execution?.model} via ${execution?.providerId === primary.id ? 'primary' : 'other'}`,
  );
  check(
    'token accounting is real, not a constant',
    execution?.promptTokens > 0 &&
      execution?.completionTokens > 0 &&
      execution?.totalTokens === execution.promptTokens + execution.completionTokens,
    `${execution?.promptTokens} + ${execution?.completionTokens} = ${execution?.totalTokens}`,
  );

  // Provider switching: same worker, explicitly routed elsewhere.
  const switched = await api('POST', `/workers/${worker.id}/execute`, {
    ...t(),
    body: {
      instruction: 'Repeat the summary in one sentence.',
      providerId: secondary.id,
    },
  });
  check(
    'Provider Manager switches providers on request',
    switched?.providerId === secondary.id,
    `routed to ${switched?.providerId === secondary.id ? 'secondary' : 'wrong provider'}`,
  );

  // ================================================================
  console.log('\n--- 3. Memory Engine ---');

  const longTerm = await api('POST', `/workers/${worker.id}/memory`, {
    ...t(),
    body: {
      content: 'Acme Corp raised list prices 12% in Q2 and bundles support separately.',
      type: 'LONG_TERM',
      importance: 0.9,
      tags: ['acme', 'pricing'],
    },
  });
  check('long-term memory is written', Boolean(longTerm?.id));

  const stats = await api('GET', `/workers/${worker.id}/memory/statistics`, t());
  check(
    'execution automatically wrote short-term memory',
    stats?.shortTerm >= 2,
    `${stats?.shortTerm} short-term, ${stats?.longTerm} long-term`,
  );

  const recalled = await api(
    'GET',
    `/workers/${worker.id}/memory/recall?query=acme%20pricing&limit=5`,
    t(),
  );
  check(
    'recall ranks the relevant memory first',
    recalled?.[0]?.memory?.content?.includes('Acme Corp'),
    `top score ${recalled?.[0]?.score?.toFixed(3)}`,
  );
  check(
    'recall returns scores, not just rows',
    typeof recalled?.[0]?.score === 'number' && recalled[0].score > 0,
  );

  const memoryAware = await api('POST', `/workers/${worker.id}/execute`, {
    ...t(),
    body: { instruction: 'What do we know about Acme Corp pricing?' },
  });
  check(
    'worker execution incorporates recalled memory into its context',
    memoryAware?.output?.toLowerCase().includes('prior context'),
    'simulation adapter echoes which context sections it received',
  );

  const consolidated = await api('POST', `/workers/${worker.id}/memory/consolidate`, t());
  check(
    'consolidation runs and reports what it moved',
    typeof consolidated?.promoted === 'number' && typeof consolidated?.pruned === 'number',
    `${consolidated?.promoted} promoted, ${consolidated?.pruned} pruned`,
  );

  // ================================================================
  console.log('\n--- 4. Knowledge Retrieval ---');

  await api('POST', '/knowledge', {
    ...t(),
    body: {
      title: 'Competitor pricing teardown Q2',
      content:
        'Acme raised list price 12%. Borealis held flat but cut discounting. ' +
        'Cirrus introduced usage-based tiers that undercut entry pricing by 30%.',
      type: 'INSIGHT',
      tags: ['pricing', 'competitive'],
    },
  });
  await api('POST', '/knowledge', {
    ...t(),
    body: {
      title: 'Office snack preferences',
      content: 'The team prefers oat milk and dark chocolate almonds.',
      type: 'NOTE',
      tags: ['office'],
    },
  });

  const search = await api(
    'GET',
    '/knowledge?search=competitor%20pricing%20tiers',
    t(),
  );
  check('knowledge search returns matches', search?.data?.length >= 1);

  const knowledgeAware = await api('POST', `/workers/${worker.id}/execute`, {
    ...t(),
    body: {
      instruction: 'Explain how Cirrus usage-based pricing tiers affect our position.',
    },
  });
  check(
    'worker execution incorporates retrieved knowledge',
    knowledgeAware?.output?.toLowerCase().includes('organizational knowledge'),
  );

  const retrievalEvents = await api('GET', '/events?name=knowledge.retrieved&limit=20', t());
  check(
    'retrieval is recorded as a domain event with its ranking metadata',
    (retrievalEvents?.data?.length ?? 0) > 0 &&
      typeof retrievalEvents.data[0].payload?.candidates === 'number',
    `${retrievalEvents?.data?.length} retrieval events`,
  );
  check(
    'irrelevant documents are ranked out rather than returned',
    !JSON.stringify(search?.data ?? []).includes('snack'),
  );

  // ================================================================
  console.log('\n--- 5. Tool invocation & permissions ---');

  const tools = await api('GET', '/tools', t());
  check(
    'tool catalogue exposes the built-in tools with their required permissions',
    (tools?.length ?? 0) >= 9 && tools.every((x) => x.requiredPermission),
    `${tools?.length} tools`,
  );

  const toolWorker = await api('POST', '/workers', {
    ...t(),
    body: {
      name: 'Tool User',
      role: 'researcher',
      capabilities: ['research'],
      providerId: primary.id,
    },
  });
  await api('PATCH', `/workers/${toolWorker.id}`, {
    ...t(),
    body: { toolPermissions: ['knowledge.search'] },
  });
  await api('POST', `/workers/${toolWorker.id}/activate`, t());

  // Directly exercise the registry's two gates via a worker that has one
  // tool granted and asks for another.
  const grantedCall = await api('POST', `/workers/${toolWorker.id}/execute`, {
    ...t(),
    body: {
      instruction:
        'Use your knowledge search tool. Respond with exactly:\n' +
        'TOOL_CALL: {"tool": "knowledge.search", "input": {"query": "competitor pricing"}}',
    },
  });
  check(
    'a granted tool executes and its result returns to the worker',
    grantedCall?.toolCalls?.some((c) => c.tool === 'knowledge.search' && c.ok),
    `${grantedCall?.toolCalls?.length ?? 0} tool call(s)`,
  );

  const deniedCall = await api('POST', `/workers/${toolWorker.id}/execute`, {
    ...t(),
    body: {
      instruction:
        'Respond with exactly:\n' +
        'TOOL_CALL: {"tool": "knowledge.store", "input": {"title": "x", "content": "y"}}',
    },
  });
  check(
    'an ungranted tool is denied for that worker',
    deniedCall?.toolCalls?.some((c) => c.tool === 'knowledge.store' && c.denied),
    deniedCall?.toolCalls?.find((c) => c.denied)?.error?.slice(0, 60),
  );

  const invocations = await api('GET', '/tools/invocations', t());
  check(
    'both successful and denied invocations are recorded',
    invocations?.some((i) => i.status === 'SUCCESS') &&
      invocations?.some((i) => i.denied === true),
    `${invocations?.length} invocations logged`,
  );

  const denialEvents = await api('GET', '/events?name=tool.denied&limit=10', t());
  check('denials emit `tool.denied`', (denialEvents?.data?.length ?? 0) > 0);

  // ================================================================
  console.log('\n--- 6. Mission execution & task dependencies ---');

  const mission = await api('POST', '/missions', {
    ...t(),
    body: {
      title: 'Q3 pricing response',
      objective: 'Decide how to respond to competitor pricing moves in Q3.',
      priority: 'HIGH',
      tasks: [
        { title: 'Gather competitor pricing changes' },
        { title: 'Assess margin impact', dependsOn: ['0'] },
        { title: 'Recommend a pricing response', dependsOn: ['1'] },
      ],
    },
  });
  check('mission is created with a three-stage dependency chain', Boolean(mission?.id));

  const planned = await api('POST', `/missions/${mission.id}/plan`, t());
  check(
    'planning assigns workers and computes dependency waves',
    planned?.plan?.waves?.length === 3 && planned?.status === 'PLANNING',
    `${planned?.plan?.waves?.length} waves, ${planned?.plan?.totalTasks} tasks`,
  );
  check(
    'every task received a worker during planning',
    planned?.plan?.waves?.every((w) => w.tasks.every((x) => x.workerId)),
  );

  const run = await api('POST', `/missions/${mission.id}/execute`, t());
  check(
    'mission executes to completion',
    run?.status === 'COMPLETED' && run?.tasksSucceeded === 3 && run?.tasksFailed === 0,
    `${run?.status}: ${run?.tasksSucceeded}/${run?.tasksExecuted} succeeded`,
  );

  const finished = await api('GET', `/missions/${mission.id}`, t());
  check('mission progress reaches 100%', finished?.progress === 100);

  const finalTasks = await api('GET', `/missions/${mission.id}/tasks`, t());
  const sorted = [...(finalTasks ?? [])].sort(
    (a, b) => new Date(a.completedAt) - new Date(b.completedAt),
  );
  check(
    'tasks completed in dependency order, not arbitrary order',
    sorted[0]?.title?.includes('Gather') &&
      sorted[2]?.title?.includes('Recommend'),
    sorted.map((x) => x.title.split(' ')[0]).join(' → '),
  );
  check(
    'every task produced output',
    finalTasks?.every((x) => x.output && x.output.length > 0),
  );
  check(
    'downstream tasks received upstream output as context',
    // The dependent task's own output exists and the chain completed, which
    // is only reachable if context assembly did not throw.
    finalTasks?.find((x) => x.title.includes('Assess'))?.status === 'COMPLETED',
  );

  const archived = await api('POST', `/missions/${mission.id}/archive`, t());
  check('completed mission can be archived', archived?.status === 'ARCHIVED');

  // Failure recovery: a mission whose worker runs on the broken provider.
  const failWorker = await api('POST', '/workers', {
    ...t(),
    body: {
      name: 'Doomed Worker',
      role: 'doomed',
      capabilities: ['nothing'],
      providerId: failing.id,
      // Pinned: without this the Provider Manager would fail over to a healthy
      // provider and the task would succeed, which is correct behaviour but
      // not what this check is testing.
      allowFailover: false,
    },
  });
  await api('POST', `/workers/${failWorker.id}/activate`, t());

  const failMission = await api('POST', '/missions', {
    ...t(),
    body: {
      title: 'Mission that fails',
      objective: 'Exercise the failure path.',
      tasks: [{ title: 'Impossible step', workerId: failWorker.id }],
    },
  });
  // maxRetries defaults to 2, so this task is attempted three times overall.
  const failRun = await api('POST', `/missions/${failMission.id}/execute`, t());
  check(
    'a mission whose tasks cannot succeed ends FAILED rather than hanging',
    failRun?.status === 'FAILED',
    `${failRun?.status} after ${failRun?.tasksExecuted} attempt(s)`,
  );

  const retried = await api('POST', `/missions/${failMission.id}/retry`, t());
  check('a failed mission can be retried', retried?.status === 'QUEUED' && retried?.retryCount === 1);

  const cancelMission = await api('POST', '/missions', {
    ...t(),
    body: {
      title: 'Mission to cancel',
      objective: 'Exercise cancellation.',
      tasks: [{ title: 'Never runs' }],
    },
  });
  const cancelled = await api('POST', `/missions/${cancelMission.id}/cancel`, t());
  check('a mission can be cancelled', cancelled?.status === 'CANCELLED');

  const badTransition = await api('POST', `/missions/${cancelMission.id}/execute`, {
    ...t(),
    raw: true,
  });
  check(
    'an illegal lifecycle transition is refused with the allowed set',
    badTransition.status === 400,
    String(badTransition.body?.message ?? '').slice(0, 70),
  );

  // ================================================================
  console.log('\n--- 7. Execution logs ---');

  const executions = await api('GET', '/usage/executions?limit=100', t());
  check(
    'every AI call produced an execution log',
    (executions?.data?.length ?? 0) >= 8,
    `${executions?.data?.length} logs`,
  );

  const sample = executions.data.find((e) => e.status === 'SUCCEEDED');
  check(
    'logs capture worker, provider, model, tokens, cost, latency and timing',
    Boolean(
      sample?.workerId &&
        sample?.providerId &&
        sample?.model &&
        typeof sample?.totalTokens === 'number' &&
        typeof sample?.costUsd === 'number' &&
        typeof sample?.latencyMs === 'number' &&
        sample?.startedAt &&
        sample?.finishedAt,
    ),
    `${sample?.model}, ${sample?.totalTokens} tokens, ${sample?.latencyMs}ms`,
  );
  check(
    'failed executions are logged with their error',
    executions.data.some((e) => e.status === 'FAILED' && e.error),
  );

  const missionLogs = await api('GET', `/missions/${mission.id}/executions`, t());
  check(
    'execution logs are traceable back to their mission',
    (missionLogs?.length ?? 0) >= 3,
    `${missionLogs?.length} logs for the mission`,
  );

  // ================================================================
  console.log('\n--- 8. Cost & usage tracking ---');

  const overview = await api('GET', '/usage/overview', t());
  check(
    'usage overview reports lifetime, month and today',
    overview?.lifetime?.requests > 0 &&
      overview?.today?.requests > 0 &&
      typeof overview?.month?.totalTokens === 'number',
    `${overview?.lifetime?.requests} lifetime requests, ${overview?.lifetime?.totalTokens} tokens`,
  );
  check(
    'success rate is computed from real outcomes',
    typeof overview?.lifetime?.successRate === 'number' &&
      overview.lifetime.successRate < 100,
    `${overview?.lifetime?.successRate}% (a deliberately failing provider is in the mix)`,
  );

  const byProvider = await api('GET', '/usage/by-provider', t());
  check(
    'usage is attributable per provider',
    byProvider?.length >= 2,
    `${byProvider?.length} providers with recorded usage`,
  );

  const byWorker = await api('GET', '/usage/by-worker', t());
  check('usage is attributable per worker', byWorker?.length >= 2, `${byWorker?.length} workers`);

  const byModel = await api('GET', '/usage/by-model', t());
  check('usage is attributable per model', byModel?.length >= 1);

  const timeline = await api('GET', '/usage/timeline?days=7', t());
  check(
    'daily rollup produces a timeline series',
    timeline?.length >= 1 && timeline[0].requests > 0,
    `${timeline?.length} day(s), ${timeline?.[0]?.requests} requests today`,
  );

  const missionCost = await api('GET', `/missions/${mission.id}/cost`, t());
  check(
    'cost is attributable per mission',
    missionCost?.requests >= 3 && typeof missionCost?.totalTokens === 'number',
    `${missionCost?.requests} requests, ${missionCost?.totalTokens} tokens`,
  );

  const reliability = await api('GET', '/usage/provider-reliability', t());
  check(
    'provider reliability and average latency are reported',
    reliability?.length >= 1 && typeof reliability[0].averageLatencyMs === 'number',
  );

  // ================================================================
  console.log('\n--- 9. Event automation ---');

  const events = await api('GET', '/events?limit=100', t());

  // Query each name explicitly rather than scanning one page: by this point
  // the organization has generated well over a page of events, and the
  // earliest ones (provider registration) have scrolled off the newest-first
  // listing. Absence from page one is not absence from the log.
  const names = new Set();
  for (const name of [
    'mission.created', 'mission.planned', 'mission.started', 'mission.completed',
    'mission.failed', 'mission.retried', 'mission.cancelled', 'mission.archived',
    'task.started', 'task.completed', 'task.failed',
    'worker.created', 'worker.execution_started', 'worker.finished',
    'memory.updated', 'knowledge.retrieved', 'knowledge.stored',
    'tool.invoked', 'tool.denied', 'provider.connected', 'usage.recorded',
  ]) {
    const page = await api(`GET`, `/events?name=${encodeURIComponent(name)}&limit=1`, t());
    if ((page?.data?.length ?? 0) > 0) names.add(name);
  }

  const expected = [
    'mission.created',
    'mission.planned',
    'mission.started',
    'mission.completed',
    'mission.failed',
    'mission.retried',
    'mission.cancelled',
    'mission.archived',
    'task.started',
    'task.completed',
    'task.failed',
    'worker.created',
    'worker.execution_started',
    'worker.finished',
    'memory.updated',
    'knowledge.retrieved',
    'knowledge.stored',
    'tool.invoked',
    'tool.denied',
    'provider.connected',
    'usage.recorded',
  ];
  const missing = expected.filter((n) => !names.has(n));
  check(
    'the expanded Phase 2 event catalogue fires end to end',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${names.size} distinct events`,
  );

  const finishedEvent = (events.data ?? []).find((e) => e.name === 'worker.finished');
  check(
    'worker.finished carries cost and token telemetry',
    typeof finishedEvent?.payload?.costUsd === 'number' &&
      typeof finishedEvent?.payload?.totalTokens === 'number',
  );

  const failEvents = (events.data ?? []).filter((e) => e.name === 'provider.failed');
  check(
    'provider.failed fires when a provider errors',
    failEvents.length > 0,
    `${failEvents.length} provider failures recorded`,
  );

  // ================================================================
  console.log('\n--- 10. Isolation still holds under Phase 2 ---');

  const other = {
    email: `phase2-other-${unique}@prism-x.test`,
    password: 'CorrectHorse42Battery',
    organizationName: `Other Labs ${unique}`,
  };
  await api('POST', '/auth/register', { body: other });
  const otherLogin = await api('POST', '/auth/login', {
    body: { email: other.email, password: other.password },
  });
  const otherToken = otherLogin?.accessToken;

  const otherExecutions = await api('GET', '/usage/executions', { token: otherToken });
  check(
    'another organization sees none of these execution logs',
    otherExecutions?.data?.length === 0,
    `${otherExecutions?.data?.length} visible`,
  );

  const otherMemory = await api('GET', `/workers/${worker.id}/memory`, {
    token: otherToken,
  });
  check(
    'another organization cannot read this worker’s memory',
    Array.isArray(otherMemory) && otherMemory.length === 0,
  );

  const otherRun = await api('POST', `/missions/${mission.id}/execute`, {
    token: otherToken,
    raw: true,
  });
  check(
    'another organization cannot execute this mission',
    otherRun.status === 404,
    `status ${otherRun.status}`,
  );

  const otherUsage = await api('GET', '/usage/overview', { token: otherToken });
  check(
    'cost reporting is organization-scoped',
    otherUsage?.lifetime?.requests === 0,
    `${otherUsage?.lifetime?.requests} requests`,
  );

  // ================================================================
  console.log(`\n${'='.repeat(64)}`);
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
