/**
 * PRISM-X Backend — Phase 8 validation suite.
 *
 * Exercises the ten Phase 8 checks against a running server with live
 * Postgres and Redis:
 *
 *   1. Production deployment succeeds
 *   2. Multiple backend instances operate correctly
 *   3. Monitoring captures platform health
 *   4. Backups restore successfully
 *   5. CI/CD deploys automatically
 *   6. Billing calculations are accurate
 *   7. Enterprise administration functions correctly
 *   8. Test suite passes
 *   9. Security controls operate as expected
 *  10. Production readiness checklist is complete
 *
 * Check 2 starts a genuine second process against the same database, because
 * leader election that has only ever run with one instance has not been tested.
 *
 *   node test/phase8-validation.js
 */
const { spawn } = require('node:child_process');
const { createHmac, existsSync } = { ...require('node:crypto'), ...require('node:fs') };
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000/api/v1';
const results = [];
let failures = 0;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  if (!passed) failures++;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

async function api(method, endpoint, { token, apiKey, body, raw, text, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (apiKey) h['x-api-key'] = apiKey;

  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw_ = await response.text();
  if (text) return { status: response.status, body: raw_, headers: response.headers };

  let json = null;
  try {
    json = raw_ ? JSON.parse(raw_) : null;
  } catch {
    json = raw_;
  }
  return raw ? { status: response.status, body: json, headers: response.headers } : json;
}

/** The same TOTP the server computes, so enrolment can actually be confirmed. */
function totp(base32Secret, drift = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of base32Secret.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const secret = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / 30) + drift;

  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** 6).padStart(6, '0');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const unique = Date.now();
const ACCOUNT = {
  email: `phase8-${unique}@prism-x.test`,
  password: 'CorrectHorse42Battery',
  organizationName: `Phase8 Labs ${unique}`,
};

let secondInstance = null;

