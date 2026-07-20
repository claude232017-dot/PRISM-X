/* PRISM-X — missions.js
 * PHASE EPSILON — AUTONOMOUS ORCHESTRATION.
 *
 * Mission Control: a high-level objective becomes a dependency graph of
 * tasks executed by collaborating Workers under GOD CORE supervision.
 *
 *   Mission → Planner → Task Graph → Workers (chained context) →
 *   Execution → Mission Memory → Knowledge → Reusable Template
 *
 * Real generation through the Phase H0 funnel; real knowledge retrieval;
 * real Execution-Layer actions where wired (publish → Broadcast Queue).
 * Failure recovery: retry → reassign → escalate → pause → resume from
 * checkpoint — completed tasks are never redone.
 */
window.PRISM = window.PRISM || {};

PRISM.missions = (function () {
  "use strict";
  const S = () => PRISM.store;
  const E = () => PRISM.engine;
  const B = () => PRISM.bridge;
  const P = () => PRISM.providers;
  const K = () => PRISM.knowledge;
  const X = () => PRISM.execution;
  const D = () => PRISM.data;

  /* ================================================================== *
   * MODULE 7 — mission templates (blueprints; DAG via `needs`)
   * ================================================================== */
  const TEMPLATES = [
    {
      id: "product-launch", icon: "🚀", name: "Product Launch",
      objective: "Launch a digital product end-to-end",
      steps: [
        { key: "research", label: "Research Market", taskType: "Market Narrative Scan", needs: [] },
        { key: "product", label: "Generate Product Offer", taskType: "Build Offer", needs: ["research"] },
        { key: "sales", label: "Write Sales Page", taskType: "Landing Page Copy", needs: ["product"] },
        { key: "social", label: "Generate Social Content", taskType: "Write Thread", needs: ["product"] },
        { key: "email", label: "Prepare Email Campaign", taskType: "Email Copy", needs: ["sales"] },
        { key: "publish", label: "Publish Product", taskType: "Write Tweet", needs: ["sales", "social"], action: "queue.publish" },
        { key: "track", label: "Track Results", taskType: "Weekly Briefing", needs: ["publish"] }
      ]
    },
    {
      id: "cold-outreach", icon: "❄", name: "Cold Outreach Campaign",
      objective: "Build and arm a cold outreach campaign",
      steps: [
        { key: "offer", label: "Define the Offer", taskType: "Build Offer", needs: [] },
        { key: "magnet", label: "Build Prospect Angle", taskType: "Lead Magnet Idea", needs: ["offer"] },
        { key: "open", label: "Opening DM Script", taskType: "Opening DM", needs: ["magnet"] },
        { key: "follow", label: "Follow-Up Sequence", taskType: "DM Follow-Up", needs: ["open"] },
        { key: "objections", label: "Objection Prep", taskType: "Objection Handler", needs: ["open"] }
      ]
    },
    {
      id: "client-onboarding", icon: "🤝", name: "Client Onboarding",
      objective: "Onboard a new client cleanly",
      steps: [
        { key: "package", label: "Confirm Package & Pricing", taskType: "Price & Package", needs: [] },
        { key: "welcome", label: "Welcome Email", taskType: "Email Copy", needs: ["package"] },
        { key: "kickoff", label: "Kickoff Brief", taskType: "Weekly Briefing", needs: ["welcome"] },
        { key: "upsell", label: "Design the Upsell Path", taskType: "Design Upsell", needs: ["kickoff"] }
      ]
    },
    {
      id: "weekly-content", icon: "📅", name: "Weekly Content Engine",
      objective: "Produce a coordinated week of content",
      steps: [
        { key: "thesis", label: "Content Thesis", taskType: "Weekly Briefing", needs: [] },
        { key: "thread", label: "Anchor Thread", taskType: "Write Thread", needs: ["thesis"] },
        { key: "tweets", label: "Daily Tweets", taskType: "Write Tweet", needs: ["thesis"] },
        { key: "captions", label: "Captions", taskType: "Write Caption", needs: ["thesis"] },
        { key: "cta", label: "CTA & Objection Pass", taskType: "Objection Handler", needs: ["thread", "tweets"] }
      ]
    },
    {
      id: "competitor-analysis", icon: "🔍", name: "Competitor Analysis",
      objective: "Research a competitor and build the counter-position",
      steps: [
        { key: "scan", label: "Market Scan", taskType: "Market Narrative Scan", needs: [] },
        { key: "position", label: "Positioning Plan", taskType: "Position Plan", needs: ["scan"] },
        { key: "counter", label: "Counter Offer", taskType: "Build Offer", needs: ["position"] },
        { key: "attack", label: "Attack Content", taskType: "Write Thread", needs: ["counter"] }
      ]
    }
  ];
  /* custom missions decompose into a generic pipeline */
  const GENERIC_STEPS = [
    { key: "research", label: "Research", taskType: "Market Narrative Scan", needs: [] },
    { key: "asset", label: "Draft the Core Asset", taskType: "Build Offer", needs: ["research"] },
    { key: "copy", label: "Write the Copy", taskType: "Landing Page Copy", needs: ["asset"] },
    { key: "distribute", label: "Distribution Content", taskType: "Write Thread", needs: ["copy"] },
    { key: "review", label: "Review & Next Steps", taskType: "Weekly Briefing", needs: ["distribute"] }
  ];

  function ensure() {
    const st = S().state;
    st.missions = st.missions || [];
    st.missionTemplatesCustom = st.missionTemplatesCustom || [];
    return st.missions;
  }
  function templates() { ensure(); return TEMPLATES.concat(S().state.missionTemplatesCustom); }
  function template(id) { return templates().find(t => t.id === id) || null; }
  function missions() { return ensure(); }
  function mission(id) { return missions().find(m => m.id === id) || null; }
  function emit(text, meta) { B().emit("mission", "🎯 " + text, meta || {}); }

  /* ================================================================== *
   * MODULE 2 — the Mission Planner (objective → execution graph)
   * ================================================================== */
  function plan(input) {
    ensure();
    const st = S().state;
    const tpl = input.templateId ? template(input.templateId) : null;
    const steps = tpl ? tpl.steps : GENERIC_STEPS;
    const objective = (input.objective || (tpl ? tpl.objective : "") || "Advance the PRISM-X empire").trim();
    const kn = K() ? K().search(objective, { limit: 3 }).map(h => h.doc.title) : [];
    const m = {
      id: S().uid("ms"),
      name: (input.name || (tpl ? tpl.name : "Custom Mission")).trim().slice(0, 80),
      icon: tpl ? tpl.icon : "🎯",
      objective,
      priority: ["high", "normal", "low"].includes(input.priority) ? input.priority : "normal",
      deadline: input.deadline || (Date.now() + 7 * 86400000),
      status: "active",
      templateId: tpl ? tpl.id : null,
      createdAt: Date.now(), startedAt: null, completedAt: null,
      clientId: input.clientId || null,
      requiredKnowledge: kn,
      requiredIntegrations: steps.filter(s2 => s2.action).map(s2 => (X() && X().action(s2.action) ? X().action(s2.action).integrationName : s2.action)),
      decisions: [`Planned from ${tpl ? 'template "' + tpl.name + '"' : "a custom objective (generic pipeline)"} — ${steps.length} tasks, graph built before execution.`],
      lessons: [], timeTakenMs: 0, costEst: 0, successScore: null,
      tasks: steps.map(s2 => ({
        id: S().uid("mt"),
        key: s2.key, label: s2.label, taskType: s2.taskType,
        needs: s2.needs.slice(), action: s2.action || null,
        status: s2.needs.length ? "blocked" : "ready",
        assignedWorkerId: null, assignedWorkerName: null, assignmentReason: null,
        attempts: 0, provider: null, ms: 0, output: "", note: null,
        startedAt: null, finishedAt: null, contextFrom: []
      })),
      _forceFail: 0 /* test hook counter — labeled, verify-only */
    };
    st.missions.push(m);
    if (st.missions.length > 20) st.missions.shift();
    emit(`Mission planned — "${m.name}": ${m.tasks.length} tasks in a dependency graph. Objective: ${m.objective.slice(0, 80)}.`, { priority: "medium" });
    S().save();
    return m;
  }

  /* ================================================================== *
   * MODULE 4 — dependency graph helpers
   * ================================================================== */
  function refreshGraph(m) {
    m.tasks.forEach(t => {
      if (t.status === "blocked" || t.status === "ready") {
        const deps = t.needs.map(k2 => m.tasks.find(x => x.key === k2)).filter(Boolean);
        t.status = deps.every(d2 => d2.status === "done") ? "ready" : "blocked";
      }
    });
  }
  function readyTasks(m) { refreshGraph(m); return m.tasks.filter(t => t.status === "ready"); }
  function depthOf(m, t, seen) {
    seen = seen || new Set();
    if (!t.needs.length || seen.has(t.key)) return 0;
    seen.add(t.key);
    return 1 + Math.max(...t.needs.map(k2 => {
      const p2 = m.tasks.find(x => x.key === k2);
      return p2 ? depthOf(m, p2, seen) : 0;
    }));
  }

  /* ================================================================== *
   * MODULE 5 — dynamic assignment (skills · performance · availability
   * · provider fit) with manual override
   * ================================================================== */
  function busy(workerId) {
    return missions().some(m2 => (m2.tasks || []).some(t => t.status === "running" && t.assignedWorkerId === workerId));
  }
  function scoreWorker(c, task) {
    const role = D().ROLES[c.role] || { taskTypes: [] };
    let s2 = 0;
    const why = [];
    if (role.taskTypes.includes(task.taskType)) { s2 += 3; why.push(`role match (${c.role})`); }
    const avg = c.stats.ratingCount ? c.stats.ratingSum / c.stats.ratingCount : 0;
    if (avg) { s2 += avg / 2.5; why.push(`avg rating ${avg.toFixed(1)}`); }
    if (!busy(c.id)) { s2 += 1; why.push("available"); } else why.push("busy");
    s2 += Math.min(1, (c.stats.earnings || 0) / 1000);
    const sel = P().resolve(c.provider || "auto", "Copywriting / content");
    if (!sel.switched) s2 += 0.5;
    return { score: s2, why: why.join(", ") };
  }
  function assign(m, task, workerId) {
    const st = S().state;
    let c, reason;
    if (workerId) {
      c = st.clones.find(x => x.id === workerId);
      reason = "manual override by GOD CORE";
    } else {
      const scored = st.clones
        .map(c2 => ({ c: c2, r: scoreWorker(c2, task) }))
        .sort((a2, b2) => b2.r.score - a2.r.score);
      if (!scored.length) return null;
      /* on reassignment, skip the worker that just failed */
      const pick2 = scored.find(x => x.c.id !== task.assignedWorkerId) || scored[0];
      c = pick2.c;
      reason = pick2.r.why;
    }
    if (!c) return null;
    task.assignedWorkerId = c.id;
    task.assignedWorkerName = c.name;
    task.assignmentReason = reason;
    /* Phase Iota: record which network node carries this task */
    if (!task.nodeId && window.PRISM && PRISM.network) {
      const nd = PRISM.network.nodeOf(c.id);
      task.nodeId = nd.id;
      task.nodeName = nd.name;
    }
    emit(`Task assigned — "${task.label}" → ${c.name} (${reason}).`, { workerId: c.id });
    S().save();
    return c;
  }

  /* ================================================================== *
   * MODULES 3 + 9 — execution with collaboration chain + recovery
   * ================================================================== */
  function chainFor(m, task) {
    const chain = task.needs
      .map(k2 => m.tasks.find(x => x.key === k2))
      .filter(t => t && t.status === "done" && t.output)
      .map(t => ({ from: t.assignedWorkerName || "worker", step: t.label, excerpt: t.output.slice(0, 300) }));
    /* Phase Eta: missions carrying a CRM client hand every worker the brief */
    if (m.clientId && window.PRISM && PRISM.enterprise) {
      const brief = PRISM.enterprise.clientBrief(m.clientId);
      if (brief) chain.unshift({ from: "CRM", step: "Client brief", excerpt: brief.slice(0, 300) });
    }
    return chain;
  }

  async function runTask(missionId, taskId, onTick) {
    ensure();
    const st = S().state;
    const m = mission(missionId);
    if (!m) return { ok: false, reason: "mission not found" };
    if (m.status === "paused") return { ok: false, reason: "mission paused — resume first" };
    refreshGraph(m);
    const task = taskId ? m.tasks.find(t => t.id === taskId) : readyTasks(m)[0];
    if (!task) return { ok: false, reason: "no ready task — dependencies pending or mission done" };
    if (task.status === "blocked") return { ok: false, reason: `dependencies not satisfied (needs: ${task.needs.join(", ")})` };
    if (task.status !== "ready") return { ok: false, reason: `task is ${task.status}` };

    if (!m.startedAt) m.startedAt = Date.now();
    const c = task.assignedWorkerId ? st.clones.find(x => x.id === task.assignedWorkerId) : assign(m, task);
    if (!c) return { ok: false, reason: "no worker available to assign" };

    task.status = "running";
    task.startedAt = Date.now();
    task.attempts += 1;
    S().save();
    if (onTick) { try { onTick(m, task); } catch (_) {} }
    emit(`Execution — ${c.name} started "${task.label}" (attempt ${task.attempts}) for mission "${m.name}".`, { workerId: c.id });

    const t0 = Date.now();
    const cost0 = P().analyticsOf("claude").costEst + P().analyticsOf("local").costEst;
    try {
      if (m._forceFail > 0) { m._forceFail -= 1; S().save(); throw new Error("forced failure (recovery-policy test hook)"); }
      const chain = chainFor(m, task);
      task.contextFrom = chain.map(x => `${x.from}: ${x.step}`);
      const genTask = { type: task.taskType, topic: m.objective, outcome: task.label, chain };
      const out = await E().generate(c, genTask, st.dna, st.settings);
      task.ms = Date.now() - t0;
      task.provider = out.engine === "neural" ? "Claude" : "Local Models";
      task.output = out.text.slice(0, 3000);
      task.status = "done";
      task.finishedAt = Date.now();
      m.costEst = +(m.costEst + Math.max(0, (P().analyticsOf("claude").costEst + P().analyticsOf("local").costEst) - cost0)).toFixed(4);
      /* wired real-world step: publish through the Execution Layer */
      if (task.action && X()) {
        const res = await X().execute({ workerId: c.id, actionId: task.action, params: { text: task.output.slice(0, 400), title: `${m.name} — ${task.label}` }, mode: "live" });
        task.note = res.ok ? "→ published via the Execution Layer (real Broadcast Queue item)"
          : res.denied ? "→ publish attempt DENIED by least-privilege permissions (grant Publishing to this worker) — mission continued"
          : "→ publish attempt failed: " + (res.rec.error || "unknown");
      }
      emit(`Collaboration — "${task.label}" done by ${c.name}${task.contextFrom.length ? " building on " + task.contextFrom.length + " prior output(s)" : ""}; handing context downstream.`, { workerId: c.id });
      refreshGraph(m);
      maybeComplete(m);
      S().save();
      if (onTick) { try { onTick(m, task); } catch (_) {} }
      return { ok: true, task, recovery: null };
    } catch (err) {
      task.ms = Date.now() - t0;
      const msg = String(err.message || err).slice(0, 160);
      let recovery;
      if (task.attempts === 1) {
        task.status = "ready"; /* retry with the same worker */
        recovery = "retry";
        emit(`Recovery — "${task.label}" failed (${msg}). Retrying with ${c.name}.`, { priority: "medium", workerId: c.id });
      } else if (task.attempts === 2) {
        task.status = "ready";
        const prev = c.name;
        assign(m, task); /* skips the failed worker */
        recovery = "reassign";
        emit(`Recovery — "${task.label}" failed twice with ${prev}. Reassigned to ${task.assignedWorkerName}.`, { priority: "medium" });
      } else {
        task.status = "failed";
        m.status = "paused";
        recovery = "escalate";
        m.decisions.push(`Escalated: "${task.label}" failed ${task.attempts}x (${msg}). Mission paused at checkpoint — ${m.tasks.filter(t => t.status === "done").length} completed task(s) preserved.`);
        emit(`ESCALATION — "${task.label}" failed ${task.attempts} times. Mission "${m.name}" paused at checkpoint; GOD CORE review required.`, { priority: "high" });
        S().logMemory("system", `⚠ GOD CORE escalation: mission "${m.name}" paused — "${task.label}" failed repeatedly (${msg}).`);
      }
      S().save();
      if (onTick) { try { onTick(m, task); } catch (_) {} }
      return { ok: false, reason: msg, task, recovery };
    }
  }

  function resumeMission(missionId) {
    const m = mission(missionId);
    if (!m || m.status !== "paused") return false;
    m.status = "active";
    m._forceFail = 0;
    m.tasks.filter(t => t.status === "failed").forEach(t => { t.status = "ready"; t.attempts = 0; });
    refreshGraph(m);
    m.decisions.push(`Resumed from checkpoint — completed tasks preserved, failed task(s) reset for a clean attempt.`);
    emit(`Mission "${m.name}" resumed from checkpoint.`, { priority: "medium" });
    S().save();
    return true;
  }
  function pauseMission(missionId) {
    const m = mission(missionId);
    if (!m || m.status !== "active") return false;
    m.status = "paused";
    emit(`Mission "${m.name}" paused by GOD CORE.`);
    S().save();
    return true;
  }

  async function runMission(missionId, onTick) {
    const m = mission(missionId);
    if (!m) return { ok: false };
    let guard = 0;
    while (m.status === "active" && readyTasks(m).length && guard < 30) {
      guard += 1;
      const res = await runTask(missionId, null, onTick);
      if (!res.ok && res.recovery === "escalate") break;
      if (!res.ok && !res.recovery) break;
      await new Promise(r => setTimeout(r, 120));
    }
    return { ok: mission(missionId).status === "completed", mission: mission(missionId) };
  }

  /* ================================================================== *
   * MODULE 6 — mission memory (and the template flywheel)
   * ================================================================== */
  function maybeComplete(m) {
    if (m.tasks.every(t => t.status === "done")) {
      m.status = "completed";
      m.completedAt = Date.now();
      m.timeTakenMs = m.completedAt - (m.startedAt || m.createdAt);
      const q = Math.round(m.tasks.reduce((a2, t) => a2 + (PRISM.runtime ? PRISM.runtime.autoQuality(t.output) : 60), 0) / m.tasks.length);
      m.successScore = q;
      m.lessons.push(`${m.tasks.length} tasks by ${new Set(m.tasks.map(t => t.assignedWorkerName)).size} worker(s) in ${(m.timeTakenMs / 1000).toFixed(1)}s · avg quality ${q}/100 · est cost $${m.costEst}.`);
      if (K()) {
        K().addDoc({
          title: `Mission — ${m.name}: ${m.objective}`.slice(0, 110),
          body: `Completed ${new Date(m.completedAt).toLocaleString()}.\n${m.lessons.join("\n")}\nPipeline: ${m.tasks.map(t => t.label).join(" → ")}.\nDecisions:\n${m.decisions.join("\n")}`,
          type: "playbook", category: "auto", layer: "business",
          tags: ["mission", m.templateId || "custom"], source: "mission", owner: "GOD CORE"
        });
      }
      emit(`Mission COMPLETED — "${m.name}" · ${m.tasks.length} tasks · ${(m.timeTakenMs / 1000).toFixed(1)}s · score ${q}/100. Memory stored; reusable as a template.`, { priority: "high" });
    }
  }

  function saveAsTemplate(missionId) {
    const m = mission(missionId);
    if (!m) return null;
    const st = S().state;
    const tpl = {
      id: "custom-" + S().uid("tpl"),
      icon: "⭐", name: m.name + " (learned)",
      objective: m.objective,
      custom: true,
      steps: m.tasks.map(t => ({ key: t.key, label: t.label, taskType: t.taskType, needs: t.needs.slice(), action: t.action || undefined }))
    };
    st.missionTemplatesCustom.push(tpl);
    emit(`Template saved — completed mission "${m.name}" is now a one-click blueprint.`, { priority: "medium" });
    S().save();
    return tpl;
  }

  /* test hook — labeled; used by the verification suite to exercise M9 */
  function forceFailNext(missionId, times) {
    const m = mission(missionId);
    if (m) { m._forceFail = times || 1; S().save(); }
  }

  /* ================================================================== *
   * MODULES 8 + 10 — dashboard + analytics
   * ================================================================== */
  function progress(m) {
    const done = m.tasks.filter(t => t.status === "done").length;
    return Math.round((done / m.tasks.length) * 100);
  }
  function bottleneck(m) {
    const failed = m.tasks.find(t => t.status === "failed");
    if (failed) return failed.label + " (failed)";
    const running = m.tasks.find(t => t.status === "running");
    if (running) return running.label + " (running)";
    const ready = readyTasks(m)[0];
    return ready ? ready.label + " (awaiting run)" : null;
  }
  function estCompletion(m) {
    const doneTasks = m.tasks.filter(t => t.status === "done" && t.ms);
    const avg = doneTasks.length ? doneTasks.reduce((a2, t) => a2 + t.ms, 0) / doneTasks.length : 1500;
    const remaining = m.tasks.filter(t => t.status !== "done").length;
    return remaining * avg;
  }
  function health(m) {
    if (m.status === "completed") return "completed";
    if (m.status === "paused") return "paused";
    if (m.deadline && Date.now() > m.deadline) return "delayed";
    return (m.tasks || []).some(t => t.status === "failed") ? "at risk" : "on track";
  }
  function stats() {
    ensure();
    const ms2 = missions();
    const done = ms2.filter(m => m.status === "completed");
    const allTasks = ms2.flatMap(m => m.tasks);
    const byWorker = {};
    allTasks.filter(t => t.assignedWorkerName).forEach(t => {
      const w = byWorker[t.assignedWorkerName] = byWorker[t.assignedWorkerName] || { tasks: 0, done: 0, ms: 0 };
      w.tasks += 1;
      if (t.status === "done") { w.done += 1; w.ms += t.ms; }
    });
    const byProvider = {};
    allTasks.filter(t => t.provider).forEach(t => { byProvider[t.provider] = (byProvider[t.provider] || 0) + 1; });
    const knowledgeDocs = K() ? K().docs().filter(d2 => d2.source === "mission").length : 0;
    const automation = (S().state.execHistory || []).filter(h => /Mission|—/.test(JSON.stringify(h.params)) && h.actionId === "queue.publish").length;
    return {
      total: ms2.length,
      active: ms2.filter(m => m.status === "active").length,
      completed: done.length,
      delayed: ms2.filter(m => health(m) === "delayed").length,
      paused: ms2.filter(m => m.status === "paused").length,
      successRate: ms2.length ? Math.round((done.length / ms2.length) * 100) : null,
      avgTimeMs: done.length ? Math.round(done.reduce((a2, m) => a2 + m.timeTakenMs, 0) / done.length) : 0,
      avgScore: done.length ? Math.round(done.reduce((a2, m) => a2 + (m.successScore || 0), 0) / done.length) : null,
      totalCost: +ms2.reduce((a2, m) => a2 + (m.costEst || 0), 0).toFixed(4),
      outputs: allTasks.filter(t => t.status === "done").length,
      byWorker, byProvider, knowledgeDocs, automation
    };
  }

  return {
    TEMPLATES, GENERIC_STEPS,
    ensure, templates, template, missions, mission,
    plan, refreshGraph, readyTasks, depthOf,
    assign, scoreWorker, runTask, runMission,
    pauseMission, resumeMission, forceFailNext,
    saveAsTemplate, progress, bottleneck, estCompletion, health, stats
  };
})();
