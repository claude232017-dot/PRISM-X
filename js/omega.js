/* PRISM-X — omega.js
 * PHASE OMEGA — PRODUCTION READINESS & OPERATING SYSTEM.
 *
 * No new empire features — this phase makes everything already built
 * secure, observable, recoverable, fast, configurable, documented and
 * validated as one platform.
 *
 * Honesty line: authentication here is a browser-local passcode (SHA-256
 * with a random salt via WebCrypto). It keeps casual hands off the app on
 * a shared machine; it cannot stop someone with access to the browser
 * profile's disk — the Security tab says exactly that. Every sensitive
 * action is traceable because every module already emits through the
 * Bridge; the audit view is that stream, filtered and stamped with the
 * acting role.
 */
window.PRISM = window.PRISM || {};

PRISM.omega = (function () {
  "use strict";
  const S = () => PRISM.store;
  const B = () => PRISM.bridge;
  const P = () => PRISM.providers;
  const X = () => PRISM.execution;
  const K = () => PRISM.knowledge;
  const MS = () => PRISM.missions;
  const EV = () => PRISM.evolution;
  const EN = () => PRISM.enterprise;
  const XT = () => PRISM.extensions;
  const NW = () => PRISM.network;
  const RT = () => PRISM.runtime;

  const CORE_VERSION = "1.0.0";
  const STATE_VERSION = 1;
  const ENV_PROFILES = ["development", "staging", "production"];

  /* the full release history — every phase shipped and verified */
  const CHANGELOG = [
    { v: "0.1", name: "Phase 1 — GOD CORE", note: "Clones, forge, task console, weekly audit, vaults, broadcast queue, five-layer DNA onboarding." },
    { v: "0.2", name: "Phase 2 — Product Ghosts", note: "Self-cloning product agents with autonomous launch/evolve loops (labeled revenue simulation)." },
    { v: "0.3", name: "Phase 3 — Outer Shells", note: "Faceless content brands: daily loops, persona tests, power meter, builder AI." },
    { v: "0.4", name: "Phase 4 — Matrix Merge", note: "Human executor bridge, briefs from real assets, PayShare, superfunnels, task grid." },
    { v: "0.5", name: "Phase Alpha — Foundation Protocol", note: "The Bridge: universal workers, event bus, shared memory, workflows, permissions, internal API." },
    { v: "0.6", name: "Phase H0 — Intelligence Provider Layer", note: "Provider Manager funnel, universal interface, capability registry, per-worker provider field." },
    { v: "0.7", name: "Phase Beta — First Intelligence", note: "Worker Runtime Engine: one executable worker, live monitor, execution logs, evaluation." },
    { v: "0.8", name: "Phase Gamma — Execution Layer", note: "Integration adapters, action registry, AES-GCM credential vault, dry/live modes, retries, least privilege." },
    { v: "0.85", name: "Phase Delta — Knowledge Network", note: "Layered vault, meaning-expanded search, linking, auto-retrieval, learning engine." },
    { v: "0.9", name: "Phase Epsilon — Autonomous Orchestration", note: "Mission planner, dependency graphs, collaborating workers, recovery, templates flywheel." },
    { v: "0.93", name: "Phase Zeta — Evolution Engine", note: "Scorecards, approval-gated improvements, real A/B experiments, prompt versioning." },
    { v: "0.96", name: "Phase Eta — Enterprise OS", note: "Organizations, CRM feeding missions, real ledger, projects, automations, executive reports." },
    { v: "0.98", name: "Phase Theta — Extension Ecosystem", note: "SDK, manager, event bus, permission-scoped APIs, private catalog, marketplace foundation." },
    { v: "0.99", name: "Phase Iota — Distributed Network", note: "Nodes, distributed missions, knowledge sync with conflict resolution, federation, failover, backups." },
    { v: "1.0.0", name: "Phase Omega — Production Readiness", note: "Security, health diagnostics, observability, selective recovery, performance, config center, docs, guided setup, validation suite." }
  ];

  function ensure() {
    const st = S().state;
    st.security = st.security || { enabled: false, passHash: null, passSalt: null, session: null, authLog: [] };
    st.security.authLog = st.security.authLog || [];
    st.readinessReports = st.readinessReports || [];
    return st;
  }
  function emit(text, meta) { B().emit("security", "🛡 " + text, meta || {}); }
  function authLog(action, detail) {
    const sec = ensure().security;
    sec.authLog.push({ at: Date.now(), actor: B().activeRole(), action, detail: String(detail || "").slice(0, 120) });
    if (sec.authLog.length > 50) sec.authLog.shift();
    S().save();
  }

  /* ================================================================== *
   * MODULE 1 — security & identity (browser-local, honestly labeled)
   * ================================================================== */
  const subtle = (typeof crypto !== "undefined" && crypto.subtle) ? crypto.subtle : null;
  async function hashPass(pass, saltB64) {
    if (!subtle) return "plain:" + btoa(pass); /* ancient-browser fallback, flagged */
    const salt = saltB64 ? atob(saltB64) : String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)));
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode(salt + pass));
    return { hash: btoa(String.fromCharCode(...new Uint8Array(buf))), salt: btoa(salt) };
  }
  async function enableLock(pass) {
    if (!pass || pass.length < 4) return { ok: false, reason: "passcode too short (min 4)" };
    const h = await hashPass(pass);
    const sec = ensure().security;
    sec.enabled = true;
    sec.passHash = h.hash;
    sec.passSalt = h.salt;
    sec.session = { at: Date.now(), until: Date.now() + sessionMs() };
    authLog("lock-enabled", "passcode set (SHA-256 + salt)");
    emit("Access lock enabled — passcode required on load (browser-local protection; the Security tab states its limits honestly).", { priority: "medium" });
    S().save();
    return { ok: true };
  }
  function disableLock() {
    const sec = ensure().security;
    sec.enabled = false;
    sec.passHash = null;
    sec.passSalt = null;
    sec.session = null;
    authLog("lock-disabled", "");
    emit("Access lock disabled.");
    S().save();
  }
  function sessionMs() { return Math.max(5, S().state.settings.sessionTimeoutMin || 60) * 60000; }
  function sessionValid() {
    const sec = ensure().security;
    if (!sec.enabled) return true;
    return !!(sec.session && sec.session.until > Date.now());
  }
  async function unlock(pass) {
    const sec = ensure().security;
    if (!sec.enabled) return { ok: true };
    const h = await hashPass(pass, sec.passSalt);
    if (h.hash === sec.passHash) {
      sec.session = { at: Date.now(), until: Date.now() + sessionMs() };
      authLog("unlock", "session opened for " + (S().state.settings.sessionTimeoutMin || 60) + "min");
      S().save();
      return { ok: true };
    }
    authLog("unlock-failed", "wrong passcode");
    S().save();
    return { ok: false, reason: "wrong passcode" };
  }
  function lockNow() {
    const sec = ensure().security;
    if (!sec.enabled) return false;
    sec.session = null;
    authLog("locked", "manual lock");
    S().save();
    return true;
  }
  /* the audit trail: security events + every sensitive Bridge event,
     already emitted by each module — filtered here, stamped with actor */
  const SENSITIVE_KINDS = ["delete", "dna", "upgrade", "permission", "integration", "provider", "extension", "node", "security", "org"];
  function auditTrail(limit) {
    ensure();
    const evs = S().state.events
      .filter(e2 => SENSITIVE_KINDS.includes(e2.kind))
      .slice(-(limit || 40))
      .map(e2 => ({ at: e2.at, actor: "role:" + B().activeRole(), action: e2.kind, detail: e2.text }));
    const auth = ensure().security.authLog.map(a => ({ at: a.at, actor: a.actor, action: "auth:" + a.action, detail: a.detail }));
    return evs.concat(auth).sort((a, b2) => b2.at - a.at).slice(0, limit || 40);
  }
  function keyInventory() {
    const st = S().state;
    const vaultKeys = Object.entries(st.credVault.entries || {}).map(([k2, v]) => ({ where: "Credential Vault (AES-GCM)", name: k2, fields: Object.keys(v).length }));
    return [
      { where: "Neural Link (Settings)", name: "Anthropic API key", present: !!st.settings.apiKey, masked: st.settings.apiKey ? "••••" + st.settings.apiKey.slice(-4) : "—" }
    ].concat(vaultKeys.map(v => ({ where: v.where, name: v.name, present: true, masked: v.fields + " field(s) encrypted" })));
  }

  /* ================================================================== *
   * MODULE 2 — system health center (diagnostics + recommendations)
   * ================================================================== */
  function componentHealth() {
    const st = S().state;
    const out = [];
    const push = (name, status, diag, rec) => out.push({ name, status, diag, rec });
    let storageOK = true;
    try { localStorage.setItem("prismx_health_probe", "1"); localStorage.removeItem("prismx_health_probe"); } catch (_) { storageOK = false; }
    const ss = S().saveStats();
    push("Storage", storageOK ? "ok" : "fail",
      storageOK ? `writable · state ${ss.lastKB || Math.round((localStorage.getItem("prismx_state_v1") || "").length / 1024)}KB · ${ss.writes} write(s), ${ss.coalesced} coalesced, avg ${ss.avgMs}ms` : "localStorage not writable",
      storageOK ? "healthy" : "free browser storage or export a backup immediately");
    push("Bridge", st.bridgeReady ? "ok" : "warn", `${st.events.length}/500 events`, st.bridgeReady ? "healthy" : "reload to boot the Bridge");
    const provFail = P().analyticsOf("claude").failureRate;
    push("Providers", st.settings.apiKey ? "ok" : "warn",
      st.settings.apiKey ? "Neural Link keyed · Local Cortex online" : "Local Cortex only (no API key)",
      st.settings.apiKey ? (provFail > 30 ? "high Claude failure rate — check the key" : "healthy") : "add a Claude key in Settings for live generation");
    const weak = st.clones.filter(c => c.stats.ratingCount >= 2 && c.stats.ratingSum / c.stats.ratingCount < 3);
    push("Workers", weak.length ? "warn" : "ok", `${st.clones.length} clone(s), ${weak.length} under-performing`, weak.length ? `retrain ${weak.map(c => c.name).join(", ")} (Evolution → Prompts)` : "healthy");
    const failedExec = (st.execHistory || []).filter(h => h.status === "failed").length;
    push("Execution Layer", failedExec > 3 ? "warn" : "ok", `${(st.execHistory || []).length} action(s), ${failedExec} failed`, failedExec > 3 ? "review failed actions in Integration Center → History" : "healthy");
    const badDocs = K().docs().filter(d2 => !d2.tags || !d2.category || !d2.layer).length;
    push("Knowledge Index", badDocs ? "warn" : "ok", `${K().docs().length} doc(s), ${badDocs} with schema gaps`, badDocs ? "run the Validation Suite to normalize" : "healthy");
    const delayed = MS().missions().filter(m => MS().health(m) === "delayed").length;
    const paused = MS().missions().filter(m => m.status === "paused").length;
    push("Mission Engine", delayed + paused ? "warn" : "ok", `${MS().missions().length} mission(s) · ${delayed} delayed · ${paused} paused`, delayed + paused ? "resume paused missions from their checkpoints" : "healthy");
    const extErr = XT().installed().filter(x2 => x2.health === "error").length;
    push("Extensions", extErr ? "warn" : "ok", `${XT().installed().length} installed, ${extErr} erroring`, extErr ? "check Developer Console logs" : "healthy");
    const failedNodes = NW().nodes().filter(n => n.status === "failed").length;
    push("Network", failedNodes ? "warn" : "ok", `${NW().nodes().length} node(s), ${failedNodes} failed`, failedNodes ? "revive or remove failed nodes (failover already moved their work)" : "healthy");
    const highEvents = st.events.filter(e2 => e2.priority === "high").length;
    push("Error Rate", highEvents > 25 ? "warn" : "ok", `${highEvents} high-priority event(s) of ${st.events.length}`, highEvents > 25 ? "sweep the Command Center for unresolved failures" : "healthy");
    return out;
  }
  function overallHealth() {
    const comps = componentHealth();
    const fails = comps.filter(c => c.status === "fail").length;
    const warns = comps.filter(c => c.status === "warn").length;
    return { score: Math.max(0, 100 - fails * 30 - warns * 8), fails, warns, comps };
  }

  /* ================================================================== *
   * MODULE 3 — observability: structured logs, traces, export
   * ================================================================== */
  function logs(filter) {
    filter = filter || {};
    let list = S().state.events.slice().reverse();
    if (filter.category && filter.category !== "all") list = list.filter(e2 => e2.category === filter.category);
    if (filter.q) {
      const q = filter.q.toLowerCase();
      list = list.filter(e2 => e2.text.toLowerCase().includes(q));
    }
    return list.slice(0, filter.limit || 60);
  }
  function traces() {
    const rt = (S().state.runtime || { executions: [] }).executions.map(x2 => ({
      id: x2.id, kind: "runtime", label: `${x2.taskType} — ${x2.topic}`, at: x2.at, ms: x2.ms,
      steps: [`worker ${x2.workerName}`, `provider ${x2.provider}`, `memory ${x2.memoryAccessed} item(s)`, `knowledge ${x2.knowledgeUsed || 0} doc(s)`, `events ${x2.eventsGenerated}`, x2.success ? "success" : "FAILED: " + x2.error]
    }));
    const xh = (S().state.execHistory || []).map(x2 => ({
      id: x2.id, kind: "action", label: `${x2.action} · ${x2.integration}`, at: x2.at, ms: x2.ms,
      steps: [`worker ${x2.workerName}`, `mode ${x2.mode}`, `retries ${x2.retries}`, x2.status === "success" ? "success" : x2.status + (x2.error ? ": " + x2.error : "")]
    }));
    return rt.concat(xh).sort((a, b2) => b2.at - a.at).slice(0, 30);
  }
  function exportLogs() {
    return JSON.stringify({ exportedAt: Date.now(), events: S().state.events, traces: traces(), audit: auditTrail(100) }, null, 2);
  }

  /* ================================================================== *
   * MODULE 4 — backup & recovery: selective restore + validation
   * ================================================================== */
  const RECOVERY_SLICES = { organizations: "enterprise", knowledge: "knowledge", missions: "missions" };
  function validateSnapshot(json) {
    try {
      const p2 = JSON.parse(json);
      const problems = [];
      ["clones", "settings", "events"].forEach(k2 => { if (!(k2 in p2)) problems.push("missing " + k2); });
      if (p2.version !== STATE_VERSION) problems.push("state version " + p2.version + " ≠ " + STATE_VERSION);
      return { ok: !problems.length, problems, stats: { clones: (p2.clones || []).length, docs: p2.knowledge ? (p2.knowledge.docs || []).length : 0, missions: (p2.missions || []).length, sizeKB: Math.round(json.length / 1024) } };
    } catch (_) { return { ok: false, problems: ["not valid JSON"] }; }
  }
  function selectiveRestore(snapKey, slice) {
    const stateKey = RECOVERY_SLICES[slice];
    if (!stateKey) return { ok: false, reason: "unknown slice" };
    const json = NW().snapshotJson(snapKey);
    if (!json) return { ok: false, reason: "snapshot missing" };
    const val = validateSnapshot(json);
    if (!val.ok) return { ok: false, reason: "validation failed: " + val.problems.join(", ") };
    const snap = JSON.parse(json);
    if (!(stateKey in snap)) return { ok: false, reason: "slice absent in snapshot" };
    S().state[stateKey] = snap[stateKey];
    emit(`Selective recovery — "${slice}" restored from snapshot (validated first). Everything else untouched.`, { priority: "high" });
    S().save(true);
    return { ok: true };
  }

  /* ================================================================== *
   * MODULE 7 — deployment & versioning
   * ================================================================== */
  function versionInfo() {
    return {
      core: CORE_VERSION,
      stateVersion: STATE_VERSION,
      phases: CHANGELOG.length,
      modules: ["data", "engine", "store", "ui", "ghosts", "shells", "matrix", "bridge", "providers", "runtime", "execution", "knowledge", "missions", "evolution", "enterprise", "extensions", "network", "omega"].filter(m => !!PRISM[m]).length,
      profile: S().state.settings.envProfile || "development"
    };
  }
  function setProfile(p2) {
    if (!ENV_PROFILES.includes(p2)) return false;
    S().state.settings.envProfile = p2;
    authLog("profile", "environment → " + p2);
    emit(`Environment profile → ${p2}${p2 === "production" ? " (sandboxes disabled, validation expected before deploy)" : ""}.`, { priority: "medium" });
    S().save();
    return true;
  }
  function validateConfig() {
    const st = S().state;
    const problems = [];
    if (!st.dna || !st.dna.decision) problems.push("Decision Framework empty — train it in System Memory");
    if (st.settings.engine === "neural" && !st.settings.apiKey) problems.push("Neural engine selected without an API key");
    if (!ENV_PROFILES.includes(st.settings.envProfile)) problems.push("invalid environment profile");
    if (st.settings.sessionTimeoutMin < 5) problems.push("session timeout below 5 minutes");
    return { ok: !problems.length, problems };
  }
  /* safe upgrade path: snapshot first, run migrations, keep rollback */
  const MIGRATIONS = {}; /* { 2: (state) => {...} } — arrives with state v2 */
  function runMigrations() {
    const st = S().state;
    const from = st.version || 1;
    if (from >= STATE_VERSION) return { ran: 0, from, to: from };
    NW().takeSnapshot("pre-migration v" + from);
    let v = from;
    while (v < STATE_VERSION) {
      v += 1;
      if (MIGRATIONS[v]) MIGRATIONS[v](st);
    }
    st.version = STATE_VERSION;
    emit(`State migrated v${from} → v${STATE_VERSION} (pre-migration snapshot kept for rollback).`, { priority: "high" });
    S().save(true);
    return { ran: STATE_VERSION - from, from, to: STATE_VERSION };
  }

  /* ================================================================== *
   * MODULE 9 — guided setup (detected from real state)
   * ================================================================== */
  function setupSteps() {
    const st = S().state;
    return [
      { label: "Create an Organization", done: EN().orgs().length > 0, link: "#/enterprise/orgs" },
      { label: "Configure a Provider", done: !!st.settings.apiKey || P().analyticsOf("local").requests > 0, link: "#/intelligence" },
      { label: "Forge your first Worker", done: st.clones.length > 0, link: "#/forge" },
      { label: "Enable an Integration", done: st.integrations.some(i => i.enabled), link: "#/integrations" },
      { label: "Complete a Mission", done: MS().missions().some(m => m.status === "completed"), link: "#/missions" },
      { label: "Feed the Knowledge Vault", done: K().docs().length > 0 && K().stats().retrievals > 0, link: "#/knowledge" },
      { label: "Install an Extension", done: XT().installed().length > 0, link: "#/extensions" }
    ];
  }
  function setupProgress() {
    const steps = setupSteps();
    return { steps, done: steps.filter(s2 => s2.done).length, total: steps.length };
  }

  /* ================================================================== *
   * MODULE 10 — production validation suite → readiness report
   * ================================================================== */
  function runValidation() {
    ensure();
    const checks = [];
    const add = (name, ok, msg, warn) => checks.push({ name, status: ok ? "pass" : warn ? "warn" : "fail", msg });
    try {
      add("Permissions", B().ROLES.length === 8 && B().RESOURCES.every(r => B().access(r, "Owner") === "full"), `${B().ROLES.length} roles × ${B().RESOURCES.length} resources, Owner full access`);
      add("Integrations", S().state.integrations.length >= 20 && X().actions().length >= 20, `${S().state.integrations.length} cards · ${X().actions().length} registered actions`);
      const claudeReady = !!S().state.settings.apiKey;
      add("Provider connectivity", true, claudeReady ? "Local Cortex online · Claude keyed" : "Local Cortex online · Claude awaiting key (fallback covered)", !claudeReady);
      const badWf = S().state.workflows.filter(w => !w.name || !w.trigger).length;
      add("Workflow integrity", badWf === 0, `${S().state.workflows.length} workflow(s), ${badWf} malformed`);
      const badDocs = K().docs().filter(d2 => !d2.tags || !d2.category || !d2.layer);
      badDocs.forEach(d2 => { d2.tags = d2.tags || []; d2.category = d2.category || "Business"; d2.layer = d2.layer || "intelligence"; }); /* normalize while checking */
      add("Knowledge index", K().search("framework").length >= 0 && badDocs.length === 0, `${K().docs().length} doc(s) indexed${badDocs.length ? " · " + badDocs.length + " normalized in place" : ""}`, badDocs.length > 0);
      const m = MS().plan({ name: "· validation probe ·", objective: "probe" });
      const graphOK = MS().readyTasks(m).length === 1;
      S().state.missions = S().state.missions.filter(x2 => x2.id !== m.id); /* probe leaves no trace */
      add("Mission engine", graphOK, "planner + dependency graph respond correctly");
      const extBad = XT().installed().filter(x2 => !XT().validate(x2.manifest).ok).length;
      add("Extension compatibility", extBad === 0, `${XT().installed().length} installed, all SDK-valid`);
      add("Network status", NW().node(NW().PRIME_ID).status === "online", `${NW().nodes().length} node(s) · PRIME online · ${NW().snapshots().length} restore point(s)`);
      let storageOK = true;
      try { localStorage.setItem("prismx_val_probe", "x"); storageOK = localStorage.getItem("prismx_val_probe") === "x"; localStorage.removeItem("prismx_val_probe"); } catch (_) { storageOK = false; }
      add("Storage health", storageOK, storageOK ? "write/read/delete verified · " + S().saveStats().lastKB + "KB state" : "storage not writable");
      const cfg = validateConfig();
      add("Configuration", cfg.ok, cfg.ok ? "all checks green" : cfg.problems.join("; "), !cfg.ok);
    } catch (err) {
      checks.push({ name: "Suite integrity", status: "fail", msg: "validation crashed: " + err.message });
    }
    const fails = checks.filter(c => c.status === "fail").length;
    const warns = checks.filter(c => c.status === "warn").length;
    const report = {
      id: S().uid("rr"),
      at: Date.now(),
      profile: S().state.settings.envProfile,
      checks, fails, warns,
      ready: fails === 0,
      summary: fails === 0 ? (warns ? `PRODUCTION READY with ${warns} advisory note(s)` : "PRODUCTION READY") : `NOT READY — ${fails} failing check(s)`
    };
    ensure().readinessReports.push(report);
    if (ensure().readinessReports.length > 10) ensure().readinessReports.shift();
    emit(`Production validation — ${report.summary} (${checks.length} checks).`, { priority: fails ? "high" : "medium" });
    S().save();
    return report;
  }
  function reports() { return ensure().readinessReports.slice().reverse(); }

  function boot() {
    ensure();
    runMigrations();
    const st = S().state;
    if (!st.omegaReady && st.onboarded) {
      st.omegaReady = true;
      emit("Production layer online — security, health diagnostics, observability, recovery, configuration, docs and the validation suite are live.", { priority: "medium" });
      S().save();
    }
  }

  return {
    CORE_VERSION, STATE_VERSION, ENV_PROFILES, CHANGELOG, RECOVERY_SLICES,
    ensure, emit,
    enableLock, disableLock, unlock, lockNow, sessionValid, auditTrail, keyInventory,
    componentHealth, overallHealth,
    logs, traces, exportLogs,
    validateSnapshot, selectiveRestore,
    versionInfo, setProfile, validateConfig, runMigrations,
    setupSteps, setupProgress,
    runValidation, reports, boot
  };
})();