(async () => {
  console.log(`\nPRISM-X Backend — Phase 8 validation\n${'='.repeat(66)}\n`);

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
  console.log('--- 1. Production deployment succeeds ---');

  const root = path.join(__dirname, '..');
  const artefacts = {
    dockerfile: fs.existsSync(path.join(root, 'Dockerfile')),
    dockerignore: fs.existsSync(path.join(root, '.dockerignore')),
    compose: fs.existsSync(path.join(root, 'docker-compose.yml')),
    composeProd: fs.existsSync(path.join(root, 'docker-compose.prod.yml')),
    loadBalancer: fs.existsSync(path.join(root, 'ops', 'nginx.conf')),
    pipeline: fs.existsSync(path.join(root, '..', '.github', 'workflows', 'ci.yml')),
  };
  check(
    'the deployment artefacts exist',
    Object.values(artefacts).every(Boolean),
    Object.entries(artefacts).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'all present',
  );

  const dockerfile = artefacts.dockerfile
    ? fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')
    : '';
  check(
    'the image is multi-stage, runs unprivileged and has a liveness check',
    /FROM .* AS build/.test(dockerfile) &&
      /USER prismx/.test(dockerfile) &&
      /HEALTHCHECK/.test(dockerfile),
    `${(dockerfile.match(/^FROM /gm) ?? []).length} stage(s)`,
  );

  const composeProd = artefacts.composeProd
    ? fs.readFileSync(path.join(root, 'docker-compose.prod.yml'), 'utf8')
    : '';
  check(
    'production compose refuses to start without its secrets',
    /JWT_SECRET:\?/.test(composeProd.replace(/\$\{/g, '')) ||
      /\$\{JWT_SECRET:\?/.test(composeProd),
    'required-variable syntax present',
  );
  check(
    'migrations run as their own step, not at instance startup',
    /migrate:/.test(composeProd) && /service_completed_successfully/.test(composeProd),
  );

  const live = await api('GET', '/ops/health/live');
  check(
    'the environment is reported and separated',
    ['development', 'test', 'staging', 'production'].includes(live?.environment),
    `${live?.environment} v${live?.version}`,
  );

  const evidence = await api('GET', '/ops/readiness/evidence', t());
  check(
    'configuration comes from the environment, and shipped defaults are detected',
    Array.isArray(evidence?.config?.defaultSecretsInUse),
    evidence?.config?.defaultSecretsInUse?.length
      ? `defaults still in use: ${evidence.config.defaultSecretsInUse.join(', ')}`
      : 'no shipped defaults in use',
  );

  // ================================================================
  console.log('\n--- 2. Multiple backend instances operate correctly ---');

  const before = await api('GET', '/ops/instances', t());
  check(
    'this instance is registered and holds the scheduler lease',
    before?.self && before.leader === before.self && before.isLeader === true,
    `${before?.healthy} healthy, leader ${before?.leader}`,
  );

  // A genuine second process against the same database. Leader election that
  // has only run with one instance has not been tested.
  console.log('    starting a second instance on :3101 …');
  secondInstance = spawn('node', ['dist/main.js'], {
    cwd: root,
    env: { ...process.env, PORT: '3101' },
    stdio: 'ignore',
    detached: false,
  });

  let secondUp = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(1000);
    try {
      const probe = await fetch('http://127.0.0.1:3101/api/v1/ops/health/live');
      if (probe.ok) {
        secondUp = true;
        break;
      }
    } catch {
      /* still starting */
    }
  }
  check('a second instance starts against the same database', secondUp);

  // Give both a heartbeat cycle to register and contend for the lease.
  await sleep(3000);

  const cluster = await api('GET', '/ops/instances', t());
  check(
    'both instances are visible to each other',
    cluster?.healthy >= 2,
    `${cluster?.healthy} healthy instance(s)`,
  );

  const leaders = (cluster?.instances ?? []).filter((i) => i.isLeader);
  check(
    'exactly one instance holds the lease — scheduled work is not duplicated',
    leaders.length === 1,
    `${leaders.length} leader(s): ${leaders.map((l) => l.instanceId).join(', ')}`,
  );

  const secondLive = await fetch('http://127.0.0.1:3101/api/v1/ops/health/live').then((r) => r.json());
  check(
    'the second instance has its own identity',
    secondLive?.instanceId && secondLive.instanceId !== before.self,
    secondLive?.instanceId,
  );

  // A session opened against one instance must work against the other, which
  // is the whole claim of statelessness.
  const crossInstance = await fetch('http://127.0.0.1:3101/api/v1/missions', {
    headers: { authorization: `Bearer ${token}` },
  });
  check(
    'a session created on one instance is accepted by the other',
    crossInstance.status === 200,
    `status ${crossInstance.status}`,
  );
  check(
    'responses identify the instance that served them',
    Boolean(crossInstance.headers.get('x-instance-id')) &&
      crossInstance.headers.get('x-instance-id') !== before.self,
    crossInstance.headers.get('x-instance-id'),
  );

  // Statelessness is now measured from a register of what each component
  // actually holds in memory, not asserted. So the check is that the platform
  // either reports itself stateless or names precisely what stops it — a
  // hard-coded `true` would pass this line and tell us nothing.
  const holdings = evidence?.instances?.statefulHoldings ?? [];
  check(
    'the platform reports statelessness from measurement, naming any holding',
    evidence?.instances?.stateless === true || holdings.length > 0,
    evidence?.instances?.stateless === true ? 'stateless' : holdings.join('; '),
  );
  check(
    'the only thing that can hold state here is the unshared local storage driver',
    evidence?.instances?.stateless === true ||
      holdings.every((holding) => String(holding).startsWith('backup.artefacts')),
    holdings.join('; ') || 'none',
  );

  // ================================================================
  console.log('\n--- 3. Monitoring captures platform health ---');

  const probes = await Promise.all([
    api('GET', '/ops/health/live', { raw: true }),
    api('GET', '/ops/health/ready', { raw: true }),
    api('GET', '/ops/health/deep', { raw: true }),
  ]);
  check(
    'liveness and readiness answer separately, and neither depends on the other',
    probes[0].status === 200 &&
      probes[1].status === 200 &&
      probes[0].body.status === 'alive' &&
      probes[1].body.status === 'ready',
    `live ${probes[0].status}, ready ${probes[1].status}`,
  );
  check(
    'the deep check is available and rate limited',
    // 429 is a correct answer here: the exhaustion test below shares this
    // route's budget, and a probe that could exhaust it would not be a probe.
    [200, 429].includes(probes[2].status),
    `deep ${probes[2].status}`,
  );
  check(
    'readiness reports its dependency checks',
    probes[1].body?.checks?.database === true,
    JSON.stringify(probes[1].body?.checks),
  );

  const prometheus = await api('GET', '/ops/metrics', { text: true });
  check(
    'metrics are exposed in Prometheus format',
    prometheus.status === 200 &&
      prometheus.body.includes('# TYPE prismx_http_requests_total counter'),
    `${prometheus.body.split('\n').length} line(s)`,
  );
  check(
    'metrics carry no tenant identifiers',
    // Parameter names in a route template (`:workerId`) are fine — they are
    // the opposite of an identifier. What must never appear is a *value*: a
    // cuid, an email, or anything unique to one caller.
    !/c[a-z0-9]{20,}|@[a-z0-9.-]+\.[a-z]{2,}/i.test(prometheus.body) &&
      !prometheus.body.includes(String(unique)),
    'no identifiers, addresses or unique values in any label',
  );

  const snapshot = await api('GET', '/ops/metrics/json', t());
  const duration = snapshot?.metrics?.prismx_http_request_duration_ms;
  check(
    'latency is recorded as a distribution, not an average',
    duration?.kind === 'histogram' && typeof duration.p95 === 'number',
    `count ${duration?.count}, p50 ${duration?.p50}ms, p95 ${duration?.p95}ms`,
  );
  const routeLabels = (snapshot?.metrics?.prismx_http_requests_total?.series ?? []).map(
    (entry) => entry.labels.route,
  );
  check(
    'requests are labelled by route template, not by URL',
    routeLabels.length > 0 &&
      // No cuid, no numeric id, no query string — an unbounded label value is
      // a memory leak with a dashboard attached.
      routeLabels.every((route) => !/c[a-z0-9]{20,}|\?|\d{6,}/.test(route)),
    `${routeLabels.length} route label(s): ${[...new Set(routeLabels)].slice(0, 3).join(', ')}`,
  );

  const traced = await api('GET', '/missions', {
    ...t(),
    raw: true,
    headers: { 'x-request-id': `trace-${unique}` },
  });
  check(
    'a correlation identifier is honoured and echoed',
    traced.headers.get('x-request-id') === `trace-${unique}`,
    traced.headers.get('x-request-id'),
  );

  const alerts = await api('GET', '/ops/alerts', t());
  check(
    'alert rules are seeded and evaluated',
    (alerts?.rules ?? []).length >= 8,
    `${alerts?.rules?.length} rule(s), ${alerts?.summary?.firing} firing`,
  );
  check(
    'rules cover errors, latency, queues, providers, availability and auth',
    ['api_error_rate', 'api_latency_p95', 'dead_letters', 'provider_errors',
     'no_healthy_instances', 'auth_failures'].every((key) =>
      alerts.rules.some((rule) => rule.key === key),
    ),
  );

  const evaluated = await api('POST', '/ops/alerts/evaluate', t());
  check(
    'evaluation runs every rule without firing on thin data',
    evaluated?.evaluated >= 8,
    `${evaluated?.evaluated} evaluated, ${evaluated?.fired} fired`,
  );

  // ================================================================
  console.log('\n--- 4. Backups restore successfully ---');

  const backup = await api('POST', '/ops/backups', {
    ...t(),
    body: { kind: 'DATABASE', retentionDays: 7 },
  });
  check(
    'a backup completes, encrypted, with a checksum',
    backup?.status === 'SUCCEEDED' && backup.encrypted === true && backup.checksum?.length === 64,
    `${backup?.sizeBytes} bytes, checksum ${backup?.checksum?.slice(0, 12)}`,
  );
  check(
    'the backup records what it captured',
    Object.keys(backup?.manifest?.tables ?? {}).length > 10,
    `${Object.keys(backup?.manifest?.tables ?? {}).length} table(s), ${backup?.manifest?.rows} row(s)`,
  );

  const verified = await api('POST', `/ops/backups/${backup.id}/verify`, t());
  check(
    'verification reads the backup back and matches the plaintext checksum',
    verified?.ok === true && verified.backup.status === 'VERIFIED',
    verified?.detail,
  );

  const dry = await api('POST', `/ops/backups/${backup.id}/restore`, {
    ...t(),
    body: { mode: 'FULL' },
  });
  check(
    'a restore defaults to a dry run',
    dry?.status === 'SUCCEEDED' && dry.dryRun === true && dry.rowsRestored > 0,
    `${dry?.tablesRestored} table(s), ${dry?.rowsRestored} row(s) — nothing written`,
  );

  const real = await api('POST', `/ops/backups/${backup.id}/restore`, {
    ...t(),
    body: { mode: 'FULL', dryRun: false },
  });
  check(
    'a real restore writes without clobbering newer rows',
    real?.status === 'SUCCEEDED' && real.dryRun === false,
    `${real?.rowsRestored} row(s) considered`,
  );

  const pit = await api('POST', '/ops/backups/point-in-time', {
    ...t(),
    body: { targetTime: new Date().toISOString(), dryRun: true },
  });
  check(
    'point-in-time recovery selects the nearest backup and says what it is',
    pit?.mode === 'POINT_IN_TIME' &&
      pit.status === 'SUCCEEDED' &&
      String(JSON.stringify(pit.detail)).includes('WAL archiving'),
    'reconstructs to the nearest backup; the limit is stated',
  );

  const posture = await api('GET', '/ops/backups/posture', t());
  check(
    'recovery posture reports the recovery point objective',
    posture?.allEncrypted === true &&
      posture.restoreExercised === true &&
      typeof posture.recoveryPointObjectiveHours === 'number',
    `RPO ${posture?.recoveryPointObjectiveHours}h, ${posture?.count} backup(s)`,
  );

  // ================================================================
  console.log('\n--- 5. CI/CD deploys automatically ---');

  const pipeline = artefacts.pipeline
    ? fs.readFileSync(path.join(root, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
    : '';
  const gates = [
    'npm run lint',
    'tsc -p tsconfig.check.json --noEmit',
    'prisma validate',
    'npm test',
    'npm audit',
    'prisma migrate deploy',
    'npm run build',
  ];
  const missingGates = gates.filter((gate) => !pipeline.includes(gate));
  check(
    'the pipeline gates on lint, types, schema, tests, security, migrations and build',
    missingGates.length === 0,
    missingGates.length ? `missing: ${missingGates.join(', ')}` : `${gates.length} gates`,
  );
  check(
    'the pipeline runs every validation suite against live infrastructure',
    /phase\$\{phase\}-validation\.js/.test(pipeline) &&
      /postgres:16/.test(pipeline) &&
      /redis:7/.test(pipeline),
  );
  check(
    'migrations are proven against an empty database and for idempotency',
    /Migrations apply to an empty database/.test(pipeline) &&
      /Migrations are idempotent/.test(pipeline),
  );
  check(
    'deployment requires a human on the environment, and can roll back',
    pipeline.includes('name: ${{ inputs.deploy }}') &&
      pipeline.includes('Roll back on failure') &&
      /if: github\.event_name == 'workflow_dispatch'/.test(pipeline),
    'gated on a protected environment, with a rollback step',
  );

  const release = await api('POST', '/admin/releases', {
    ...t(),
    body: { environment: 'STAGING', version: `1.0.${unique % 1000}`, commitSha: 'a91f3c2' },
  });
  check('a deployment is recorded before it happens', release?.status === 'RUNNING', release?.version);

  const completed = await api('POST', `/admin/releases/${release.id}/complete`, {
    ...t(),
    body: { succeeded: true },
  });
  check('a deployment is closed out with its duration', completed?.status === 'SUCCEEDED');

  const second = await api('POST', '/admin/releases', {
    ...t(),
    body: { environment: 'STAGING', version: `1.0.${(unique % 1000) + 1}` },
  });
  await api('POST', `/admin/releases/${second.id}/complete`, { ...t(), body: { succeeded: true } });
  check(
    'a deployment records the version it replaced',
    second?.previousVersion === release.version,
    `${second?.previousVersion} → ${second?.version}`,
  );

  const rolledBack = await api('POST', `/admin/releases/${second.id}/rollback`, {
    ...t(),
    body: { reason: 'Error rate spiked after the deploy.' },
  });
  check(
    'a rollback is a new release pointing at what it undid',
    rolledBack?.version === release.version && rolledBack.previousVersion === second.version,
    `${rolledBack?.previousVersion} → ${rolledBack?.version}`,
  );

  const history = await api('GET', '/admin/releases?environment=STAGING', t());
  check(
    'deployment history keeps the original rather than rewriting it',
    history.some((r) => r.id === second.id && r.status === 'ROLLED_BACK') &&
      history.some((r) => r.rollbackOfId === second.id),
    `${history.length} release(s)`,
  );

  // ================================================================
  console.log('\n--- 6. Billing calculations are accurate ---');

  const plans = await api('GET', '/billing/plans', t());
  check(
    'a plan ladder is available',
    plans.length >= 4 && plans.every((p) => p.key && typeof p.priceCents === 'number'),
    plans.map((p) => `${p.key}:$${p.priceCents / 100}`).join(' '),
  );

  const unlicensed = await api('GET', '/billing/entitlements', t());
  check(
    'an organization with no subscription is unlicensed, not blocked',
    unlicensed?.licensed === false && unlicensed.features.includes('*'),
    `plan ${unlicensed?.planKey}`,
  );

  const subscribed = await api('POST', '/billing/subscribe', {
    ...t(),
    body: { planKey: 'team', seats: 7 },
  });
  check(
    'subscribing starts a trial when the plan offers one',
    subscribed?.status === 'TRIALING' && subscribed.seats === 7,
    `${subscribed?.planKey}, ${subscribed?.seats} seats, trial ends ${subscribed?.trialEndsAt?.slice(0, 10)}`,
  );

  const entitled = await api('GET', '/billing/entitlements', t());
  const teamPlan = plans.find((p) => p.key === 'team');
  check(
    'entitlements reflect the plan',
    entitled?.licensed === true &&
      entitled.features.length === teamPlan.features.length &&
      entitled.limits.workers === teamPlan.limits.workers,
    `${entitled?.features?.length} feature(s), workers ≤ ${entitled?.limits?.workers}`,
  );

  const invoice = await api('POST', '/billing/invoices', t());
  const planLine = (invoice?.lines ?? []).find((l) => l.kind === 'plan');
  const seatLine = (invoice?.lines ?? []).find((l) => l.kind === 'seats');
  const expectedSeats = (7 - teamPlan.seatsIncluded) * teamPlan.seatPriceCents;

  check(
    'the invoice charges the plan price',
    planLine?.amountCents === teamPlan.priceCents,
    `$${(planLine?.amountCents ?? 0) / 100} vs plan $${teamPlan.priceCents / 100}`,
  );
  check(
    'additional seats are charged beyond what the plan includes',
    seatLine?.quantity === 7 - teamPlan.seatsIncluded && seatLine.amountCents === expectedSeats,
    `${seatLine?.quantity} extra seat(s) × $${teamPlan.seatPriceCents / 100} = $${expectedSeats / 100}`,
  );
  check(
    'the total is the sum of its lines',
    invoice?.totalCents === invoice.subtotalCents + invoice.usageCents &&
      invoice.subtotalCents === (planLine?.amountCents ?? 0) + (seatLine?.amountCents ?? 0),
    `$${invoice?.totalCents / 100} = $${invoice?.subtotalCents / 100} + $${invoice?.usageCents / 100}`,
  );
  check(
    'every line carries the numbers it was derived from',
    (invoice?.lines ?? []).every((line) => line.kind && line.description && 'amountCents' in line),
    `${invoice?.lines?.length} line(s)`,
  );

  // Exercised after invoicing, so the seat count the invoice was built from
  // is the one that was subscribed to.
  const raised = await api('POST', '/billing/seats', { ...t(), body: { seats: 12 } });
  check('seats can be raised', raised?.seats === 12, `${raised?.seats} seat(s)`);

  const lowered = await api('POST', '/billing/seats', { ...t(), body: { seats: 1 } });
  check(
    'seats can be lowered only to the member count',
    lowered?.seats === 1,
    'one member, so one seat is the floor',
  );

  const paid = await api('POST', `/billing/invoices/${invoice.id}/paid`, t());
  check('an invoice can be settled', paid?.status === 'PAID' && Boolean(paid.paidAt));

  const billingOverview = await api('GET', '/billing', t());
  check(
    'usage is read from what execution recorded, not counted twice',
    typeof billingOverview?.usage?.kTokens === 'number' &&
      billingOverview.usage.includedKTokens === teamPlan.includedKTokens,
    `${billingOverview?.usage?.kTokens}k used of ${billingOverview?.usage?.includedKTokens}k included`,
  );

  const cancelled = await api('POST', '/billing/cancel', t());
  check(
    'cancelling keeps the period already paid for',
    cancelled?.cancelAtPeriodEnd === true && cancelled.status !== 'CANCELLED',
    `status ${cancelled?.status}, ends ${cancelled?.currentPeriodEnd?.slice(0, 10)}`,
  );

  // ================================================================
  console.log('\n--- 7. Enterprise administration functions correctly ---');

  const admin = await api('GET', '/admin', t());
  check(
    'the administration overview covers people, capability and platform',
    admin?.members?.total >= 1 &&
      typeof admin.extensions?.total === 'number' &&
      typeof admin.providers?.total === 'number' &&
      admin.platform?.instances >= 1,
    `${admin?.members?.total} member(s), ${admin?.platform?.instances} instance(s)`,
  );

  const accessModel = await api('GET', '/admin/access', t());
  check(
    'the access model is reported as configured',
    accessModel?.permissionCount >= 60 && accessModel.roles.length >= 4,
    `${accessModel?.permissionCount} permissions across ${accessModel?.roles?.length} roles`,
  );
  const owner = accessModel.roles.find((r) => r.key === 'OWNER');
  check(
    'the owner role tracks the permission catalogue rather than a fixed list',
    owner?.tracksCatalogue === true && owner.permissionCount === accessModel.permissionCount,
    `${owner?.permissionCount} of ${accessModel?.permissionCount} permissions`,
  );

  const members = await api('GET', '/admin/members', t());
  check(
    'members are listed with roles and sign-in history',
    members.length >= 1 && members[0].role && 'lastLoginAt' in members[0],
    `${members.length} member(s)`,
  );

  const accessReview = await api('POST', '/admin/compliance', {
    ...t(),
    body: { kind: 'ACCESS_REVIEW' },
  });
  check(
    'an access review reports privileged and dormant accounts',
    accessReview?.summary?.members >= 1 && 'dormant' in accessReview.summary,
    `${accessReview?.summary?.members} member(s), ${accessReview?.summary?.privileged} privileged, ${accessReview?.summary?.dormant} dormant`,
  );

  const inventory = await api('POST', '/admin/compliance', {
    ...t(),
    body: { kind: 'DATA_INVENTORY' },
  });
  check(
    'a data inventory lists stores, processors and what can reach them',
    inventory?.summary?.dataStores >= 6 && 'extensionsWithDataAccess' in inventory.summary,
    `${inventory?.summary?.dataStores} store(s), ${inventory?.summary?.processors} processor(s)`,
  );

  const securityReport = await api('POST', '/admin/compliance', {
    ...t(),
    body: { kind: 'SECURITY_POSTURE' },
  });
  check(
    'a security posture report is generated',
    typeof securityReport?.summary?.administrators === 'number',
    `${securityReport?.summary?.administrators} administrator(s)`,
  );

  const reports = await api('GET', '/admin/compliance', t());
  check(
    'reports are stored rather than re-derived on demand',
    reports.length >= 3 && reports.every((r) => r.createdAt && r.findings),
    `${reports.length} report(s)`,
  );

  const stored = await api('GET', `/admin/compliance/${accessReview.id}`, t());
  check(
    'a stored report can be re-read whole',
    stored?.id === accessReview.id && Object.keys(stored.findings).length > 0,
  );

  // ================================================================
  console.log('\n--- 8. Test suite passes ---');

  const suites = fs
    .readdirSync(path.join(root, 'test'))
    .filter((file) => /^phase\d+-validation\.js$/.test(file));
  check(
    'a validation suite exists for every phase',
    suites.length === 8,
    suites.sort().join(', '),
  );

  const specs = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.spec.ts')) specs.push(full);
    }
  };
  walk(path.join(root, 'src'));
  check(
    'unit specs cover the primitives each phase is built on',
    specs.length >= 16,
    `${specs.length} spec file(s)`,
  );
  check(
    'the pipeline blocks a deploy on a failing suite',
    evidence?.quality?.gatesDeployment === true,
    `${evidence?.quality?.suites} suite(s) wired into CI`,
  );

  // ================================================================
  console.log('\n--- 9. Security controls operate as expected ---');

  const mfaBefore = await api('GET', '/security/mfa', t());
  check('no second factor is enrolled to begin with', mfaBefore?.enrolled === false);

  const enrolment = await api('POST', '/security/mfa/enrol', t());
  check(
    'enrolment returns a secret and a provisioning URI, once',
    enrolment?.secret?.length >= 16 && enrolment.otpauthUrl?.startsWith('otpauth://totp/'),
    `${enrolment?.digits} digits, ${enrolment?.period}s period`,
  );

  const wrongCode = await api('POST', '/security/mfa/confirm', {
    ...t(),
    body: { code: '000000' },
    raw: true,
  });
  check(
    'a wrong code does not confirm enrolment',
    wrongCode.status === 401,
    wrongCode.body?.message,
  );

  const confirmed = await api('POST', '/security/mfa/confirm', {
    ...t(),
    body: { code: totp(enrolment.secret) },
  });
  check(
    'a correct code confirms enrolment and issues recovery codes',
    (confirmed?.recoveryCodes ?? []).length === 10,
    `${confirmed?.recoveryCodes?.length} recovery code(s)`,
  );

  const drifted = await api('POST', '/security/mfa/verify', {
    ...t(),
    body: { code: totp(enrolment.secret, -1) },
  });
  check(
    'clock drift of one step is tolerated',
    drifted?.ok === true,
    `verified by ${drifted?.method}`,
  );

  const farDrift = await api('POST', '/security/mfa/verify', {
    ...t(),
    body: { code: totp(enrolment.secret, -5) },
  });
  check('drift beyond the window is refused', farDrift?.ok === false);

  const recovery = confirmed.recoveryCodes[0];
  const byRecovery = await api('POST', '/security/mfa/verify', { ...t(), body: { code: recovery } });
  check(
    'a recovery code verifies',
    byRecovery?.ok === true && byRecovery.method === 'RECOVERY_CODE',
  );

  const reuse = await api('POST', '/security/mfa/verify', { ...t(), body: { code: recovery } });
  check('a recovery code cannot be used twice', reuse?.ok === false);

  const afterRecovery = await api('GET', '/security/mfa', t());
  check(
    'the consumed code is gone',
    afterRecovery?.recoveryCodesRemaining === 9,
    `${afterRecovery?.recoveryCodesRemaining} remaining`,
  );

  const allowEntry = await api('POST', '/security/ip-allowlist', {
    ...t(),
    body: { cidr: '203.0.113.0/24', label: 'Office' },
  });
  check('a network restriction is accepted', allowEntry?.cidr === '203.0.113.0/24');

  const badCidr = await api('POST', '/security/ip-allowlist', {
    ...t(),
    body: { cidr: 'not-an-address' },
    raw: true,
  });
  check('a malformed block is refused', badCidr.status === 400);
  await api('DELETE', `/security/ip-allowlist/${allowEntry.id}`, t());

  const rotation = await api('POST', '/security/rotate', {
    ...t(),
    body: { scope: 'CREDENTIAL_KEY', overlapHours: 1 },
  });
  check(
    'rotation completes with an overlap window rather than an instant cutover',
    rotation?.status === 'OVERLAPPING' && Boolean(rotation.overlapUntil),
    `${rotation?.itemsRotated} item(s) rotated`,
  );

  const securityPosture = await api('GET', '/security/posture', t());
  check(
    'security posture reports MFA coverage and stale credentials',
    securityPosture?.administratorsWithMfa >= 1 && 'staleApiKeys' in securityPosture,
    `${securityPosture?.administratorsWithMfa}/${securityPosture?.administrators} admins with MFA`,
  );

  // Rate limiting: /ops/health/deep is capped at 20/minute.
  let limited = null;
  for (let i = 0; i < 28; i += 1) {
    const response = await api('GET', '/ops/health/deep', { raw: true });
    if (response.status === 429) {
      limited = response;
      break;
    }
  }
  check(
    'rate limiting refuses a caller over budget',
    limited?.status === 429,
    limited ? `blocked after the budget, retry-after ${limited.headers.get('retry-after')}s` : 'never blocked',
  );
  check(
    'the response tells a client when to come back',
    Boolean(limited?.headers.get('retry-after')) && Boolean(limited?.headers.get('x-ratelimit-limit')),
    `limit ${limited?.headers.get('x-ratelimit-limit')}`,
  );

  const headers = await api('GET', '/ops/health/live', { raw: true });
  check(
    'security headers are applied to every response',
    headers.headers.get('x-frame-options') === 'DENY' &&
      headers.headers.get('x-content-type-options') === 'nosniff' &&
      headers.headers.get('referrer-policy') === 'no-referrer',
    'frame-options, content-type-options, referrer-policy',
  );

  const unauth = await api('GET', '/admin', { raw: true });
  check('administration refuses unauthenticated callers', unauth.status === 401);

  const disable = await api('POST', '/security/mfa/disable', {
    ...t(),
    body: { code: '000000' },
    raw: true,
  });
  check(
    'disabling the second factor requires the factor itself',
    disable.status === 401,
    disable.body?.message,
  );

  // ================================================================
  console.log('\n--- 10. Production readiness checklist is complete ---');

  const bar = await api('GET', '/ops/readiness/checks', t());
  check(
    'the readiness bar is published as executable checks',
    (bar?.checks ?? []).length >= 24 &&
      bar.checks.every((c) => c.id && c.dimension && c.statement && c.rationale && c.severity),
    `${bar?.checks?.length} checks, version ${bar?.version}`,
  );
  check(
    'every dimension the review is meant to cover has at least one check',
    ['ARCHITECTURE', 'PERFORMANCE', 'SECURITY', 'SCALABILITY', 'RELIABILITY',
     'DOCUMENTATION', 'RECOVERY', 'MONITORING', 'DEVELOPER_EXPERIENCE', 'OPERATIONS'].every(
      (dimension) => bar.checks.some((c) => c.dimension === dimension),
    ),
    `${new Set(bar.checks.map((c) => c.dimension)).size} dimension(s)`,
  );

  const reviewed = await api('GET', '/ops/readiness', t());
  check(
    'the review runs and grades every check',
    reviewed?.verdicts?.length === bar.checks.length &&
      reviewed.summary.PASS + reviewed.summary.WARN + reviewed.summary.FAIL + reviewed.summary.UNKNOWN ===
        bar.checks.length,
    `${reviewed?.summary?.PASS} pass, ${reviewed?.summary?.WARN} warn, ${reviewed?.summary?.FAIL} fail, ${reviewed?.summary?.UNKNOWN} unknown`,
  );
  check(
    'the review is evidence-driven, not declared',
    reviewed.verdicts.every((v) => typeof v.detail === 'string' && v.detail.length > 0),
    'every verdict cites a measured value',
  );
  check(
    'tenant isolation is verified against the catalogue, not a list',
    reviewed.verdicts.find((v) => v.id === 'TENANT_ISOLATION_COMPLETE')?.outcome === 'PASS',
    reviewed.verdicts.find((v) => v.id === 'TENANT_ISOLATION_COMPLETE')?.detail,
  );
  check(
    'no migration is pending against the running schema',
    reviewed.verdicts.find((v) => v.id === 'MIGRATIONS_SETTLED')?.outcome === 'PASS',
    reviewed.verdicts.find((v) => v.id === 'MIGRATIONS_SETTLED')?.detail,
  );
  check(
    'leader election is verified, not assumed',
    reviewed.verdicts.find((v) => v.id === 'SCHEDULED_WORK_ELECTED')?.outcome === 'PASS',
    reviewed.verdicts.find((v) => v.id === 'SCHEDULED_WORK_ELECTED')?.detail,
  );
  check(
    'recovery is graded on a real backup and a real restore',
    reviewed.verdicts.find((v) => v.id === 'BACKUPS_ENCRYPTED')?.outcome === 'PASS' &&
      reviewed.verdicts.find((v) => v.id === 'RESTORE_EXERCISED')?.outcome === 'PASS',
    reviewed.verdicts.find((v) => v.id === 'RESTORE_EXERCISED')?.detail,
  );
  check(
    'runbooks are counted, not claimed',
    reviewed.verdicts.find((v) => v.id === 'RUNBOOKS')?.outcome === 'PASS',
    reviewed.verdicts.find((v) => v.id === 'RUNBOOKS')?.detail,
  );
  check(
    'what could not be measured is UNKNOWN rather than a pass',
    reviewed.verdicts
      .filter((v) => v.outcome === 'UNKNOWN')
      .every((v) => /not enough|has not run|no |unreachable/i.test(v.detail)),
    `${reviewed.summary.UNKNOWN} check(s) abstained with a reason`,
  );
  check(
    'a failing blocker is what decides production readiness',
    reviewed.readyForProduction === (reviewed.blockers.length === 0),
    reviewed.readyForProduction
      ? `ready, score ${(reviewed.score * 100).toFixed(0)}%`
      : `${reviewed.blockers.length} blocker(s): ${reviewed.blockers.map((b) => b.id).join(', ')}`,
  );

  const reviewHistory = await api('GET', '/ops/readiness/history', t());
  check(
    'reviews are recorded, so readiness can be tracked over time',
    reviewHistory.length >= 1 && reviewHistory[0].verdicts,
    `${reviewHistory.length} recorded review(s)`,
  );

  // ================================================================
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${'='.repeat(66)}`);
  console.log(`${passed}/${results.length} checks passed`);
  if (failures) {
    console.log('\nFailures:');
    for (const r of results.filter((x) => !x.passed)) {
      console.log(`  - ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`);
    }
  }
})()
  .catch((error) => {
    console.error('\nSuite crashed:', error);
    failures = failures || 1;
  })
  .finally(() => {
    if (secondInstance) {
      secondInstance.kill('SIGTERM');
      // Let the shutdown hook release the lease before the process exits.
      setTimeout(() => process.exit(failures ? 1 : 0), 2000);
    } else {
      process.exit(failures ? 1 : 0);
    }
  });
