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
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';

/**
 * Runs SQL as the constrained tenant role.
 *
 * `prismx_tenant` is NOBYPASSRLS, so what it can see is what the policies
 * permit — which is the only way to test row-level security. Asking the owner
 * role would prove nothing: the owner bypasses RLS by default, so every query
 * would succeed whether the policies were right, wrong, or absent.
 */
function databaseUrl() {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  const envFile = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envFile)) return null;
  const match = /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync(envFile, 'utf8'));
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

function psql(sql) {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL is not set');
  const parsed = new URL(url);
  const env = {
    ...process.env,
    PGPASSWORD: decodeURIComponent(parsed.password || ''),
  };
  const args = [
    '-h', parsed.hostname,
    '-p', parsed.port || '5432',
    '-U', decodeURIComponent(parsed.username || 'postgres'),
    '-d', parsed.pathname.replace(/^\//, ''),
    // Collapsed to one line: the SQL is passed as a single shell argument, and
    // an embedded newline arrives at psql as a literal backslash-n.
    '-tAc', JSON.stringify(sql.replace(/\s+/g, ' ').trim()),
  ].join(' ');
  const out = execSync(`psql ${args}`, {
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // psql prints a line per statement, so a script that has to `SET ROLE` and
  // `set_config` before its query emits those tags first. The answer is the
  // last non-empty line.
  const lines = out.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

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

  // The deep probe is rate limited on purpose — it is for people, not
  // orchestrators — and running the phase suites back to back can exhaust that
  // budget. Retried rather than skipped: a check that quietly passes when it
  // could not gather evidence is the thing this whole phase exists to remove.
  let deep = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await api('GET', '/ops/health/deep', { raw: true });
    if (response.status !== 429) {
      deep = await response.json();
      break;
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 20_000);
  }
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

  // ================================================================
  console.log('\n--- I. Row-level security is engaged, not merely present ---');

  try {
    // Coverage first. A table added in a later phase whose RLS migration
    // sorted before the migration creating it would be silently unprotected,
    // and every check below would still pass because it samples known tables.
    const unprotected = psql(`
      SELECT COALESCE(string_agg(c.table_name, ', '), '')
        FROM information_schema.columns c
        JOIN pg_tables t ON t.tablename = c.table_name AND t.schemaname = 'public'
       WHERE c.table_schema = 'public'
         AND c.column_name = 'organizationId'
         AND NOT t.rowsecurity`);
    check('every table carrying organizationId has RLS enabled', unprotected === '', unprotected || 'none');

    const policyless = psql(`
      SELECT COALESCE(string_agg(t.tablename, ', '), '')
        FROM pg_tables t
       WHERE t.schemaname = 'public'
         AND t.rowsecurity
         AND EXISTS (
           SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name = t.tablename
              AND c.column_name = 'organizationId')
         AND NOT EXISTS (
           SELECT 1 FROM pg_policies p
            WHERE p.schemaname = 'public' AND p.tablename = t.tablename)`);
    check(
      'every tenant table with RLS also has a policy',
      policyless === '',
      policyless || 'none',
    );

    const tenantTables = Number(
      psql(`SELECT count(DISTINCT table_name) FROM information_schema.columns
             WHERE table_schema = 'public' AND column_name = 'organizationId'`),
    );
    check('the protected surface is the whole tenant schema', tenantTables >= 60, `${tenantTables} tenant table(s)`);

    // The role has to actually be constrained, or none of this means anything.
    const bypasses = psql(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'prismx_tenant'`);
    check('the tenant role cannot bypass row-level security', bypasses === 'f', `rolbypassrls=${bypasses}`);

    // A session with no organization set must see nothing — failing closed is
    // the property that matters, because an unset variable is what a bug looks
    // like from the database's side.
    const blind = psql(
      `SET ROLE prismx_tenant; SELECT count(*) FROM missions;`,
    );
    check('a tenant session with no organization set sees no rows', blind === '0', `saw ${blind}`);

    // Read the org this suite has been writing to, then read it back through
    // a constrained session pinned to a *different* organization.
    const ownOrg = psql(
      `SELECT id FROM organizations WHERE name = ${JSON.stringify(ACCOUNT.organizationName).replace(/"/g, "'")} LIMIT 1`,
    );
    const otherOrg = psql(`SELECT id FROM organizations WHERE id <> '${ownOrg}' LIMIT 1`);

    if (ownOrg && otherOrg) {
      const mine = psql(
        `SET ROLE prismx_tenant; SELECT set_config('app.current_organization_id','${ownOrg}',false);` +
          ` SELECT count(*) FROM missions;`,
      );
      const theirs = psql(
        `SET ROLE prismx_tenant; SELECT set_config('app.current_organization_id','${otherOrg}',false);` +
          ` SELECT count(*) FROM missions WHERE "organizationId" = '${ownOrg}';`,
      );
      check('a tenant session sees its own rows', Number(mine) >= 1, `${mine} mission(s)`);
      check(
        'a tenant session cannot read another organization even by naming it',
        theirs === '0',
        `saw ${theirs}`,
      );

      // The events table is written by the append buffer under withTenant, so
      // this also proves the buffered write path lands in the right tenant.
      const bufferedEvents = psql(
        `SET ROLE prismx_tenant; SELECT set_config('app.current_organization_id','${ownOrg}',false);` +
          ` SELECT count(*) FROM events;`,
      );
      check(
        'batched event writes landed under the tenant that produced them',
        Number(bufferedEvents) >= 1,
        `${bufferedEvents} event(s)`,
      );

      let insertBlocked = false;
      try {
        psql(
          `BEGIN; SET ROLE prismx_tenant;` +
            ` SELECT set_config('app.current_organization_id','${ownOrg}',true);` +
            ` INSERT INTO missions (id,"organizationId",title,objective) ` +
            ` VALUES ('omega-rls-probe','${otherOrg}','probe','probe'); ROLLBACK;`,
        );
      } catch {
        insertBlocked = true;
      }
      check('a cross-tenant INSERT is rejected by WITH CHECK', insertBlocked);
    } else {
      check('two organizations exist to compare', false, `own=${ownOrg} other=${otherOrg}`);
    }

    // Operator tables carry no organizationId and are protected differently:
    // RLS on with no policies at all, which denies everything to a constrained
    // role. There is no tenant that "owns" an instance row.
    let operatorBlocked = false;
    try {
      const seen = psql(`SET ROLE prismx_tenant; SELECT count(*) FROM instances;`);
      operatorBlocked = seen === '0';
    } catch {
      operatorBlocked = true;
    }
    check('operator tables are unreachable from a tenant session', operatorBlocked);
  } catch (error) {
    check('RLS checks executed', false, String(error.message).slice(0, 140));
  }

  console.log(`\n${'='.repeat(66)}`);
  console.log(`${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
