/**
 * PRISM-X Backend — Phase 7 validation suite.
 *
 * Exercises the ten Phase 7 checks against a running server with live
 * Postgres and Redis:
 *
 *   1. Extensions install and uninstall correctly
 *   2. Plugins communicate through the SDK
 *   3. Custom Workers execute successfully
 *   4. Marketplace assets install correctly
 *   5. Public APIs authenticate securely
 *   6. Extensions remain sandboxed
 *   7. Version upgrades preserve compatibility
 *   8. Developer Portal documentation is complete
 *   9. Governance policies enforce platform integrity
 *  10. No extension can compromise the core platform
 *
 * Plus the capability catalogue, which is what makes the rest enforceable.
 *
 *   node test/phase7-validation.js
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000/api/v1';
const results = [];
let failures = 0;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  if (!passed) failures++;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

async function api(method, endpoint, { token, apiKey, body, raw, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (apiKey) h['x-api-key'] = apiKey;

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
  email: `phase7-${unique}@prism-x.test`,
  password: 'CorrectHorse42Battery',
  organizationName: `Phase7 Labs ${unique}`,
};
const SLUG = `digest-${unique}`;

/** A manifest that asks only for what it uses. */
const manifestV1 = {
  slug: SLUG,
  name: 'Daily Digest',
  version: '1.0.0',
  description: 'Summarises yesterday.',
  author: 'Phase7 Labs',
  license: 'MIT',
  engine: '^1.0.0',
  capabilities: [
    'can_read_missions',
    'can_persist_state',
    'can_access_knowledge',
    'can_read_events',
    'can_register_tools',
    'can_register_workers',
  ],
  subscribes: ['mission.completed'],
  config: {
    channel: { type: 'string', label: 'Channel', required: true, default: '#ops' },
    apiToken: { type: 'secret', label: 'Upstream token' },
  },
  contributes: {
    tools: [
      {
        key: 'summarise',
        name: 'Summarise missions',
        description: 'Produces a short digest of missions in a window.',
        input: { properties: { days: { type: 'number', description: 'How far back.' } }, required: ['days'] },
        output: { properties: { digest: { type: 'string' } } },
        mutates: false,
        capability: 'can_read_missions',
      },
    ],
    workers: [
      {
        key: 'digest-writer',
        name: 'Digest Writer',
        description: 'Writes the digest prose.',
        systemPrompt: 'You write concise digests.',
        capabilities: ['can_read_missions', 'can_persist_state'],
      },
    ],
  },
  limits: { callsPerMinute: 60, httpRequestsPerMinute: 5 },
};

