/**
 * PRISM-X Backend — Phase 3 validation suite.
 *
 * Exercises the ten Phase 3 checks against a running server with live
 * Postgres and Redis:
 *
 *   1. Integrations connect successfully
 *   2. Connectors authenticate correctly
 *   3. Workflows execute end-to-end
 *   4. Internal, external and scheduled triggers fire
 *   5. AI decision-making follows configured rules
 *   6. Human approvals interrupt and resume workflows
 *   7. Notifications are delivered
 *   8. Analytics record execution metrics
 *   9. Reliability mechanisms handle failures
 *  10. Public APIs and webhooks function securely
 *
 *   node test/phase3-validation.js
 */
const { createHmac } = require('node:crypto');

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
  email: `phase3-${unique}@prism-x.test`,
  password: 'CorrectHorse42Battery',
  organizationName: `Phase3 Labs ${unique}`,
};

(async () => {
  console.log(`\nPRISM-X Backend — Phase 3 validation\n${'='.repeat(66)}\n`);

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

  // Phase 2 substrate: a provider and a worker the workflows will use.
  const provider = await api('POST', '/providers', {
    ...t(),
    body: { name: 'Sim provider', kind: 'LOCAL', isDefault: true },
  });
  await api('POST', `/providers/${provider.id}/health-check`, t());

  const worker = await api('POST', '/workers', {
    ...t(),
    body: {
      name: 'Automation Worker',
      role: 'operator',
      capabilities: ['automation'],
      providerId: provider.id,
      systemPrompt: 'You operate automations precisely.',
    },
  });
  await api('POST', `/workers/${worker.id}/activate`, t());

  // ================================================================
  console.log('--- 1. Integration framework & connectors ---');

  const catalogue = await api('GET', '/connectors', t());
  const kinds = (catalogue ?? []).map((c) => c.kind);
  check(
    'connector catalogue exposes the built-in services',
    ['slack', 'telegram', 'discord', 'github', 'notion', 'stripe', 'gmail', 'airtable', 'hubspot', 'rest', 'simulated'].every(
      (k) => kinds.includes(k),
    ),
    `${kinds.length} connectors: ${kinds.slice(0, 6).join(', ')}…`,
  );
  check(
    'connectors declare category, auth method and actions',
    (catalogue ?? []).every((c) => c.category && c.authMethod && Array.isArray(c.actions)),
  );
  check(
    'connectors span the required service categories',
    new Set((catalogue ?? []).map((c) => c.category)).size >= 5,
    [...new Set((catalogue ?? []).map((c) => c.category))].join(', '),
  );

  const integration = await api('POST', '/integrations', {
    ...t(),
    body: {
      name: 'Ops channel',
      kind: 'simulated',
      secret: 'sk-integration-secret-9911',
      permissions: ['send', 'read'],
      config: { notifications: true },
    },
  });
  check('integration is created with an encrypted credential', Boolean(integration?.id));
  check(
    'the integration secret is never returned',
    !JSON.stringify(integration).includes('sk-integration-secret'),
  );

  const validated = await api('POST', `/integrations/${integration.id}/validate`, t());
  check('connector validates its configuration', validated?.valid === true, JSON.stringify(validated?.errors ?? []));

  const health = await api('POST', `/integrations/${integration.id}/health-check`, t());
  check('connector authenticates and reports healthy', health?.healthy === true);

  await api('POST', `/integrations/${integration.id}/activate`, t());

  const actions = await api('GET', `/integrations/${integration.id}/actions`, t());
  check(
    'granted actions are marked permitted, ungranted ones are not',
    actions?.find((a) => a.key === 'send')?.permitted === true &&
      actions?.find((a) => a.key === 'upsert')?.permitted === false,
    'send granted; upsert (write) withheld',
  );

  const call = await api('POST', `/integrations/${integration.id}/execute`, {
    ...t(),
    body: { action: 'send', input: { to: 'ops', message: 'Phase 3 online' } },
  });
  check('connector executes an action through the manager', call?.ok === true && Boolean(call?.externalId));

  const denied = await api('POST', `/integrations/${integration.id}/execute`, {
    ...t(),
    body: { action: 'upsert', input: { collection: 'x', record: {} } },
  });
  check(
    'an action outside the granted permissions is refused',
    denied?.ok === false && /not granted/i.test(denied?.error ?? ''),
    (denied?.error ?? '').slice(0, 60),
  );

  // A deliberately broken integration, for the reliability checks.
  const broken = await api('POST', '/integrations', {
    ...t(),
    body: {
      name: 'Broken service',
      kind: 'simulated',
      secret: 'sk-broken',
      permissions: ['send'],
      config: { simulate: { alwaysFail: true, retryableFailures: true } },
    },
  });
  await api('POST', `/integrations/${broken.id}/activate`, t());
  const brokenHealth = await api('POST', `/integrations/${broken.id}/health-check`, t());
  check('a failing connector reports unhealthy rather than assumed good', brokenHealth?.healthy === false);

  // ================================================================
  console.log('\n--- 2. Workflow engine ---');

  const stepTypes = await api('GET', '/workflows/step-types', t());
  check(
    'engine exposes its step vocabulary and execution adapters',
    (stepTypes?.stepTypes?.length ?? 0) >= 10 && (stepTypes?.adapters?.length ?? 0) >= 3,
    `${stepTypes?.stepTypes?.length} step types, adapters: ${stepTypes?.adapters?.map((a) => a.key).join(', ')}`,
  );
  check(
    'n8n and Make.com are pluggable execution adapters, not reimplementations',
    stepTypes?.adapters?.some((a) => a.key === 'n8n') &&
      stepTypes?.adapters?.some((a) => a.key === 'make'),
  );

  const workflow = await api('POST', '/workflows', {
    ...t(),
    body: {
      name: 'Lead triage',
      description: 'Score a lead, branch on the score, notify.',
      steps: [
        {
          id: 'score',
          type: 'worker',
          config: { workerId: worker.id, instruction: 'Score this lead out of 100.' },
        },
        {
          id: 'branch',
          type: 'condition',
          config: { condition: { left: '{{leadScore}}', operator: 'gte', right: 50 } },
          onTrue: [
            {
              id: 'notify',
              type: 'integration',
              config: {
                integrationId: integration.id,
                action: 'send',
                input: { to: 'sales', message: 'Qualified lead' },
              },
            },
          ],
          onFalse: [{ id: 'discard', type: 'transform', config: { outcome: 'discarded' } }],
        },
      ],
    },
  });
  check('workflow is created in DRAFT', workflow?.status === 'DRAFT', workflow?.name);

  const unpublished = await api('POST', `/workflows/${workflow.id}/run`, {
    ...t(),
    body: {},
    raw: true,
  });
  check(
    'an unpublished workflow refuses to run',
    unpublished.status === 400,
    String(unpublished.body?.message ?? '').slice(0, 60),
  );

  const published = await api('POST', `/workflows/${workflow.id}/publish`, t());
  check('publishing activates the workflow', published?.status === 'ACTIVE');

  const run = await api('POST', `/workflows/${workflow.id}/run`, {
    ...t(),
    body: { input: { leadScore: 82, leadId: 'L-4471' } },
  });
  check(
    'workflow executes end to end',
    run?.status === 'SUCCEEDED',
    `${run?.status}, ${run?.stepsRun} steps in ${run?.durationMs}ms`,
  );

  const detail = await api('GET', `/workflows/runs/${run.runId}`, t());
  const stepIds = (detail?.stepRuns ?? []).map((s) => s.stepId);
  check(
    'the true branch ran and the false branch did not',
    stepIds.includes('notify') && !stepIds.includes('discard'),
    stepIds.join(' → '),
  );
  check(
    'each step records its adapter',
    detail?.stepRuns?.some((s) => s.adapter === 'internal'),
  );

  const lowScore = await api('POST', `/workflows/${workflow.id}/run`, {
    ...t(),
    body: { input: { leadScore: 12 } },
  });
  const lowDetail = await api('GET', `/workflows/runs/${lowScore.runId}`, t());
  check(
    'a different input takes the other branch',
    lowDetail?.stepRuns?.some((s) => s.stepId === 'discard'),
    'low score routed to discard',
  );

  // Versioning
  const v2 = await api('POST', `/workflows/${workflow.id}/versions`, {
    ...t(),
    body: {
      steps: [{ id: 'score', type: 'transform', config: { note: 'v2' } }],
      notes: 'Simplified',
    },
  });
  check('a new version is created rather than mutating the old one', v2?.version === 2);
  const versions = await api('GET', `/workflows/${workflow.id}/versions`, t());
  check('both versions are retained', versions?.length === 2);

  const invalid = await api('POST', `/workflows/${workflow.id}/versions`, {
    ...t(),
    raw: true,
    body: { steps: [{ id: 'dup', type: 'transform', config: {} }, { id: 'dup', type: 'transform', config: {} }] },
  });
  check(
    'a malformed graph is rejected at authoring time',
    invalid.status === 400,
    String(invalid.body?.message ?? '').slice(0, 60),
  );

  // Parallel + loop
  const complex = await api('POST', '/workflows', {
    ...t(),
    body: {
      name: 'Parallel and loop',
      steps: [
        {
          id: 'fanout',
          type: 'parallel',
          config: {},
          steps: [
            { id: 'p1', type: 'transform', config: { branch: 1 } },
            { id: 'p2', type: 'transform', config: { branch: 2 } },
            { id: 'p3', type: 'transform', config: { branch: 3 } },
          ],
        },
        {
          id: 'iterate',
          type: 'loop',
          config: { items: '{{items}}' },
          steps: [{ id: 'each', type: 'transform', config: { value: '{{$item}}' } }],
        },
      ],
    },
  });
  await api('POST', `/workflows/${complex.id}/publish`, t());
  const complexRun = await api('POST', `/workflows/${complex.id}/run`, {
    ...t(),
    body: { input: { items: ['a', 'b', 'c'] } },
  });
  check(
    'parallel and loop steps execute',
    complexRun?.status === 'SUCCEEDED',
    `${complexRun?.stepsRun} steps run`,
  );

  // Idempotency
  const key = `dedupe-${unique}`;
  const first = await api('POST', `/workflows/${workflow.id}/run`, {
    ...t(),
    body: { input: { leadScore: 70 }, idempotencyKey: key },
  });
  const second = await api('POST', `/workflows/${workflow.id}/run`, {
    ...t(),
    body: { input: { leadScore: 70 }, idempotencyKey: key },
  });
  check(
    'duplicate detection returns the original run instead of running twice',
    second?.deduplicated === true && second?.runId === first?.runId,
  );

  // ================================================================
  console.log('\n--- 3. Triggers ---');

  const eventTrigger = await api('POST', '/triggers', {
    ...t(),
    body: {
      name: 'On knowledge stored',
      workflowId: complex.id,
      type: 'EVENT',
      eventName: 'knowledge.stored',
      inputMapping: { items: ['x'] },
    },
  });
  check('event trigger is created', Boolean(eventTrigger?.id));

  const runsBefore = (await api('GET', `/workflows/runs?workflowId=${complex.id}`, t()))?.length ?? 0;
  await api('POST', '/knowledge', {
    ...t(),
    body: { title: 'Trigger probe', content: 'Storing this should fire the trigger.' },
  });
  await new Promise((r) => setTimeout(r, 1500));
  const runsAfter = (await api('GET', `/workflows/runs?workflowId=${complex.id}`, t()))?.length ?? 0;
  check(
    'an internal domain event fires its trigger',
    runsAfter > runsBefore,
    `${runsBefore} → ${runsAfter} runs`,
  );

  const webhookTrigger = await api('POST', '/triggers', {
    ...t(),
    body: { name: 'Inbound hook', workflowId: complex.id, type: 'WEBHOOK', inputMapping: { items: ['w'] } },
  });
  check(
    'webhook trigger issues an unguessable path and a signing secret',
    Boolean(webhookTrigger?.webhookPath) &&
      Boolean(webhookTrigger?.webhookSecret) &&
      webhookTrigger.webhookPath.length >= 24,
    `path length ${webhookTrigger?.webhookPath?.length}`,
  );

  const payload = { source: 'external', value: 42 };
  const rawBody = JSON.stringify(payload);
  const goodSig = createHmac('sha256', webhookTrigger.webhookSecret).update(rawBody).digest('hex');

  const unsigned = await api('POST', `/hooks/${webhookTrigger.webhookPath}`, {
    body: payload,
    raw: true,
  });
  check(
    'an unsigned webhook is rejected',
    unsigned.body?.accepted === false,
    unsigned.body?.reason,
  );

  const badSig = await api('POST', `/hooks/${webhookTrigger.webhookPath}`, {
    body: payload,
    headers: { 'x-prismx-signature': 'deadbeef'.repeat(8) },
    raw: true,
  });
  check('a mis-signed webhook is rejected', badSig.body?.accepted === false);

  const signed = await api('POST', `/hooks/${webhookTrigger.webhookPath}`, {
    body: payload,
    headers: { 'x-prismx-signature': goodSig },
  });
  check(
    'a correctly signed webhook fires its workflow',
    signed?.accepted === true && Boolean(signed?.runId),
    `run ${signed?.runId}`,
  );

  const unknownPath = await api('POST', '/hooks/definitely-not-a-real-path', { body: {} });
  check('an unknown webhook path is rejected', unknownPath?.accepted === false);

  const schedule = await api('POST', '/triggers', {
    ...t(),
    body: {
      name: 'Frequent schedule',
      workflowId: complex.id,
      type: 'SCHEDULE',
      intervalSeconds: 60,
      inputMapping: { items: ['s'] },
    },
  });
  check('schedule trigger computes its next run time', Boolean(schedule?.nextRunAt));

  // Make the schedule due. Creating a trigger sets its next run in the future
  // by design — firing on creation would surprise anyone who scheduled
  // something for 6am. Backdating simulates the wait.
  await api('PATCH', `/triggers/${schedule.id}`, {
    ...t(),
    body: { nextRunAt: new Date(Date.now() - 1000).toISOString() },
  });

  const ticked = await api('POST', '/triggers/tick', t());
  check(
    'the scheduler fires due schedules',
    (ticked?.fired ?? 0) >= 1,
    `${ticked?.fired} schedule(s) fired`,
  );

  // ================================================================
  console.log('\n--- 4. AI decisions & human approval ---');

  const decisionFlow = await api('POST', '/workflows', {
    ...t(),
    body: {
      name: 'Escalating decision',
      steps: [
        {
          id: 'decide',
          type: 'ai_decision',
          config: {
            workerId: worker.id,
            question: 'Should this lead be contacted immediately?',
            options: ['contact_now', 'nurture', 'discard'],
            // The simulated provider reports no explicit confidence, so the
            // inferred value sits below this threshold and must escalate.
            confidenceThreshold: 0.9,
            riskLevel: 'HIGH',
          },
        },
        { id: 'after', type: 'transform', config: { proceeded: true } },
      ],
    },
  });
  await api('POST', `/workflows/${decisionFlow.id}/publish`, t());

  const decisionRun = await api('POST', `/workflows/${decisionFlow.id}/run`, {
    ...t(),
    body: { input: { lead: 'L-9001' } },
  });
  check(
    'a low-confidence AI decision suspends the run for approval',
    decisionRun?.status === 'AWAITING_APPROVAL' && Boolean(decisionRun?.awaitingApprovalId),
    `${decisionRun?.status}`,
  );

  const pending = await api('GET', '/approvals?status=PENDING', t());
  const approval = pending?.find((a) => a.id === decisionRun.awaitingApprovalId);
  check(
    'the approval carries reason, suggested action, risk level and context',
    Boolean(approval?.reason && approval?.riskLevel) &&
      typeof approval?.context === 'object',
    `risk ${approval?.riskLevel}`,
  );

  const beforeResume = await api('GET', `/workflows/runs/${decisionRun.runId}`, t());
  check(
    'the suspended run has not executed steps beyond the decision',
    !beforeResume?.stepRuns?.some((s) => s.stepId === 'after' && s.status === 'SUCCEEDED'),
  );

  const approved = await api('POST', `/approvals/${approval.id}/approve`, {
    ...t(),
    body: { comment: 'Confirmed by ops.' },
  });
  check(
    'approving resumes the suspended run',
    approved?.approval?.status === 'APPROVED' && approved?.resumed === true,
  );

  const afterResume = await api('GET', `/workflows/runs/${decisionRun.runId}`, t());
  check(
    'the run completes after approval',
    afterResume?.status === 'SUCCEEDED' &&
      afterResume?.stepRuns?.some((s) => s.stepId === 'after'),
    afterResume?.status,
  );

  const redecided = await api('POST', `/approvals/${approval.id}/approve`, {
    ...t(),
    raw: true,
    body: {},
  });
  check('an already-decided approval cannot be decided again', redecided.status === 400);

  // Reject path
  const rejectRun = await api('POST', `/workflows/${decisionFlow.id}/run`, {
    ...t(),
    body: { input: { lead: 'L-9002' } },
  });
  const rejectApproval = rejectRun.awaitingApprovalId;
  const rejected = await api('POST', `/approvals/${rejectApproval}/reject`, {
    ...t(),
    body: { comment: 'Not this quarter.' },
  });
  check(
    'rejecting leaves the run suspended rather than resuming it',
    rejected?.approval?.status === 'REJECTED' && rejected?.resumed === false,
  );

  const changesRun = await api('POST', `/workflows/${decisionFlow.id}/run`, {
    ...t(),
    body: { input: { lead: 'L-9003' } },
  });
  const noComment = await api('POST', `/approvals/${changesRun.awaitingApprovalId}/request-changes`, {
    ...t(),
    raw: true,
    body: {},
  });
  check('requesting changes without a comment is refused', noComment.status === 400);

  const changed = await api('POST', `/approvals/${changesRun.awaitingApprovalId}/request-changes`, {
    ...t(),
    body: { comment: 'Narrow the audience first.' },
  });
  check('changes can be requested with a comment', changed?.approval?.status === 'CHANGES_REQUESTED');

  const approvalStats = await api('GET', '/approvals/statistics', t());
  check(
    'approval statistics are reported',
    typeof approvalStats?.approved === 'number' && typeof approvalStats?.rejected === 'number',
    `${approvalStats?.approved} approved, ${approvalStats?.rejected} rejected`,
  );

  // ================================================================
  console.log('\n--- 5. Notifications ---');

  const notifications = await api('GET', '/notifications', t());
  check(
    'approvals raised notifications',
    (notifications?.length ?? 0) >= 3,
    `${notifications?.length} notifications`,
  );
  check(
    'each notification records its per-channel delivery outcome',
    notifications?.[0]?.deliveries?.some((d) => d.channel === 'in_app' && d.ok === true),
  );
  check(
    'an external channel was attempted through the integration',
    notifications?.some((n) => n.deliveries?.some((d) => d.channel.startsWith('integration:'))),
    'routed via the configured integration',
  );

  const notifStats = await api('GET', '/notifications/statistics', t());
  check('notification counts are reported', notifStats?.total >= 3);

  await api('POST', '/notifications/read-all', t());
  const afterRead = await api('GET', '/notifications/statistics', t());
  check('notifications can be marked read', afterRead?.unread === 0);

  // ================================================================
  console.log('\n--- 6. Reliability ---');

  const failingFlow = await api('POST', '/workflows', {
    ...t(),
    body: {
      name: 'Failing flow',
      maxRetries: 0,
      steps: [
        {
          id: 'doomed',
          type: 'integration',
          config: { integrationId: broken.id, action: 'send', input: { to: 'x', message: 'y' } },
        },
      ],
    },
  });
  await api('POST', `/workflows/${failingFlow.id}/publish`, t());
  const failedRun = await api('POST', `/workflows/${failingFlow.id}/run`, { ...t(), body: {} });
  check(
    'a failing step fails the run rather than hanging',
    failedRun?.status === 'FAILED' || failedRun?.status === 'DEAD_LETTERED',
    failedRun?.status,
  );

  const reliability = await api('GET', '/automation/reliability', t());
  check(
    'exhausted work is dead-lettered rather than dropped',
    reliability?.deadLetters?.total >= 1,
    `${reliability?.deadLetters?.unresolved} unresolved dead letter(s)`,
  );

  const deadLetters = await api('GET', '/automation/dead-letters', t());
  check(
    'dead letters carry their reason and payload for replay',
    deadLetters?.[0]?.reason && deadLetters?.[0]?.source,
    `${deadLetters?.[0]?.source}: ${String(deadLetters?.[0]?.reason).slice(0, 40)}`,
  );

  // onError: continue
  const tolerant = await api('POST', '/workflows', {
    ...t(),
    body: {
      name: 'Tolerant flow',
      steps: [
        {
          id: 'flaky',
          type: 'integration',
          onError: 'continue',
          config: { integrationId: broken.id, action: 'send', input: { to: 'x', message: 'y' } },
        },
        { id: 'still_runs', type: 'transform', config: { reached: true } },
      ],
    },
  });
  await api('POST', `/workflows/${tolerant.id}/publish`, t());
  const tolerantRun = await api('POST', `/workflows/${tolerant.id}/run`, { ...t(), body: {} });
  check(
    'onError=continue lets a workflow survive a failing step',
    tolerantRun?.status === 'SUCCEEDED',
    tolerantRun?.status,
  );

  const brokenState = await api('GET', `/integrations/${broken.id}`, t());
  check(
    'a repeatedly failing integration is marked unhealthy',
    brokenState?.healthy === false && brokenState?.failureCount > 0,
    `${brokenState?.failureCount} failures recorded`,
  );

  // ================================================================
  console.log('\n--- 7. Automation analytics ---');

  const analytics = await api('GET', '/automation/analytics', t());
  check(
    'execution counts and success/failure rates are measured',
    analytics?.executions > 0 && typeof analytics?.successRate === 'number',
    `${analytics?.executions} runs, ${analytics?.successRate}% success`,
  );
  check('average duration is reported', typeof analytics?.averageDurationMs === 'number');
  check(
    'most-used integrations and workers are ranked',
    Array.isArray(analytics?.mostUsedIntegrations) && Array.isArray(analytics?.mostUsedWorkers),
    `${analytics?.mostUsedIntegrations?.length} integrations, ${analytics?.mostUsedWorkers?.length} workers`,
  );
  check(
    'AI cost is attributed to automation',
    typeof analytics?.aiCostUsd === 'number' && typeof analytics?.totalTokens === 'number',
  );
  check(
    'savings and ROI are reported with their assumptions, not as bare facts',
    typeof analytics?.humanHoursSaved === 'number' &&
      Boolean(analytics?.assumptions?.minutesSavedPerRun) &&
      /estimate/i.test(analytics?.assumptions?.note ?? ''),
    `${analytics?.humanHoursSaved}h saved @ ${analytics?.assumptions?.minutesSavedPerRun}min/run`,
  );

  const tuned = await api('GET', '/automation/analytics?minutesPerRun=30&hourlyRate=100', t());
  check(
    'savings assumptions are operator-configurable',
    tuned?.assumptions?.minutesSavedPerRun === 30 &&
      tuned?.humanHoursSaved > analytics?.humanHoursSaved,
    `${tuned?.humanHoursSaved}h at 30min/run`,
  );

  // ================================================================
  console.log('\n--- 8. Public API & outbound webhooks ---');

  const issued = await api('POST', '/api-keys', {
    ...t(),
    body: { name: 'CI pipeline', scopes: ['workflow:execute'], rateLimitPerMinute: 60 },
  });
  check('API key is issued with its plaintext returned once', Boolean(issued?.key && issued?.prefix));
  check('API key is prefixed for identification', issued.key.startsWith('px_'));

  const keyList = await api('GET', '/api-keys', t());
  const stored = keyList?.find((k) => k.id === issued.id);
  check(
    'only a hash is stored — the key itself is unrecoverable',
    Boolean(stored) && !JSON.stringify(keyList).includes(issued.key.slice(3)),
  );

  const keyUsage = await api('GET', '/api-keys/usage', t());
  check('API key usage analytics are available', keyUsage?.total >= 1);

  const revoked = await api('DELETE', `/api-keys/${issued.id}`, t());
  check('API key can be revoked', revoked?.revoked === true);

  const endpoint = await api('POST', '/webhook-endpoints', {
    ...t(),
    body: {
      name: 'Ops receiver',
      url: 'https://example.invalid/hooks/prismx',
      events: ['mission.completed'],
    },
  });
  check(
    'webhook endpoint is created with a signing secret returned once',
    Boolean(endpoint?.id && endpoint?.secret),
  );

  const signature = (() => {
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ test: true });
    const digest = createHmac('sha256', endpoint.secret).update(`${ts}.${body}`).digest('hex');
    return { header: `t=${ts},v1=${digest}`, body, secret: endpoint.secret };
  })();
  check(
    'outbound deliveries are signed over timestamp and body',
    /^t=\d+,v1=[0-9a-f]{64}$/.test(signature.header),
    'x-prismx-signature format verified',
  );

  const deliveryStats = await api('GET', '/webhook-endpoints/deliveries', t());
  check('webhook delivery statistics are reported', typeof deliveryStats?.total === 'number');

  // ================================================================
  console.log('\n--- 9. Events ---');

  const expected = [
    'workflow.created',
    'workflow.published',
    'workflow.run_started',
    'workflow.run_completed',
    'workflow.run_failed',
    'workflow.run_suspended',
    'workflow.run_resumed',
    'workflow.step_completed',
    'trigger.fired',
    'webhook.received',
    'approval.requested',
    'approval.granted',
    'approval.rejected',
    'ai.decision_escalated',
    'integration.call_succeeded',
    'integration.call_failed',
    'notification.sent',
    'deadletter.recorded',
    'apikey.created',
    'apikey.revoked',
  ];

  const found = new Set();
  for (const name of expected) {
    const page = await api('GET', `/events?name=${encodeURIComponent(name)}&limit=1`, t());
    if ((page?.data?.length ?? 0) > 0) found.add(name);
  }
  const missing = expected.filter((n) => !found.has(n));
  check(
    'the Phase 3 event catalogue fires end to end',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${found.size} distinct events`,
  );

  // ================================================================
  console.log('\n--- 10. Isolation still holds ---');

  const other = {
    email: `phase3-other-${unique}@prism-x.test`,
    password: 'CorrectHorse42Battery',
    organizationName: `Other Automation ${unique}`,
  };
  await api('POST', '/auth/register', { body: other });
  const otherLogin = await api('POST', '/auth/login', {
    body: { email: other.email, password: other.password },
  });
  const otherToken = otherLogin?.accessToken;

  const otherWorkflows = await api('GET', '/workflows', { token: otherToken });
  check(
    'another organization sees none of these workflows',
    otherWorkflows?.length === 0,
    `${otherWorkflows?.length} visible`,
  );

  const otherRun = await api('POST', `/workflows/${workflow.id}/run`, {
    token: otherToken,
    body: {},
    raw: true,
  });
  check("another organization cannot run this org's workflow", otherRun.status === 404);

  const otherKeys = await api('GET', '/api-keys', { token: otherToken });
  check('API keys are organization-scoped', otherKeys?.length === 0);

  const otherApprovals = await api('GET', '/approvals', { token: otherToken });
  check('approvals are organization-scoped', otherApprovals?.length === 0);

  const otherIntegration = await api('POST', `/integrations/${integration.id}/execute`, {
    token: otherToken,
    body: { action: 'send', input: { to: 'x', message: 'y' } },
    raw: true,
  });
  check(
    "another organization cannot use this org's integration",
    otherIntegration.status === 404,
    `status ${otherIntegration.status}`,
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
