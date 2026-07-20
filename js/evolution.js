/* PRISM-X — evolution.js
 * PHASE ZETA — EVOLUTION ENGINE.
 *
 * The system measures itself, identifies weaknesses, proposes improvements
 * and runs controlled experiments — but deploys NOTHING without owner
 * approval. Safe evolution:
 *
 *   suggested → pending approval → approved → applied → monitored →
 *   accepted | rolled back
 *
 * Applies are real where they can be (archive knowledge, switch tone,
 * merge workflows) and honestly marked "manual" where a human must act
 * (create a worker, connect an API key). Every change lands on the
 * Evolution Timeline.
 */
window.PRISM = window.PRISM || {};

PRISM.evolution = (function () {
  "use strict";
  const S = () => PRISM.store;
  const E = () => PRISM.engine;
  const B = () => PRISM.bridge;
  const P = () => PRISM.providers;
  const K = () => PRISM.knowledge;
  const X = () => PRISM.execution;
  const MS = () => PRISM.missions;
  const RT = () => PRISM.runtime;
  const D = () => PRISM.data;

  function ensure() {
    const st = S().state;
    st.evolution = st.evolution || { suggestions: [], experiments: [], timeline: [], scoreHistory: { system: [], workers: {} }, lastAnalyzeAt: null };
    st.evolution.scoreHistory = st.evolution.scoreHistory || { system: [], workers: {} };
    return st.evolution;
  }
  function emit(text, meta) { B().emit("evolve", "🧬 " + text, meta || {}); }
  function timeline(kind, text) {
    const ev = ensure();
    ev.timeline.push({ id: S().uid("tl"), at: Date.now(), kind, text });
    if (ev.timeline.length > 150) ev.timeline.shift();
  }

  /* ================================================================== *
   * MODULE 7 — intelligence scorecards (with history for trends)
   * ================================================================== */
  function workerExecs(c) {
    const rt = S().state.runtime || { executions: [] };
    const mt = (S().state.missions || []).flatMap(m => m.tasks).filter(t => t.assignedWorkerId === c.id);
    return { rt: rt.executions.filter(x => x.workerId === c.id), mt };
  }
  function scorecard(c) {
    const { rt, mt } = workerExecs(c);
    const avgRating = c.stats.ratingCount ? c.stats.ratingSum / c.stats.ratingCount : 0;
    const accuracy = avgRating ? Math.round(avgRating / 5 * 100) : 60;
    const allMs = rt.map(x => x.ms).concat(mt.filter(t => t.ms).map(t => t.ms));
    const avgMs = allMs.length ? allMs.reduce((a, b2) => a + b2, 0) / allMs.length : 0;
    const speed = !allMs.length ? 70 : avgMs < 3000 ? 92 : avgMs < 8000 ? 78 : 60;
    const attempts = rt.length + mt.reduce((a, t) => a + Math.max(1, t.attempts || 1), 0);
    const ok = rt.filter(x => x.success).length + mt.filter(t => t.status === "done").length;
    const reliability = attempts ? Math.round((ok / attempts) * 100) : 70;
    const cost = rt.reduce((a, x) => a + (x.costEst || 0), 0);
    const costEff = cost < 0.01 ? 95 : cost < 0.2 ? 80 : 65;
    const kUsed = rt.filter(x => (x.knowledgeUsed || 0) > 0).length;
    const knowledgeUsage = rt.length ? Math.min(95, 50 + Math.round((kUsed / rt.length) * 45)) : 50;
    const collabN = mt.filter(t => (t.contextFrom || []).length > 0 && t.status === "done").length;
    const collaboration = Math.min(95, 50 + collabN * 15);
    const missionRate = mt.length ? Math.round((mt.filter(t => t.status === "done").length / mt.length) * 100) : null;
    const parts = [accuracy, speed, reliability, costEff, knowledgeUsage, collaboration].concat(missionRate == null ? [] : [missionRate]);
    const composite = Math.round(parts.reduce((a, b2) => a + b2, 0) / parts.length);
    return { id: c.id, name: c.name, role: c.role, accuracy, speed, reliability, costEff, knowledgeUsage, collaboration, missionRate, composite, avgMs: Math.round(avgMs), tasks: rt.length + mt.length };
  }
  function systemScore() {
    const st = S().state;
    const cards = st.clones.map(scorecard);
    const workerAvg = cards.length ? cards.reduce((a, c2) => a + c2.composite, 0) / cards.length : 60;
    const msStats = MS() ? MS().stats() : { successRate: null };
    const wfs = st.workflows || [];
    const wfRate = wfs.length ? wfs.reduce((a, w) => a + (w.runs ? w.successes / w.runs : 0.7), 0) / wfs.length * 100 : 70;
    const kAvg = K() ? K().stats().avgConfidence : 60;
    const provOk = P() ? (P().analyticsOf("local").successRate || 90) : 80;
    const score = Math.round(workerAvg * 0.4 + (msStats.successRate == null ? 70 : msStats.successRate) * 0.2 + wfRate * 0.15 + kAvg * 0.15 + provOk * 0.1);
    return Math.min(100, score);
  }
  function snapshotScores() {
    const ev = ensure();
    const now = Date.now();
    const sys = ev.scoreHistory.system;
    if (!sys.length || now - sys[sys.length - 1].at > 30000) {
      sys.push({ at: now, score: systemScore() });
      if (sys.length > 60) sys.shift();
      S().state.clones.forEach(c => {
        const h = ev.scoreHistory.workers[c.id] = ev.scoreHistory.workers[c.id] || [];
        h.push({ at: now, score: scorecard(c).composite });
        if (h.length > 60) h.shift();
      });
    }
  }

  /* ================================================================== *
   * MODULES 2 + 6 — performance analyzer + workflow optimization
   * ================================================================== */
  function analyze() {
    ensure();
    const st = S().state;
    const insights = [];
    st.clones.forEach(c => {
      const sc = scorecard(c);
      insights.push({ target: c.name, kind: "worker", text: `${sc.composite}/100 composite · accuracy ${sc.accuracy}% · ${sc.tasks} task(s)${sc.avgMs ? " · avg " + (sc.avgMs / 1000).toFixed(1) + "s" : ""}`, metric: sc.composite });
    });
    if (MS()) {
      const s2 = MS().stats();
      if (s2.total) insights.push({ target: "Missions", kind: "mission", text: `${s2.completed}/${s2.total} completed · ${s2.successRate}% success · avg ${(s2.avgTimeMs / 1000).toFixed(1)}s · $${s2.totalCost} est`, metric: s2.successRate || 0 });
    }
    (st.workflows || []).forEach(w => {
      if (w.runs) insights.push({ target: w.name, kind: "workflow", text: `${w.runs} run(s) · ${Math.round((w.successes / w.runs) * 100)}% success`, metric: Math.round((w.successes / w.runs) * 100) });
    });
    if (P()) ["claude", "local"].forEach(pid => {
      const a = P().analyticsOf(pid);
      if (a.requests) insights.push({ target: a.name, kind: "provider", text: `${a.requests} request(s) · ${a.successRate}% success · ${a.avgMs < 50 ? "instant" : (a.avgMs / 1000).toFixed(1) + "s"} · $${a.costEst}`, metric: a.successRate || 0 });
    });
    const hist = st.execHistory || [];
    const byInt = {};
    hist.forEach(h => { const b2 = byInt[h.integration] = byInt[h.integration] || { n: 0, ok: 0 }; b2.n += 1; if (h.status === "success") b2.ok += 1; });
    Object.entries(byInt).forEach(([n2, v]) => insights.push({ target: n2, kind: "integration", text: `${v.n} action(s) · ${Math.round((v.ok / v.n) * 100)}% reliability`, metric: Math.round((v.ok / v.n) * 100) }));
    if (K()) {
      const ks = K().stats();
      insights.push({ target: "Knowledge Vault", kind: "knowledge", text: `${ks.items} doc(s) · ${ks.retrievals} retrieval(s) · avg confidence ${ks.avgConfidence} · ${ks.verifiedPct}% verified`, metric: ks.avgConfidence });
    }
    /* MODULE 6 — workflow/mission optimization findings */
    const bottlenecks = [];
    (st.missions || []).forEach(m => {
      const slow = m.tasks.filter(t => t.ms).sort((a, b2) => b2.ms - a.ms)[0];
      if (slow && slow.ms > 2500) bottlenecks.push({ mission: m.name, task: slow.label, ms: slow.ms });
      for (let i = 1; i < m.tasks.length; i++) {
        if (m.tasks[i].taskType === m.tasks[i - 1].taskType) bottlenecks.push({ mission: m.name, task: m.tasks[i].label, dup: true });
      }
    });
    const idle = st.clones.filter(c => !c.lastTaskAt || Date.now() - c.lastTaskAt > 7 * 86400000).map(c => c.name);
    ensure().lastAnalyzeAt = Date.now();
    snapshotScores();
    S().save();
    return { insights, bottlenecks, idle };
  }

  /* ================================================================== *
   * MODULES 3 + 9 — suggestions + safe evolution state machine
   * ================================================================== */
  const FLOW = ["pending", "approved", "applied", "monitored", "accepted"];
  function suggestions() { return ensure().suggestions; }
  function suggestion(id) { return suggestions().find(s2 => s2.id === id) || null; }

  function addSuggestion(input) {
    const ev = ensure();
    if (ev.suggestions.some(s2 => s2.dedupe && s2.dedupe === input.dedupe && !["rejected", "rolled_back"].includes(s2.state))) return null;
    const s2 = {
      id: S().uid("sg"),
      kind: input.kind, auto: !!input.auto,
      title: input.title, detail: input.detail,
      impact: input.impact || 5,
      payload: input.payload || {},
      dedupe: input.dedupe || null,
      state: "pending", at: Date.now(), decidedAt: null
    };
    ev.suggestions.push(s2);
    if (ev.suggestions.length > 40) ev.suggestions.shift();
    return s2;
  }

  function generateSuggestions() {
    ensure();
    const st = S().state;
    const added = [];
    /* stale knowledge → archive (auto-appliable, rollbackable) */
    if (K()) {
      K().docs().filter(d2 => !d2.archived && (d2.uses || 0) === 0 && Date.now() - d2.createdAt > 3 * 86400000 && d2.source !== "learning-engine").slice(0, 2).forEach(d2 => {
        const s2 = addSuggestion({
          kind: "archive-knowledge", auto: true,
          title: `Archive unused knowledge — "${d2.title.slice(0, 50)}"`,
          detail: `0 retrievals since ${new Date(d2.createdAt).toLocaleDateString()}. Archiving removes it from worker retrieval (reversible).`,
          impact: 3, payload: { docId: d2.id }, dedupe: "arch:" + d2.id
        });
        if (s2) added.push(s2);
      });
    }
    /* weak worker → optimize prompt (manual, links Prompts tab) */
    st.clones.forEach(c => {
      const avg = c.stats.ratingCount ? c.stats.ratingSum / c.stats.ratingCount : 0;
      if (c.stats.ratingCount >= 2 && avg < 3) {
        const s2 = addSuggestion({
          kind: "optimize-prompt", auto: false,
          title: `Optimize ${c.name}'s prompt (avg ${avg.toFixed(1)}/5)`,
          detail: `Ratings are below the bar. Save a prompt version, tighten the mindset rules, and compare with an experiment.`,
          impact: 8, payload: { cloneId: c.id }, dedupe: "prompt:" + c.id
        });
        if (s2) added.push(s2);
      }
    });
    /* missing role → create worker (manual) */
    const have = new Set(st.clones.map(c => c.role));
    const missing = Object.keys(D().ROLES).find(r => !have.has(r));
    if (missing) {
      const s2 = addSuggestion({
        kind: "create-worker", auto: false,
        title: `Create a new Worker — no ${missing} in the network`,
        detail: `Missions that need "${missing}" tasks are being covered by off-role clones (lower assignment scores). Forge one to lift mission fit.`,
        impact: 7, payload: { role: missing }, dedupe: "role:" + missing
      });
      if (s2) added.push(s2);
    }
    /* neural off → provider upgrade (manual) */
    if (st.settings.engine !== "neural" || !st.settings.apiKey) {
      const s2 = addSuggestion({
        kind: "connect-provider", auto: false,
        title: "Connect the Neural Link for deep-analysis tasks",
        detail: "Everything currently executes on the Local Cortex. Adding a Claude key routes Reasoning/Research categories to live models via the AI Router — measurably richer artifacts.",
        impact: 9, dedupe: "neural"
      });
      if (s2) added.push(s2);
    }
    /* duplicate-worker workflows → merge (auto, rollbackable) */
    const byWorker = {};
    (st.workflows || []).forEach(w => { if (w.workerId) (byWorker[w.workerId] = byWorker[w.workerId] || []).push(w); });
    Object.values(byWorker).filter(ws => ws.length >= 2).slice(0, 1).forEach(ws => {
      const s2 = addSuggestion({
        kind: "merge-workflows", auto: true,
        title: `Merge similar workflows — "${ws[0].name}" + "${ws[1].name}"`,
        detail: `Both target the same worker. Merging consolidates steps and halves the registry noise (reversible).`,
        impact: 5, payload: { keepId: ws[0].id, removeId: ws[1].id }, dedupe: "merge:" + ws[0].id + ":" + ws[1].id
      });
      if (s2) added.push(s2);
    });
    if (added.length) {
      emit(`Performance analysis proposed ${added.length} improvement(s) — awaiting GOD CORE approval (nothing deploys automatically).`, { priority: "medium" });
      S().save();
    }
    return added;
  }

  /* the safe-evolution state machine — owner drives every transition */
  function approve(id) { return transition(id, "pending", "approved", s2 => `Approved — "${s2.title}".`); }
  function reject(id) {
    const s2 = suggestion(id);
    if (!s2 || s2.state !== "pending") return false;
    s2.state = "rejected"; s2.decidedAt = Date.now();
    timeline("rejected", `Rejected: ${s2.title}`);
    emit(`Rejected — "${s2.title}".`);
    S().save();
    return true;
  }
  function apply(id) {
    const s2 = suggestion(id);
    if (!s2 || s2.state !== "approved") return false;
    const st = S().state;
    if (s2.auto) {
      if (s2.kind === "archive-knowledge") {
        const d2 = K().doc(s2.payload.docId);
        if (d2) d2.archived = true;
      } else if (s2.kind === "merge-workflows") {
        const idx = st.workflows.findIndex(w => w.id === s2.payload.removeId);
        if (idx >= 0) { s2.payload.removed = st.workflows[idx]; st.workflows.splice(idx, 1); }
      } else if (s2.kind === "switch-tone") {
        const c = st.clones.find(x => x.id === s2.payload.cloneId);
        if (c) { s2.payload.prevTone = c.tone; c.tone = s2.payload.tone; }
      }
    }
    s2.state = "applied";
    timeline(s2.kind, `Applied: ${s2.title}${s2.auto ? "" : " (manual action acknowledged)"}`);
    emit(`Applied — "${s2.title}". Now monitored; roll back anytime.`, { priority: "medium" });
    s2.state = "monitored";
    S().save();
    return true;
  }
  function acceptChange(id) {
    return transition(id, "monitored", "accepted", s2 => `Accepted permanently — "${s2.title}".`, true);
  }
  function rollback(id) {
    const s2 = suggestion(id);
    if (!s2 || s2.state !== "monitored") return false;
    const st = S().state;
    if (s2.kind === "archive-knowledge") {
      const d2 = K().doc(s2.payload.docId);
      if (d2) d2.archived = false;
    } else if (s2.kind === "merge-workflows" && s2.payload.removed) {
      st.workflows.push(s2.payload.removed);
    } else if (s2.kind === "switch-tone" && s2.payload.prevTone) {
      const c = st.clones.find(x => x.id === s2.payload.cloneId);
      if (c) c.tone = s2.payload.prevTone;
    }
    s2.state = "rolled_back"; s2.decidedAt = Date.now();
    timeline("rollback", `Rolled back: ${s2.title}`);
    emit(`Rolled back — "${s2.title}". Previous state restored.`, { priority: "medium" });
    S().save();
    return true;
  }
  function transition(id, from, to, msg, stamp) {
    const s2 = suggestion(id);
    if (!s2 || s2.state !== from) return false;
    s2.state = to;
    if (stamp) s2.decidedAt = Date.now();
    if (to === "accepted") timeline("accepted", `Accepted: ${s2.title}`);
    emit(msg(s2), {});
    S().save();
    return true;
  }

  /* ================================================================== *
   * MODULE 5 — prompt versioning with rollback
   * ================================================================== */
  function promptVersions(cloneId) {
    const c = S().state.clones.find(x => x.id === cloneId);
    if (!c) return [];
    c.promptVersions = c.promptVersions || [];
    return c.promptVersions;
  }
  function savePromptVersion(cloneId, notes, author) {
    const c = S().state.clones.find(x => x.id === cloneId);
    if (!c) return null;
    c.promptVersions = c.promptVersions || [];
    const v = {
      v: c.promptVersions.length + 1,
      at: Date.now(),
      author: author || "GOD CORE",
      notes: (notes || "").slice(0, 200),
      snapshot: { mindset: c.mindset, skills: c.skills, tone: c.tone, target: c.target },
      ratingSumAt: c.stats.ratingSum, ratingCountAt: c.stats.ratingCount
    };
    c.promptVersions.push(v);
    timeline("prompt", `Prompt v${v.v} saved for ${c.name}${v.notes ? " — " + v.notes : ""}`);
    emit(`Prompt versioned — ${c.name} v${v.v}.`);
    S().save();
    return v;
  }
  function versionPerf(c, v) {
    const dc = c.stats.ratingCount - v.ratingCountAt;
    if (dc <= 0) return null;
    return +((c.stats.ratingSum - v.ratingSumAt) / dc).toFixed(1);
  }
  function rollbackPrompt(cloneId, vNum) {
    const c = S().state.clones.find(x => x.id === cloneId);
    const v = (c && c.promptVersions || []).find(x => x.v === vNum);
    if (!c || !v) return false;
    Object.assign(c, v.snapshot);
    timeline("prompt", `Prompt rolled back — ${c.name} restored to v${v.v}.`);
    emit(`Prompt rollback — ${c.name} instantly restored to v${v.v}.`, { priority: "medium" });
    S().save();
    return true;
  }

  /* ================================================================== *
   * MODULE 4 — experiment engine (real A/B generations)
   * ================================================================== */
  const q = (t) => (RT() ? RT().autoQuality(t) : 60);
  async function runExperiment(input) {
    ensure();
    const st = S().state;
    const c = st.clones.find(x => x.id === input.cloneId) || st.clones[0];
    if (!c) return null;
    const kind = input.kind || "knowledge-ablation";
    const taskType = input.taskType || "Write Tweet";
    const topic = (input.topic || "evolution experiment").trim();
    const cost = () => P().analyticsOf("claude").costEst + P().analyticsOf("local").costEst;

    const t0 = Date.now(); const c0 = cost();
    const outA = await E().generate(c, { type: taskType, topic }, st.dna, st.settings);
    const a = { label: "A — current config", ms: Date.now() - t0, quality: q(outA.text), cost: +(cost() - c0).toFixed(4), excerpt: outA.text.slice(0, 200) };

    let b2, cB = c;
    const t1 = Date.now(); const c1 = cost();
    if (kind === "tone-swap") {
      const tones = Object.keys(D().TONES).filter(t => t !== c.tone);
      cB = Object.assign({}, c, { tone: input.tone || tones[0] });
      const outB = await E().generate(cB, { type: taskType, topic }, st.dna, st.settings);
      b2 = { label: `B — tone "${cB.tone}"`, ms: Date.now() - t1, quality: q(outB.text), cost: +(cost() - c1).toFixed(4), excerpt: outB.text.slice(0, 200) };
    } else {
      const outB = await E().generate(c, { type: taskType, topic, knowledge: [] }, st.dna, st.settings);
      b2 = { label: "B — no vault knowledge (ablation)", ms: Date.now() - t1, quality: q(outB.text), cost: +(cost() - c1).toFixed(4), excerpt: outB.text.slice(0, 200) };
    }
    const winner = b2.quality > a.quality ? "B" : "A";
    const rec = winner === "A"
      ? `Keep the current configuration (${a.quality} vs ${b2.quality} quality).`
      : `Adopt variant B — ${b2.label.replace(/^B — /, "")} scored ${b2.quality} vs ${a.quality}.`;
    const ex = {
      id: S().uid("exp"), name: input.name || `${kind} · ${c.name}`, kind,
      worker: c.name, workerId: c.id, taskType, topic,
      at: Date.now(), a, b: b2, winner, recommendation: rec, state: "concluded"
    };
    ensure().experiments.push(ex);
    if (ensure().experiments.length > 30) ensure().experiments.shift();
    timeline("experiment", `Experiment "${ex.name}" — winner ${winner}. ${rec}`);
    emit(`Experiment concluded — "${ex.name}": ${rec}`, { priority: "medium" });
    if (winner === "B" && kind === "tone-swap") {
      addSuggestion({
        kind: "switch-tone", auto: true,
        title: `Switch ${c.name} to "${cB.tone}" tone (experiment winner)`,
        detail: rec, impact: 6,
        payload: { cloneId: c.id, tone: cB.tone }, dedupe: "tone:" + c.id + ":" + cB.tone
      });
    }
    S().save();
    return ex;
  }
  function experiments() { return ensure().experiments; }

  /* ================================================================== *
   * MODULES 1 + 10 — evolution score, dashboard stats
   * ================================================================== */
  function stats() {
    ensure();
    const ev = ensure();
    const week = Date.now() - 7 * 86400000;
    const sugg = ev.suggestions;
    const cards = S().state.clones.map(scorecard);
    const hist = ev.scoreHistory;
    const improvedDelta = (id) => {
      const h = hist.workers[id] || [];
      return h.length >= 2 ? h[h.length - 1].score - h[0].score : 0;
    };
    const mostImproved = cards.slice().sort((a, b2) => improvedDelta(b2.id) - improvedDelta(a.id))[0] || null;
    const accepted = sugg.filter(s2 => s2.state === "accepted");
    const bestOpt = accepted.slice().sort((a, b2) => b2.impact - a.impact)[0] || null;
    const exps = ev.experiments;
    const bestExp = exps.slice().sort((a, b2) => Math.abs((b2.b.quality - b2.a.quality)) - Math.abs((a.b.quality - a.a.quality)))[0] || null;
    const kDocsWeek = K() ? K().docs().filter(d2 => d2.createdAt > week).length : 0;
    return {
      score: systemScore(),
      trend: hist.system.map(x => x.score),
      weeklyImprovements: ev.timeline.filter(t => t.at > week).length,
      pending: sugg.filter(s2 => s2.state === "pending").length,
      monitored: sugg.filter(s2 => s2.state === "monitored").length,
      accepted: accepted.length,
      rejected: sugg.filter(s2 => s2.state === "rejected").length,
      rolledBack: sugg.filter(s2 => s2.state === "rolled_back").length,
      experiments: exps.length,
      learningVelocity: kDocsWeek,
      mostImproved: mostImproved ? { name: mostImproved.name, delta: improvedDelta(mostImproved.id), score: mostImproved.composite } : null,
      bestOpt, bestExp,
      cards
    };
  }

  function boot() {
    ensure();
    const st = S().state;
    if (!st.evolutionReady && st.onboarded) {
      st.evolutionReady = true;
      timeline("system", "Evolution Engine online — the system now measures, proposes and awaits approval.");
      /* every clone gets v1 of its prompt under version control */
      st.clones.forEach(c => { if (!(c.promptVersions || []).length) savePromptVersion(c.id, "baseline (auto-captured at Evolution Engine activation)", "Evolution Engine"); });
      emit("Evolution Engine online — performance analysis, experiments and safe (approval-gated) evolution are live.", { priority: "medium" });
      S().save();
    }
  }

  return {
    ensure, analyze, scorecard, systemScore, snapshotScores,
    suggestions, suggestion, generateSuggestions,
    approve, reject, apply, acceptChange, rollback,
    promptVersions, savePromptVersion, rollbackPrompt, versionPerf,
    runExperiment, experiments,
    timelineList: () => ensure().timeline.slice().reverse(),
    stats, boot
  };
})();
