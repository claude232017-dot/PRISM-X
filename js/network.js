/* PRISM-X — network.js
 * PHASE IOTA — DISTRIBUTED INTELLIGENCE NETWORK.
 *
 * The architecture for infinite scale: nodes, a distributed mission
 * engine, global knowledge synchronization, a network worker pool, a
 * resource scheduler, organization federation and disaster recovery.
 *
 * Honesty line: this browser IS a real node (PRIME) with real telemetry
 * (JS heap, storage, queues, provider counters). Additional nodes are
 * REGISTERED topology — provisioned records whose telemetry is a labeled
 * simulation until remote runtimes connect. The coordination logic
 * (scheduling, distribution, failover, balancing, sync conflict
 * resolution, backups) is fully real and operates on live state; remote
 * task execution is proxied locally "on behalf of" the assigned node and
 * says so. Enterprise path: swap store.js for a server adapter — every
 * Bridge/API surface stays identical.
 */
window.PRISM = window.PRISM || {};

PRISM.network = (function () {
  "use strict";
  const S = () => PRISM.store;
  const B = () => PRISM.bridge;
  const E = () => PRISM.engine;
  const K = () => PRISM.knowledge;
  const MS = () => PRISM.missions;
  const EN = () => PRISM.enterprise;
  const P = () => PRISM.providers;
  const D = () => PRISM.data;

  const PRIME_ID = "node-prime";
  const NODE_KINDS = ["cloud server", "VPS", "business workspace", "dedicated AI server", "edge device"];
  const SYNC_POLICIES = ["manual", "automatic", "read-only"];
  const SHAREABLES = ["knowledge", "workers", "extensions", "templates", "integrations", "blueprints"];
  const SNAP_PREFIX = "prismx_snapshot_";
  const SNAP_MAX = 5;

  function ensure() {
    const st = S().state;
    st.network = st.network || { nodes: [], syncLog: [], federation: {}, snapshotsMeta: [], nodeAssignments: {}, bootAt: Date.now() };
    const nw = st.network;
    ["nodes", "syncLog", "snapshotsMeta"].forEach(k2 => { nw[k2] = nw[k2] || []; });
    nw.federation = nw.federation || {};
    nw.nodeAssignments = nw.nodeAssignments || {};
    if (!nw.bootAt) nw.bootAt = Date.now();
    if (!nw.nodes.find(n => n.id === PRIME_ID)) {
      nw.nodes.unshift({
        id: PRIME_ID, name: "PRIME (this browser)", kind: "local",
        status: "online", real: true,
        version: PRISM.extensions ? PRISM.extensions.CORE_VERSION : "1.0.0",
        syncPolicy: "automatic", registeredAt: Date.now(), lastSync: Date.now()
      });
    }
    return nw;
  }
  function emit(text, meta) { B().emit("node", "🌍 " + text, meta || {}); }

  /* ================================================================== *
   * MODULE 2 — node architecture
   * ================================================================== */
  function nodes() { return ensure().nodes; }
  function node(id) { return nodes().find(n => n.id === id) || null; }
  function registerNode(input) {
    const nw = ensure();
    const n = {
      id: S().uid("node"),
      name: (input.name || "New Node").trim().slice(0, 60),
      kind: NODE_KINDS.includes(input.kind) ? input.kind : "cloud server",
      status: "provisioned", real: false,
      version: PRISM.extensions ? PRISM.extensions.CORE_VERSION : "1.0.0",
      syncPolicy: SYNC_POLICIES.includes(input.syncPolicy) ? input.syncPolicy : "manual",
      registeredAt: Date.now(), lastSync: null
    };
    nw.nodes.push(n);
    emit(`Node registered — "${n.name}" (${n.kind}). Provisioned topology: coordination is live, telemetry is a labeled simulation until its runtime connects.`, { priority: "medium" });
    S().save();
    return n;
  }
  function removeNode(id) {
    if (id === PRIME_ID) return false;
    const nw = ensure();
    const n = node(id);
    if (!n) return false;
    failover(id, true); /* move everything off before removal */
    nw.nodes = nw.nodes.filter(x => x.id !== id);
    emit(`Node removed — "${n.name}".`);
    S().save();
    return true;
  }

  /* real telemetry for PRIME; deterministic labeled sim for virtual nodes */
  function telemetry(n) {
    if (n.real) {
      const heap = (typeof performance !== "undefined" && performance.memory) ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
      let storeKB = 0;
      try { storeKB = Math.round((localStorage.getItem("prismx_state_v1") || "").length / 1024); } catch (_) {}
      return {
        real: true,
        cpu: null, memMB: heap, storageKB: storeKB,
        queue: S().dueQueue().length + (S().state.runtime ? S().state.runtime.queue.filter(t => t.state === "pending").length : 0),
        missions: MS() ? MS().stats().active : 0
      };
    }
    const r = E().rng(E().hashStr(n.id + ":" + new Date().toISOString().slice(0, 13)));
    return {
      real: false,
      cpu: n.status === "failed" ? 0 : Math.round(15 + r() * 55),
      memMB: n.status === "failed" ? 0 : Math.round(300 + r() * 900),
      storageKB: Math.round(80 + r() * 400),
      queue: n.status === "failed" ? 0 : Math.round(r() * 4),
      missions: 0
    };
  }
  function nodeHealth(n) {
    if (n.status === "failed") return "failed";
    if (n.real) return "online";
    const t = telemetry(n);
    return t.cpu > 60 ? "loaded" : "standing by";
  }
  function nodeLoad(n) {
    /* real load: tasks currently assigned to this node across active missions */
    const tasks = (MS() ? MS().missions() : []).flatMap(m => m.tasks || []).filter(t => t.nodeId === n.id && t.status !== "done");
    const t = telemetry(n);
    return tasks.length + (t.real ? 0 : Math.round((t.cpu || 0) / 40));
  }

  /* ================================================================== *
   * MODULE 5 + 6 — distributed worker pool + scheduler + balancer
   * ================================================================== */
  function nodeOf(workerId) {
    const nw = ensure();
    return node(nw.nodeAssignments[workerId]) || node(PRIME_ID);
  }
  function assignWorkerToNode(workerId, nodeId) {
    const nw = ensure();
    if (!node(nodeId)) return false;
    nw.nodeAssignments[workerId] = nodeId;
    S().save();
    return true;
  }
  function workerOrg(workerId) {
    const orgs = EN() ? EN().orgs() : [];
    const o = orgs.find(o2 => (o2.team || []).some(t => t.kind === "worker" && t.refId === workerId));
    return o || null;
  }
  function shares(orgId, what) {
    const fed = ensure().federation[orgId] || {};
    return !!fed[what];
  }
  function pool() {
    ensure();
    return S().state.clones.map(c => {
      const n = nodeOf(c.id);
      const o = workerOrg(c.id);
      return {
        id: c.id, name: c.name, role: c.role,
        node: n.name, nodeId: n.id,
        org: o ? o.name : null, orgId: o ? o.id : null,
        load: (MS() ? MS().missions() : []).flatMap(m => m.tasks || []).some(t => t.assignedWorkerId === c.id && t.status === "running") ? 1 : 0,
        rating: c.stats.ratingCount ? +(c.stats.ratingSum / c.stats.ratingCount).toFixed(1) : null
      };
    });
  }
  /* the network scheduler: skills · availability · node capacity ·
     provider access · current load · organization permissions */
  function schedule(req) {
    ensure();
    req = req || {};
    const cands = S().state.clones.map(c => {
      const o = workerOrg(c.id);
      /* MODULE 7 — federation: isolated by default */
      if (req.orgId && o && o.id !== req.orgId && !shares(o.id, "workers")) {
        return { c, blocked: `org "${o.name}" does not share workers` };
      }
      const role = D().ROLES[c.role] || { taskTypes: [] };
      const n = nodeOf(c.id);
      let score = 0;
      const why = [];
      if (req.taskType && role.taskTypes.includes(req.taskType)) { score += 3; why.push("skills (" + c.role + ")"); }
      const busyNow = (MS() ? MS().missions() : []).flatMap(m => m.tasks || []).some(t => t.assignedWorkerId === c.id && t.status === "running");
      if (!busyNow) { score += 1.5; why.push("available"); }
      const load = nodeLoad(n);
      score += Math.max(0, 1.5 - load * 0.5);
      why.push(`node ${n.name.split(" ")[0]} load ${load}`);
      const sel = P().resolve(c.provider || "auto", "Copywriting / content");
      if (!sel.switched) { score += 0.5; why.push("provider ok"); }
      const avg = c.stats.ratingCount ? c.stats.ratingSum / c.stats.ratingCount : 0;
      score += avg / 3;
      return { c, n, score, why: why.join(", ") };
    });
    const eligible = cands.filter(x => !x.blocked).sort((a, b2) => b2.score - a.score);
    return {
      pick: eligible[0] ? { workerId: eligible[0].c.id, worker: eligible[0].c.name, node: eligible[0].n.name, nodeId: eligible[0].n.id, reason: eligible[0].why } : null,
      excluded: cands.filter(x => x.blocked).map(x => ({ worker: x.c.name, reason: x.blocked }))
    };
  }
  /* MODULE 6 — balance worker placement across online nodes */
  function balance() {
    const nw = ensure();
    const online = nodes().filter(n => n.status !== "failed");
    if (online.length < 2) return { moves: 0, note: "one node — nothing to balance" };
    const ws = S().state.clones.map(c => c.id);
    const per = Math.ceil(ws.length / online.length);
    const counts = {};
    online.forEach(n => { counts[n.id] = 0; });
    ws.forEach(w => { const nid = nodeOf(w).id; counts[nid] = (counts[nid] || 0) + 1; });
    let moves = 0;
    ws.forEach(w => {
      const cur = nodeOf(w).id;
      if (counts[cur] > per) {
        const target = online.slice().sort((a, b2) => (counts[a.id] || 0) - (counts[b2.id] || 0))[0];
        if (target && target.id !== cur) {
          counts[cur] -= 1;
          counts[target.id] = (counts[target.id] || 0) + 1;
          nw.nodeAssignments[w] = target.id;
          moves += 1;
        }
      }
    });
    if (moves) emit(`Resource scheduler balanced the pool — ${moves} worker(s) redistributed across ${online.length} node(s).`, { priority: "medium" });
    S().save();
    return { moves, distribution: counts };
  }

  /* ================================================================== *
   * MODULE 3 — distributed mission engine
   * ================================================================== */
  function distributeMission(missionId) {
    ensure();
    const m = MS() ? MS().mission(missionId) : null;
    if (!m) return { ok: false };
    const online = nodes().filter(n => n.status !== "failed");
    let i = 0;
    (m.tasks || []).forEach(t => {
      if (t.status === "done") return;
      const n = online.slice().sort((a, b2) => nodeLoad(a) - nodeLoad(b2))[i % Math.max(1, Math.min(online.length, 4))] || online[0];
      t.nodeId = n.id;
      t.nodeName = n.name;
      i += 1;
    });
    const used = Array.from(new Set((m.tasks || []).filter(t => t.nodeId).map(t => t.nodeName)));
    m.decisions.push(`Distributed across ${used.length} node(s): ${used.join(" → ")}. Remote tasks execute locally on behalf of their node until remote runtimes connect.`);
    emit(`Mission "${m.name}" distributed across ${used.length} node(s): ${used.join(" → ")}.`, { priority: "medium" });
    S().save();
    return { ok: true, nodesUsed: used };
  }

  /* ================================================================== *
   * MODULE 8 — disaster recovery: snapshots, restore, failover
   * ================================================================== */
  function snapshots() { return ensure().snapshotsMeta.slice().reverse(); }
  function takeSnapshot(label) {
    const nw = ensure();
    const key = SNAP_PREFIX + Date.now().toString(36);
    const json = JSON.stringify(S().state);
    try { localStorage.setItem(key, json); } catch (e) { return { ok: false, reason: "storage full — delete old snapshots" }; }
    nw.snapshotsMeta.push({ key, at: Date.now(), label: (label || "manual").slice(0, 60), sizeKB: Math.round(json.length / 1024) });
    while (nw.snapshotsMeta.length > SNAP_MAX) {
      const old = nw.snapshotsMeta.shift();
      try { localStorage.removeItem(old.key); } catch (_) {}
    }
    emit(`Backup snapshot captured — "${label || "manual"}" (${Math.round(json.length / 1024)} KB). ${nw.snapshotsMeta.length}/${SNAP_MAX} restore points held.`);
    S().save();
    return { ok: true, key };
  }
  function snapshotJson(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function restoreSnapshot(key) {
    const json = snapshotJson(key);
    if (!json) return { ok: false, reason: "snapshot missing" };
    try { JSON.parse(json); } catch (_) { return { ok: false, reason: "snapshot corrupt" }; }
    S().suspendSaves(); /* Omega: no pending throttled write may clobber the restore */
    try { localStorage.setItem("prismx_state_v1", json); } catch (e) { return { ok: false, reason: "storage error" }; }
    emit("Restore point applied — reloading into the recovered state.", { priority: "high" });
    return { ok: true, reload: true };
  }
  function deleteSnapshot(key) {
    const nw = ensure();
    nw.snapshotsMeta = nw.snapshotsMeta.filter(s2 => s2.key !== key);
    try { localStorage.removeItem(key); } catch (_) {}
    S().save();
  }
  /* failover: a failed node's work moves to the healthiest survivor */
  function failNode(id) {
    const n = node(id);
    if (!n || n.real) return false; /* PRIME can't be failed from inside itself — honest */
    n.status = "failed";
    emit(`⚠ Node "${n.name}" marked FAILED — initiating failover.`, { priority: "high" });
    failover(id);
    S().save();
    return true;
  }
  function reviveNode(id) {
    const n = node(id);
    if (!n || n.real) return false;
    n.status = "provisioned";
    emit(`Node "${n.name}" back online (provisioned).`);
    S().save();
    return true;
  }
  function failover(fromId, silent) {
    const nw = ensure();
    const online = nodes().filter(n => n.status !== "failed" && n.id !== fromId);
    const target = online.slice().sort((a, b2) => nodeLoad(a) - nodeLoad(b2))[0] || node(PRIME_ID);
    let movedTasks = 0, movedWorkers = 0;
    (MS() ? MS().missions() : []).forEach(m => (m.tasks || []).forEach(t => {
      if (t.nodeId === fromId && t.status !== "done") { t.nodeId = target.id; t.nodeName = target.name; movedTasks += 1; }
    }));
    Object.keys(nw.nodeAssignments).forEach(w => {
      if (nw.nodeAssignments[w] === fromId) { nw.nodeAssignments[w] = target.id; movedWorkers += 1; }
    });
    if (!silent && (movedTasks || movedWorkers)) {
      emit(`Failover complete — ${movedTasks} task(s) and ${movedWorkers} worker(s) moved to "${target.name}". Missions continue.`, { priority: "high" });
    }
    S().save();
    return { movedTasks, movedWorkers, target: target.name };
  }

  /* ================================================================== *
   * MODULE 4 — global knowledge synchronization
   * ================================================================== */
  function syncLog() { return ensure().syncLog.slice().reverse(); }
  function logSync(text) {
    const nw = ensure();
    nw.syncLog.push({ at: Date.now(), text: String(text).slice(0, 180) });
    if (nw.syncLog.length > 40) nw.syncLog.shift();
  }
  function exportKnowledge() {
    const k2 = K().ensure();
    const blob = { nodeId: PRIME_ID, exportedAt: Date.now(), docs: k2.docs, links: k2.links };
    logSync(`Exported ${k2.docs.length} doc(s) + ${k2.links.length} link(s) for network sync.`);
    S().save();
    return JSON.stringify(blob);
  }
  function importKnowledge(json, policy) {
    ensure();
    policy = SYNC_POLICIES.includes(policy) ? policy : "manual";
    let blob;
    try { blob = JSON.parse(json); } catch (_) { return { ok: false, reason: "invalid sync payload" }; }
    if (!Array.isArray(blob.docs)) return { ok: false, reason: "no docs in payload" };
    if (policy === "read-only") {
      logSync(`READ-ONLY policy — inspected ${blob.docs.length} incoming doc(s), wrote nothing.`);
      S().save();
      return { ok: true, added: 0, resolved: 0, skipped: blob.docs.length, readOnly: true };
    }
    const k2 = K().ensure();
    let added = 0, resolved = 0, kept = 0;
    blob.docs.forEach(inc => {
      const local = k2.docs.find(d2 => d2.title === inc.title);
      if (!local) {
        const copy = Object.assign({
          type: "note", category: "Business", layer: "intelligence",
          tags: [], owner: "network", verified: "unverified", uses: 0,
          createdAt: Date.now(), updatedAt: Date.now(), baseConfidence: 55
        }, inc, { id: S().uid("kd"), tags: inc.tags || [], source: "sync:" + (blob.nodeId || "remote") });
        k2.docs.push(copy);
        added += 1;
      } else {
        /* conflict resolution: higher confidence wins; tie → newer updatedAt */
        const incConf = inc.baseConfidence != null ? inc.baseConfidence : 55;
        const locConf = local.baseConfidence != null ? local.baseConfidence : 55;
        const incWins = incConf > locConf || (incConf === locConf && (inc.updatedAt || 0) > (local.updatedAt || 0));
        if (incWins) {
          local.body = inc.body;
          local.baseConfidence = incConf;
          local.updatedAt = Date.now();
          resolved += 1;
          logSync(`Conflict resolved — "${String(inc.title).slice(0, 50)}": incoming version won (confidence ${incConf} vs ${locConf}).`);
        } else {
          kept += 1;
          logSync(`Conflict resolved — "${String(inc.title).slice(0, 50)}": local version kept (confidence ${locConf} vs ${incConf}).`);
        }
      }
    });
    logSync(`Sync (${policy}) — ${added} added · ${resolved} incoming won · ${kept} local kept.`);
    emit(`Knowledge synchronized — ${added} new doc(s), ${resolved + kept} conflict(s) resolved by confidence/freshness.`, { priority: "medium" });
    S().save();
    return { ok: true, added, resolved, kept };
  }

  /* ================================================================== *
   * MODULE 7 — organization federation
   * ================================================================== */
  function federation(orgId) {
    const fed = ensure().federation;
    if (!fed[orgId]) { fed[orgId] = {}; SHAREABLES.forEach(s2 => { fed[orgId][s2] = false; }); }
    return fed[orgId];
  }
  function setShare(orgId, what, on) {
    const f = federation(orgId);
    if (!SHAREABLES.includes(what)) return false;
    f[what] = !!on;
    const o = EN() ? EN().org(orgId) : null;
    emit(`Federation — ${o ? o.name : orgId} ${on ? "now shares" : "stopped sharing"} ${what} with the network.`, { priority: "medium" });
    S().save();
    return true;
  }

  /* ================================================================== *
   * MODULES 1 + 9 + 10 — control, monitoring, scalability
   * ================================================================== */
  function stats() {
    ensure();
    const st = S().state;
    const ns = nodes();
    const online = ns.filter(n => n.status !== "failed");
    const msS = MS() ? MS().stats() : {};
    const health = Math.round((online.length / ns.length) * 60 + (msS.active ? 20 : 10) + (st.clones.length ? 20 : 10));
    return {
      nodes: ns.length, online: online.length, failed: ns.length - online.length,
      orgs: EN() ? EN().orgs().filter(o => o.status === "active").length : 0,
      workers: st.clones.length,
      missionsRunning: msS.active || 0,
      health: Math.min(100, health),
      uptimeMs: Date.now() - ensure().bootAt,
      events: st.events.length,
      lastSync: ensure().syncLog.length ? ensure().syncLog[ensure().syncLog.length - 1].at : null
    };
  }
  function capacity() {
    const st = S().state;
    let storeKB = 0;
    try { storeKB = Math.round((localStorage.getItem("prismx_state_v1") || "").length / 1024); } catch (_) {}
    return [
      { name: "Events ring", used: st.events.length, cap: 500 },
      { name: "Knowledge docs", used: K() ? K().docs().length : 0, cap: 300 },
      { name: "Execution history", used: (st.execHistory || []).length, cap: 100 },
      { name: "Missions", used: (st.missions || []).length, cap: 20 },
      { name: "Ledger entries", used: st.enterprise ? st.enterprise.finance.length : 0, cap: 400 },
      { name: "Local storage (KB)", used: storeKB, cap: 5120 }
    ];
  }
  function alerts() {
    const out = [];
    nodes().filter(n => n.status === "failed").forEach(n => out.push(`Node failed — ${n.name} (failover engaged)`));
    capacity().forEach(c => { if (c.used / c.cap > 0.8) out.push(`Capacity — ${c.name} at ${Math.round((c.used / c.cap) * 100)}%`); });
    if (MS()) MS().missions().forEach(m => { if (MS().health(m) === "delayed") out.push(`Mission delayed — "${m.name}"`); });
    if (!snapshots().length) out.push("No restore points yet — take a backup snapshot");
    return out;
  }

  function boot() {
    ensure();
    const st = S().state;
    /* automatic backups: at most one every 6 hours, taken on boot */
    const last = ensure().snapshotsMeta[ensure().snapshotsMeta.length - 1];
    if (st.onboarded && (!last || Date.now() - last.at > 6 * 3600000)) takeSnapshot("auto (boot)");
    if (!st.networkReady && st.onboarded) {
      st.networkReady = true;
      emit(`Distributed Intelligence Network online — PRIME node registered, scheduler and disaster recovery armed. Register nodes to grow the topology.`, { priority: "medium" });
      S().save();
    }
  }

  return {
    PRIME_ID, NODE_KINDS, SYNC_POLICIES, SHAREABLES,
    ensure, nodes, node, registerNode, removeNode,
    telemetry, nodeHealth, nodeLoad,
    nodeOf, assignWorkerToNode, pool, schedule, balance, workerOrg,
    distributeMission,
    snapshots, takeSnapshot, snapshotJson, restoreSnapshot, deleteSnapshot,
    failNode, reviveNode, failover,
    exportKnowledge, importKnowledge, syncLog,
    federation, setShare, shares,
    stats, capacity, alerts, boot
  };
})();