(async () => {
  console.log(`\nPRISM-X Backend — Phase 7 validation\n${'='.repeat(66)}\n`);

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
  console.log('--- 0. The capability catalogue ---');

  const capabilities = await api('GET', '/platform/capabilities', t());
  const ids = (capabilities?.capabilities ?? []).map((c) => c.id);

  check(
    'the catalogue is published with risk, implied permissions and guarded surface',
    ids.length >= 12 &&
      capabilities.capabilities.every(
        (c) => c.id && c.title && c.description && c.risk && Array.isArray(c.surface),
      ),
    `${ids.length} capabilities, version ${capabilities?.version}`,
  );
  check(
    'it names the capabilities the architecture called for',
    [
      'can_execute_missions',
      'can_access_knowledge',
      'can_manage_workers',
      'can_register_triggers',
      'can_send_notifications',
      'can_invoke_external_apis',
    ].every((id) => ids.includes(id)),
    ids.filter((i) => i.startsWith('can_')).length + ' capability ids',
  );
  check(
    'every guarded host method is claimed by exactly one capability',
    (capabilities?.guardedMethods ?? []).length > 20 &&
      capabilities.guardedMethods.every(
        (method) =>
          capabilities.capabilities.filter((c) => c.surface.includes(method)).length === 1,
      ),
    `${capabilities?.guardedMethods?.length} guarded methods`,
  );
  check(
    'high-risk capabilities are marked as needing review',
    capabilities.capabilities
      .filter((c) => c.risk === 'HIGH' || c.risk === 'CRITICAL')
      .every((c) => c.reviewRequired === true),
    `threshold ${capabilities?.reviewThreshold}`,
  );

  // ================================================================
  console.log('\n--- 1. Extensions install and uninstall correctly ---');

  const badManifest = await api('POST', '/platform/extensions/validate', {
    ...t(),
    body: { manifest: { slug: 'Bad Slug!', name: 'x', version: 'not-semver', capabilities: 'nope' } },
  });
  check(
    'an invalid manifest is refused with field-level errors, not a stack trace',
    badManifest?.ok === false && badManifest.errors.length >= 3,
    `${badManifest?.errors?.length} errors`,
  );

  const unknownCapability = await api('POST', '/platform/extensions/validate', {
    ...t(),
    body: { manifest: { slug: 'x-y', name: 'Test', version: '1.0.0', capabilities: ['can_do_anything'] } },
  });
  check(
    'a capability outside the catalogue is refused',
    unknownCapability?.ok === false &&
      unknownCapability.errors.some((e) => e.message.includes('can_do_anything')),
  );

  const dryRun = await api('POST', '/platform/extensions', {
    ...t(),
    body: { manifest: manifestV1, config: { channel: '#ops', apiToken: 'sk-upstream-123' }, dryRun: true },
  });
  check(
    'a dry run reports the grant without persisting anything',
    dryRun?.extension === undefined && Array.isArray(dryRun?.grant?.granted),
    `${dryRun?.grant?.granted?.length} would be granted`,
  );

  const installed = await api('POST', '/platform/extensions', {
    ...t(),
    body: { manifest: manifestV1, config: { channel: '#ops', apiToken: 'sk-upstream-123' } },
  });
  const extensionId = installed?.extension?.id;
  check(
    'an extension installs and records its grant',
    Boolean(extensionId) && installed.grant.granted.includes('can_persist_state'),
    `${extensionId} :: ${installed?.grant?.granted?.length} granted`,
  );

  check(
    'a manifest requesting a critical capability is held for approval',
    installed?.consentRequired === true && installed.extension.status === 'PENDING_REVIEW',
    `risk ${installed?.grant?.risk}`,
  );
  await api('POST', `/platform/extensions/${extensionId}/approve`, t());

  const lifecycle = await api('GET', `/platform/extensions/${extensionId}/history`, t());
  const phases = new Set((lifecycle ?? []).map((e) => e.phase));
  check(
    'the lifecycle is recorded phase by phase, not just as a final status',
    ['INSTALL', 'REGISTER', 'INITIALIZE'].every((phase) => phases.has(phase)),
    [...phases].join(', '),
  );

  const enabled = await api('POST', `/platform/extensions/${extensionId}/enable`, t());
  check('an extension enables', enabled?.status === 'ENABLED');

  const detail = await api('GET', `/platform/extensions/${extensionId}`, t());
  check(
    'the sealed configuration is never returned',
    detail?.secrets === undefined && detail?.config?.channel === '#ops',
    `config keys: ${Object.keys(detail?.config ?? {}).join(', ')}`,
  );

  // ================================================================
  console.log('\n--- 2. Plugins communicate through the SDK ---');

  const stateKeys = await api('GET', `/platform/extensions/${extensionId}/calls`, t());
  const initCall = (stateKeys ?? []).find((c) => c.method === 'state.set');
  check(
    'initialize reached the host through the SDK and was allowed',
    Boolean(initCall) && initCall.decision === 'ALLOWED',
    `${stateKeys?.length} host call(s) recorded`,
  );
  check(
    'each host call is attributed to the capability that permitted it',
    Boolean(initCall) && initCall.capability === 'can_persist_state',
    initCall?.capability,
  );

  // ================================================================
  console.log('\n--- 3. Custom Workers execute successfully ---');

  const contributions = await api('GET', `/platform/extensions/${extensionId}/contributions`, t());
  const contributedTool = (contributions ?? []).find((c) => c.kind === 'TOOL');
  const contributedWorker = (contributions ?? []).find((c) => c.kind === 'WORKER');

  check(
    'contributed tools and workers are registered and namespaced',
    contributedTool?.key === `${SLUG}.summarise` && contributedWorker?.key === `${SLUG}.digest-writer`,
    `${contributions?.length} contribution(s)`,
  );
  check(
    'a contribution runs under a subset of its extension’s grant, never a superset',
    contributedWorker.capabilities.every((c) => installed.grant.granted.includes(c)) &&
      contributedWorker.capabilities.length <= installed.grant.granted.length,
    contributedWorker?.capabilities?.join(', '),
  );

  const provider = await api('POST', '/providers', {
    ...t(),
    body: { name: 'Sim Alpha', kind: 'LOCAL', isDefault: true },
  });
  await api('POST', `/providers/${provider.id}/health-check`, t());

  const nativeWorker = await api('POST', '/workers', {
    ...t(),
    body: {
      name: 'Digest Caller',
      role: 'research',
      capabilities: ['research'],
      providerId: provider.id,
      systemPrompt: 'You summarise.',
      toolPermissions: [`${SLUG}.summarise`],
    },
  });
  await api('POST', `/workers/${nativeWorker.id}/activate`, t());

  const toolCatalogue = await api('GET', '/tools', t());
  check(
    'the built-in tool registry is unchanged by the addition',
    Array.isArray(toolCatalogue) && toolCatalogue.length >= 9,
    `${toolCatalogue?.length} built-in tools`,
  );

  const contributedWorkerRow = await api('GET', `/workers/${contributedWorker.workerId}`, t());
  check(
    'a contributed worker is an ordinary worker downstream',
    contributedWorkerRow?.id === contributedWorker.workerId &&
      contributedWorkerRow.dna?.contributedBy === SLUG,
    contributedWorkerRow?.name,
  );

  const execution = await api('POST', `/workers/${nativeWorker.id}/execute`, {
    ...t(),
    body: {
      instruction:
        `Summarise the week. Respond with exactly:\n` +
        `TOOL_CALL: {"tool": "${SLUG}.summarise", "input": {"days": 7}}`,
    },
  });
  const contributedCall = (execution?.toolCalls ?? []).find((c) => c.tool === `${SLUG}.summarise`);
  check(
    'a worker invokes a contributed tool through the ordinary execution path',
    Boolean(contributedCall) && contributedCall.ok === true,
    `${execution?.toolCalls?.length ?? 0} tool call(s)`,
  );
  check(
    'the contributed tool answered from the extension, not from the core',
    Boolean(contributedCall?.output?.extension === SLUG),
    JSON.stringify(contributedCall?.output ?? {}).slice(0, 120),
  );

  const invoked = await api('GET', `/platform/extensions/${extensionId}/contributions`, t());
  check(
    'the invocation is counted against the contribution',
    (invoked.find((c) => c.kind === 'TOOL')?.invocations ?? 0) >= 1,
    `${invoked.find((c) => c.kind === 'TOOL')?.invocations} invocation(s)`,
  );

  // ================================================================
  console.log('\n--- 6. Extensions remain sandboxed ---');

  // The install granted no can_manage_workers (never requested), so the
  // guarded method must be unreachable regardless of the caller's own rights.
  const grantDetail = await api('GET', `/platform/extensions/${extensionId}/grant`, t());
  check(
    'the consent screen explains the grant in plain sentences',
    (grantDetail?.granted ?? []).every((c) => c.title && c.description && c.risk),
    `${grantDetail?.granted?.length} granted, risk ${grantDetail?.risk}`,
  );
  check(
    'the grant is stamped with the catalogue version it was issued under',
    Boolean(grantDetail?.catalogueVersion) && grantDetail.catalogueCurrent === true,
    grantDetail?.catalogueVersion,
  );
  check(
    'capabilities never requested are absent from the grant',
    !grantDetail.granted.some((c) => c.id === 'can_manage_workers') &&
      !grantDetail.granted.some((c) => c.id === 'can_invoke_external_apis'),
  );
  check(
    'the grant implies only the permissions its capabilities carry',
    Array.isArray(grantDetail?.permissions) &&
      grantDetail.permissions.includes('knowledge:read') &&
      !grantDetail.permissions.includes('worker:delete'),
    grantDetail?.permissions?.join(', '),
  );

  // ================================================================
  console.log('\n--- 10. No extension can compromise the core platform ---');

  const greedyManifest = {
    slug: `greedy-${unique}`,
    name: 'Greedy',
    version: '1.0.0',
    engine: '^1.0.0',
    capabilities: ['can_manage_workers', 'can_use_credentials', 'can_invoke_external_apis'],
  };

  // Install as an operator, who holds neither worker:delete nor provider:read.
  // A genuinely narrower principal, reachable through the public API: an API
  // key carries only its own scopes as permissions. Installing through it must
  // therefore withhold every capability whose implied permissions the key does
  // not hold — the intersection rule, exercised end to end rather than asserted
  // about a function.
  const narrowApp = await api('POST', '/platform/developer/apps', {
    ...t(),
    body: { name: 'Narrow Installer', slug: `narrow-${unique}` },
  });
  const narrowKey = await api('POST', `/platform/developer/apps/${narrowApp.app.id}/keys`, {
    ...t(),
    body: { name: 'installer', scopes: ['extension:install', 'extension:read'] },
  });

  const asKey = await api('GET', '/auth/me', { apiKey: narrowKey.key });
  check(
    'an API key authenticates as a principal holding only its own scopes',
    asKey?.roleKey === 'API_KEY' &&
      asKey.permissions.length === 2 &&
      !asKey.permissions.includes('*'),
    `${asKey?.permissions?.join(', ')}`,
  );

  const escalation = await api('POST', '/platform/extensions', {
    apiKey: narrowKey.key,
    body: { manifest: greedyManifest, dryRun: true },
  });
  check(
    'an installer cannot lend authority they do not hold',
    escalation?.grant?.granted?.length === 0 && escalation.grant.withheld.length === 3,
    `withheld: ${(escalation?.grant?.withheld ?? []).map((w) => w.capability).join(', ')}`,
  );
  check(
    'each withheld capability names the permissions that were missing',
    escalation?.grant?.withheld?.length === 3 &&
      escalation.grant.withheld.every((w) => Array.isArray(w.missing) && w.missing.length),
    JSON.stringify(escalation?.grant?.withheld?.[0]),
  );

  const partial = await api('POST', '/platform/extensions', {
    apiKey: narrowKey.key,
    body: {
      manifest: {
        slug: `partial-${unique}`,
        name: 'Partial',
        version: '1.0.0',
        engine: '^1.0.0',
        capabilities: ['can_register_tools', 'can_manage_workers'],
      },
      dryRun: true,
    },
  });
  check(
    'a partly-grantable install keeps what it can and reports the gap',
    partial?.grant?.granted?.length === 0 &&
      partial.grant.withheld.some((w) => w.capability === 'can_manage_workers'),
    `granted ${partial?.grant?.granted?.join(', ') || 'none'}; withheld ${partial?.grant?.withheld?.length}`,
  );

  const contributionEscalation = await api('POST', '/platform/extensions/validate', {
    ...t(),
    body: {
      manifest: {
        slug: `sneaky-${unique}`,
        name: 'Sneaky',
        version: '1.0.0',
        capabilities: ['can_persist_state'],
        contributes: {
          workers: [
            { key: 'w', name: 'W', capabilities: ['can_manage_workers'] },
          ],
        },
      },
    },
  });
  check(
    'a contribution cannot ask for a capability its extension did not request',
    contributionEscalation?.ok === false &&
      contributionEscalation.errors.some((e) => e.message.includes('can_manage_workers')),
    contributionEscalation?.errors?.[0]?.message,
  );

  const criticalManifest = {
    slug: `critical-${unique}`,
    name: 'Critical',
    version: '1.0.0',
    engine: '^1.0.0',
    capabilities: ['can_invoke_external_apis'],
  };
  const critical = await api('POST', '/platform/extensions', {
    ...t(),
    body: { manifest: criticalManifest },
  });
  check(
    'a high-risk grant is held inert until a human approves it',
    critical?.extension?.status === 'PENDING_REVIEW' && critical.consentRequired === true,
    `risk ${critical?.grant?.risk}`,
  );

  const enableBlocked = await api('POST', `/platform/extensions/${critical.extension.id}/enable`, {
    ...t(),
    raw: true,
  });
  check(
    'it cannot be enabled while the grant is pending',
    enableBlocked?.status === 400,
    enableBlocked?.body?.message,
  );

  const approved = await api('POST', `/platform/extensions/${critical.extension.id}/approve`, t());
  check('approving the grant releases it', approved?.status === 'INSTALLED');

  // ================================================================
  console.log('\n--- 7. Version upgrades preserve compatibility ---');

  const patch = { ...manifestV1, version: '1.0.1', description: 'Summarises yesterday, faster.' };
  const patchUpgrade = await api('POST', `/platform/extensions/${extensionId}/upgrade`, {
    ...t(),
    body: { manifest: patch },
  });
  check(
    'a non-breaking upgrade applies immediately',
    patchUpgrade?.applied === true && patchUpgrade.analysis.release === 'PATCH',
    `${patchUpgrade?.analysis?.from} -> ${patchUpgrade?.analysis?.to}`,
  );

  const sneakyPatch = {
    ...manifestV1,
    version: '1.0.2',
    capabilities: [...manifestV1.capabilities, 'can_invoke_external_apis'],
  };
  const sneakyAnalysis = await api('POST', `/platform/extensions/${extensionId}/upgrade/analyse`, {
    ...t(),
    body: { manifest: sneakyPatch },
  });
  check(
    'a capability added in a patch release is flagged as breaking',
    sneakyAnalysis?.analysis?.breaking === true &&
      sneakyAnalysis.analysis.changes.some((c) => c.code === 'undeclared_capability_change'),
    sneakyAnalysis?.analysis?.changes?.map((c) => c.code).join(', '),
  );

  const downgrade = await api('POST', `/platform/extensions/${extensionId}/upgrade/analyse`, {
    ...t(),
    body: { manifest: { ...manifestV1, version: '0.9.0' } },
  });
  check(
    'a downgrade is blocked rather than treated as an upgrade',
    downgrade?.analysis?.blocked === true &&
      downgrade.analysis.changes.some((c) => c.code === 'downgrade'),
  );

  const incompatible = await api('POST', `/platform/extensions/${extensionId}/upgrade/analyse`, {
    ...t(),
    body: { manifest: { ...manifestV1, version: '9.0.0', engine: '^99.0.0' } },
  });
  check(
    'an engine range this platform cannot satisfy is caught before installation',
    incompatible?.analysis === undefined ||
      incompatible.analysis.blocked === true ||
      incompatible?.errors?.some((e) => e.field === 'engine'),
    incompatible?.errors?.[0]?.message ?? incompatible?.analysis?.changes?.[0]?.code,
  );

  const majorManifest = {
    ...manifestV1,
    version: '2.0.0',
    capabilities: [...manifestV1.capabilities, 'can_send_notifications'],
    contributes: { ...manifestV1.contributes, tools: [] },
    migrations: [{ to: '2.0.0', description: 'Moves the channel into config.' }],
  };
  const breaking = await api('POST', `/platform/extensions/${extensionId}/upgrade`, {
    ...t(),
    body: { manifest: majorManifest },
  });
  check(
    'a breaking upgrade is detected before installation and waits for consent',
    breaking?.applied === false &&
      breaking.analysis.breaking === true &&
      breaking.upgrade.outcome === 'AWAITING_CONSENT',
    breaking?.analysis?.changes?.map((c) => c.code).join(', '),
  );
  check(
    'the removed contribution is reported as a breaking change',
    breaking.analysis.changes.some((c) => c.code === 'contribution_removed'),
  );

  const consented = await api('POST', `/platform/upgrades/${breaking.upgrade.id}/consent`, t());
  check(
    'consent applies the version that was analysed',
    consented?.version === '2.0.0',
    consented?.version,
  );

  const afterUpgrade = await api('GET', `/platform/extensions/${extensionId}/contributions`, t());
  check(
    'a removed contribution is actually gone after the upgrade',
    !afterUpgrade.some((c) => c.kind === 'TOOL'),
    `${afterUpgrade.length} remaining`,
  );

  const migrated = await api('GET', `/platform/extensions/${extensionId}/history`, t());
  check(
    'declared migrations run as part of the upgrade',
    migrated.some((e) => e.phase === 'MIGRATE' && e.outcome === 'SUCCEEDED'),
  );

  const rolledBack = await api('POST', `/platform/extensions/${extensionId}/rollback`, t());
  check(
    'rollback restores the previous version and its grant',
    rolledBack?.version === '1.0.1' &&
      !rolledBack.capabilities.includes('can_send_notifications'),
    `${rolledBack?.version}, ${rolledBack?.capabilities?.length} capabilities`,
  );

  const restored = await api('GET', `/platform/extensions/${extensionId}/contributions`, t());
  check(
    'rollback restores the contributions the upgrade removed',
    restored.some((c) => c.kind === 'TOOL'),
    `${restored.length} contribution(s)`,
  );

  const upgradeHistory = await api('GET', `/platform/extensions/${extensionId}/upgrades`, t());
  check(
    'every version change is recorded with its analysis',
    upgradeHistory.length >= 2 &&
      upgradeHistory.every((u) => u.fromVersion && u.toVersion && Array.isArray(u.changes)),
    upgradeHistory.map((u) => `${u.fromVersion}->${u.toVersion}:${u.outcome}`).join(' '),
  );

  // ================================================================
  console.log('\n--- 4. Marketplace assets install correctly ---');

  const publisherResult = await api('POST', '/platform/marketplace/publishers', {
    ...t(),
    body: { slug: `labs-${unique}`, displayName: 'Phase7 Labs', contactEmail: 'dev@phase7.test' },
  });
  const publisher = publisherResult?.publisher;
  const signingKey = publisherResult?.signingKey;
  check(
    'registering a publisher returns a private key the platform does not keep',
    Boolean(publisher?.id) &&
      typeof signingKey === 'string' &&
      signingKey.includes('PRIVATE KEY') &&
      publisher.signingKey.includes('PUBLIC KEY'),
    `${publisher?.slug}, trust ${publisher?.trust}`,
  );

  const listing = await api('POST', '/platform/marketplace/listings', {
    ...t(),
    body: {
      assetKind: 'EXTENSION',
      slug: `market-${unique}`,
      name: 'Market Digest',
      summary: 'A digest you can install from the marketplace.',
      publisherId: publisher.id,
      license: 'MIT',
      tags: ['reporting'],
      documentation: '# Market Digest\n\nInstall it, enable it, read it.',
    },
  });
  check('a listing is created as a draft', listing?.status === 'DRAFT', listing?.slug);

  const marketManifest = {
    slug: `market-${unique}`,
    name: 'Market Digest',
    version: '1.0.0',
    engine: '^1.0.0',
    license: 'MIT',
    capabilities: ['can_read_missions', 'can_persist_state'],
  };
  const release = await api('POST', `/platform/marketplace/listings/${listing.id}/versions`, {
    ...t(),
    body: { manifest: marketManifest, changelog: 'First release.', signingKey },
  });
  check(
    'a low-risk release is signed and immediately installable',
    Boolean(release?.version?.signature) && release.version.reviewStatus === 'APPROVED',
    `signed by ${release?.version?.signedBy}`,
  );

  const duplicate = await api('POST', `/platform/marketplace/listings/${listing.id}/versions`, {
    ...t(),
    body: { manifest: marketManifest },
    raw: true,
  });
  check(
    'versions are immutable — republishing the same one is a conflict',
    duplicate?.status === 409,
    duplicate?.body?.message,
  );

  const catalogue = await api(
    'GET',
    `/platform/marketplace/listings?assetKind=EXTENSION&q=market-${unique}`,
    t(),
  );
  check(
    'the listing appears in the catalogue once published',
    catalogue?.rows?.some((l) => l.slug === `market-${unique}` && l.latestVersion === '1.0.0'),
    `${catalogue?.total} result(s)`,
  );

  const marketInstall = await api('POST', `/platform/marketplace/listings/${listing.id}/install`, {
    ...t(),
    body: {},
  });
  check(
    'a marketplace asset installs with its signature verified',
    Boolean(marketInstall?.extension?.id) && marketInstall.extension.signatureVerified === true,
    `${marketInstall?.version}`,
  );

  await api('POST', `/platform/marketplace/listings/${listing.id}/rate`, {
    ...t(),
    body: { rating: 5, title: 'Works', body: 'Installed cleanly.' },
  });
  const rated = await api('GET', `/platform/marketplace/listings/${listing.id}`, t());
  check(
    'ratings aggregate onto the listing',
    rated?.rating === 5 && rated.ratingCount === 1 && rated.installCount >= 1,
    `rating ${rated?.rating} from ${rated?.ratingCount}, ${rated?.installCount} install(s)`,
  );

  const overview = await api('GET', '/platform/marketplace/overview', t());
  check(
    'the marketplace carries the ten asset kinds',
    overview?.assetKinds === 10,
    `${overview?.assetKinds} kinds, ${overview?.listings} listing(s)`,
  );

  // ================================================================
  console.log('\n--- 9. Governance policies enforce platform integrity ---');

  const riskyManifest = {
    slug: `risky-${unique}`,
    name: 'Risky',
    version: '1.0.0',
    engine: '^1.0.0',
    capabilities: ['can_use_credentials', 'can_invoke_external_apis'],
  };
  const riskyListing = await api('POST', '/platform/marketplace/listings', {
    ...t(),
    body: {
      assetKind: 'TOOL',
      slug: `risky-${unique}`,
      name: 'Risky Tool',
      summary: 'Asks for credentials and network access.',
      publisherId: publisher.id,
    },
  });
  const riskyRelease = await api('POST', `/platform/marketplace/listings/${riskyListing.id}/versions`, {
    ...t(),
    body: { manifest: riskyManifest, signingKey },
  });
  check(
    'a critical-capability release opens a review instead of going live',
    riskyRelease?.reviewOpened === true && riskyRelease.version.reviewStatus === 'PENDING',
    `risk ${riskyRelease?.version?.riskLevel}`,
  );

  const blockedInstall = await api('POST', `/platform/marketplace/listings/${riskyListing.id}/install`, {
    ...t(),
    body: { version: '1.0.0' },
    raw: true,
  });
  check(
    'a listing whose only version is under review is not installable',
    blockedInstall?.status === 404 || blockedInstall?.status === 403,
    blockedInstall?.body?.message,
  );

  const queue = await api('GET', '/platform/governance/reviews', t());
  const pendingReview = (queue ?? []).find((r) => r.subjectId === riskyRelease.version.id);
  check(
    'the review reaches the queue with its risk and capabilities attached',
    Boolean(pendingReview) && pendingReview.riskLevel === 'CRITICAL',
    pendingReview?.subjectLabel,
  );

  await api('POST', `/platform/governance/reviews/${pendingReview.id}/decide`, {
    ...t(),
    body: { status: 'APPROVED', notes: 'Capabilities are justified by the described function.' },
  });
  const nowInstallable = await api('POST', `/platform/marketplace/listings/${riskyListing.id}/install`, {
    ...t(),
    body: { version: '1.0.0' },
    raw: true,
  });
  check(
    'approving the review is what makes it installable',
    nowInstallable?.status === 201 || nowInstallable?.status === 200,
    `status ${nowInstallable?.status}`,
  );

  const compatibility = await api('POST', '/platform/governance/compatibility', {
    ...t(),
    body: { listingId: listing.id, version: '1.0.0' },
  });
  check(
    'compatibility testing runs every static check',
    compatibility?.compatible === true && compatibility.checks.length >= 5,
    compatibility?.checks?.map((c) => `${c.check}:${c.ok ? 'ok' : 'no'}`).join(' '),
  );

  const futureApi = await api('POST', '/platform/governance/compatibility', {
    ...t(),
    body: { listingId: listing.id, version: '1.0.0', apiVersion: '2.0.0' },
  });
  check(
    'the same check answers what would break at a future API version',
    futureApi?.compatible === false &&
      futureApi.checks.some((c) => c.check === 'engine_range' && c.ok === false),
    `compatible at 2.0.0: ${futureApi?.compatible}`,
  );

  const advisory = await api('POST', '/platform/governance/advisories', {
    ...t(),
    body: {
      affectedSlug: `market-${unique}`,
      severity: 'HIGH',
      title: 'Digest leaks mission titles',
      summary: 'Sends mission titles to an undisclosed endpoint.',
      affectedRange: '>=1.0.0 <1.1.0',
      patchedVersion: '1.1.0',
      listingId: listing.id,
    },
  });
  check(
    'an advisory quarantines affected installs rather than only warning',
    advisory?.quarantined >= 1,
    `${advisory?.quarantined} install(s) quarantined`,
  );

  const quarantined = await api('GET', `/platform/extensions/${marketInstall.extension.id}`, t());
  check(
    'the quarantined install is stopped and told why',
    quarantined?.status === 'QUARANTINED' && String(quarantined.lastError).includes('advisory'),
    quarantined?.lastError,
  );

  const reEnable = await api('POST', `/platform/extensions/${marketInstall.extension.id}/enable`, {
    ...t(),
    raw: true,
  });
  check(
    'a quarantined extension cannot simply be re-enabled',
    reEnable?.status === 400,
    reEnable?.body?.message,
  );

  const advisoryBlocked = await api('POST', `/platform/marketplace/listings/${listing.id}/install`, {
    ...t(),
    body: { version: '1.0.0' },
    raw: true,
  });
  check(
    'a version covered by a live advisory cannot be newly installed',
    advisoryBlocked?.status === 403 && String(advisoryBlocked.body.message).includes('advisory'),
    advisoryBlocked?.body?.message,
  );

  await api('POST', `/platform/governance/publishers/${publisher.id}/trust`, {
    ...t(),
    body: { trust: 'VERIFIED' },
  });
  const verified = await api('GET', `/platform/marketplace/listings/${listing.id}`, t());
  check(
    'publisher verification is visible on every listing they own',
    verified?.publisher?.trust === 'VERIFIED',
    verified?.publisher?.slug,
  );

  await api('POST', `/platform/governance/publishers/${publisher.id}/suspend`, {
    ...t(),
    body: { reason: 'Undisclosed data egress.' },
  });
  const suspendedListing = await api('GET', `/platform/marketplace/listings/${listing.id}`, t());
  check(
    'suspending a publisher withdraws every listing they own',
    suspendedListing?.status === 'SUSPENDED',
    suspendedListing?.suspensionReason,
  );

  const audit = await api('GET', '/platform/governance/audit', t());
  check(
    'every governance decision lands in the platform audit log',
    Array.isArray(audit) && audit.some((entry) => entry.action === 'review_approved'),
    `${audit?.length} decision(s)`,
  );

  const governanceOverview = await api('GET', '/platform/governance/overview', t());
  check(
    'the governance dashboard reports the ecosystem’s standing',
    governanceOverview?.publishers?.suspended >= 1 && governanceOverview.advisories.total >= 1,
    JSON.stringify(governanceOverview?.listings),
  );

  // ================================================================
  console.log('\n--- 5. Public APIs authenticate securely ---');

  const app = await api('POST', '/platform/developer/apps', {
    ...t(),
    body: {
      name: 'Ops Console',
      slug: `ops-${unique}`,
      description: 'Reads missions for a status board.',
      webhookUrl: 'https://ops.example/prismx/hooks',
    },
  });
  check(
    'the webhook secret is generated, shown once and stored sealed',
    typeof app?.webhookSecret === 'string' &&
      app.webhookSecret.length >= 32 &&
      app.app.webhookSecret === '[sealed]',
    `app ${app?.app?.slug}`,
  );

  const issuedKey = await api('POST', `/platform/developer/apps/${app.app.id}/keys`, {
    ...t(),
    body: { name: 'production', scopes: ['mission:read'], rateLimitPerMinute: 240 },
  });
  check(
    'an API key is issued and attributed to the app',
    typeof issuedKey?.key === 'string' && issuedKey.appId === app.app.id,
    issuedKey?.prefix,
  );

  const withKey = await api('GET', '/missions', { apiKey: issuedKey.key, raw: true });
  check(
    'a valid API key authenticates against the public API',
    withKey?.status === 200,
    `status ${withKey?.status}`,
  );

  const badKey = await api('GET', '/missions', { apiKey: 'prx_not-a-real-key', raw: true });
  check(
    'an invalid API key is refused',
    badKey?.status === 401,
    `status ${badKey?.status}`,
  );

  const noAuth = await api('GET', '/platform/extensions', { raw: true });
  check(
    'the platform API refuses unauthenticated callers',
    noAuth?.status === 401,
    `status ${noAuth?.status}`,
  );

  const appDetail = await api('GET', `/platform/developer/apps/${app.app.id}`, t());
  check(
    'keys are listed by prefix, never by value',
    appDetail?.keys?.length === 1 &&
      appDetail.keys[0].prefix &&
      appDetail.keys[0].key === undefined,
    appDetail?.keys?.[0]?.prefix,
  );

  const revealed = await api('GET', `/platform/developer/apps/${app.app.id}/webhook-secret`, t());
  check(
    'the sealed webhook secret round-trips through the crypto service',
    revealed?.webhookSecret === app.webhookSecret,
  );

  // ================================================================
  console.log('\n--- 8. Developer Portal documentation is complete ---');

  const portal = await api('GET', '/platform/developer', t());
  check(
    'the portal covers documentation, guides, testing, release notes and migration',
    Boolean(portal?.documentation) &&
      (portal.guides ?? []).length >= 3 &&
      Boolean(portal.testing) &&
      (portal.releaseNotes ?? []).length >= 1 &&
      (portal.migrationGuides ?? []).length >= 1,
    `${portal?.guides?.length} guides`,
  );

  const sdk = await api('GET', '/platform/developer/sdk', t());
  check(
    'the SDK reference is generated from the catalogue the sandbox enforces',
    sdk?.catalogueVersion === capabilities.version &&
      sdk.capabilities.length === capabilities.capabilities.length &&
      sdk.hostSurface.every((entry) => Boolean(entry.capability)),
    `${sdk?.hostSurface?.length} host methods documented`,
  );
  check(
    'the SDK documents every lifecycle hook it supports',
    (sdk?.hooks ?? []).length >= 7 && sdk.hooks.every((h) => h.name && h.when),
    sdk?.hooks?.map((h) => h.name).join(', '),
  );
  check(
    'the SDK publishes the default and maximum resource limits',
    Boolean(sdk?.limits?.default?.callsPerMinute) &&
      sdk.limits.maximum.callsPerMinute >= sdk.limits.default.callsPerMinute,
    `default ${sdk?.limits?.default?.callsPerMinute}/min, max ${sdk?.limits?.maximum?.callsPerMinute}/min`,
  );

  const manifestDocs = await api('GET', '/platform/developer/manifest', t());
  check(
    'the manifest reference ships an example that actually validates',
    manifestDocs?.exampleIsValid === true && Object.keys(manifestDocs.fields).length >= 8,
    `${Object.keys(manifestDocs?.fields ?? {}).length} fields documented`,
  );

  const usage = await api('GET', '/platform/developer/analytics?days=7', t());
  check(
    'usage analytics report volume, errors and latency over a window',
    typeof usage?.totals?.requests === 'number' &&
      typeof usage.totals.errorRate === 'number' &&
      Array.isArray(usage.byDay),
    `${usage?.totals?.requests} request(s) in ${usage?.window?.days} days`,
  );

  const openapi = await fetch('http://127.0.0.1:3000/docs-json').then((r) => r.json());
  const platformPaths = Object.keys(openapi.paths ?? {}).filter((p) => p.includes('/platform/'));
  check(
    'platform endpoints are in the generated OpenAPI document',
    platformPaths.length >= 25,
    `${platformPaths.length} platform paths documented`,
  );

  // ================================================================
  console.log('\n--- 1b. Uninstall ---');

  const preUninstall = await api('GET', `/platform/extensions/${extensionId}/contributions`, t());
  await api('DELETE', `/platform/extensions/${extensionId}`, t());
  const gone = await api('GET', `/platform/extensions/${extensionId}`, { ...t(), raw: true });
  check(
    'uninstalling removes the extension',
    gone?.status === 404,
    `was ${preUninstall.length} contribution(s)`,
  );

  const contributionsAfter = await api('GET', '/platform/contributions', t());
  check(
    'uninstalling removes its contributions from the platform',
    !contributionsAfter.some((c) => c.key.startsWith(`${SLUG}.`)),
    `${contributionsAfter.length} contribution(s) remain`,
  );

  const orphanedTool = await api('POST', `/workers/${nativeWorker.id}/execute`, {
    ...t(),
    body: {
      instruction:
        `Summarise. Respond with exactly:\n` +
        `TOOL_CALL: {"tool": "${SLUG}.summarise", "input": {"days": 1}}`,
    },
  });
  const orphanCall = (orphanedTool?.toolCalls ?? []).find((c) => c.tool === `${SLUG}.summarise`);
  check(
    'a tool from an uninstalled extension is denied rather than silently answered',
    Boolean(orphanCall) && orphanCall.ok === false && orphanCall.denied === true,
    orphanCall?.error,
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
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('\nSuite crashed:', error);
  process.exit(1);
});
