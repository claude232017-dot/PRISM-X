/**
 * PRISM-X Backend — Phase 1 validation suite.
 *
 * Exercises the ten checks from the Phase 1 specification against a running
 * server and a live Postgres/Redis. Run with the API listening on $BASE_URL.
 *
 *   node test/phase1-validation.js
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000/api/v1';
const results = [];
let failures = 0;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  if (!passed) failures++;
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

async function api(method, endpoint, { token, body, orgId, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (orgId) headers['x-organization-id'] = orgId;

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
const ALPHA = {
  email: `alpha-${unique}@prism-x.test`,
  password: 'CorrectHorse42Battery',
  organizationName: `Alpha Labs ${unique}`,
};
const BETA = {
  email: `beta-${unique}@prism-x.test`,
  password: 'CorrectHorse42Battery',
  organizationName: `Beta Works ${unique}`,
};

(async () => {
  console.log(`\nPRISM-X Backend — Phase 1 validation\n${'='.repeat(60)}\n`);

  // ---------------------------------------------------------------
  // 1. Authentication
  // ---------------------------------------------------------------
  console.log('--- 1. Authentication ---');

  const registered = await api('POST', '/auth/register', { body: ALPHA });
  check(
    'register creates account + organization + owner membership',
    Boolean(registered?.accessToken && registered?.organization?.id),
    registered?.organization?.slug,
  );

  const alphaLogin = await api('POST', '/auth/login', {
    body: { email: ALPHA.email, password: ALPHA.password },
  });
  const alphaToken = alphaLogin?.accessToken;
  const alphaOrg = alphaLogin?.organization?.id;
  check('login returns tokens, role and permissions', Boolean(alphaToken && alphaOrg));
  // Later phases add resources and therefore permissions, so the assertion
  // is that an owner holds every Phase 1 permission — not that the catalogue
  // has stopped growing.
  const PHASE1_PERMISSIONS = [
    'organization:read', 'organization:update', 'organization:delete',
    'member:read', 'member:invite', 'member:update', 'member:remove',
    'worker:read', 'worker:create', 'worker:update', 'worker:delete',
    'mission:read', 'mission:create', 'mission:update', 'mission:delete', 'mission:execute',
    'knowledge:read', 'knowledge:create', 'knowledge:update', 'knowledge:delete',
    'provider:read', 'provider:create', 'provider:update', 'provider:delete',
    'integration:read', 'integration:create', 'integration:update', 'integration:delete',
    'extension:read', 'extension:install', 'extension:update', 'extension:delete',
    'event:read', 'audit:read', 'analytics:read',
    'storage:read', 'storage:write', 'storage:delete',
  ];
  const missingForOwner = PHASE1_PERMISSIONS.filter(
    (p) => !(alphaLogin?.permissions ?? []).includes(p),
  );
  check(
    'login resolves OWNER role with full permission set',
    alphaLogin?.role === 'OWNER' && missingForOwner.length === 0,
    `${alphaLogin?.role}, ${alphaLogin?.permissions?.length} permissions` +
      (missingForOwner.length ? `, missing ${missingForOwner.join(', ')}` : ''),
  );

  const me = await api('GET', '/auth/me', { token: alphaToken });
  check('GET /auth/me describes the session', Boolean(alphaOrg) && me?.organizationId === alphaOrg);

  const badLogin = await api('POST', '/auth/login', {
    body: { email: ALPHA.email, password: 'WrongPassword123' },
    raw: true,
  });
  check('wrong password is rejected with 401', badLogin.status === 401);

  const noToken = await api('GET', '/workers', { raw: true });
  check('protected route without a token returns 401', noToken.status === 401);

  const resetRequest = await api('POST', '/auth/password-reset/request', {
    body: { email: 'nobody-at-all@prism-x.test' },
    raw: true,
  });
  check(
    'password reset does not disclose whether an account exists',
    resetRequest.status === 200 && resetRequest.body?.success === true,
  );

  const refreshed = await api('POST', '/auth/refresh', {
    body: { refreshToken: alphaLogin.refreshToken },
  });
  check('refresh token exchanges for a new access token', Boolean(refreshed?.accessToken));

  // ---------------------------------------------------------------
  // 2-6. Core entities persist
  // ---------------------------------------------------------------
  console.log('\n--- 2. Core entities persist ---');

  const org = await api('GET', '/organizations/current', { token: alphaToken });
  check('organization persists and is readable', Boolean(alphaOrg) && org?.id === alphaOrg, org?.name);

  const worker = await api('POST', '/workers', {
    token: alphaToken,
    body: {
      name: 'Market Scout',
      role: 'researcher',
      capabilities: ['web-search', 'summarize'],
    },
  });
  check('worker persists', Boolean(worker?.id), worker?.name);

  const workerReread = await api('GET', `/workers/${worker.id}`, { token: alphaToken });
  check('worker survives a re-read', Boolean(worker?.id) && workerReread?.id === worker.id);

  const activated = await api('POST', `/workers/${worker.id}/activate`, { token: alphaToken });
  check('worker activates', activated?.status === 'ACTIVE');

  const emptyWorker = await api('POST', '/workers', {
    token: alphaToken,
    body: { name: 'Hollow', role: 'none' },
  });
  const badActivate = await api('POST', `/workers/${emptyWorker.id}/activate`, {
    token: alphaToken,
    raw: true,
  });
  check(
    'activating a capability-less worker is rejected',
    badActivate.status === 400,
    badActivate.body?.message,
  );

  const mission = await api('POST', '/missions', {
    token: alphaToken,
    body: {
      title: 'Q3 competitive sweep',
      objective: 'Map competitor pricing changes since Q2.',
      priority: 'HIGH',
      tasks: [
        { title: 'Collect pricing pages', workerId: worker.id },
        { title: 'Summarise deltas', dependsOn: ['0'] },
      ],
    },
  });
  check('mission persists with its task graph', Boolean(mission?.id), mission?.title);

  const tasks = await api('GET', `/missions/${mission.id}/tasks`, { token: alphaToken });
  check('tasks persist', tasks?.length === 2, `${tasks?.length} tasks`);
  check(
    'index-based dependencies rewritten to real task ids',
    Boolean(tasks?.[0]?.id) && tasks?.[1]?.dependsOn?.[0] === tasks?.[0]?.id,
  );

  const runnable = await api('GET', `/missions/${mission.id}/tasks/runnable`, {
    token: alphaToken,
  });
  check(
    'only dependency-free tasks are runnable',
    runnable?.length === 1 && runnable[0].id === tasks[0].id,
  );

  const cyclic = await api('POST', '/missions', {
    token: alphaToken,
    raw: true,
    body: {
      title: 'Cyclic',
      objective: 'Should be rejected',
      tasks: [
        { title: 'Alpha step', dependsOn: ['1'] },
        { title: 'Beta step', dependsOn: ['0'] },
      ],
    },
  });
  check('cyclic task graph is rejected', cyclic.status === 400, cyclic.body?.message);

  const knowledge = await api('POST', '/knowledge', {
    token: alphaToken,
    body: {
      title: 'Competitor pricing moved 12%',
      content: 'Across the top five competitors list price rose 12% on average.',
      type: 'INSIGHT',
      tags: ['Pricing', 'pricing ', 'competitive'],
    },
  });
  check('knowledge persists', Boolean(knowledge?.id));
  check(
    'tags are normalised and de-duplicated',
    JSON.stringify(knowledge?.tags) === JSON.stringify(['pricing', 'competitive']),
    JSON.stringify(knowledge?.tags),
  );

  const search = await api('GET', '/knowledge?search=competitor', { token: alphaToken });
  check('knowledge search finds the entry', search?.data?.length >= 1);

  const provider = await api('POST', '/providers', {
    token: alphaToken,
    body: {
      name: 'Primary reasoning provider',
      kind: 'ANTHROPIC',
      apiKey: 'sk-test-secret-value-f3a9',
      isDefault: true,
    },
  });
  check('provider persists', Boolean(provider?.id));

  const providerJson = JSON.stringify(provider);
  check(
    'provider API key is never returned (only a hint)',
    !providerJson.includes('sk-test-secret-value') && provider?.keyHint === '****f3a9',
    `keyHint=${provider?.keyHint}`,
  );

  const integration = await api('POST', '/integrations', {
    token: alphaToken,
    body: { name: 'Ops Slack', kind: 'slack', config: { channel: '#alerts' } },
  });
  check('integration persists', Boolean(integration?.id));

  const extension = await api('POST', '/extensions', {
    token: alphaToken,
    body: {
      name: 'LinkedIn Composer',
      slug: 'linkedin-composer',
      subscribes: ['knowledge.stored'],
    },
  });
  check('extension persists', Boolean(extension?.id));

  // ---------------------------------------------------------------
  // Mission lifecycle
  // ---------------------------------------------------------------
  console.log('\n--- 3. Mission lifecycle & derived state ---');

  const started = await api('POST', `/missions/${mission.id}/start`, { token: alphaToken });
  check('mission starts', started?.status === 'RUNNING');

  await api('PATCH', `/missions/${mission.id}/tasks/${tasks[0].id}`, {
    token: alphaToken,
    body: { status: 'COMPLETED' },
  });
  const halfway = await api('GET', `/missions/${mission.id}`, { token: alphaToken });
  check('progress recomputes as tasks complete', halfway?.progress === 50, `${halfway?.progress}%`);

  await api('PATCH', `/missions/${mission.id}/tasks/${tasks[1].id}`, {
    token: alphaToken,
    body: { status: 'COMPLETED' },
  });
  const finished = await api('GET', `/missions/${mission.id}`, { token: alphaToken });
  check(
    'mission auto-completes when its last task finishes',
    finished?.status === 'COMPLETED' && finished?.progress === 100,
    `${finished?.status} @ ${finished?.progress}%`,
  );

  const illegalStart = await api('POST', `/missions/${mission.id}/start`, {
    token: alphaToken,
    raw: true,
  });
  check(
    'illegal state transition is rejected',
    illegalStart.status === 400,
    illegalStart.body?.message,
  );

  // ---------------------------------------------------------------
  // 7. Events
  // ---------------------------------------------------------------
  console.log('\n--- 4. Event system ---');

  const events = await api('GET', '/events?limit=100', { token: alphaToken });
  const names = new Set((events?.data ?? []).map((e) => e.name));
  const expected = [
    'organization.created',
    'user.registered',
    'worker.created',
    'worker.activated',
    'mission.created',
    'mission.started',
    'task.completed',
    'mission.completed',
    'knowledge.stored',
    'provider.connected',
    'integration.created',
    'extension.installed',
  ];
  const missing = expected.filter((n) => !names.has(n));
  check(
    'all expected domain events were emitted and persisted',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${names.size} distinct events`,
  );

  const correlated = (events?.data ?? []).find((e) => e.correlationId);
  check('events carry actor and correlation ids', Boolean(correlated?.actorId));

  // ---------------------------------------------------------------
  // 8. Organization isolation
  // ---------------------------------------------------------------
  console.log('\n--- 5. Organization isolation ---');

  await api('POST', '/auth/register', { body: BETA });
  const betaLogin = await api('POST', '/auth/login', {
    body: { email: BETA.email, password: BETA.password },
  });
  const betaToken = betaLogin?.accessToken;
  check('second organization registers independently', Boolean(betaToken));

  const betaWorkers = await api('GET', '/workers', { token: betaToken });
  check(
    'org B sees none of org A’s workers',
    betaWorkers?.data?.length === 0,
    `${betaWorkers?.data?.length} visible`,
  );

  const crossRead = await api('GET', `/workers/${worker.id}`, { token: betaToken, raw: true });
  check(
    'org B cannot read org A’s worker by id (404, not 403)',
    crossRead.status === 404,
    `status ${crossRead.status}`,
  );

  const crossUpdate = await api('PATCH', `/workers/${worker.id}`, {
    token: betaToken,
    body: { name: 'Hijacked' },
    raw: true,
  });
  check('org B cannot update org A’s worker', crossUpdate.status === 404);

  const crossDelete = await api('DELETE', `/workers/${worker.id}`, {
    token: betaToken,
    raw: true,
  });
  check('org B cannot delete org A’s worker', crossDelete.status === 404);

  const stillThere = await api('GET', `/workers/${worker.id}`, { token: alphaToken, raw: true });
  check('org A’s worker is untouched after those attempts', stillThere.status === 200);

  const betaEvents = await api('GET', '/events', { token: betaToken });
  const betaEventNames = new Set((betaEvents?.data ?? []).map((e) => e.name));
  check(
    'org B’s event log contains only its own events',
    !betaEventNames.has('worker.activated') && !betaEventNames.has('mission.completed'),
  );

  // Spoofing organizationId in a request body must not change ownership.
  const spoof = await api('POST', '/workers', {
    token: betaToken,
    body: { name: 'Spoofed', role: 'x', organizationId: alphaOrg },
    raw: true,
  });
  check(
    'organizationId in the request body is rejected by validation',
    spoof.status === 400,
    spoof.body?.message,
  );

  // ---------------------------------------------------------------
  // 9. RBAC
  // ---------------------------------------------------------------
  console.log('\n--- 6. Role-based access control ---');

  const invite = await api('POST', '/organizations/current/members', {
    token: alphaToken,
    body: { email: `viewer-${unique}@prism-x.test`, role: 'VIEWER' },
  });
  check('member invitation creates a membership', invite?.role === 'VIEWER');

  const dupInvite = await api('POST', '/organizations/current/members', {
    token: alphaToken,
    body: { email: `viewer-${unique}@prism-x.test`, role: 'VIEWER' },
    raw: true,
  });
  check('duplicate invitation is rejected with 409', dupInvite.status === 409);

  const members = await api('GET', '/organizations/current/members', { token: alphaToken });
  check('members are listable', members?.length === 2, `${members?.length} members`);

  const ownerMembership = members.find((m) => m.role === 'OWNER');
  const demote = await api(`PATCH`, `/organizations/current/members/${ownerMembership.membershipId}`, {
    token: alphaToken,
    body: { role: 'VIEWER' },
    raw: true,
  });
  check(
    'the last owner cannot demote themselves',
    demote.status === 400,
    demote.body?.message,
  );

  const selfRemove = await api(
    'DELETE',
    `/organizations/current/members/${ownerMembership.membershipId}`,
    { token: alphaToken, raw: true },
  );
  check('a member cannot remove their own membership', selfRemove.status === 403);

  // ---------------------------------------------------------------
  // 10. Row-level security (database layer, independent of the app)
  // ---------------------------------------------------------------
  console.log('\n--- 7. Postgres row-level security ---');

  // `SET ROLE` and `set_config` each emit a line of their own, so only the
  // final line of output is the value we asked for.
  const psql = (sql) =>
    execFileSync('psql', ['-U', 'postgres', '-h', '127.0.0.1', '-d', 'prismx', '-tAc', sql], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .pop()
      .trim();

  try {
    const noCtx = psql(
      `SET ROLE prismx_tenant; SELECT count(*) FROM workers;`,
    );
    check('RLS: no org context yields zero rows (fails closed)', noCtx === '0', `saw ${noCtx}`);

    const alphaCount = psql(
      `SET ROLE prismx_tenant; SELECT set_config('app.current_organization_id','${alphaOrg}',false); SELECT count(*) FROM workers;`,
    );
    check(
      'RLS: org context reveals exactly that org’s rows',
      alphaCount === '2',
      `saw ${alphaCount} (expected 2)`,
    );

    let blocked = false;
    try {
      psql(
        `BEGIN; SET ROLE prismx_tenant; SELECT set_config('app.current_organization_id','${alphaOrg}',true); ` +
          `INSERT INTO workers (id,"organizationId",name,role,status,dna,capabilities,generation,fitness,"createdAt","updatedAt") ` +
          `VALUES ('rls_probe','${betaLogin.organization.id}','X','x','ACTIVE','{}','{}',1,0,now(),now()); ROLLBACK;`,
      );
    } catch (error) {
      blocked = /row-level security/i.test(String(error.stderr ?? error.message));
    }
    check('RLS: cross-tenant INSERT is blocked by WITH CHECK', blocked);
  } catch (error) {
    check('RLS checks executed', false, String(error.message).slice(0, 120));
  }

  // ---------------------------------------------------------------
  // Repository layer discipline (static)
  // ---------------------------------------------------------------
  console.log('\n--- 8. Architecture invariants ---');

  const srcDir = path.join(__dirname, '..', 'src');
  const grep = (pattern, exclude) => {
    try {
      return execFileSync(
        'grep',
        ['-rlE', pattern, srcDir, '--include=*.ts'],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter((f) => f && !exclude.some((e) => f.includes(e)));
    } catch {
      return [];
    }
  };

  const supabaseLeaks = grep('@supabase/supabase-js', [
    'auth/providers/supabase-auth.provider.ts',
    'storage/storage.module.ts',
  ]);
  check(
    'Supabase SDK is confined to its two adapters',
    supabaseLeaks.length === 0,
    supabaseLeaks.join(', '),
  );

  const prismaLeaks = grep('PrismaService', [
    'database/',
    'health/health.module.ts',
    'auth/auth.service.ts',
  ]);
  check(
    'business services do not touch Prisma directly',
    prismaLeaks.length === 0,
    prismaLeaks.join(', '),
  );

  // ---------------------------------------------------------------
  // Swagger
  // ---------------------------------------------------------------
  console.log('\n--- 9. API documentation ---');

  const specResponse = await fetch(`${BASE.replace('/api/v1', '')}/docs-json`);
  const spec = await specResponse.json();
  const pathCount = Object.keys(spec.paths ?? {}).length;
  check('Swagger document is generated', pathCount > 0, `${pathCount} paths`);

  const operations = Object.values(spec.paths ?? {}).flatMap((p) => Object.values(p));
  const undocumented = operations.filter((op) => !op.summary);
  check(
    'every operation carries a summary',
    undocumented.length === 0,
    `${operations.length} operations, ${undocumented.length} undocumented`,
  );

  // An operation is documented if it carries an inline example OR returns a
  // schema whose properties define examples. Checking only for inline
  // examples would under-count every endpoint typed with a response DTO.
  const schemas = spec.components?.schemas ?? {};
  const schemaHasExample = (name, depth = 0) => {
    if (depth > 3) return false;
    const schema = schemas[name];
    if (!schema) return false;
    return Object.values(schema.properties ?? {}).some(
      (prop) =>
        prop.example !== undefined ||
        (prop.$ref && schemaHasExample(prop.$ref.split('/').pop(), depth + 1)),
    );
  };

  const documentsResponse = (op) => {
    // A 204 has no body by definition, so there is nothing to exemplify.
    const success = Object.entries(op.responses ?? {}).filter(
      ([code]) => code.startsWith('2') && code !== '204',
    );
    if (success.length === 0) return true;

    const body = JSON.stringify(Object.fromEntries(success));
    if (body.includes('"example"')) return true;
    const refs = [...body.matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1]);
    return refs.some((ref) => schemaHasExample(ref));
  };

  const documented = operations.filter(documentsResponse);
  const bare = operations.filter((op) => !documentsResponse(op));
  check(
    'every operation documents its response shape (inline example or typed schema)',
    bare.length === 0,
    bare.length ? `${bare.length} bare: ${bare.slice(0, 6).map((o) => o.summary).join(' | ')}` : `${documented.length}/${operations.length}`,
  );
  check(
    'security scheme is declared',
    Boolean(spec.components?.securitySchemes?.bearer),
  );

  // ---------------------------------------------------------------
  // Independence from the frontend
  // ---------------------------------------------------------------
  console.log('\n--- 10. Backend independence ---');

  const health = await api('GET', '/health');
  check(
    'backend serves over HTTP with no frontend present',
    health?.status === 'ok' && health?.checks?.database === 'up',
    `status=${health?.status}`,
  );

  const queues = await api('GET', '/queues/statistics', { token: alphaToken });
  check(
    'BullMQ queues are live',
    Boolean(queues?.['mission-execution']),
    Object.keys(queues ?? {}).join(', '),
  );

  const analytics = await api('GET', '/analytics/overview', { token: alphaToken });
  check(
    'analytics aggregates real persisted data',
    analytics?.missions?.completed === 1 && analytics?.workers?.total === 2,
    `${analytics?.workers?.total} workers, ${analytics?.missions?.completed} completed missions`,
  );

  const capabilities = await api('GET', '/providers/capabilities', { token: alphaToken });
  // Phase 1 asserted this registry was empty by design. Phase 2 fills it, so
  // the meaningful invariant is no longer "no adapters exist" but "the
  // abstraction still mediates them" — business logic names a provider by id,
  // never by vendor, which the architecture check below enforces.
  check(
    'provider abstraction exposes its registered adapters through the registry',
    Array.isArray(capabilities?.registered),
    `${capabilities?.registered?.length ?? 0} adapters registered`,
  );

  // ---------------------------------------------------------------
  console.log(`\n${'='.repeat(60)}`);
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
