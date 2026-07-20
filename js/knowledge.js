/* PRISM-X — knowledge.js
 * PHASE DELTA — KNOWLEDGE & MEMORY NETWORK.
 *
 * The long-term memory of the system: a searchable, linked, layered
 * Knowledge Vault that grows with every task, lesson and decision.
 * Workers retrieve context before executing and feed lessons back after.
 *
 * Honesty line: "semantic search" here is meaning-expanded lexical
 * retrieval — a synonym/concept graph plus weighted scoring over title,
 * tags and body, re-ranked by confidence and freshness. It is deterministic,
 * offline and labeled as such; true embeddings plug in when a vector store
 * connects in a later phase.
 */
window.PRISM = window.PRISM || {};

PRISM.knowledge = (function () {
  "use strict";
  const S = () => PRISM.store;
  const B = () => PRISM.bridge;

  /* ---------------- MODULE 2 — categories (auto-classification) ---------------- */
  const CATEGORIES = ["Business", "Marketing", "Sales", "Programming", "Automation", "Finance", "Crypto", "Psychology", "Fitness", "Legal", "Personal", "AI", "Operations"];
  const CAT_KEYWORDS = {
    Marketing: ["content", "audience", "brand", "funnel", "landing", "page", "hook", "viral", "caption", "followers", "post"],
    Sales: ["close", "closing", "objection", "dm", "outreach", "email", "lead", "pitch", "offer", "prospect", "cold"],
    Programming: ["code", "api", "function", "deploy", "bug", "javascript", "database"],
    Automation: ["workflow", "webhook", "automation", "trigger", "make.com", "n8n", "scenario", "zap"],
    Finance: ["revenue", "pricing", "profit", "cost", "cash", "income", "reinvest"],
    Crypto: ["token", "chain", "defi", "wallet", "narrative", "position", "onchain"],
    Psychology: ["mindset", "persuasion", "bias", "trust", "emotion", "habit"],
    Fitness: ["training", "diet", "workout", "sleep"],
    Legal: ["contract", "compliance", "terms", "policy"],
    Personal: ["preference", "voice", "dna", "values", "tone", "identity"],
    AI: ["model", "prompt", "llm", "provider", "claude", "agent", "neural"],
    Operations: ["sop", "process", "checklist", "system", "onboarding", "procedure"],
    Business: ["strategy", "growth", "client", "market", "product", "business"]
  };
  const TYPES = ["framework", "sop", "research", "book", "pdf-note", "note", "prompt", "lesson", "playbook", "meeting", "product-doc", "decision"];
  /* MODULE 5 — memory layers */
  const LAYERS = {
    personal: "Personal — your preferences",
    operational: "Operational — workflow performance",
    business: "Business — offers, funnels, clients, revenue",
    intelligence: "Intelligence — research, reasoning, frameworks",
    system: "System — architecture, configuration, integrations"
  };

  /* ---------------- MODULE 3 — synonym/concept graph ---------------- */
  const STOP = new Set(["the", "a", "an", "my", "our", "your", "we", "i", "is", "are", "was", "what", "did", "do", "does", "about", "find", "best", "for", "of", "to", "in", "on", "with", "and", "or", "how", "me", "it", "that", "this", "learn", "learned"]);
  const SYNONYMS = {
    email: ["outreach", "cold", "inbox", "sequence", "dm"],
    cold: ["email", "outreach", "dm"],
    outreach: ["email", "dm", "cold", "prospect"],
    dm: ["message", "outreach", "close"],
    landing: ["page", "funnel", "conversion"],
    page: ["landing", "funnel", "copy"],
    funnel: ["landing", "conversion", "offer"],
    lesson: ["insight", "takeaway", "pattern", "learned"],
    product: ["offer", "asset", "ghost"],
    offer: ["product", "pricing", "stack"],
    content: ["post", "hook", "thread", "caption", "shell"],
    hook: ["opener", "headline", "content"],
    client: ["lead", "prospect", "customer"],
    lead: ["prospect", "client", "dm"],
    money: ["revenue", "income", "pricing", "profit"],
    revenue: ["income", "money", "earnings"],
    voice: ["tone", "dna", "style"],
    framework: ["playbook", "system", "sop", "template"],
    playbook: ["framework", "sop", "system"],
    strategy: ["logic", "plan", "framework"],
    knowledge: ["vault", "memory", "doc"]
  };

  function tokenize(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9\s.-]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
  }
  function expand(tokens) {
    const out = new Map(); /* term → weight */
    tokens.forEach(t => {
      out.set(t, Math.max(out.get(t) || 0, 1));
      (SYNONYMS[t] || []).forEach(s2 => out.set(s2, Math.max(out.get(s2) || 0, 0.6)));
    });
    return out;
  }

  /* ---------------- store ---------------- */
  function ensure() {
    const st = S().state;
    st.knowledge = st.knowledge || { docs: [], links: [] };
    st.knowledge.docs = st.knowledge.docs || [];
    st.knowledge.links = st.knowledge.links || [];
    return st.knowledge;
  }
  function docs() { return ensure().docs; }
  function doc(id) { return docs().find(d => d.id === id) || null; }
  function links() { return ensure().links; }
  function linksFor(id) { return links().filter(l => l.from === id || l.to === id); }

  function emit(text, meta) { B().emit("knowledge", "📚 " + text, meta || {}); }

  function classify(title, body) {
    const toks = tokenize(title + " " + title + " " + body); /* title counted twice */
    let best = "Business", bestScore = 0;
    Object.entries(CAT_KEYWORDS).forEach(([cat, kws]) => {
      const score = toks.reduce((a, t) => a + (kws.some(k => t.includes(k) || k.includes(t)) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = cat; }
    });
    return best;
  }

  /* MODULE 7 — confidence + freshness */
  function freshness(d) {
    const days = (Date.now() - (d.updatedAt || d.createdAt)) / 86400000;
    return Math.max(20, Math.round(100 - days * 2));
  }
  function confidence(d) {
    let c = d.baseConfidence != null ? d.baseConfidence : 55;
    if (d.verified === "verified") c += 15;
    c += Math.min(15, (d.uses || 0) * 3);
    return Math.min(100, Math.round(c));
  }

  /* ---------------- MODULE 1 — add / manage docs ---------------- */
  function addDoc(input) {
    const k = ensure();
    const title = (input.title || "Untitled").trim().slice(0, 120);
    const body = (input.body || "").trim().slice(0, 6000);
    const d = {
      id: S().uid("kd"),
      title, body,
      type: TYPES.includes(input.type) ? input.type : "note",
      category: input.category && input.category !== "auto" ? input.category : classify(title, body),
      layer: LAYERS[input.layer] ? input.layer : "intelligence",
      tags: (input.tags || []).map(t => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 8),
      source: input.source || "manual",
      owner: input.owner || "GOD CORE",
      createdAt: Date.now(), updatedAt: Date.now(),
      baseConfidence: input.baseConfidence != null ? input.baseConfidence : (input.source === "learning-engine" ? 62 : 55),
      verified: "unverified",
      uses: 0, lastUsedAt: null
    };
    k.docs.push(d);
    if (k.docs.length > 300) k.docs.shift();
    autoLink(d);
    emit(`Knowledge stored — "${d.title}" (${d.category} · ${d.layer} · ${d.type}, via ${d.source}).`);
    S().save();
    return d;
  }
  function deleteDoc(id) {
    const k = ensure();
    const d = doc(id);
    k.docs = k.docs.filter(x => x.id !== id);
    k.links = k.links.filter(l => l.from !== id && l.to !== id);
    if (d) emit(`Knowledge removed — "${d.title}".`);
    S().save();
  }
  function verifyDoc(id) {
    const d = doc(id);
    if (!d) return;
    d.verified = d.verified === "verified" ? "unverified" : "verified";
    d.updatedAt = Date.now();
    emit(`Knowledge ${d.verified} — "${d.title}" (confidence now ${confidence(d)}/100).`);
    S().save();
  }

  /* ---------------- MODULE 4 — linking + graph ---------------- */
  function similarity(a, b) {
    const ta = new Set(tokenize(a.title + " " + a.tags.join(" ") + " " + a.body.slice(0, 400)));
    const tb = new Set(tokenize(b.title + " " + b.tags.join(" ") + " " + b.body.slice(0, 400)));
    let shared = 0;
    ta.forEach(t => { if (tb.has(t)) shared++; });
    return shared + (a.category === b.category ? 1 : 0);
  }
  function addLink(fromId, toId, label) {
    const k = ensure();
    if (fromId === toId || !doc(fromId) || !doc(toId)) return false;
    if (k.links.some(l => (l.from === fromId && l.to === toId) || (l.from === toId && l.to === fromId))) return false;
    k.links.push({ from: fromId, to: toId, label: label || "related" });
    S().save();
    return true;
  }
  function autoLink(d) {
    docs()
      .filter(o => o.id !== d.id)
      .map(o => ({ o, s: similarity(d, o) }))
      .filter(x => x.s >= 3)
      .sort((x, y) => y.s - x.s)
      .slice(0, 2)
      .forEach(x => addLink(d.id, x.o.id, "auto"));
  }

  /* ---------------- MODULE 3 — meaning-expanded search ---------------- */
  function search(query, opts) {
    ensure();
    opts = opts || {};
    const terms = expand(tokenize(query));
    if (!terms.size) return [];
    /* archived docs (Phase Zeta evolution) drop out of retrieval */
    const scored = docs().filter(d => !d.archived).map(d => {
      const title = tokenize(d.title), tags = d.tags || [], body = tokenize(d.body).slice(0, 400);
      let score = 0;
      const matched = [];
      terms.forEach((w, t) => {
        const inTitle = title.some(x => x.includes(t) || t.includes(x));
        const inTags = tags.some(x => x.includes(t) || t.includes(x));
        const inBody = body.some(x => x === t);
        if (inTitle) { score += 3 * w; matched.push(t); }
        else if (inTags) { score += 2 * w; matched.push(t); }
        else if (inBody) { score += 1 * w; matched.push(t); }
      });
      if (opts.layer && opts.layer !== "all" && d.layer !== opts.layer) score = 0;
      if (opts.category && opts.category !== "all" && d.category !== opts.category) score = 0;
      /* reliability re-rank: confidence + freshness nudge the order */
      const rank = score > 0 ? score * (0.7 + confidence(d) / 250 + freshness(d) / 500) : 0;
      return { doc: d, score: rank, matched: Array.from(new Set(matched)) };
    }).filter(x => x.score > 0).sort((a, b2) => b2.score - a.score);
    return scored.slice(0, opts.limit || 8);
  }

  /* ---------------- MODULE 6 — retrieval (workers call this) ---------------- */
  function retrieve(query, n, who) {
    const hits = search(query, { limit: n || 3 });
    hits.forEach(h => { h.doc.uses = (h.doc.uses || 0) + 1; h.doc.lastUsedAt = Date.now(); });
    if (hits.length) {
      emit(`Knowledge retrieved${who ? " for " + who : ""} — ${hits.length} doc(s) for "${String(query).slice(0, 60)}": ${hits.map(h => h.doc.title).join(" · ").slice(0, 120)}.`);
      S().save();
    }
    return hits.map(h => ({ id: h.doc.id, title: h.doc.title, excerpt: h.doc.body.slice(0, 220), confidence: confidence(h.doc), category: h.doc.category }));
  }

  /* ---------------- MODULE 8 — learning engine ---------------- */
  function summarize(text) {
    const lines = String(text || "").split("\n").map(l => l.trim()).filter(Boolean);
    const cta = lines.find(l => /^CTA:/.test(l));
    const head = lines.slice(0, 5).join("\n");
    return (head + (cta && !head.includes(cta) ? "\n" + cta : "")).slice(0, 900);
  }
  function learnFromExecution(exec, stars) {
    /* Should this become knowledge? — yes when the owner scored it a win */
    if (!exec || stars < 4) return null;
    const d = addDoc({
      title: `Lesson — ${exec.taskType}: ${exec.topic}`.slice(0, 110),
      body: `Owner-rated ${stars}/5 (auto quality ${exec.quality}/100, ${exec.provider}, ${(exec.ms / 1000).toFixed(1)}s).\n\n${summarize(exec.output)}`,
      type: "lesson",
      category: "auto",
      layer: "intelligence",
      tags: [exec.taskType.toLowerCase().replace(/\s+/g, "-"), "runtime"],
      source: "learning-engine",
      owner: exec.workerName,
      baseConfidence: 50 + stars * 8
    });
    emit(`Learning engine — execution "${exec.topic}" became knowledge: "${d.title}" (summarized · categorized ${d.category} · linked · indexed).`, { priority: "medium" });
    return d;
  }

  /* ---------------- seeding from the live system (state-derived only) ---------------- */
  function seed() {
    const st = S().state;
    if (docs().length) return;
    const dna = st.dna || {};
    if (dna.tone || dna.mindset) addDoc({ title: "Operator DNA — voice & mindset", body: ["Voice: " + (dna.tone || "—"), "Mindset: " + (dna.mindset || "—"), "Strategy: " + (dna.logic || "—"), "Signature CTA: " + (dna.cta || "—")].join("\n"), type: "framework", category: "Personal", layer: "personal", tags: ["dna", "voice"], source: "system-seed" });
    if (dna.decision) addDoc({ title: "Decision Framework — operating laws", body: dna.decision, type: "decision", category: "Personal", layer: "personal", tags: ["decision", "laws"], source: "system-seed" });
    if (dna.cta) addDoc({ title: "Signature CTA — proven closer", body: `The network-default call to action: "${dna.cta}". Push into every artifact unless a better local CTA exists.`, type: "playbook", category: "Sales", layer: "business", tags: ["cta", "conversion"], source: "system-seed" });
    (st.products || []).slice(0, 2).forEach(p => addDoc({ title: `Product angle — ${p.name}`, body: `${p.type} in ${p.niche} at $${p.price}. Pain: ${p.pain ? p.pain.pain : "—"}. Angle: ${p.angle || "—"}. Status: ${p.status}.`, type: "product-doc", category: "Business", layer: "business", tags: ["ghost", "offer"], source: "system-seed" }));
    if (st.shells && st.shells.length) {
      const s2 = st.shells[0];
      addDoc({ title: `Shell playbook — ${s2.name}`, body: `Niche ${s2.niche}, persona ${s2.persona}, platforms ${s2.platforms.join("/")}. Offer source: ${s2.offerSource}. Posts/day: ${s2.postsPerDay}.`, type: "playbook", category: "Marketing", layer: "business", tags: ["shell", "content"], source: "system-seed" });
    }
    if (st.workflows && st.workflows.length) {
      const wf = st.workflows[0];
      addDoc({ title: `Workflow performance — ${wf.name}`, body: `${wf.runs} run(s), ${wf.successes} success(es). Trigger: ${wf.trigger}. Steps: ${(wf.steps || []).join(" → ") || "—"}.`, type: "sop", category: "Operations", layer: "operational", tags: ["workflow"], source: "system-seed" });
    }
    addDoc({ title: "PRISM-X architecture map", body: "Bridge (events/memory/permissions/API) → Provider Manager (intelligence routing) → Worker Runtime (executable missions) → Execution Layer (external actions, credential vault, dry/live). All state in localStorage; content generation real; money/engagement labeled simulation.", type: "product-doc", category: "AI", layer: "system", tags: ["architecture"], source: "system-seed" });
    emit(`Knowledge Vault seeded from the live system — ${docs().length} founding documents across ${Object.keys(LAYERS).length} memory layers.`, { priority: "medium" });
  }

  /* ---------------- MODULE 10 — dashboard stats ---------------- */
  function stats() {
    ensure();
    const ds = docs();
    const byCat = {};
    ds.forEach(d => { byCat[d.category] = (byCat[d.category] || 0) + 1; });
    const perDay = {};
    ds.forEach(d => { const k = new Date(d.createdAt).toISOString().slice(0, 10); perDay[k] = (perDay[k] || 0) + 1; });
    const linkCount = {};
    links().forEach(l => { linkCount[l.from] = (linkCount[l.from] || 0) + 1; linkCount[l.to] = (linkCount[l.to] || 0) + 1; });
    const mostRef = ds.slice().sort((a, b) => (linkCount[b.id] || 0) - (linkCount[a.id] || 0)).slice(0, 5).map(d => ({ d, n: linkCount[d.id] || 0 }));
    return {
      items: ds.length,
      links: links().length,
      retrievals: ds.reduce((a, d) => a + (d.uses || 0), 0),
      avgConfidence: ds.length ? Math.round(ds.reduce((a, d) => a + confidence(d), 0) / ds.length) : 0,
      verifiedPct: ds.length ? Math.round(ds.filter(d => d.verified === "verified").length / ds.length * 100) : 0,
      byCat: Object.entries(byCat).sort((a, b) => b[1] - a[1]),
      recent: ds.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
      recentLearned: ds.filter(d => d.source === "learning-engine").sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
      mostUsed: ds.slice().sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 5),
      mostRef,
      perDay
    };
  }

  function boot() {
    ensure();
    const st = S().state;
    /* seed only once the operator exists — DNA and system state feed the vault */
    if (!st.knowledgeReady && st.onboarded) {
      st.knowledgeReady = true;
      seed();
      S().save();
    }
  }

  return {
    CATEGORIES, TYPES, LAYERS,
    ensure, docs, doc, links, linksFor,
    addDoc, deleteDoc, verifyDoc, addLink, autoLink,
    classify, search, retrieve, confidence, freshness,
    learnFromExecution, summarize, seed, stats, boot
  };
})();
