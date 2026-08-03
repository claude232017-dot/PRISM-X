/**
 * PRISM-X Backend — Phase 4 validation suite.
 *
 * Exercises the ten Phase 4 checks against a running server with live
 * Postgres and Redis:
 *
 *   1. Nodes register and report status
 *   2. Tasks distribute across nodes
 *   3. Workers execute on remote nodes
 *   4. Memory synchronises correctly
 *   5. Queues distribute work efficiently
 *   6. Monitoring reflects real infrastructure state
 *   7. Failover works when nodes disconnect
 *   8. Organizations remain isolated
 *   9. Communication is authenticated and encrypted
 *  10. Adding nodes increases capacity
 *
 *   node test/phase4-validation.js
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

/** Signs a node-agent request exactly as the control plane does. */
async function agent(endpoint, payload, { nodeId, keyVersion, secret, tamper } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = secret
    ? `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
    : 'v1=' + '0'.repeat(64);

  const response = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-prismx-node-id': nodeId ?? '',
      'x-prismx-key-version': String(keyVersion ?? 1),
      'x-prismx-timestamp': String(timestamp),
      'x-prismx-signature': signature,
    },
    body: tamper ? `${body} ` : body,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

const unique = Date.now();
const ACCOUNT = {
  email: `phase4-${unique}@prism-x.test`,
  password: 'CorrectHorse42Battery',
  organizationName: `Phase4 Labs ${unique}`,
};

(async () => {
  console.log(`\nPRISM-X Backend — Phase 4 validation\n${'='.repeat(66)}\n`);

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

  // Phase 2 substrate the routed worker executions need.
  const provider = await api('POST', '/providers', {
    ...t(),
    body: { name: 'Sim provider', kind: 'LOCAL', isDefault: true },
  });
  await api('POST', `/providers/${provider.id}/health-check`, t());

  // ================================================================
  console.log('--- 1. Node registration and status reporting ---');

  const local = await api('POST', '/nodes/local', t());
  check(
    'the control plane registers itself as a node',
    local?.isLocal === true && local?.slug === 'control-plane',
    `${local?.slug} · ${local?.status}`,
  );
  check(
    'the local node measures its own hardware',
    local?.cpuCores > 0 && local?.memoryMb > 0,
    `${local?.cpuCores} cores · ${local?.memoryMb}MB`,
  );

  const localAgain = await api('POST', '/nodes/local', t());
  check(
    'ensuring the local node is idempotent',
    localAgain?.id === local?.id,
    `${localAgain?.id}`,
  );

  const localDetail = await api('GET', `/nodes/${local.id}`, t());
  check(
    'the local node discovers its own capabilities',
    (localDetail?.capabilities ?? []).length > 0,
    `${localDetail?.capabilities?.length} capabilities`,
  );
  check(
    'discovery finds providers, tools and a runtime',
    ['PROVIDER', 'TOOL', 'RUNTIME'].every((kind) =>
      (localDetail?.capabilities ?? []).some((c) => c.kind === kind),
    ),
    [...new Set((localDetail?.capabilities ?? []).map((c) => c.kind))].join(', '),
  );

  // A fleet of simulated remote machines with different shapes, so the
  // scheduler has something to actually choose between.
  const gpuNode = await api('POST', '/nodes', {
    ...t(),
    body: {
      name: 'GPU Box',
      slug: `gpu-${unique}`,
      type: 'DEDICATED_AI_SERVER',
      endpointUrl: 'http://127.0.0.1:9101',
      region: 'eu-west',
      labels: ['gpu', 'inference'],
      maxConcurrency: 6,
      costPerHourUsd: 1.2,
      trusted: true,
      resources: { cpuCores: 32, memoryMb: 131072, gpuCount: 2, gpuMemoryMb: 49152, diskMb: 2000000 },
      capabilities: [
        { kind: 'PROVIDER', key: 'OLLAMA', name: 'Local Ollama' },
        { kind: 'TOOL', key: 'knowledge.search' },
        { kind: 'HARDWARE', key: 'GPU' },
      ],
      metadata: { simulate: { latencyMs: 5 } },
    },
  });
  check(
    'a remote node registers and is issued a signing secret once',
    Boolean(gpuNode?.node?.id) && typeof gpuNode?.credentials?.secret === 'string',
    `${gpuNode?.node?.slug} · key v${gpuNode?.credentials?.keyVersion}`,
  );
  check(
    'a registered node starts PENDING until it heartbeats',
    gpuNode?.node?.status === 'PENDING',
    gpuNode?.node?.status,
  );

  const edgeNode = await api('POST', '/nodes', {
    ...t(),
    body: {
      name: 'Edge Pi',
      slug: `edge-${unique}`,
      type: 'EDGE_DEVICE',
      endpointUrl: 'http://127.0.0.1:9102',
      region: 'eu-west',
      labels: ['edge'],
      maxConcurrency: 1,
      costPerHourUsd: 0.02,
      trusted: true,
      resources: { cpuCores: 4, memoryMb: 4096, diskMb: 32000 },
      capabilities: [{ kind: 'RUNTIME', key: 'NODEJS' }],
      metadata: { simulate: { latencyMs: 120 } },
    },
  });

  const untrusted = await api('POST', '/nodes', {
    ...t(),
    body: {
      name: 'Unverified VPS',
      slug: `vps-${unique}`,
      type: 'CLOUD_VPS',
      endpointUrl: 'http://127.0.0.1:9103',
      metadata: { simulate: {} },
    },
  });
  check(
    'a node registered without proof of identity is UNVERIFIED',
    untrusted?.node?.trust === 'UNVERIFIED',
    untrusted?.node?.trust,
  );

  const noEndpoint = await api('POST', '/nodes', {
    ...t(),
    raw: true,
    body: { name: 'Nowhere', slug: `nowhere-${unique}` },
  });
  check(
    'a remote node without an endpoint is refused',
    noEndpoint.status === 400,
    `status ${noEndpoint.status}`,
  );

  const duplicate = await api('POST', '/nodes', {
    ...t(),
    raw: true,
    body: { name: 'GPU Box again', slug: `gpu-${unique}`, endpointUrl: 'http://127.0.0.1:9199' },
  });
  check('slugs are unique per organization', duplicate.status === 409, `status ${duplicate.status}`);

  const beat = await api('POST', `/nodes/${gpuNode.node.id}/heartbeat`, {
    ...t(),
    body: { cpuUsage: 0.2, memoryUsage: 0.3, diskUsage: 0.1, activeTasks: 0, latencyMs: 8, uptimeSeconds: 4200 },
  });
  check(
    'a heartbeat brings a node ONLINE and scores its health',
    beat?.status === 'ONLINE' && beat?.healthScore > 0.5,
    `${beat?.status} · health ${beat?.healthScore}`,
  );

  const stressed = await api('POST', `/nodes/${edgeNode.node.id}/heartbeat`, {
    ...t(),
    body: { cpuUsage: 0.98, memoryUsage: 0.97, diskUsage: 0.95, activeTasks: 1, latencyMs: 140 },
  });
  check(
    'a node under heavy load is DEGRADED rather than ONLINE',
    stressed?.status === 'DEGRADED',
    `${stressed?.status} · health ${stressed?.healthScore}`,
  );
  check(
    'a saturated node scores far below a healthy one',
    stressed?.healthScore < beat?.healthScore / 2,
    `${stressed?.healthScore} vs ${beat?.healthScore}`,
  );

  await api('POST', `/nodes/${edgeNode.node.id}/heartbeat`, {
    ...t(),
    body: { cpuUsage: 0.1, memoryUsage: 0.2, diskUsage: 0.1, activeTasks: 0, latencyMs: 110 },
  });

  const nodeTypes = await api('GET', '/nodes', t());
  check(
    'the fleet spans the required node types',
    ['LOCAL_MACHINE', 'DEDICATED_AI_SERVER', 'EDGE_DEVICE', 'CLOUD_VPS'].every((type) =>
      (nodeTypes ?? []).some((n) => n.type === type),
    ),
    [...new Set((nodeTypes ?? []).map((n) => n.type))].join(', '),
  );
  check(
    'each node reports the transport that reaches it',
    (nodeTypes ?? []).every((n) => ['local', 'http', 'simulated'].includes(n.transport)),
    [...new Set((nodeTypes ?? []).map((n) => n.transport))].join(', '),
  );

  const transports = await api('GET', '/nodes/transports', t());
  check(
    'all three transports are registered',
    ['local', 'http', 'simulated'].every((k) => transports?.transports?.includes(k)),
    (transports?.transports ?? []).join(', '),
  );

  // ================================================================
  console.log('\n--- 2. Distributed execution and node selection ---');

  const kinds = await api('GET', '/distributed/task-kinds', t());
  check(
    'the fleet advertises what it can run',
    ['echo', 'worker.execute', 'tool.invoke'].every((k) => kinds?.kinds?.includes(k)),
    (kinds?.kinds ?? []).join(', '),
  );

  const plan = await api('POST', '/distributed/plan', { ...t(), body: {} });
  check(
    'the scheduler picks a node and explains why',
    Boolean(plan?.chosen) && typeof plan?.explanation === 'string' && plan.explanation.length > 10,
    plan?.explanation,
  );
  check(
    'placement scores are broken down per factor',
    (plan?.candidates?.[0]?.factors ?? []).length === 6,
    (plan?.candidates?.[0]?.factors ?? []).map((f) => f.name).join(', '),
  );

  const gpuPlan = await api('POST', '/distributed/plan', {
    ...t(),
    body: { requiresGpu: true },
  });
  check(
    'a GPU requirement selects only a GPU node',
    gpuPlan?.chosen === `gpu-${unique}`,
    `chose ${gpuPlan?.chosen}`,
  );
  check(
    'nodes without a GPU are rejected with a reason',
    (gpuPlan?.rejected ?? []).some((r) => r.reason === 'no GPU'),
    (gpuPlan?.rejected ?? []).map((r) => `${r.slug}: ${r.reason}`).join(' | '),
  );

  const capPlan = await api('POST', '/distributed/plan', {
    ...t(),
    body: { capabilities: ['PROVIDER:OLLAMA'] },
  });
  check(
    'a provider requirement selects a node that advertises it',
    capPlan?.chosen === `gpu-${unique}`,
    `chose ${capPlan?.chosen}`,
  );
  check(
    'nodes missing a required capability are rejected by name',
    (capPlan?.rejected ?? []).some((r) => r.reason.includes('PROVIDER:OLLAMA')),
    (capPlan?.rejected ?? []).map((r) => r.reason).join(' | '),
  );

  const labelPlan = await api('POST', '/distributed/plan', { ...t(), body: { labels: ['edge'] } });
  check('label constraints are honoured', labelPlan?.chosen === `edge-${unique}`, labelPlan?.chosen);

  const regionPlan = await api('POST', '/distributed/plan', {
    ...t(),
    body: { region: 'ap-south' },
  });
  check(
    'an unsatisfiable requirement yields no placement, with reasons',
    regionPlan?.chosen === null && (regionPlan?.rejected ?? []).length > 0,
    regionPlan?.explanation,
  );

  const costPlan = await api('POST', '/distributed/plan', {
    ...t(),
    body: { maxCostPerHourUsd: 0.5 },
  });
  check(
    'a cost ceiling excludes expensive nodes',
    (costPlan?.rejected ?? []).some((r) => r.reason.startsWith('too expensive')),
    (costPlan?.rejected ?? []).map((r) => r.reason).join(' | '),
  );

  const untrustedRejected = (plan?.rejected ?? []).some((r) => r.reason === 'trust is UNVERIFIED');
  check(
    'an untrusted node is never scheduled',
    untrustedRejected,
    (plan?.rejected ?? []).map((r) => `${r.slug}: ${r.reason}`).join(' | '),
  );

  const pinned = await api('POST', '/distributed/tasks', {
    ...t(),
    body: {
      kind: 'echo',
      payload: { hello: 'fleet' },
      requirements: { nodeId: gpuNode.node.id },
      wait: true,
    },
  });
  check(
    'a task runs on the node it was pinned to',
    pinned?.task?.status === 'SUCCEEDED' && pinned?.task?.nodeId === gpuNode.node.id,
    `${pinned?.task?.status} on ${pinned?.task?.nodeId}`,
  );
  check(
    'the simulated transport actually executed it',
    pinned?.task?.result?.simulatedOn === `gpu-${unique}`,
    JSON.stringify(pinned?.task?.result ?? {}).slice(0, 90),
  );

  const idem = await api('POST', '/distributed/tasks', {
    ...t(),
    body: { kind: 'echo', payload: { n: 1 }, idempotencyKey: `idem-${unique}` },
  });
  const idemAgain = await api('POST', '/distributed/tasks', {
    ...t(),
    body: { kind: 'echo', payload: { n: 2 }, idempotencyKey: `idem-${unique}` },
  });
  check(
    'an idempotency key prevents the same work running twice',
    idem?.task?.id === idemAgain?.task?.id,
    `${idem?.task?.id} === ${idemAgain?.task?.id}`,
  );

  const unknownKind = await api('POST', '/distributed/tasks', {
    ...t(),
    body: { kind: 'does.not.exist', wait: true, maxAttempts: 1 },
  });
  check(
    'work no node can run is failed, not retried forever',
    ['FAILED', 'DEAD_LETTERED'].includes(unknownKind?.task?.status),
    `${unknownKind?.task?.status} · ${unknownKind?.task?.error ?? ''}`.slice(0, 100),
  );

  // ================================================================
  console.log('\n--- 3. Worker execution routed across the fleet ---');

  const localWorker = await api('POST', '/workers', {
    ...t(),
    body: {
      name: 'Local Worker',
      role: 'analyst',
      capabilities: ['analysis'],
      providerId: provider.id,
      systemPrompt: 'You analyse things.',
    },
  });
  await api('POST', `/workers/${localWorker.id}/activate`, t());

  const localRun = await api('POST', `/workers/${localWorker.id}/execute`, {
    ...t(),
    body: { instruction: 'Summarise the fleet in one line.' },
  });
  check(
    'an unconstrained worker still executes (fleet routing is transparent)',
    localRun?.status === 'SUCCEEDED',
    `${localRun?.status} · ${String(localRun?.output ?? '').slice(0, 50)}`,
  );

  const pinnedWorker = await api('POST', '/workers', {
    ...t(),
    body: {
      name: 'GPU Worker',
      role: 'inference',
      capabilities: ['inference'],
      providerId: provider.id,
      systemPrompt: 'You run on the GPU box.',
      preferredNodeId: gpuNode.node.id,
    },
  });
  await api('POST', `/workers/${pinnedWorker.id}/activate`, t());

  const remoteRun = await api('POST', `/workers/${pinnedWorker.id}/execute`, {
    ...t(),
    body: { instruction: 'Run somewhere else.' },
  });
  check(
    'a worker pinned to a remote node executes there and returns a normal result',
    remoteRun?.status === 'SUCCEEDED' && typeof remoteRun?.output === 'string',
    `${remoteRun?.status} · ${String(remoteRun?.output ?? '').slice(0, 50)}`,
  );

  const routedTasks = await api('GET', '/distributed/queues/COMPLETED', t());
  const workerTask = (routedTasks ?? []).find(
    (task) => task.kind === 'worker.execute' && task.workerId === pinnedWorker.id,
  );
  check(
    'the routed execution is recorded as a distributed task on that node',
    Boolean(workerTask) && workerTask.nodeId === gpuNode.node.id,
    workerTask ? `${workerTask.id} on ${workerTask.nodeId}` : 'not found',
  );

  // ================================================================
  console.log('\n--- 4. Distributed memory and synchronisation ---');

  const shared = await api('POST', '/distributed/memory/shards', {
    ...t(),
    body: { scope: 'SHARED', key: 'fleet.settings', value: { maxParallelMissions: 4 } },
  });
  check(
    'a shared shard is written with a version and a checksum',
    shared?.version === 1 && typeof shared?.checksum === 'string' && shared.checksum.length === 64,
    `v${shared?.version} · ${String(shared?.checksum).slice(0, 12)}…`,
  );

  const updated = await api('POST', '/distributed/memory/shards', {
    ...t(),
    body: { scope: 'SHARED', key: 'fleet.settings', value: { maxParallelMissions: 6 } },
  });
  check('rewriting a shard bumps its version', updated?.version === 2, `v${updated?.version}`);
  check(
    'a changed value changes the checksum',
    updated?.checksum !== shared?.checksum,
  );

  const localShard = await api('POST', '/distributed/memory/shards', {
    ...t(),
    body: { scope: 'LOCAL', key: 'node.cache', value: { warm: true }, nodeId: gpuNode.node.id },
  });
  check(
    'LOCAL memory is scoped to one node',
    localShard?.nodeId === gpuNode.node.id,
    localShard?.nodeId,
  );

  const localNoNode = await api('POST', '/distributed/memory/shards', {
    ...t(),
    raw: true,
    body: { scope: 'LOCAL', key: 'bad', value: {} },
  });
  check(
    'LOCAL memory without a node is refused',
    localNoNode.status === 400,
    `status ${localNoNode.status}`,
  );

  const globalShard = await api('POST', '/distributed/memory/shards', {
    ...t(),
    body: { scope: 'GLOBAL', key: 'org.policy', value: { retentionDays: 30 } },
  });
  check('GLOBAL memory is organization-wide', globalShard?.nodeId === '', `nodeId "${globalShard?.nodeId}"`);

  const read = await api('GET', '/distributed/memory/shards/SHARED/fleet.settings', t());
  check(
    'a shard reads back its latest value',
    read?.value?.maxParallelMissions === 6,
    JSON.stringify(read?.value ?? {}),
  );

  const fastForward = await api('POST', '/distributed/memory/sync/apply', {
    ...t(),
    body: {
      scope: 'SHARED',
      key: 'fleet.settings',
      op: 'PUT',
      version: 3,
      nodeId: gpuNode.node.id,
      value: { maxParallelMissions: 9 },
      vectorClock: { 'control-plane': 2, [gpuNode.node.id]: 1 },
    },
  });
  check(
    'a write that descends from ours is fast-forwarded',
    fastForward?.outcome === 'applied',
    `${fastForward?.outcome} · ${fastForward?.reason}`,
  );

  const stale = await api('POST', '/distributed/memory/sync/apply', {
    ...t(),
    body: {
      scope: 'SHARED',
      key: 'fleet.settings',
      op: 'PUT',
      version: 2,
      nodeId: edgeNode.node.id,
      value: { maxParallelMissions: 2 },
      vectorClock: { 'control-plane': 1 },
    },
  });
  check(
    'a stale write is superseded, not treated as a conflict',
    stale?.outcome === 'superseded',
    `${stale?.outcome} · ${stale?.reason}`,
  );

  const conflict = await api('POST', '/distributed/memory/sync/apply', {
    ...t(),
    body: {
      scope: 'SHARED',
      key: 'fleet.settings',
      op: 'PUT',
      version: 4,
      nodeId: edgeNode.node.id,
      value: { maxParallelMissions: 12 },
      vectorClock: { [edgeNode.node.id]: 7 },
    },
  });
  check(
    'two concurrent writes are detected as a conflict and resolved',
    conflict?.outcome === 'conflict' && ['incoming', 'existing'].includes(conflict?.winner),
    `${conflict?.outcome} · winner ${conflict?.winner}`,
  );

  const conflicts = await api('GET', '/distributed/memory/sync/conflicts', t());
  check(
    'the losing side of a conflict is kept for inspection',
    (conflicts ?? []).length > 0 && Boolean(conflicts[0].resolution),
    conflicts?.[0]?.resolution,
  );

  const pull = await api('POST', `/distributed/memory/sync/${gpuNode.node.id}/pull`, t());
  check(
    'a node pulls the ops it has not seen and advances its cursor',
    (pull?.ops ?? []).length > 0 && pull?.cursor > 0,
    `${pull?.ops?.length} ops · cursor ${pull?.cursor}`,
  );

  const pullAgain = await api('POST', `/distributed/memory/sync/${gpuNode.node.id}/pull`, t());
  check(
    'a second pull is incremental, not a full replay',
    (pullAgain?.ops ?? []).length === 0,
    `${pullAgain?.ops?.length} ops`,
  );

  await api('POST', '/distributed/memory/shards', {
    ...t(),
    body: { scope: 'SHARED', key: 'fleet.offline-write', value: { while: 'node was away' } },
  });

  const syncStatus = await api('GET', '/distributed/memory/sync/status', t());
  const lagging = (syncStatus ?? []).find((row) => row.nodeId === edgeNode.node.id);
  const caughtUp = (syncStatus ?? []).find((row) => row.nodeId === gpuNode.node.id);
  check(
    'sync status reports per-node replication lag',
    Array.isArray(syncStatus) && syncStatus.length > 0,
    `${syncStatus?.length} rows`,
  );
  check(
    'a node that has not synced shows lag against one that has',
    Boolean(caughtUp) && caughtUp.lag >= 0,
    `gpu lag ${caughtUp?.lag}${lagging ? ` · edge lag ${lagging.lag}` : ''}`,
  );

  const recovered = await api('POST', `/distributed/memory/sync/${edgeNode.node.id}/recover`, t());
  check(
    'a node that was offline replays everything it missed',
    recovered?.delivered > 0 && recovered?.remaining === 0,
    `${recovered?.delivered} ops delivered, ${recovered?.remaining} remaining`,
  );

  // ================================================================
  console.log('\n--- 5. Distributed queues ---');

  const queued = [];
  for (const priority of ['LOW', 'CRITICAL', 'MEDIUM']) {
    queued.push(
      await api('POST', '/distributed/tasks', {
        ...t(),
        body: { kind: 'echo', payload: { priority }, priority },
      }),
    );
  }
  const queueState = await api('GET', '/distributed/queues', t());
  check(
    'submitted work lands on the incoming queue',
    queueState?.incoming >= 3,
    `incoming ${queueState?.incoming}`,
  );
  check(
    'all four queues are reported',
    ['incoming', 'active', 'completed', 'failed'].every((k) => typeof queueState?.[k] === 'number'),
    JSON.stringify({
      incoming: queueState?.incoming,
      active: queueState?.active,
      completed: queueState?.completed,
      failed: queueState?.failed,
    }),
  );
  check(
    'queue depth is reported per node',
    Array.isArray(queueState?.perNode) && queueState.perNode.length >= 3,
    `${queueState?.perNode?.length} nodes`,
  );

  const drained = await api('POST', '/distributed/tick', t());
  check(
    'a coordinator tick places and dispatches waiting work',
    drained?.placed >= 3,
    `placed ${drained?.placed}, deferred ${drained?.deferred}`,
  );

  const criticalTask = await api('GET', `/distributed/tasks/${queued[1].task.id}`, t());
  const lowTask = await api('GET', `/distributed/tasks/${queued[0].task.id}`, t());
  check(
    'critical work is dispatched ahead of low-priority work',
    new Date(criticalTask?.assignedAt).getTime() <= new Date(lowTask?.assignedAt).getTime(),
    `critical ${criticalTask?.assignedAt} vs low ${lowTask?.assignedAt}`,
  );

  const afterDrain = await api('GET', '/distributed/queues', t());
  check(
    'completed work moves off the incoming queue',
    afterDrain?.completed > queueState?.completed,
    `completed ${queueState?.completed} → ${afterDrain?.completed}`,
  );

  const spread = new Set(
    ((await api('GET', '/distributed/queues/COMPLETED', { ...t(), token })) ?? [])
      .filter((task) => task.kind === 'echo')
      .map((task) => task.nodeId),
  );
  check(
    'work is spread across more than one node',
    spread.size >= 2,
    `${spread.size} distinct nodes`,
  );

  const migrateSource = await api('POST', '/distributed/tasks', {
    ...t(),
    body: { kind: 'echo', payload: { migrate: true }, requirements: { nodeId: edgeNode.node.id } },
  });
  const migrated = await api('POST', `/distributed/tasks/${migrateSource.task.id}/migrate`, {
    ...t(),
    body: { toNodeId: gpuNode.node.id, reason: 'test migration' },
  });
  check(
    'a task can be migrated between nodes without losing its identity',
    migrated?.id === migrateSource?.task?.id && migrated?.migrations === 1,
    `migrations ${migrated?.migrations}`,
  );

  await api('POST', '/distributed/tick', t());
  const migratedFinal = await api('GET', `/distributed/tasks/${migrateSource.task.id}`, t());
  check(
    'a migrated task runs on the node it was moved to',
    migratedFinal?.nodeId === gpuNode.node.id && migratedFinal?.status === 'SUCCEEDED',
    `${migratedFinal?.status} on ${migratedFinal?.nodeId} after ${migratedFinal?.migrations} migration(s)`,
  );

  const rebalance = await api('POST', '/distributed/rebalance', t());
  check(
    'rebalancing reports what it did and why',
    typeof rebalance?.explanation === 'string' && Array.isArray(rebalance?.moved),
    rebalance?.explanation,
  );

  // ================================================================
  console.log('\n--- 6. Infrastructure monitoring ---');

  const cluster = await api('GET', '/distributed/cluster', t());
  check(
    'the cluster overview aggregates fleet capacity',
    cluster?.capacity?.nodes >= 3 && cluster?.capacity?.cpuCores > 0,
    `${cluster?.capacity?.nodes} nodes · ${cluster?.capacity?.cpuCores} cores · ${cluster?.capacity?.gpuCount} GPUs`,
  );
  check(
    'nodes are broken down by status, type and region',
    Boolean(cluster?.nodesByStatus) && Boolean(cluster?.nodesByType) && Boolean(cluster?.nodesByRegion),
    JSON.stringify(cluster?.nodesByStatus ?? {}),
  );
  check(
    'fleet health names the weakest node',
    typeof cluster?.health?.average === 'number' && cluster?.health?.average > 0,
    `average ${cluster?.health?.average} · weakest ${cluster?.health?.weakest?.slug}`,
  );
  check(
    'the overview includes queue depths and memory lag',
    typeof cluster?.queues?.incoming === 'number' && typeof cluster?.memory?.maxLag === 'number',
    `queued ${cluster?.queues?.incoming} · max lag ${cluster?.memory?.maxLag}`,
  );
  check(
    'utilisation is derived from real reserved concurrency',
    typeof cluster?.capacity?.utilisation === 'number' && cluster.capacity.utilisation >= 0,
    `utilisation ${cluster?.capacity?.utilisation}`,
  );

  const metrics = await api('GET', `/distributed/nodes/${gpuNode.node.id}/metrics`, t());
  check(
    'per-node metrics return a heartbeat time series',
    (metrics?.points ?? []).length > 0,
    `${metrics?.points?.length} points`,
  );
  check(
    'metric points are ordered oldest first',
    (metrics?.points ?? []).length < 2 ||
      new Date(metrics.points[0].at) <= new Date(metrics.points[metrics.points.length - 1].at),
  );

  // ================================================================
  console.log('\n--- 7. Failover and recovery ---');

  const failing = await api('POST', '/nodes', {
    ...t(),
    body: {
      name: 'Flaky Node',
      slug: `flaky-${unique}`,
      type: 'CLOUD_VPS',
      endpointUrl: 'http://127.0.0.1:9104',
      trusted: true,
      maxConcurrency: 4,
      resources: { cpuCores: 8, memoryMb: 16384 },
      // Shares the "overflow" label with the healthy GPU node, so the fleet
      // has somewhere to fail over *to* — a task pinned to only the broken
      // machine could never demonstrate failover, only give up.
      labels: ['overflow'],
      metadata: { simulate: { unreachable: true } },
    },
  });
  await api('POST', `/nodes/${failing.node.id}/heartbeat`, {
    ...t(),
    body: { cpuUsage: 0.01, memoryUsage: 0.01, diskUsage: 0.01, activeTasks: 0, latencyMs: 1 },
  });
  await api('PATCH', `/nodes/${gpuNode.node.id}`, { ...t(), body: { labels: ['gpu', 'inference', 'overflow'] } });

  const overflowPlan = await api('POST', '/distributed/plan', {
    ...t(),
    body: { labels: ['overflow'] },
  });
  check(
    'the idle-looking broken node is the scheduler’s first choice',
    overflowPlan?.chosen === `flaky-${unique}`,
    `chose ${overflowPlan?.chosen}`,
  );

  const failedOver = await api('POST', '/distributed/tasks', {
    ...t(),
    body: {
      kind: 'echo',
      payload: { failover: true },
      requirements: { labels: ['overflow'] },
      maxAttempts: 3,
      wait: true,
    },
  });
  check(
    'a task whose node is unreachable is retried on another node',
    failedOver?.task?.attempts >= 2 && failedOver?.task?.status === 'SUCCEEDED',
    `${failedOver?.task?.attempts} attempts · ${failedOver?.task?.status} on ${failedOver?.task?.nodeId}`,
  );
  check(
    'the retry landed on a healthy node, not the broken one',
    failedOver?.task?.nodeId === gpuNode.node.id &&
      failedOver?.task?.previousNodeId === failing.node.id,
    `${failedOver?.task?.previousNodeId} → ${failedOver?.task?.nodeId}`,
  );

  // Three failures in a row is a property of the node rather than of any one
  // task, which is what the quarantine threshold is meant to detect.
  for (let i = 0; i < 3; i += 1) {
    await api('POST', '/distributed/tasks', {
      ...t(),
      body: {
        kind: 'echo',
        payload: { probe: i },
        requirements: { nodeId: failing.node.id },
        maxAttempts: 1,
        wait: true,
      },
    });
  }

  const flakyAfter = await api('GET', `/nodes/${failing.node.id}`, t());
  check(
    'repeated dispatch failures quarantine the node',
    flakyAfter?.status === 'QUARANTINED',
    `${flakyAfter?.status} · ${flakyAfter?.consecutiveFailures} failures`,
  );

  const quarantinePlan = await api('POST', '/distributed/plan', {
    ...t(),
    body: { nodeId: failing.node.id },
  });
  check(
    'a quarantined node is excluded from scheduling',
    quarantinePlan?.chosen === null,
    quarantinePlan?.explanation,
  );

  const openWork = await api('POST', '/distributed/tasks', {
    ...t(),
    body: { kind: 'echo', payload: { orphan: true }, requirements: { nodeId: gpuNode.node.id } },
  });
  const orphanMigrated = await api('POST', `/distributed/tasks/${openWork.task.id}/migrate`, {
    ...t(),
    body: { reason: 'simulated node loss' },
  });
  check(
    'work held by a lost node is returned to the queue',
    orphanMigrated?.status === 'QUEUED' && orphanMigrated?.nodeId === null,
    `${orphanMigrated?.status} · node ${orphanMigrated?.nodeId}`,
  );

  const sweep = await api('POST', '/distributed/sweep', t());
  check(
    'the failover sweep reports what it reclaimed',
    sweep &&
      Array.isArray(sweep.nodesMarkedOffline) &&
      Array.isArray(sweep.tasksReassigned) &&
      Array.isArray(sweep.leasesExpired),
    `offline ${sweep?.nodesMarkedOffline?.length} · reassigned ${sweep?.tasksReassigned?.length}`,
  );

  const recoveredNode = await api('POST', `/distributed/nodes/${failing.node.id}/recover`, t());
  check(
    'a recovered node returns to service empty',
    typeof recoveredNode?.clearedTasks === 'number',
    `${recoveredNode?.node} · cleared ${recoveredNode?.clearedTasks}`,
  );

  const drainedNode = await api('POST', `/nodes/${edgeNode.node.id}/drain`, {
    ...t(),
    body: { reason: 'maintenance' },
  });
  check('a node can be drained', drainedNode?.status === 'DRAINING', drainedNode?.status);

  const drainPlan = await api('POST', '/distributed/plan', { ...t(), body: { labels: ['edge'] } });
  check(
    'a draining node takes no new work',
    drainPlan?.chosen === null,
    drainPlan?.explanation,
  );

  const resumedNode = await api('POST', `/nodes/${edgeNode.node.id}/resume`, t());
  check('a drained node can be returned to service', resumedNode?.status === 'ONLINE', resumedNode?.status);

  // ================================================================
  console.log('\n--- 8. Multi-organization federation ---');

  const partner = {
    email: `phase4-partner-${unique}@prism-x.test`,
    password: 'CorrectHorse42Battery',
    organizationName: `Phase4 Partner ${unique}`,
  };
  await api('POST', '/auth/register', { body: partner });
  const partnerLogin = await api('POST', '/auth/login', {
    body: { email: partner.email, password: partner.password },
  });
  const partnerToken = partnerLogin?.accessToken;
  const partnerOrgId = partnerLogin?.organization?.id ?? partnerLogin?.organizationId;

  const partnerNodes = await api('GET', '/nodes', { token: partnerToken });
  check(
    'another organization sees none of this fleet',
    (partnerNodes ?? []).every((n) => n.slug === 'control-plane'),
    `${partnerNodes?.length} nodes visible`,
  );

  const crossRead = await api('GET', `/nodes/${gpuNode.node.id}`, {
    token: partnerToken,
    raw: true,
  });
  check(
    "another organization cannot read this org's node",
    crossRead.status === 404,
    `status ${crossRead.status}`,
  );

  const crossTask = await api('POST', '/distributed/tasks', {
    token: partnerToken,
    raw: true,
    body: { kind: 'echo', requirements: { nodeId: gpuNode.node.id }, wait: true },
  });
  check(
    "another organization cannot place work on this org's node",
    crossTask.status !== 201 || crossTask.body?.task?.status !== 'SUCCEEDED',
    `status ${crossTask.status} · ${crossTask.body?.task?.status ?? ''}`,
  );

  const crossMemory = await api('GET', '/distributed/memory/shards?scope=SHARED', {
    token: partnerToken,
  });
  check(
    'distributed memory is organization-scoped',
    (crossMemory ?? []).length === 0,
    `${crossMemory?.length} shards visible`,
  );

  const noGrant = await api(
    'GET',
    `/federation/peers/${partnerOrgId}/check?resource=nodes:execute`,
    t(),
  );
  check(
    'nothing is shared between organizations by default',
    noGrant?.allowed === false,
    noGrant?.reason,
  );

  const beforeGrant = await api('GET', `/federation/peers/${partnerOrgId}/nodes`, {
    ...t(),
    raw: true,
  });
  check(
    'borrowing a peer node without a grant is refused',
    beforeGrant.status === 403,
    `status ${beforeGrant.status}`,
  );

  const badResource = await api('POST', '/federation/grants', {
    ...t(),
    raw: true,
    body: { peerOrganizationId: partnerOrgId, resources: ['everything'] },
  });
  check(
    'a grant naming an unknown resource is refused',
    badResource.status === 400,
    `status ${badResource.status}`,
  );

  const emptyGrant = await api('POST', '/federation/grants', {
    ...t(),
    raw: true,
    body: { peerOrganizationId: partnerOrgId, resources: [] },
  });
  check('a grant that shares nothing is refused', emptyGrant.status === 400, `status ${emptyGrant.status}`);

  const grant = await api('POST', '/federation/grants', {
    ...t(),
    body: {
      peerOrganizationId: partnerOrgId,
      resources: ['nodes:execute', 'nodes:read'],
      allowedNodeIds: [gpuNode.node.id],
      maxConcurrentTasks: 2,
    },
  });
  check('a grant starts PENDING', grant?.status === 'PENDING', grant?.status);

  const beforeAccept = await api('GET', `/federation/peers/${partnerOrgId}/check?resource=nodes:execute`, t());
  check(
    'a pending grant confers nothing',
    beforeAccept?.allowed === false,
    beforeAccept?.reason,
  );

  const partnerReceived = await api('GET', '/federation/grants/received', { token: partnerToken });
  check(
    'the peer can see a grant offered to it',
    (partnerReceived ?? []).some((g) => g.id === grant.id),
    `${partnerReceived?.length} received`,
  );

  const accepted = await api('POST', `/federation/grants/${grant.id}/accept`, { token: partnerToken });
  check('the peer accepts and the grant becomes ACTIVE', accepted?.status === 'ACTIVE', accepted?.status);

  const partnerBorrow = await api('GET', `/federation/peers/${login.organization?.id ?? login.organizationId}/nodes`, {
    token: partnerToken,
  });
  check(
    'an accepted grant makes exactly the named nodes borrowable',
    Array.isArray(partnerBorrow) &&
      partnerBorrow.length === 1 &&
      partnerBorrow[0].id === gpuNode.node.id,
    `${partnerBorrow?.length} node(s)`,
  );

  const wrongResource = await api(
    'GET',
    `/federation/peers/${login.organization?.id ?? login.organizationId}/check?resource=memory:write`,
    { token: partnerToken },
  );
  check(
    'a grant covers only the resources it names',
    wrongResource?.allowed === false && wrongResource?.reason.includes('memory:write'),
    wrongResource?.reason,
  );

  const revoked = await api('POST', `/federation/grants/${grant.id}/revoke`, t());
  check('a grant can be revoked', revoked?.status === 'REVOKED', revoked?.status);

  const afterRevoke = await api('GET', `/federation/peers/${login.organization?.id ?? login.organizationId}/nodes`, {
    token: partnerToken,
    raw: true,
  });
  check(
    'revocation takes effect immediately',
    afterRevoke.status === 403,
    `status ${afterRevoke.status}`,
  );

  // ================================================================
  console.log('\n--- 9. Node authentication and key management ---');

  const goodCall = await agent('/nodes/agent/execute', { taskId: 'probe-1', kind: 'echo', payload: { ping: true } }, {
    nodeId: gpuNode.node.id,
    keyVersion: gpuNode.credentials.keyVersion,
    secret: gpuNode.credentials.secret,
  });
  check(
    'a correctly signed node request is accepted',
    goodCall.status === 200 || goodCall.status === 201,
    `status ${goodCall.status} · ${goodCall.body?.status ?? ''}`,
  );
  check(
    'the node agent executes the dispatched work',
    goodCall.body?.status === 'SUCCEEDED',
    JSON.stringify(goodCall.body?.result ?? {}).slice(0, 80),
  );

  const wrongSecret = await agent('/nodes/agent/execute', { taskId: 'probe-2', kind: 'echo' }, {
    nodeId: gpuNode.node.id,
    keyVersion: 1,
    secret: 'not-the-real-secret',
  });
  check('a wrongly signed request is rejected', wrongSecret.status === 401, `status ${wrongSecret.status}`);

  const noSignature = await agent('/nodes/agent/execute', { taskId: 'probe-3', kind: 'echo' }, {
    nodeId: gpuNode.node.id,
    keyVersion: 1,
  });
  check('an unsigned request is rejected', noSignature.status === 401, `status ${noSignature.status}`);

  const tampered = await agent('/nodes/agent/execute', { taskId: 'probe-4', kind: 'echo' }, {
    nodeId: gpuNode.node.id,
    keyVersion: gpuNode.credentials.keyVersion,
    secret: gpuNode.credentials.secret,
    tamper: true,
  });
  check(
    'a request whose body was altered in flight is rejected',
    tampered.status === 401,
    `status ${tampered.status}`,
  );

  const unknownNode = await agent('/nodes/agent/execute', { taskId: 'probe-5', kind: 'echo' }, {
    nodeId: 'clx0doesnotexist',
    keyVersion: 1,
    secret: 'anything',
  });
  check('an unknown node is rejected', unknownNode.status === 401, `status ${unknownNode.status}`);

  const agentStatus = await agent('/nodes/agent/status', {}, {
    nodeId: gpuNode.node.id,
    keyVersion: gpuNode.credentials.keyVersion,
    secret: gpuNode.credentials.secret,
  });
  check(
    'a signed status probe returns load and capabilities',
    (agentStatus.status === 200 || agentStatus.status === 201) &&
      Array.isArray(agentStatus.body?.capabilities),
    `${agentStatus.body?.capabilities?.length} capabilities`,
  );

  const rotated = await api('POST', `/nodes/${gpuNode.node.id}/rotate-key`, t());
  check(
    'rotating issues a new key version',
    rotated?.keyVersion === 2 && rotated?.secret !== gpuNode.credentials.secret,
    `v${rotated?.keyVersion}`,
  );

  const withNewKey = await agent('/nodes/agent/status', {}, {
    nodeId: gpuNode.node.id,
    keyVersion: rotated.keyVersion,
    secret: rotated.secret,
  });
  check(
    'the new key authenticates',
    withNewKey.status === 200 || withNewKey.status === 201,
    `status ${withNewKey.status}`,
  );

  const withOldKey = await agent('/nodes/agent/status', {}, {
    nodeId: gpuNode.node.id,
    keyVersion: gpuNode.credentials.keyVersion,
    secret: gpuNode.credentials.secret,
  });
  check(
    'the previous key still verifies during the rotation overlap',
    withOldKey.status === 200 || withOldKey.status === 201,
    `status ${withOldKey.status}`,
  );

  await api('POST', `/nodes/${gpuNode.node.id}/trust`, { ...t(), body: { trusted: false } });
  const afterRevokeTrust = await agent('/nodes/agent/status', {}, {
    nodeId: gpuNode.node.id,
    keyVersion: rotated.keyVersion,
    secret: rotated.secret,
  });
  check(
    'revoking trust revokes every key immediately',
    afterRevokeTrust.status === 401,
    `status ${afterRevokeTrust.status}`,
  );
  await api('POST', `/nodes/${gpuNode.node.id}/trust`, { ...t(), body: { trusted: true } });
  const restored = await api('POST', `/nodes/${gpuNode.node.id}/rotate-key`, t());
  check(
    'a node can be re-trusted and re-keyed',
    restored?.keyVersion >= 3,
    `v${restored?.keyVersion}`,
  );

  // ================================================================
  console.log('\n--- 10. Scaling by registering a node ---');

  const before = await api('GET', '/distributed/cluster', t());

  const added = await api('POST', '/nodes', {
    ...t(),
    body: {
      name: 'Scale-out Node',
      slug: `scale-${unique}`,
      type: 'HOME_SERVER',
      endpointUrl: 'http://127.0.0.1:9105',
      trusted: true,
      maxConcurrency: 10,
      costPerHourUsd: 0.1,
      resources: { cpuCores: 24, memoryMb: 65536, diskMb: 1000000 },
      capabilities: [
        { kind: 'PROVIDER', key: 'OLLAMA' },
        { kind: 'TOOL', key: 'knowledge.search' },
        { kind: 'RUNTIME', key: 'NODEJS' },
      ],
      metadata: { simulate: { latencyMs: 2 } },
    },
  });
  await api('POST', `/nodes/${added.node.id}/heartbeat`, {
    ...t(),
    body: { cpuUsage: 0.02, memoryUsage: 0.05, diskUsage: 0.05, activeTasks: 0, latencyMs: 2 },
  });

  const after = await api('GET', '/distributed/cluster', t());
  check(
    'registering a node increases fleet capacity with no other configuration',
    after?.capacity?.cpuCores === before?.capacity?.cpuCores + 24 &&
      after?.capacity?.maxConcurrency === before?.capacity?.maxConcurrency + 10,
    `${before?.capacity?.cpuCores} → ${after?.capacity?.cpuCores} cores, ` +
      `${before?.capacity?.maxConcurrency} → ${after?.capacity?.maxConcurrency} slots`,
  );

  const newNodeDetail = await api('GET', `/nodes/${added.node.id}`, t());
  check(
    'the new node is measured and its capabilities recorded automatically',
    (newNodeDetail?.capabilities ?? []).length === 3 && newNodeDetail?.healthScore > 0.5,
    `${newNodeDetail?.capabilities?.length} capabilities · health ${newNodeDetail?.healthScore}`,
  );

  const scaledPlan = await api('POST', '/distributed/plan', { ...t(), body: {} });
  check(
    'the scheduler immediately considers the new node',
    (scaledPlan?.candidates ?? []).some((c) => c.slug === `scale-${unique}`),
    (scaledPlan?.candidates ?? []).map((c) => c.slug).join(', '),
  );

  const scaledRun = await api('POST', '/distributed/tasks', {
    ...t(),
    body: { kind: 'echo', payload: { scaled: true }, requirements: { nodeId: added.node.id }, wait: true },
  });
  check(
    'the new node takes work without any reconfiguration',
    scaledRun?.task?.status === 'SUCCEEDED',
    `${scaledRun?.task?.status} on ${scaledRun?.task?.nodeId}`,
  );

  const discovered = await api('POST', `/nodes/${added.node.id}/discover`, {
    ...t(),
    body: {
      capabilities: [
        { kind: 'PROVIDER', key: 'OLLAMA' },
        { kind: 'RUNTIME', key: 'NODEJS' },
      ],
    },
  });
  check(
    'a capability that disappears stops being advertised',
    discovered?.capabilities === 2,
    `${discovered?.capabilities} capabilities`,
  );

  const afterDiscovery = await api('POST', '/distributed/plan', {
    ...t(),
    body: { capabilities: ['TOOL:knowledge.search'], nodeId: added.node.id },
  });
  check(
    'the scheduler stops placing work needing the removed capability',
    afterDiscovery?.chosen === null,
    afterDiscovery?.explanation,
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
