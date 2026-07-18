/* PRISM-X — runtime.js
 * PHASE BETA — FIRST INTELLIGENCE.
 *
 * The Worker Runtime Engine turns one designated Worker from a static record
 * into executable intelligence. Every run is a complete mission through the
 * architecture built in the previous phases:
 *
 *   load memory → select provider (Provider Manager) → execute workflow
 *   (Workflow Registry) → receive response → update Shared Memory → log
 *   events (Event Bus) → store results → report for evaluation
 *
 * One Worker, one task at a time — reliability before expansion.
 */
window.PRISM = window.PRISM || {};

PRISM.runtime = (function () {
  "use strict";
  const S = () => PRISM.store;
  const E = () => PRISM.engine;
  const B = () => PRISM.bridge;
  const P = () => PRISM.providers;

  const TASK_STATES = ["pending", "running", "waiting", "completed", "failed", "cancelled"];
  const STATE_HELP = {
    pending: "queued — waiting its turn",
    running: "executing now",
    waiting: "done — awaiting owner evaluation",
    completed: "evaluated and archived",
    failed: "execution error (see log)",
    cancelled: "cancelled before execution"
  };

  const MISSION_WF_NAME = "First Intelligence Mission";
  const DEFAULT_WF_STEPS = [
    "Load memory context (worker + GOD CORE DNA + history)",
    "Resolve provider via the Provider Manager",
    "Generate the artifact",
    "Store output + lessons to Shared Memory",
    "Log execution events to the Bridge",
    "Deliver results for evaluation"
  ];

  function uid(p) { return S().uid(p); }
  function rt() { ensure(); return S().state.runtime; }
  function ensure() {
    const st = S().state;
    st.runtime = st.runtime || { workerId: null, objective: "", queue: [], executions: [], activatedAt: null };
    return st.runtime;
  }
  function worker() {
    const r = rt();
    return S().state.clones.find(c => c.id === r.workerId) || null;
  }
  function emit(text, meta) { B().emit("runtime", "⚙ " + text, meta || {}); }

  /* The mission workflow lives in the Phase Alpha Workflow Registry. */
  function missionWorkflow() {
    const r = rt();
    const st = S().state;
    let wf = st.workflows.find(w => w.workerId === r.workerId && w.name === MISSION_WF_NAME);
    if (!wf && r.workerId) {
      wf = B().addWorkflow({
        name: MISSION_WF_NAME,
        description: "Phase Beta end-to-end mission — executed for real by the Worker Runtime Engine.",
        workerId: r.workerId,
        trigger: "manual",
        steps: DEFAULT_WF_STEPS.slice(),
        expectedResult: "Evaluated artifact stored in the execution log"
      });
    }
    return wf;
  }

  /* ---------------- designation (one Worker only, per spec) ---------------- */
  function designate(cloneId, objective) {
    const st = S().state;
    const c = st.clones.find(x => x.id === cloneId);
    if (!c) return { ok: false, reason: "clone not found" };
    const r = ensure();
    r.workerId = c.id;
    r.objective = (objective || "").trim() || `Prove the PRISM-X architecture end-to-end as ${c.name}.`;
    r.activatedAt = Date.now();
    missionWorkflow();
    c.memory.push("Designated as the First Intelligence — Worker Runtime Engine attached.");
    emit(`First Intelligence activated — ${c.name} is now an executable Worker (runtime engine attached).`, { workerId: c.id, priority: "high" });
    S().save();
    return { ok: true, worker: c };
  }
  function setObjective(text) {
    const r = rt();
    r.objective = (text || "").trim();
    S().save();
  }

  /* ---------------- task queue (Module 4) ---------------- */
  function addTask(input) {
    const r = rt();
    const c = worker();
    if (!c) return null;
    const t = {
      id: uid("rtt"),
      type: input.type || "Write Tweet",
      topic: (input.topic || "").trim() || r.objective || "the PRISM-X mission",
      outcome: (input.outcome || "").trim(),
      state: "pending",
      queuedAt: Date.now(),
      startedAt: null, finishedAt: null,
      output: "", error: null, execId: null
    };
    r.queue.push(t);
    emit(`Task queued for ${c.name} — ${t.type}: "${t.topic}".`, { workerId: c.id });
    S().save();
    return t;
  }
  function cancelTask(taskId) {
    const r = rt();
    const t = r.queue.find(x => x.id === taskId);
    if (!t || t.state !== "pending") return false;
    t.state = "cancelled";
    t.finishedAt = Date.now();
    emit(`Task cancelled — ${t.type}: "${t.topic}".`);
    S().save();
    return true;
  }
  function queue() { return rt().queue; }
  function nextTask() { return rt().queue.find(t => t.state === "pending") || null; }
  function waitingTasks() { return rt().queue.filter(t => t.state === "waiting"); }
  function isRunning() { return rt().queue.some(t => t.state === "running"); }

  /* ---------------- memory context (Module 3) ---------------- */
  function gatherMemory(c, task) {
    const st = S().state;
    const items = [];
    (c.memory || []).slice(-3).forEach(m => items.push({ src: "worker memory", text: String(m).slice(0, 90) }));
    if (st.dna.tone) items.push({ src: "GOD CORE DNA", text: "Voice: " + st.dna.tone.split("\n")[0].slice(0, 70) });
    if (st.dna.mindset) items.push({ src: "GOD CORE DNA", text: "Mindset: " + st.dna.mindset.split("\n")[0].slice(0, 70) });
    if (st.dna.decision) items.push({ src: "Decision Framework", text: st.dna.decision.split("\n")[0].slice(0, 90) });
    const q = (task.topic || "").split(/\s+/)[0] || "";
    if (q) B().searchMemory(q).slice(0, 2).forEach(m => items.push({ src: "shared memory (" + m.scope + ")", text: m.title.slice(0, 80) }));
    const lastExec = rt().executions.filter(x => x.success).slice(-1)[0];
    if (lastExec) items.push({ src: "execution history", text: `Last mission: ${lastExec.taskType} — ${lastExec.topic}`.slice(0, 90) });
    return items;
  }

  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  /* ---------------- Run Worker (Modules 5, 6, 8, 9) ---------------- */
  async function run(onTick) {
    const st = S().state;
    const r = ensure();
    const c = worker();
    if (!c) return { ok: false, reason: "No worker designated — activate the First Intelligence first." };
    if (isRunning()) return { ok: false, reason: "Already executing — one task at a time." };
    const task = nextTask();
    if (!task) return { ok: false, reason: "Queue empty — add a task first." };

    const wf = missionWorkflow();
    const wfSteps = (wf.steps && wf.steps.length ? wf.steps : DEFAULT_WF_STEPS);
    const category = E().categoryFor(task.type);
    const sel = P().resolve(c.provider || "auto", category);
    const costBefore = P().analyticsOf(sel.id).costEst + P().analyticsOf("local").costEst;
    const evBefore = st.events.length;
    const t0 = Date.now();
    const totalStages = 4 + wfSteps.length; /* memory + provider + wf steps + memory-store + finalize */

    task.state = "running";
    task.startedAt = t0;
    S().save();

    const live = {
      taskId: task.id, taskType: task.type, topic: task.topic,
      stage: "Initializing", i: 0, n: totalStages, progress: 0,
      provider: null, requested: P().name(sel.requested), switched: sel.switched,
      memory: [], wfName: wf.name, wfStep: "—",
      startedAt: t0, etaMs: sel.id === "claude" ? 12000 : 2800,
      done: false, error: null
    };
    const tick = (patch) => {
      Object.assign(live, patch || {});
      live.progress = Math.min(100, Math.round((live.i / live.n) * 100));
      if (onTick) { try { onTick(live); } catch (_) {} }
    };

    emit(`Execution started — ${c.name} · ${task.type} · "${task.topic}" (workflow: ${wf.name}).`, { workerId: c.id });
    let memoryItems = [];
    try {
      /* 1 — load memory */
      tick({ stage: "Loading memory context", i: 1 });
      memoryItems = gatherMemory(c, task);
      tick({ memory: memoryItems.map(m => `${m.src}: ${m.text}`) });
      await sleep(260);

      /* 2 — select provider (the Provider Manager decides) */
      tick({ stage: "Selecting provider", i: 2, provider: P().name(sel.id) });
      await sleep(240);

      /* 3..n — execute the registered workflow, step by step */
      let out = null;
      for (let i2 = 0; i2 < wfSteps.length; i2++) {
        tick({ stage: "Executing workflow", wfStep: wfSteps[i2], i: 2 + i2 + 1 });
        if (/generate|artifact|response/i.test(wfSteps[i2]) && !out) {
          out = await E().generate(c, task, st.dna, st.settings);
        } else {
          await sleep(200);
        }
      }
      if (!out) out = await E().generate(c, task, st.dna, st.settings);
      const executedProvider = out.engine === "neural" ? "Claude" : "Local Models";

      /* n-1 — update Shared Memory */
      tick({ stage: "Updating shared memory", i: totalStages - 1, provider: executedProvider });
      B().addMemory({
        title: `Execution — ${task.type}: ${task.topic}`.slice(0, 90),
        body: out.text.slice(0, 280),
        scope: "shared", kind: "success"
      });
      c.memory.push(`Runtime mission complete — ${task.type}: "${task.topic}".`);
      await sleep(220);

      /* n — store results + report */
      tick({ stage: "Storing results", i: totalStages });
      const ms = Date.now() - t0;
      const costAfter = P().analyticsOf(sel.id).costEst + P().analyticsOf("local").costEst;
      wf.runs += 1; wf.successes += 1; wf.status = "success"; wf.lastRun = Date.now();
      const exec = {
        id: uid("ex"),
        workerId: c.id, workerName: c.name,
        taskId: task.id, taskType: task.type, topic: task.topic,
        provider: executedProvider, requested: P().name(sel.requested),
        at: t0, ms,
        costEst: +(Math.max(0, costAfter - costBefore)).toFixed(4),
        success: true, error: null,
        memoryAccessed: memoryItems.length,
        eventsGenerated: 0, /* patched below once the completion event lands */
        wfId: wf.id, wfName: wf.name,
        artifactLabel: out.artifactLabel || task.type,
        output: out.text.slice(0, 4000),
        completion: 100, quality: autoQuality(out.text), feedback: null
      };
      r.executions.push(exec);
      if (r.executions.length > 50) r.executions.shift();
      task.state = "waiting"; /* awaiting owner evaluation */
      task.finishedAt = Date.now();
      task.output = out.text;
      task.execId = exec.id;
      emit(`Execution completed — ${c.name} finished "${task.topic}" via ${executedProvider} in ${(ms / 1000).toFixed(1)}s. Awaiting evaluation.`, { workerId: c.id });
      exec.eventsGenerated = st.events.length - evBefore;
      S().save();
      tick({ stage: "Complete — awaiting evaluation", done: true });
      return { ok: true, exec, task };
    } catch (err) {
      const ms = Date.now() - t0;
      wf.runs += 1; wf.status = "failed"; wf.lastRun = Date.now();
      const exec = {
        id: uid("ex"),
        workerId: c.id, workerName: c.name,
        taskId: task.id, taskType: task.type, topic: task.topic,
        provider: P().name(sel.id), requested: P().name(sel.requested),
        at: t0, ms, costEst: 0,
        success: false, error: String(err.message || err).slice(0, 200),
        memoryAccessed: memoryItems.length, eventsGenerated: st.events.length - evBefore,
        wfId: wf.id, wfName: wf.name,
        artifactLabel: task.type, output: "",
        completion: Math.round((live.i / live.n) * 100), quality: 0, feedback: null
      };
      r.executions.push(exec);
      task.state = "failed";
      task.finishedAt = Date.now();
      task.error = exec.error;
      emit(`Execution FAILED — ${c.name} · "${task.topic}": ${exec.error}.`, { workerId: c.id, priority: "high" });
      S().save();
      tick({ stage: "Failed", done: true, error: exec.error });
      return { ok: false, reason: exec.error, exec };
    }
  }

  /* ---------------- evaluation (Module 10) ---------------- */
  function autoQuality(text) {
    let q = 55;
    if (/CTA:/.test(text)) q += 12;
    if (/EXECUTION PLAN/.test(text)) q += 10;
    if (text.length > 400) q += 10;
    if (/── CLONE NOTES ──|Decision framework/i.test(text)) q += 8;
    return Math.min(95, q);
  }
  function evaluate(execId, starsGiven) {
    const r = rt();
    const c = worker();
    const exec = r.executions.find(x => x.id === execId);
    if (!exec || !c) return { ok: false };
    exec.feedback = starsGiven;
    const task = r.queue.find(t => t.id === exec.taskId);
    if (task && task.state === "waiting") task.state = "completed";
    /* owner feedback feeds the same performance economics as Phase 1 */
    const outcome = E().recordOutcome(c, { id: exec.id }, starsGiven);
    c.ratingLog = c.ratingLog || [];
    c.ratingLog.push(starsGiven);
    if (starsGiven >= 4) {
      B().addMemory({ title: `Winning pattern — ${exec.taskType}: ${exec.topic}`.slice(0, 90), body: `Rated ${starsGiven}/5 by the owner. Quality ${exec.quality}/100 in ${(exec.ms / 1000).toFixed(1)}s.`, scope: "global", kind: "lesson" });
    } else if (starsGiven <= 2) {
      B().addMemory({ title: `Weak output — ${exec.taskType}: ${exec.topic}`.slice(0, 90), body: `Rated ${starsGiven}/5 — adjust the approach next mission.`, scope: "shared", kind: "failure" });
    }
    emit(`Evaluation recorded — "${exec.topic}" rated ${starsGiven}/5 (auto quality ${exec.quality}/100, completion ${exec.completion}%).`, { workerId: c.id });
    S().save();
    return { ok: true, exec, outcome };
  }

  /* ---------------- stats ---------------- */
  function stats() {
    const r = rt();
    const ex = r.executions;
    const ok = ex.filter(x => x.success).length;
    return {
      activated: !!r.workerId,
      workerName: worker() ? worker().name : null,
      executions: ex.length,
      successRate: ex.length ? Math.round((ok / ex.length) * 100) : null,
      avgMs: ex.length ? Math.round(ex.reduce((a, x) => a + x.ms, 0) / ex.length) : 0,
      totalCost: +ex.reduce((a, x) => a + (x.costEst || 0), 0).toFixed(4),
      pending: r.queue.filter(t => t.state === "pending").length,
      waiting: waitingTasks().length,
      lastExec: ex[ex.length - 1] || null
    };
  }

  return {
    TASK_STATES, STATE_HELP, MISSION_WF_NAME, DEFAULT_WF_STEPS,
    ensure, rt, worker, designate, setObjective,
    addTask, cancelTask, queue, nextTask, waitingTasks, isRunning,
    missionWorkflow, gatherMemory, run, evaluate, autoQuality, stats
  };
})();
