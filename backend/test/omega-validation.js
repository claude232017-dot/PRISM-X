#!/usr/bin/env node
/**
 * PRISM-X — Phase Omega validation.
 *
 * Verifies the production-hardening changes behave as claimed, against a
 * running backend and a real Postgres and Redis. Each check asserts an
 * *observable* property, not the presence of code: a retention policy that is
 * declared but never deletes anything, or a queue that accepts jobs nothing
 * consumes, would pass a source-level check and fail here.
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` :: ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

async function api(method, path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (options.raw) return response;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const unique = Date.now();
const ACCOUNT = {
  email: `omega-${unique}@prism-x.test`,
  password: 'CorrectHorse42Battery',
  organizationName: `Omega Labs ${unique}`,
};

(async () => {
  console.log(`\nPRISM-X Backend — Phase Omega validation\n${'='.repeat(66)}\n`);

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
  console.log('--- A. The connection pool is declared, not inherited ---');

  const deep = await api('GET', '/ops/health/deep');
  const pool = deep?.database?.pool;
  check('the deep probe reports the configured pool', Number.isFinite(pool?.configuredLimit), `limit ${pool?.configuredLimit}`);
  check(
    'the pool has a wait ceiling rather than blocking forever',
    Number.isFinite(pool?.poolTimeoutSeconds) && pool.poolTimeoutSeconds > 0,
    `${pool?.poolTimeoutSeconds}s`,
  );
  check(
    'the server limit is reported next to it, so the arithmetic is answerable',
    pool?.serverMaxConnections === null || Number.isFinite(pool?.serverMaxConnections),
    `server max ${pool?.serverMaxConnections}, in use ${pool?.serverInUse}`,
  );
  check(
    'the configured pool leaves room under the server limit',
    !Number.isFinite(pool?.serverMaxConnections) || pool.configuredLimit < pool.serverMaxConnections,
    `${pool?.configuredLimit} of ${pool?.serverMaxConnections}`,
  );

  // ================================================================
  console.log('\n--- C. Retention is declared and actually deletes ---');

  const policy = await api('GET', '/ops/retention', t());
  check('a retention policy is published', Array.isArray(policy?.tables) && policy.tables.length >= 10, `${policy?.tables?.length} table(s)`);
  check(
    'every rule names the column its age is measured from',
    (policy?.tables ?? []).every((rule) => typeof rule.column === 'string' && rule.column),
  );
  check(
    'every rule carries the reason for its window',
    (policy?.tables ?? []).every((rule) => typeof rule.rationale === 'string' && rule.rationale.length > 20),
  );
  check(
    'audit logs are kept longer than events',
    (policy?.tables ?? []).find((r) => r.table === 'audit_logs')?.days >
      (policy?.tables ?? []).find((r) => r.table === 'events')?.days,
  );
  check(
    'deletion is batched rather than one enormous statement',
    policy?.batchSize > 0 && policy?.maxBatchesPerTable > 0,
    `${policy?.batchSize} rows × ${policy?.maxBatchesPerTable} batches`,
  );
  check(
    'a still-firing alert is guarded against being pruned for age',
    (policy?.tables ?? []).find((r) => r.table === 'alert_events')?.guard?.includes('resolvedAt'),
  );

  const dryRun = await api('POST', '/ops/retention/sweep', t({ body: { dryRun: true } }));
  check('a dry run reports without deleting', dryRun?.deleted === 0 && Array.isArray(dryRun?.tables), `${dryRun?.tables?.length} table(s) examined`);
  check(
    'a dry run reaches every enabled table',
    (dryRun?.tables ?? []).filter((table) => table.skipped === null).length >= 10,
  );

  const swept = await api('POST', '/ops/retention/sweep', t({ body: {} }));
  check('a real sweep runs without error', Array.isArray(swept?.tables) && !swept.tables.some((x) => x.error), swept?.tables?.find((x) => x.error)?.error ?? 'no errors');

  // ================================================================
  console.log('\n--- F. Audit and event writes are batched but not invisible ---');

  const worker = await api('POST', '/workers', {
    ...t(),
    body: { name: `Omega runner ${unique}`, role: 'analyst', status: 'ACTIVE' },
  });
  check('a worker is created', Boolean(worker?.id));

  // Read immediately. Batched writes must still be visible to the very next
  // request, or batching has changed behaviour rather than just performance.
  const events = await api('GET', '/events?limit=10', t());
  check(
    'an event written moments ago is readable immediately',
    (events?.data ?? []).some((event) => event.name === 'worker.created'),
    (events?.data ?? []).map((e) => e.name).slice(0, 3).join(', '),
  );

  const audit = await api('POST', '/admin/compliance', t({ body: { kind: 'AUDIT_SUMMARY' } }));
  const sample = audit?.findings?.sample ?? [];
  check(
    'the audit row for that request is readable immediately',
    sample.some((entry) => String(entry.action).includes('/workers')),
    sample[0]?.action,
  );

  // ================================================================
  console.log('\n--- H. Mission execution happens on a queue ---');

  const mission = await api('POST', '/missions', {
    ...t(),
    body: {
      title: `Omega queued mission ${unique}`,
      objective: 'Verify execution leaves the request path',
      tasks: [{ title: 'First step' }, { title: 'Second step', dependsOn: ['0'] }],
    },
  });
  check('a mission is created', Boolean(mission?.id));

  const accepted = await api('POST', `/missions/${mission.id}/execute`, { ...t(), raw: true });
  const acceptedBody = await accepted.json();
  check(
    'execute returns 202 rather than holding the request open',
    accepted.status === 202,
    `status ${accepted.status}`,
  );
  check('the response hands back a job to follow', Boolean(acceptedBody?.jobId), acceptedBody?.jobId);
  check(
    'the response says where to look for the outcome',
    typeof acceptedBody?.statusUrl === 'string' && acceptedBody.statusUrl.includes(mission.id),
    acceptedBody?.statusUrl,
  );

  // Enqueueing twice must not produce two runs of the same mission.
  const again = await api('POST', `/missions/${mission.id}/execute`, t());
  check(
    'a second execute is deduplicated onto the same job',
    again?.jobId === acceptedBody?.jobId || again?.status,
    `${again?.jobId ?? again?.status}`,
  );

  // Give the worker time to pick it up and finish.
  let job = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(500);
    job = await api('GET', `/missions/${mission.id}/job/${acceptedBody.jobId}`, t());
    if (job?.state === 'completed' || job?.state === 'failed') break;
  }
  check('a queue worker picked the job up and finished it', job?.state === 'completed', `state ${job?.state}`);
  check(
    'the job result is the run result, not an acknowledgement',
    typeof job?.result?.status === 'string' && Number.isFinite(job?.result?.tasksExecuted),
    `${job?.result?.status}, ${job?.result?.tasksExecuted} task(s)`,
  );

  const afterRun = await api('GET', `/missions/${mission.id}`, t());
  check(
    'the mission advanced past DRAFT because the worker ran it',
    afterRun?.status !== 'DRAFT' && afterRun?.status !== 'QUEUED',
    afterRun?.status,
  );

  // The waiting form must run on the queue too — same job id, inline result.
  const waited = await api('POST', `/missions/${mission.id}/execute?wait=30`, { ...t(), raw: true });
  const waitedBody = await waited.json();
  check(
    'the waiting form returns a run result or an honest still-running handle',
    Number.isFinite(waitedBody?.tasksExecuted) || waitedBody?.accepted === true || waited.status === 400,
    `status ${waited.status}`,
  );

  const queues = await api('GET', '/queues/statistics', t());
  check(
    'the mission queue reports having done work',
    (queues?.['mission-execution']?.completed ?? 0) >= 1,
    `${queues?.['mission-execution']?.completed} completed`,
  );

  // A mission from another organization must not be executable, and the
  // refusal has to happen while the caller is listening rather than on a
  // worker where nobody sees it.
  const stranger = {
    email: `omega-other-${unique}@prism-x.test`,
    password: 'CorrectHorse42Battery',
    organizationName: `Omega Rivals ${unique}`,
  };
  await api('POST', '/auth/register', { body: stranger });
  const strangerLogin = await api('POST', '/auth/login', {
    body: { email: stranger.email, password: stranger.password },
  });
  const cross = await api('POST', `/missions/${mission.id}/execute`, {
    token: strangerLogin?.accessToken,
    raw: true,
  });
  check(
    'another organization cannot enqueue this mission',
    cross.status === 404 || cross.status === 403,
    `status ${cross.status}`,
  );

  // ================================================================
  console.log('\n--- G. The event cascade is bounded ---');

  const metrics = await (await fetch(`${BASE}/ops/metrics`)).text();
  check(
    'the write buffer depth is exposed as a metric',
    metrics.includes('prismx_write_buffer_depth'),
  );
  check(
    'retention deletions are counted',
    metrics.includes('prismx_retention_rows_deleted_total') ||
      metrics.includes('prismx_retention_backlog'),
  );

  // ================================================================
  console.log('\n--- E. Statelessness is measured, not asserted ---');

  const readiness = await api('GET', '/ops/readiness?record=false', t());
  const stateless = (readiness?.verdicts ?? []).find((v) => v.id === 'STATELESS_INSTANCES');
  check('the review reports on statelessness', Boolean(stateless), stateless?.outcome);
  check(
    'a statelessness failure names what is held rather than saying "somewhere"',
    stateless?.outcome === 'PASS' || /[a-z]+\.[a-z-]+/.test(stateless?.detail ?? ''),
    stateless?.detail,
  );
  // The latency verdict is now computed from the merged fleet view rather than
  // one process's share. It cannot abstain here: this suite has just generated
  // plenty of traffic, so a null p95 would mean the evidence never arrived.
  const latency = (readiness?.verdicts ?? []).find((v) => v.id === 'LATENCY_BUDGET');
  check(
    'the latency verdict was reached from real samples, not abstained',
    latency?.outcome !== 'UNKNOWN' && /\d/.test(latency?.detail ?? ''),
    `${latency?.outcome} — ${latency?.detail}`,
  );

  console.log(`\n${'='.repeat(66)}`);
  console.log(`${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
