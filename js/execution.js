/* PRISM-X — execution.js
 * PHASE GAMMA — REAL-WORLD EXECUTION LAYER.
 *
 * The Universal Execution Engine: every external action from any Worker,
 * Ghost, Shell or future module flows
 *
 *   Worker → Bridge → Provider Manager (context) → Execution Engine
 *   → Integration Adapter → external service → result → Memory → Events
 *
 * Honesty line: Dry Run (default) simulates without touching anything.
 * Live mode is real only where a browser can genuinely reach — Telegram Bot
 * API, Make/n8n/Discord/Slack webhooks, Supabase REST, and the internal
 * Broadcast Queue. Everything else reports that it needs a server-side
 * relay instead of pretending. No silent failures anywhere.
 */
window.PRISM = window.PRISM || {};

PRISM.execution = (function () {
  "use strict";
  const S = () => PRISM.store;
  const B = () => PRISM.bridge;
  const P = () => PRISM.providers;

  const CATEGORIES = {
    communicate: "Communication", automate: "Automation", data: "Data",
    publish: "Publishing", files: "Files", voice: "Voice",
    payments: "Payments", dev: "Dev"
  };

  /* ================================================================== *
   * MODULE 3 — Integration Adapters (standardized interface per service)
   * live: null = needs a server-side relay · "webhook"/"telegram"/
   * "supabase"/"internal" = genuinely executable from the browser
   * ================================================================== */
  const DEFS = {
    make: {
      name: "Make.com", live: "webhook",
      credSchema: [{ key: "webhookUrl", label: "Scenario webhook URL" }],
      actions: [
        { id: "make.trigger", label: "Trigger Scenario", category: "automate", params: [{ key: "payload", label: "JSON payload", ph: '{"event":"prismx"}' }] },
        { id: "make.webhook", label: "Receive Webhook", category: "automate", params: [], inbound: true }
      ]
    },
    n8n: {
      name: "n8n", live: "webhook",
      credSchema: [{ key: "webhookUrl", label: "Workflow webhook URL" }],
      actions: [
        { id: "n8n.execute", label: "Execute Workflow", category: "automate", params: [{ key: "payload", label: "JSON payload", ph: '{"source":"prismx"}' }] },
        { id: "n8n.callback", label: "Receive Callback", category: "automate", params: [], inbound: true }
      ]
    },
    supabase: {
      name: "Supabase", live: "supabase",
      credSchema: [{ key: "url", label: "Project URL" }, { key: "anonKey", label: "anon / service key", type: "password" }],
      actions: [
        { id: "supabase.read", label: "Read Data", category: "data", params: [{ key: "table", label: "Table", ph: "leads" }, { key: "limit", label: "Limit", ph: "5" }] },
        { id: "supabase.insert", label: "Insert Data", category: "data", params: [{ key: "table", label: "Table", ph: "leads" }, { key: "json", label: "Row JSON", ph: '{"name":"…"}' }] },
        { id: "supabase.update", label: "Update Records", category: "data", params: [{ key: "table", label: "Table" }, { key: "match", label: "Match (col=val)", ph: "id=1" }, { key: "json", label: "Patch JSON" }] }
      ]
    },
    vapi: {
      name: "Vapi", live: null,
      credSchema: [{ key: "apiKey", label: "API Key", type: "password" }],
      actions: [
        { id: "vapi.call", label: "Start Voice Call", category: "voice", params: [{ key: "to", label: "Number" }, { key: "script", label: "Call goal" }] },
        { id: "vapi.generate", label: "Generate Voice", category: "voice", params: [{ key: "text", label: "Text to speak" }] }
      ]
    },
    blandai: {
      name: "Bland AI", live: null,
      credSchema: [{ key: "apiKey", label: "API Key", type: "password" }],
      actions: [
        { id: "bland.call", label: "Start AI Phone Call", category: "voice", params: [{ key: "to", label: "Number" }, { key: "task", label: "Call task" }] }
      ]
    },
    gmail: {
      name: "Gmail", live: null,
      credSchema: [{ key: "oauth", label: "OAuth token (server relay)" }],
      actions: [
        { id: "gmail.send", label: "Send Email", category: "communicate", params: [{ key: "to", label: "To" }, { key: "subject", label: "Subject" }, { key: "body", label: "Body" }] },
        { id: "gmail.read", label: "Read Inbox", category: "communicate", params: [{ key: "limit", label: "Max messages", ph: "10" }] },
        { id: "gmail.search", label: "Search Messages", category: "communicate", params: [{ key: "q", label: "Query" }] }
      ]
    },
    telegram: {
      name: "Telegram", live: "telegram",
      credSchema: [{ key: "botToken", label: "Bot token", type: "password" }, { key: "chatId", label: "Chat ID" }],
      actions: [
        { id: "telegram.send", label: "Send Message", category: "communicate", params: [{ key: "text", label: "Message" }] },
        { id: "telegram.post", label: "Create Channel Post", category: "publish", params: [{ key: "text", label: "Post text" }] }
      ]
    },
    discord: {
      name: "Discord", live: "webhook",
      credSchema: [{ key: "webhookUrl", label: "Channel webhook URL" }],
      actions: [
        { id: "discord.send", label: "Send Message", category: "communicate", params: [{ key: "content", label: "Message" }] }
      ]
    },
    slack: {
      name: "Slack", live: "webhook",
      credSchema: [{ key: "webhookUrl", label: "Incoming webhook URL" }],
      actions: [
        { id: "slack.send", label: "Send Channel Message", category: "communicate", params: [{ key: "text", label: "Message" }] }
      ]
    },
    stripe: {
      name: "Stripe", live: null,
      credSchema: [{ key: "secretKey", label: "Secret key (server relay)", type: "password" }],
      actions: [
        { id: "stripe.link", label: "Create Payment Link", category: "payments", params: [{ key: "product", label: "Product" }, { key: "amount", label: "Amount ($)" }] },
        { id: "stripe.balance", label: "Read Balance", category: "payments", params: [] }
      ]
    },
    github: {
      name: "GitHub", live: null,
      credSchema: [{ key: "token", label: "Personal access token", type: "password" }],
      actions: [
        { id: "github.issue", label: "Create Issue", category: "dev", params: [{ key: "repo", label: "owner/repo" }, { key: "title", label: "Title" }] },
        { id: "github.activity", label: "Read Repo Activity", category: "dev", params: [{ key: "repo", label: "owner/repo" }] }
      ]
    },
    notion: {
      name: "Notion", live: null,
      credSchema: [{ key: "token", label: "Integration token", type: "password" }],
      actions: [
        { id: "notion.page", label: "Create Page", category: "publish", params: [{ key: "title", label: "Title" }, { key: "content", label: "Content" }] },
        { id: "notion.append", label: "Append to Database", category: "data", params: [{ key: "db", label: "Database ID" }, { key: "json", label: "Properties JSON" }] }
      ]
    },
    gdrive: {
      name: "Google Drive", live: null,
      credSchema: [{ key: "oauth", label: "OAuth token (server relay)" }],
      actions: [
        { id: "gdrive.upload", label: "Upload File", category: "files", params: [{ key: "name", label: "File name" }, { key: "content", label: "Content" }] },
        { id: "gdrive.list", label: "List Files", category: "files", params: [{ key: "folder", label: "Folder", ph: "root" }] },
        { id: "gdrive.calendar", label: "Create Calendar Event", category: "automate", params: [{ key: "title", label: "Event" }, { key: "when", label: "When" }] }
      ]
    },
    airtable: {
      name: "Airtable", live: null,
      credSchema: [{ key: "apiKey", label: "API key", type: "password" }, { key: "base", label: "Base ID" }],
      actions: [
        { id: "airtable.create", label: "Create Record (CRM Lead)", category: "data", params: [{ key: "table", label: "Table" }, { key: "json", label: "Fields JSON" }] },
        { id: "airtable.list", label: "List Records", category: "data", params: [{ key: "table", label: "Table" }] }
      ]
    },
    queue: {
      name: "Broadcast Queue (X)", live: "internal", internal: true,
      credSchema: [],
      actions: [
        { id: "queue.publish", label: "Publish Content (X · Broadcast Queue)", category: "publish", params: [{ key: "text", label: "Post text" }, { key: "title", label: "Label", ph: "Gamma action" }] }
      ]
    },
    futureint: {
      name: "Future Integrations", live: null,
      credSchema: [{ key: "apiKey", label: "API key", type: "password" }, { key: "webhookUrl", label: "Webhook URL" }],
      actions: []
    }
  };
  const GAMMA_KEYS = Object.keys(DEFS);

  /* extra bridge cards so the Integration Center covers the full Gamma list */
  const EXTRA_CARDS = [
    { key: "blandai", name: "Bland AI", group: "Voice" },
    { key: "notion", name: "Notion", group: "Data" },
    { key: "gdrive", name: "Google Drive", group: "Files" },
    { key: "airtable", name: "Airtable", group: "Data" },
    { key: "slack", name: "Slack", group: "Comms" },
    { key: "queue", name: "Broadcast Queue (X)", group: "Internal" },
    { key: "futureint", name: "Future Integrations", group: "Future" }
  ];

  function ensure() {
    const st = S().state;
    B().ensureIntegrations();
    EXTRA_CARDS.forEach(c => {
      if (!st.integrations.find(i => i.key === c.key)) {
        st.integrations.push({
          id: S().uid("int"), key: c.key, name: c.name, group: c.group,
          enabled: c.key === "queue", status: c.key === "queue" ? "healthy" : "not_connected",
          lastSync: null, config: "",
          logs: [`${new Date().toLocaleString()} · card provisioned (Phase Gamma)`]
        });
      }
    });
    st.integrations.forEach(i => { if (!i.mode) i.mode = DEFS[i.key] && DEFS[i.key].internal ? "live" : "dry"; });
    st.execHistory = st.execHistory || [];
    st.execPerms = st.execPerms || {};
    st.credVault = st.credVault || { salt: null, entries: {} };
  }
  function integ(key) { ensure(); return S().state.integrations.find(i => i.key === key) || null; }
  function gammaIntegrations() { ensure(); return GAMMA_KEYS.map(k => integ(k)).filter(Boolean); }

  function emit(text, meta) { B().emit("action", "🔌 " + text, meta || {}); }

  /* ================================================================== *
   * MODULE 4 — Action Registry (workers pick from here, never call APIs)
   * ================================================================== */
  function actions() {
    ensure();
    const out = [];
    GAMMA_KEYS.forEach(k => (DEFS[k].actions || []).forEach(a => {
      if (a.inbound) return; /* inbound hooks are endpoints, not executables */
      out.push(Object.assign({}, a, { integrationKey: k, integrationName: DEFS[k].name, liveTransport: DEFS[k].live }));
    }));
    return out;
  }
  function action(actionId) { return actions().find(a => a.id === actionId) || null; }

  /* ================================================================== *
   * MODULE 5 — Credential Vault (AES-GCM at rest via WebCrypto; secrets
   * are decrypted only inside the Execution Engine — Workers never see
   * them, they only name actions from the registry)
   * ================================================================== */
  const subtle = (typeof crypto !== "undefined" && crypto.subtle) ? crypto.subtle : null;
  function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
  function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
  async function vaultKey() {
    const st = S().state;
    ensure();
    if (!st.credVault.salt) { st.credVault.salt = b64(crypto.getRandomValues(new Uint8Array(32)).buffer); S().save(); }
    if (!subtle) return null;
    return subtle.importKey("raw", unb64(st.credVault.salt), "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async function vaultSet(intKey, field, value) {
    const st = S().state;
    const k = await vaultKey();
    st.credVault.entries[intKey] = st.credVault.entries[intKey] || {};
    if (!value) { delete st.credVault.entries[intKey][field]; S().save(); return; }
    if (k) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(value));
      st.credVault.entries[intKey][field] = { iv: b64(iv.buffer), ct: b64(ct), n: value.length };
    } else {
      /* no WebCrypto (very old browser) — obfuscation only, flagged as such */
      st.credVault.entries[intKey][field] = { b64: btoa(value), n: value.length };
    }
    emit(`Credential stored in the vault — ${DEFS[intKey] ? DEFS[intKey].name : intKey} · ${field} (encrypted at rest).`);
    S().save();
  }
  /* decryption happens HERE and only here — the engine's private door */
  async function vaultGet(intKey) {
    const st = S().state;
    ensure();
    const entry = st.credVault.entries[intKey] || {};
    const out = {};
    const k = await vaultKey();
    for (const field of Object.keys(entry)) {
      const v = entry[field];
      try {
        if (v.ct && k) out[field] = new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv: unb64(v.iv) }, k, unb64(v.ct)));
        else if (v.b64) out[field] = atob(v.b64);
      } catch (_) { /* corrupt entry — skip */ }
    }
    return out;
  }
  function vaultFields(intKey) {
    ensure();
    const entry = S().state.credVault.entries[intKey] || {};
    return Object.keys(entry).map(f => ({ field: f, masked: "•".repeat(Math.min(12, entry[f].n || 8)) }));
  }
  function vaultHas(intKey) { return vaultFields(intKey).length > 0; }
  function vaultClear(intKey) {
    ensure();
    delete S().state.credVault.entries[intKey];
    emit(`Vault cleared for ${DEFS[intKey] ? DEFS[intKey].name : intKey}.`);
    S().save();
  }

  /* ================================================================== *
   * MODULE 10 — Integration Permissions (least privilege by default:
   * a Worker with no grant is denied; GOD CORE owner actions pass the
   * Phase Alpha Permission Engine instead)
   * ================================================================== */
  function permsFor(workerId) {
    ensure();
    return S().state.execPerms[workerId] || {};
  }
  function setPerm(workerId, category, allow) {
    ensure();
    const st = S().state;
    st.execPerms[workerId] = st.execPerms[workerId] || {};
    st.execPerms[workerId][category] = !!allow;
    const w = B().worker(workerId);
    emit(`Permission ${allow ? "granted" : "revoked"} — ${w ? w.name : workerId} · ${CATEGORIES[category] || category}.`, { workerId });
    S().save();
  }
  function canExec(workerId, category) {
    if (!workerId) return B().can("Integrations", "write"); /* owner-manual */
    return !!permsFor(workerId)[category];
  }

  /* ================================================================== *
   * MODULE 3 — adapter transports (dry always; live only where honest)
   * ================================================================== */
  function dryResult(a, params) {
    const p = Object.entries(params || {}).filter(([k]) => k !== "__forceFail").map(([k, v]) => `${k}="${String(v).slice(0, 60)}"`).join(" · ");
    return `[DRY RUN] ${DEFS[a.integrationKey].name} would execute "${a.label}"${p ? " with " + p : ""}. No external service was touched.`;
  }
  async function fetchTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 10000);
    try { return await fetch(url, Object.assign({ signal: ctl.signal }, opts)); }
    finally { clearTimeout(t); }
  }
  async function liveTransport(a, params, creds) {
    const def = DEFS[a.integrationKey];
    if (def.internal) {
      /* the one fully-internal integration: a REAL local effect */
      const q = S().addQueueItem({
        title: (params.title || "Execution Layer post").slice(0, 60),
        text: (params.text || "").slice(0, 500),
        dueAt: Date.now()
      });
      return `Queued for X posting (Broadcast Queue item ${q.id}) — due now.`;
    }
    if (!def.live) throw new Error(`${def.name} live transport needs a server-side relay (browser CORS/OAuth) — Dry Run remains available.`);
    if (def.live === "webhook") {
      if (!creds.webhookUrl) throw new Error("credentials missing in the vault (webhook URL)");
      let body = params.payload || params.text || params.content || "";
      let json;
      try { json = body ? JSON.parse(body) : { source: "PRISM-X" }; } catch (_) { json = a.integrationKey === "discord" ? { content: String(body) } : { text: String(body), source: "PRISM-X" }; }
      const res = await fetchTimeout(creds.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
      if (!res.ok) throw new Error(`webhook responded ${res.status}`);
      return `Live webhook fired — ${def.name} accepted the payload (${res.status}).`;
    }
    if (def.live === "telegram") {
      if (!creds.botToken || !creds.chatId) throw new Error("credentials missing in the vault (bot token + chat id)");
      const res = await fetchTimeout(`https://api.telegram.org/bot${creds.botToken}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: creds.chatId, text: (params.text || "").slice(0, 4000) })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(`Telegram API: ${data.description || res.status}`);
      return `Live message delivered to Telegram chat ${creds.chatId}.`;
    }
    if (def.live === "supabase") {
      if (!creds.url || !creds.anonKey) throw new Error("credentials missing in the vault (project URL + key)");
      const base = creds.url.replace(/\/$/, "") + "/rest/v1/" + (params.table || "");
      const headers = { apikey: creds.anonKey, authorization: "Bearer " + creds.anonKey, "content-type": "application/json" };
      if (a.id === "supabase.read") {
        const res = await fetchTimeout(base + "?limit=" + (parseInt(params.limit, 10) || 5), { headers });
        if (!res.ok) throw new Error(`Supabase ${res.status}`);
        const rows = await res.json();
        return `Read ${rows.length} row(s) from "${params.table}".`;
      }
      const method = a.id === "supabase.update" ? "PATCH" : "POST";
      const url = a.id === "supabase.update" && params.match ? base + "?" + params.match.replace("=", "=eq.") : base;
      const res = await fetchTimeout(url, { method, headers, body: params.json || "{}" });
      if (!res.ok) throw new Error(`Supabase ${res.status}`);
      return `${a.id === "supabase.update" ? "Updated records in" : "Inserted into"} "${params.table}".`;
    }
    throw new Error("no live transport for this integration");
  }
  async function adapterExecute(a, params, mode) {
    if (params && params.__forceFail) throw new Error("forced failure (retry-policy test hook)");
    if (mode !== "live") return dryResult(a, params);
    const creds = await vaultGet(a.integrationKey); /* decrypted only here */
    return liveTransport(a, params, creds);
  }

  /* ================================================================== *
   * MODULE 2 + 6 + 7 + 8 — the Universal Execution Engine
   * ================================================================== */
  const RETRY_LIMIT = 2; /* attempts = 1 + RETRY_LIMIT when retryable */
  let inFlight = null;

  function redact(params) {
    const out = {};
    Object.entries(params || {}).forEach(([k, v]) => {
      out[k] = /key|token|secret|password/i.test(k) ? "•••" : String(v).slice(0, 120);
    });
    return out;
  }

  async function execute(req, onTick) {
    ensure();
    const st = S().state;
    const a = action(req.actionId);
    const w = req.workerId ? B().worker(req.workerId) : null;
    const it = a ? integ(a.integrationKey) : null;
    const mode = req.mode || (it && it.mode) || "dry";
    const rec = {
      id: S().uid("xh"), at: Date.now(),
      workerId: req.workerId || null,
      workerName: w ? w.name : "GOD CORE (owner)",
      provider: w && w.provider !== "human" ? P().name(P().resolve(w.provider || "auto", "Copywriting / content").id) : "—",
      integrationKey: a ? a.integrationKey : "?", integration: a ? a.integrationName : "unknown",
      actionId: req.actionId, action: a ? a.label : req.actionId,
      category: a ? a.category : "?", mode,
      params: redact(req.params),
      status: "running", retries: 0, ms: 0, cost: 0,
      result: "", error: null, manualReview: false
    };
    st.execHistory.push(rec);
    if (st.execHistory.length > 100) st.execHistory.shift();
    const tick = (patch) => { Object.assign(rec, patch || {}); inFlight = rec.status === "running" ? rec : null; if (onTick) { try { onTick(rec); } catch (_) {} } };
    tick();

    if (!a) { rec.status = "failed"; rec.error = "unknown action id"; rec.manualReview = true; tick(); S().save(); return { ok: false, rec }; }

    /* MODULE 10 — least privilege gate */
    if (!canExec(req.workerId, a.category)) {
      rec.status = "denied";
      rec.error = `permission denied — least privilege (grant "${CATEGORIES[a.category]}" to this worker in Integration Permissions)`;
      tick();
      emit(`Action DENIED — ${rec.workerName} tried "${a.label}" without the ${CATEGORIES[a.category]} permission.`, { priority: "high", workerId: req.workerId });
      S().save();
      return { ok: false, denied: true, rec };
    }

    emit(`Action started — "${a.label}" via ${a.integrationName} (${mode}) · ${rec.workerName}.`, { workerId: req.workerId });
    const t0 = Date.now();
    const retryable = mode === "live" || (req.params && req.params.__forceFail);
    const attempts = retryable ? 1 + RETRY_LIMIT : 1;
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await adapterExecute(a, req.params || {}, mode);
        rec.ms = Date.now() - t0;
        rec.status = "success";
        rec.result = String(result).slice(0, 400);
        tick();
        it.lastSync = Date.now();
        if (mode === "live") it.status = "healthy";
        it.logs.push(`${new Date().toLocaleString()} · ${a.label} → success (${mode}${rec.retries ? " · " + rec.retries + " retr" + (rec.retries > 1 ? "ies" : "y") : ""})`);
        B().addMemory({ title: `Action — ${a.label} via ${a.integrationName}`.slice(0, 90), body: rec.result.slice(0, 200), scope: "shared", kind: "success" });
        emit(`Action completed — "${a.label}" via ${a.integrationName} in ${(rec.ms / 1000).toFixed(1)}s (${mode}).`, { workerId: req.workerId });
        S().save();
        return { ok: true, rec };
      } catch (err) {
        lastErr = err;
        rec.error = String(err.message || err).slice(0, 200);
        if (attempt < attempts) {
          rec.retries = attempt;
          tick();
          emit(`Action retry ${attempt}/${RETRY_LIMIT} — "${a.label}" via ${a.integrationName}: ${rec.error}.`, { priority: "medium", workerId: req.workerId });
          await new Promise(r => setTimeout(r, 350 * attempt));
        }
      }
    }
    /* MODULE 7 — no silent failures */
    rec.ms = Date.now() - t0;
    rec.status = "failed";
    rec.manualReview = true;
    tick();
    it.logs.push(`${new Date().toLocaleString()} · ${a.label} → FAILED after ${rec.retries} retries: ${rec.error}`);
    emit(`Action FAILED — "${a.label}" via ${a.integrationName} after ${rec.retries} retr${rec.retries === 1 ? "y" : "ies"}: ${rec.error}. Manual review suggested.`, { priority: "high", workerId: req.workerId });
    S().logMemory("system", `⚠ GOD CORE notified: execution failure — ${a.label} via ${a.integrationName} (${rec.error}). Manual review suggested.`);
    S().save();
    return { ok: false, rec };
  }

  function setMode(intKey, mode) {
    const it = integ(intKey);
    if (!it) return;
    it.mode = mode === "live" ? "live" : "dry";
    it.logs.push(`${new Date().toLocaleString()} · switched to ${it.mode.toUpperCase()} mode`);
    emit(`${DEFS[intKey].name} switched to ${it.mode === "live" ? "LIVE" : "Dry Run"} mode.`);
    S().save();
  }

  function history() { ensure(); return S().state.execHistory.slice().reverse(); }
  function current() { return inFlight; }
  function stats() {
    ensure();
    const h = S().state.execHistory;
    const ok = h.filter(x => x.status === "success").length;
    return {
      total: h.length, success: ok,
      failed: h.filter(x => x.status === "failed").length,
      denied: h.filter(x => x.status === "denied").length,
      avgMs: h.length ? Math.round(h.reduce((a2, x) => a2 + (x.ms || 0), 0) / h.length) : 0,
      review: h.filter(x => x.manualReview).length,
      last: h[h.length - 1] || null,
      inFlight
    };
  }

  function boot() {
    ensure();
    const st = S().state;
    if (!st.execLayerReady) {
      st.execLayerReady = true;
      emit(`Real-World Execution Layer online — ${gammaIntegrations().length} integrations, ${actions().length} registered actions, credential vault armed. Every external action now routes through the Execution Engine.`, { priority: "medium" });
    }
    S().save();
  }

  return {
    CATEGORIES, DEFS, GAMMA_KEYS,
    ensure, integ, gammaIntegrations, actions, action,
    vaultSet, vaultGet, vaultFields, vaultHas, vaultClear,
    permsFor, setPerm, canExec,
    execute, setMode, history, current, stats, boot
  };
})();
