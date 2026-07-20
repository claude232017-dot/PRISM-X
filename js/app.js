/* PRISM-X — app.js
 * Views, router, onboarding, and event wiring. No build step, no backend.
 */
(function () {
  "use strict";
  const D = PRISM.data, E = PRISM.engine, S = PRISM.store, U = PRISM.ui, G = PRISM.ghosts, SH = PRISM.shells, M = PRISM.matrix, B = PRISM.bridge, P = PRISM.providers, RT = PRISM.runtime, X = PRISM.execution, K = PRISM.knowledge, MS = PRISM.missions, EV = PRISM.evolution, EN = PRISM.enterprise, XT = PRISM.extensions, NW = PRISM.network, OM = PRISM.omega;
  const { $, el, esc, fmtMoney, fmtNum, timeAgo, toast } = U;

  /* =============================== router =============================== */
  function route() {
    U.closeModal(); /* navigation always dismisses any open modal */
    const hash = location.hash || "#/dashboard";
    const parts = hash.replace(/^#\//, "").split("/");
    const view = parts[0] || "dashboard";
    $$navActive(view);
    const main = $("#view");
    main.innerHTML = "";
    if (view === "forge") renderForge(main);
    else if (view === "clone" && parts[1]) renderClone(main, parts[1]);
    else if (view === "queue") renderQueue(main);
    else if (view === "ghosts") renderGhostDeck(main);
    else if (view === "ghost-forge") renderGhostForge(main);
    else if (view === "ghost" && parts[1]) renderGhostView(main, parts[1]);
    else if (view === "shells") renderShellDeck(main);
    else if (view === "shell-forge") renderShellForge(main);
    else if (view === "shell" && parts[1]) renderShellView(main, parts[1]);
    else if (view === "matrix") renderMatrix(main);
    else if (view === "bridge") renderBridge(main, parts[1]);
    else if (view === "intelligence") renderIntelligence(main, parts[1]);
    else if (view === "runtime") renderRuntime(main);
    else if (view === "integrations") renderIntegrationCenter(main, parts[1]);
    else if (view === "knowledge") renderKnowledge(main, parts[1]);
    else if (view === "missions") renderMissions(main, parts[1]);
    else if (view === "mission" && parts[1]) renderMissionView(main, parts[1]);
    else if (view === "evolution") renderEvolution(main, parts[1]);
    else if (view === "enterprise") renderEnterprise(main, parts[1]);
    else if (view === "extensions") renderExtensions(main, parts[1]);
    else if (view === "ext" && parts[1] && parts[2]) renderExtensionPage(main, parts[1], parts[2]);
    else if (view === "network") renderNetwork(main, parts[1]);
    else if (view === "production") renderProduction(main, parts[1]);
    else if (view === "worker" && parts[1]) renderWorkerInspector(main, parts[1]);
    else if (view === "memory") renderMemory(main);
    else if (view === "settings") renderSettings(main);
    else renderDashboard(main);
    window.scrollTo(0, 0);
  }

  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  function $$navActive(view) {
    U.$$(".nav-link").forEach(a => {
      const ghostViews = view === "ghost" || view === "ghost-forge" || view === "ghosts";
      const shellViews = view === "shell" || view === "shell-forge" || view === "shells";
      a.classList.toggle("active",
        a.dataset.view === view ||
        (view === "clone" && a.dataset.view === "dashboard") ||
        (view === "worker" && a.dataset.view === "runtime") ||
        (view === "mission" && a.dataset.view === "missions") ||
        (view === "ext" && a.dataset.view === "extensions") ||
        (ghostViews && a.dataset.view === "ghosts") ||
        (shellViews && a.dataset.view === "shells"));
    });
    const s = S.state.settings;
    const pill = $("#engine-pill");
    if (pill) {
      const neural = s.engine === "neural" && s.apiKey;
      pill.textContent = neural ? "◉ NEURAL LINK" : "◉ LOCAL CORTEX";
      pill.className = "engine-pill " + (neural ? "neural" : "local");
      pill.title = neural ? `Live Claude API — ${s.model}` : "Offline template cortex (no API key needed)";
    }
    const bv = $("#brain-version");
    if (bv) bv.textContent = "BRAIN v" + S.state.godBrainVersion;
    const qb = $("#queue-badge");
    if (qb) {
      const due = S.dueQueue().length;
      qb.textContent = due;
      qb.hidden = due === 0;
    }
  }

  /* =============================== helpers =============================== */
  function sumRange(daily, fromDaysAgo, toDaysAgo, field) {
    let sum = 0;
    for (let i = toDaysAgo; i < fromDaysAgo; i++) {
      const key = E.dateKey(new Date(Date.now() - i * 86400000));
      if (daily && daily[key]) sum += daily[key][field] || 0;
    }
    return sum;
  }
  function networkDelta(field) {
    let cur = 0, prev = 0;
    S.state.clones.forEach(c => {
      cur += sumRange(c.daily, 7, 0, field);
      prev += sumRange(c.daily, 14, 7, field);
    });
    return { cur, prev };
  }

  function statusBadge(clone) {
    const st = E.effectiveStatus(clone);
    const meta = D.STATUS_META[st];
    return el("span", { class: "badge " + meta.cls, text: meta.label });
  }

  function avgRating(clone) {
    return clone.stats.ratingCount ? (clone.stats.ratingSum / clone.stats.ratingCount) : 0;
  }

  function confirmDeleteClone(clone, after) {
    U.modal({
      title: `Decommission <span class="gold">${esc(clone.name)}</span>?`,
      body: `<p>This clone, its vault (${clone.vault.length} items) and its task history will be permanently deleted.</p>`,
      actions: [
        { label: "Cancel", cls: "ghost" },
        { label: "Delete Clone", cls: "danger", onClick: () => { S.deleteClone(clone.id); U.sfx("error"); toast(`"${clone.name}" decommissioned.`, "info"); if (after) after(); } }
      ]
    });
  }

  function doReplicate(cloneId) {
    const copy = S.replicate(cloneId);
    if (!copy) { toast("No clone to replicate yet.", "err"); return; }
    U.sfx("spawn"); U.evolveFlash();
    toast(`Replicated → "${copy.name}" (gen ${copy.generation}) enters the grid.`, "ok");
    go("#/clone/" + copy.id);
  }

  /* =============================== dashboard =============================== */
  function renderDashboard(main) {
    const st = S.state;
    const wrap = el("div", { class: "page" });

    /* ---- command header ---- */
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `GOD CORE <span class="dim">// command brain</span>` }),
        el("p", { class: "page-sub", text: `${st.clones.length} clones in the grid · brain v${st.godBrainVersion} · ${st.tasks.length} tasks executed` })
      ]),
      el("div", { class: "head-actions" }, [
        el("button", { class: "btn primary", text: "＋ Clone New Agent", onclick: () => go("#/forge") }),
        el("button", { class: "btn", text: "⧉ Replicate Top Performer", onclick: () => { const top = S.topPerformer(); if (top) doReplicate(top.id); else toast("Forge a clone first.", "err"); } }),
        el("button", { class: "btn", text: "⟳ Push Brain Update", onclick: pushBrainUpdateModal }),
        el("button", { class: "btn gold-btn", text: "◉ Run Weekly Audit", onclick: doAudit })
      ])
    ]));

    /* ---- due broadcasts banner ---- */
    const due = S.dueQueue();
    if (due.length) {
      wrap.appendChild(el("div", { class: "banner" }, [
        el("span", { html: `⌁ <b>${due.length} scheduled post${due.length > 1 ? "s are" : " is"} due.</b> Open the Broadcast Queue to fire.` }),
        el("button", { class: "btn small gold-btn", text: "Open Queue", onclick: () => go("#/queue") })
      ]));
    }

    /* ---- audit due banner ---- */
    if (S.auditDue()) {
      wrap.appendChild(el("div", { class: "banner" }, [
        el("span", { html: `⚡ <b>Weekly clone audit is due.</b> GOD CORE has unanalyzed performance data.` }),
        el("button", { class: "btn small gold-btn", text: "Run Audit Now", onclick: doAudit })
      ]));
    }

    /* ---- KPI tiles ---- */
    const kEarn = networkDelta("earnings"), kLeads = networkDelta("leads"), kTasks = networkDelta("tasks");
    const totals = st.clones.reduce((a, c) => { a.e += c.stats.earnings; a.l += c.stats.leads; a.t += c.stats.tasks; return a; }, { e: 0, l: 0, t: 0 });
    const activeCount = st.clones.filter(c => E.effectiveStatus(c) === "active" || E.effectiveStatus(c) === "learning").length;

    wrap.appendChild(el("div", { class: "kpi-row" }, [
      kpiTile("Total earnings", fmtMoney(totals.e), delta(kEarn, fmtMoney)),
      kpiTile("Leads generated", fmtNum(totals.l), delta(kLeads, fmtNum)),
      kpiTile("Tasks completed", fmtNum(totals.t), delta(kTasks, fmtNum)),
      kpiTile("Active clones", `${activeCount}/${st.clones.length}`, null)
    ]));

    /* ---- chart + analytics ---- */
    const grid = el("div", { class: "dash-grid" });

    const chartCard = el("div", { class: "panel" });
    const metricSel = el("select", { class: "input inline-select", "aria-label": "chart metric" });
    [["earnings", "Earnings"], ["leads", "Leads"], ["tasks", "Tasks"]].forEach(([v, l]) => metricSel.appendChild(el("option", { value: v, text: l })));
    chartCard.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "Network output — last 7 days" }),
      metricSel
    ]));
    const chartBox = el("div", { class: "chart-box" });
    chartCard.appendChild(chartBox);
    function drawChart() {
      const weekly = E.combinedWeekly(st.clones);
      const metric = metricSel.value;
      U.barChart(chartBox, {
        labels: weekly.labels,
        values: weekly[metric],
        seriesName: metricSel.options[metricSel.selectedIndex].text,
        format: metric === "earnings" ? fmtMoney : fmtNum,
        label: "weekly " + metric
      });
    }
    metricSel.addEventListener("change", drawChart);
    grid.appendChild(chartCard);

    /* analytics panel */
    const an = el("div", { class: "panel" });
    an.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Analytics — weekly report" })]));
    const rep = st.lastReport;
    if (rep) {
      const list = el("div", { class: "report-list" });
      if (rep.bestClone) list.appendChild(reportRow("🏆", "Top performer", `${rep.bestClone.name} — ${fmtMoney(rep.bestClone.earnings)} lifetime`));
      if (rep.bestTone) list.appendChild(reportRow("🎙", "Best tone", `${rep.bestTone.tone} (avg ${rep.bestTone.avg}/5)`));
      if (rep.bestLogic) list.appendChild(reportRow("🧠", "Best logic", `${rep.bestLogic.taskType} on "${rep.bestLogic.topic}" — ${rep.bestLogic.rating}/5${rep.bestLogic.cta ? ` · CTA: "${rep.bestLogic.cta}"` : ""}`));
      list.appendChild(reportRow("⏱", "Audited", `${rep.tasksAudited} rated tasks · ${timeAgo(rep.at)}`));
      an.appendChild(list);
    } else {
      an.appendChild(el("p", { class: "empty-note", text: "No audit yet. Rate a few tasks, then run the weekly audit to surface your best-performing logic." }));
    }
    if (st.pendingUpgrade) {
      const up = st.pendingUpgrade;
      an.appendChild(el("div", { class: "upgrade-card" }, [
        el("div", { class: "upgrade-head", html: `⇪ SYSTEM-WIDE UPGRADE PROPOSED <span class="uplift">+${up.uplift}%</span>` }),
        el("p", { class: "upgrade-headline", text: up.headline }),
        el("p", { class: "upgrade-detail", text: up.detail }),
        el("div", { class: "modal-actions" }, [
          el("button", { class: "btn gold-btn", text: "✓ Confirm & Push to All Clones", onclick: () => { const memo = S.confirmUpgrade(); U.evolveFlash(); U.sfx("evolve"); toast("Upgrade pushed — all clones are learning the new logic.", "ok"); route(); } }),
          el("button", { class: "btn ghost", text: "Dismiss", onclick: () => { S.dismissUpgrade(); route(); } })
        ])
      ]));
    }
    grid.appendChild(an);
    wrap.appendChild(grid);

    /* ---- Phase 2 strip: product ghosts ---- */
    const gs = G.stats();
    wrap.appendChild(el("div", { class: "panel ghost-strip" }, [
      el("div", { class: "gs-left" }, [
        el("span", { class: "gs-glyph", text: "👻" }),
        el("div", {}, [
          el("div", { class: "panel-title", text: "Product Ghosts — Phase 2" }),
          el("p", { class: "dim small-note", text: gs.ghosts
            ? `${gs.ghosts} autonomous ghost(s) · ${gs.launched} product(s) launched · ${G.money(gs.revenue)} simulated revenue · ${gs.hitRate}% hit rate`
            : "Autonomous agents that detect niche gaps, build digital products, launch and evolve — without you." })
        ])
      ]),
      el("div", { class: "cc-actions" }, [
        el("button", { class: "btn small violet-btn", text: "👻 Launch Ghost", onclick: () => go("#/ghost-forge") }),
        el("button", { class: "btn small", text: "Open Ghost Deck", onclick: () => go("#/ghosts") })
      ])
    ]));

    /* ---- Phase 3 strip: outer shells ---- */
    const ss = SH.stats();
    wrap.appendChild(el("div", { class: "panel ghost-strip shell-strip" }, [
      el("div", { class: "gs-left" }, [
        el("span", { class: "gs-glyph shell-glyph", text: "🎭" }),
        el("div", {}, [
          el("div", { class: "panel-title", text: "Outer Shells — Phase 3" }),
          el("p", { class: "dim small-note", text: ss.shells
            ? `${ss.shells} faceless brand(s) · ${U.fmtNum(ss.followers)} followers · ${SH.money(ss.income)} attributed income · ${U.fmtNum(ss.emails)} emails`
            : "Faceless content brands that grow audiences and feed traffic back into your ghosts, affiliates and clones." })
        ])
      ]),
      el("div", { class: "cc-actions" }, [
        el("button", { class: "btn small cyan-btn", text: "🎭 Deploy Shell", onclick: () => go("#/shell-forge") }),
        el("button", { class: "btn small", text: "Open Shell Deck", onclick: () => go("#/shells") })
      ])
    ]));

    /* ---- Phase 4 strip: the matrix merge ---- */
    const ms = M.stats();
    wrap.appendChild(el("div", { class: "panel ghost-strip matrix-strip" }, [
      el("div", { class: "gs-left" }, [
        el("span", { class: "gs-glyph matrix-glyph", text: "🧩" }),
        el("div", {}, [
          el("div", { class: "panel-title", text: "The Matrix Merge — Phase 4" }),
          el("p", { class: "dim small-note", text: ms.executors
            ? `${ms.executors} human executor(s) · ${ms.inFlight} task(s) in flight · ${M.money(ms.grossRouted)} routed · ${M.money(ms.vaultBalance)} in the main vault`
            : "Bridge your agents to human executors: closers, editors, designers and VAs — fed by the system, not managed by you." })
        ])
      ]),
      el("div", { class: "cc-actions" }, [
        el("button", { class: "btn small blue-btn", text: "🧩 Open Matrix", onclick: () => go("#/matrix") })
      ])
    ]));

    /* ---- Phase Alpha strip: the bridge ---- */
    const bh = B.health();
    wrap.appendChild(el("div", { class: "panel ghost-strip bridge-strip" }, [
      el("div", { class: "gs-left" }, [
        el("span", { class: "gs-glyph bridge-glyph", text: "⚫" }),
        el("div", {}, [
          el("div", { class: "panel-title", text: "PRISM-X Bridge — Foundation" }),
          el("p", { class: "dim small-note", text: `${bh.bridge === "online" ? "● online" : "◌ init"} · ${bh.workers} workers on one schema · ${bh.events} events logged · ${bh.memory} shared memories · ${bh.integrations.total} integration slots` })
        ])
      ]),
      el("div", { class: "cc-actions" }, [
        el("button", { class: "btn small", text: "⚫ Open Bridge", onclick: () => go("#/bridge") })
      ])
    ]));

    /* ---- Phase Beta strip: the First Intelligence ---- */
    const rts = RT.stats();
    wrap.appendChild(el("div", { class: "panel ghost-strip runtime-strip" }, [
      el("div", { class: "gs-left" }, [
        el("span", { class: "gs-glyph", text: "⚡" }),
        el("div", {}, [
          el("div", { class: "panel-title", text: "First Intelligence — Worker Runtime" }),
          el("p", { class: "dim small-note", text: rts.activated
            ? `${rts.workerName} operational · ${rts.executions} mission(s)${rts.successRate != null ? " · " + rts.successRate + "% success" : ""} · ${rts.pending} queued · ${rts.waiting} awaiting evaluation`
            : "No executable worker yet — activate one clone as the First Intelligence." })
        ])
      ]),
      el("div", { class: "cc-actions" }, [
        el("button", { class: "btn small " + (rts.activated ? "" : "gold-btn"), text: rts.activated ? "⚡ Open Runtime" : "⚡ Activate", onclick: () => go("#/runtime") })
      ])
    ]));

    /* ---- Phase Epsilon strip: mission control ---- */
    const mss = MS.stats();
    wrap.appendChild(el("div", { class: "panel ghost-strip mission-strip" }, [
      el("div", { class: "gs-left" }, [
        el("span", { class: "gs-glyph", text: "🎯" }),
        el("div", {}, [
          el("div", { class: "panel-title", text: "Mission Control — Orchestration" }),
          el("p", { class: "dim small-note", text: mss.total
            ? `${mss.active} active · ${mss.completed} completed · ${mss.outputs} task outputs · ${mss.knowledgeDocs} knowledge doc(s) generated`
            : "No missions yet — hand GOD CORE a high-level objective and it plans the graph." })
        ])
      ]),
      el("div", { class: "cc-actions" }, [
        el("button", { class: "btn small " + (mss.total ? "" : "gold-btn"), text: "🎯 Mission Control", onclick: () => go("#/missions") })
      ])
    ]));

    /* ---- Phase Omega strip: production readiness / guided setup ---- */
    const setup = OM.setupProgress();
    const lastReport = OM.reports()[0];
    wrap.appendChild(el("div", { class: "panel ghost-strip" }, [
      el("div", { class: "gs-left" }, [
        el("span", { class: "gs-glyph", text: "🌌" }),
        el("div", {}, [
          el("div", { class: "panel-title", text: "Production Center — the platform, hardened" }),
          el("p", { class: "dim small-note", text: setup.done < setup.total
            ? `Guided setup ${setup.done}/${setup.total} · ${lastReport ? lastReport.summary : "run the Validation Suite for a readiness report"}`
            : `Setup complete · ${lastReport ? lastReport.summary : "run the Validation Suite to confirm production readiness"}` })
        ])
      ]),
      el("div", { class: "cc-actions" }, [
        el("button", { class: "btn small " + (setup.done < setup.total ? "gold-btn" : ""), text: "🌌 Production Center", onclick: () => go("#/production") })
      ])
    ]));

    /* ---- Phase Theta: extension dashboard widgets ---- */
    const xw = XT.widgets();
    if (xw.length) {
      const wgrid = el("div", { class: "kpi-row xt-widgets" });
      xw.forEach(({ extId, extName, widget }) => {
        const box = el("div", { class: "kpi xt-widget" });
        box.appendChild(el("div", { class: "kpi-label", text: (typeof widget.title === "function" ? widget.title(XT.api(extId)) : widget.title) + " · 📦 " + extName }));
        const mountEl = el("div", { class: "xt-mount" });
        box.appendChild(mountEl);
        try { widget.mount(mountEl, XT.api(extId)); }
        catch (err) { mountEl.appendChild(el("p", { class: "dim tiny-note", text: "widget error: " + err.message })); }
        wgrid.appendChild(box);
      });
      wrap.appendChild(wgrid);
    }

    /* ---- clone grid ---- */
    wrap.appendChild(el("div", { class: "panel-head standalone" }, [
      el("h2", { class: "panel-title", text: "Clone grid" }),
      el("span", { class: "dim small-note", text: "click a card to open its console" })
    ]));

    if (!st.clones.length) {
      wrap.appendChild(el("div", { class: "hero-empty" }, [
        el("div", { class: "hero-glyph", text: "◈" }),
        el("h2", { text: "The grid is empty." }),
        el("p", { text: "Forge your first specialized clone — a DM closer, a copywriter, an offer architect — and put it to work." }),
        el("button", { class: "btn primary big", text: "＋ Forge First Clone", onclick: () => go("#/forge") })
      ]));
    } else {
      const grid2 = el("div", { class: "clone-grid" });
      st.clones.forEach(c => grid2.appendChild(cloneCard(c)));
      wrap.appendChild(grid2);
    }

    main.appendChild(wrap);
    drawChart();
  }

  function kpiTile(label, value, deltaNode) {
    return el("div", { class: "kpi" }, [
      el("div", { class: "kpi-label", text: label }),
      el("div", { class: "kpi-value", text: value }),
      deltaNode || el("div", { class: "kpi-delta dim", text: "—" })
    ]);
  }
  function delta(d, fmt) {
    const diff = d.cur - d.prev;
    if (d.cur === 0 && d.prev === 0) return el("div", { class: "kpi-delta dim", text: "no data this week" });
    const sign = diff >= 0 ? "▲" : "▼";
    const cls = diff >= 0 ? "up" : "down";
    return el("div", { class: "kpi-delta " + cls, text: `${sign} ${fmt(Math.abs(diff))} vs prev 7d` });
  }
  function reportRow(icon, label, text) {
    return el("div", { class: "report-row" }, [
      el("span", { class: "report-ico", text: icon }),
      el("div", {}, [el("div", { class: "report-label", text: label }), el("div", { class: "report-text", text })])
    ]);
  }

  function cloneCard(c) {
    const role = D.ROLES[c.role] || { icon: "◈" };
    const isLearning = E.effectiveStatus(c) === "learning";
    const weekly = E.weeklySeries(c.daily).earnings;
    const card = el("div", {
      class: "clone-card" + (isLearning ? " evolving" : ""),
      onclick: (e) => { if (e.target.closest("button")) return; go("#/clone/" + c.id); }
    }, [
      el("div", { class: "cc-top" }, [
        el("div", { class: "cc-ident" }, [
          el("span", { class: "cc-icon", text: role.icon }),
          el("div", {}, [
            el("div", { class: "cc-name", text: c.name + (c.generation > 1 ? ` · G${c.generation}` : "") }),
            el("div", { class: "cc-role", text: `${c.role} · ${c.tone}` })
          ])
        ]),
        statusBadge(c)
      ]),
      c.target ? el("div", { class: "cc-target", text: "◎ " + c.target }) : null,
      el("div", { class: "cc-metrics" }, [
        ccMetric("EARNED", fmtMoney(c.stats.earnings)),
        ccMetric("LEADS", fmtNum(c.stats.leads)),
        ccMetric("TASKS", fmtNum(c.stats.tasks)),
        ccMetric("SCORE", avgRating(c) ? avgRating(c).toFixed(1) + "★" : "—")
      ]),
      el("div", { class: "cc-foot" }, [
        U.sparkline(weekly),
        el("div", { class: "cc-actions" }, [
          el("button", { class: "btn small", text: "Console", onclick: () => go("#/clone/" + c.id) }),
          el("button", { class: "btn small ghost", text: "⧉", title: "Replicate", onclick: () => doReplicate(c.id) }),
          el("button", { class: "btn small danger ghost", text: "✕", title: "Delete", onclick: () => confirmDeleteClone(c, route) })
        ])
      ])
    ].filter(Boolean));
    return card;
  }
  function ccMetric(label, value) {
    return el("div", { class: "cc-metric" }, [el("div", { class: "cc-mv", text: value }), el("div", { class: "cc-ml", text: label })]);
  }

  /* ---- audit + brain update ---- */
  function doAudit() {
    const res = S.runAudit();
    if (!res.ok) { toast(res.reason, "err"); return; }
    U.sfx("evolve");
    route(); /* refresh analytics panel — proposal card renders there */
    toast("Audit complete — report ready in the analytics panel.", "ok");
  }

  function pushBrainUpdateModal() {
    const ta = U.el("textarea", { class: "input", rows: 3, placeholder: `e.g. "All clones now lead with proof before the pitch." or a new default CTA…` });
    U.modal({
      title: "⟳ Push Brain Update to All Clones",
      body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(el("p", { text: "Broadcast a directive to every clone in the grid. It becomes part of their working memory and bumps the network brain version." })); b.appendChild(ta); return b; })(),
      actions: [
        { label: "Cancel", cls: "ghost" },
        {
          label: "Push Update", cls: "gold-btn", keepOpen: true, onClick: () => {
            const text = ta.value.trim();
            if (!text) { toast("Write the directive first.", "err"); return; }
            U.closeModal();
            S.state.godBrainVersion += 1;
            const v = S.state.godBrainVersion;
            S.state.clones.forEach(c => { c.brainVersion = v; c.memory.push(`Brain v${v} directive: ${text}`); c.learnUntil = Date.now() + 45000; });
            S.logMemory("upgrade", `Brain v${v} pushed manually: ${text}`);
            S.save();
            U.evolveFlash(); U.sfx("evolve");
            toast(`Brain v${v} pushed to ${S.state.clones.length} clone(s).`, "ok");
            route();
          }
        }
      ]
    });
  }

  /* =============================== forge =============================== */
  function renderForge(main) {
    const wrap = el("div", { class: "page narrow" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `CLONE FORGE <span class="dim">// deploy a new agent</span>` }),
        el("p", { class: "page-sub", text: "Define its mission, style and strategy. It inherits GOD CORE DNA the moment it wakes." })
      ])
    ]));

    const f = {};
    const form = el("div", { class: "panel form-panel" });

    form.appendChild(field("Clone name", f, "name", el("input", { class: "input", placeholder: "e.g. APEX, QUILL, VULCAN…", maxlength: 24 })));

    const roleSel = el("select", { class: "input" });
    Object.keys(D.ROLES).forEach(r => roleSel.appendChild(el("option", { value: r, text: `${D.ROLES[r].icon}  ${r} — ${D.ROLES[r].blurb}` })));
    form.appendChild(field("Role", f, "role", roleSel));

    form.appendChild(field("Target output", f, "target", el("input", { class: "input", placeholder: "e.g. $3k/month · 50 leads/week · 1k followers/month" })));

    const toneSel = el("select", { class: "input" });
    Object.entries(D.TONES).forEach(([t, meta]) => toneSel.appendChild(el("option", { value: t, text: `${t} — ${meta.desc}` })));
    form.appendChild(field("Tone", f, "tone", toneSel));

    form.appendChild(field("Mindset rules", f, "mindset", el("textarea", { class: "input", rows: 3, placeholder: "Custom behavior, one rule per line.\ne.g. Never discount. Always ask one question before pitching." })));

    form.appendChild(field("Skill / tool focus", f, "skills", el("input", { class: "input", placeholder: "e.g. Twitter DMs, Gumroad, Uniswap, Notion" })));

    const srcSel = el("select", { class: "input" });
    D.LEARNING_SOURCES.forEach(s => srcSel.appendChild(el("option", { value: s, text: s })));
    form.appendChild(field("Learning source", f, "learningSource", srcSel));

    form.appendChild(providerField(f));

    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn ghost", text: "Cancel", onclick: () => go("#/dashboard") }),
      el("button", {
        class: "btn primary big", text: "⚡ Launch Clone", onclick: () => {
          const name = f.name.value.trim();
          if (!name) { toast("Name your clone.", "err"); f.name.focus(); return; }
          if (S.state.clones.some(c => c.name.toLowerCase() === name.toLowerCase())) { toast("A clone with that name already exists.", "err"); return; }
          const clone = S.addClone({
            name: name.toUpperCase(), role: f.role.value, target: f.target.value.trim(),
            tone: f.tone.value, mindset: f.mindset.value.trim(), skills: f.skills.value.trim(),
            learningSource: f.learningSource.value, provider: f.provider.value
          });
          U.sfx("spawn"); U.evolveFlash();
          toast(`"${clone.name}" is online — ready for tasks.`, "ok");
          go("#/clone/" + clone.id);
        }
      })
    ]));

    wrap.appendChild(form);
    main.appendChild(wrap);
  }

  function field(label, refs, key, input) {
    refs[key] = input;
    return el("label", { class: "field" }, [el("span", { class: "field-label", text: label }), input]);
  }

  /* Phase H0 (Module 4): every AI Worker carries an Intelligence Provider field. */
  function providerField(refs) {
    const sel = el("select", { class: "input" });
    P.PROVIDER_OPTIONS.forEach(([v, l]) => sel.appendChild(el("option", { value: v, text: l })));
    refs.provider = sel;
    return el("label", { class: "field" }, [
      el("span", { class: "field-label", text: "Intelligence Provider" }),
      sel,
      el("span", { class: "dim tiny-note", text: P.FIELD_DESC })
    ]);
  }

  /* =============================== clone console =============================== */
  function renderClone(main, id) {
    const clone = S.state.clones.find(c => c.id === id);
    if (!clone) { go("#/dashboard"); return; }
    const role = D.ROLES[clone.role] || { icon: "◈", taskTypes: [] };
    const wrap = el("div", { class: "page" });

    /* ---- header ---- */
    const statsStrip = el("div", { class: "stat-strip" });
    function drawStats() {
      statsStrip.innerHTML = "";
      [["EARNED", fmtMoney(clone.stats.earnings)], ["LEADS", fmtNum(clone.stats.leads)], ["TASKS", fmtNum(clone.stats.tasks)],
       ["SCORE", avgRating(clone) ? avgRating(clone).toFixed(1) + "★" : "—"], ["BRAIN", "v" + clone.brainVersion], ["LAST RUN", timeAgo(clone.lastTaskAt)]]
        .forEach(([l, v]) => statsStrip.appendChild(ccMetric(l, v)));
    }
    drawStats();

    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "back-link", href: "#/dashboard", text: "← grid" }),
        el("h1", { class: "page-title clone-title" }, [
          el("span", { class: "cc-icon big", text: role.icon }),
          el("span", { text: ` ${clone.name}${clone.generation > 1 ? " · G" + clone.generation : ""} ` }),
          statusBadge(clone)
        ]),
        el("p", { class: "page-sub", text: `${clone.role} · ${clone.tone} · ${clone.learningSource}${clone.target ? " · ◎ " + clone.target : ""}` })
      ]),
      el("div", { class: "head-actions" }, [
        el("button", { class: "btn", text: "⧉ Replicate", onclick: () => doReplicate(clone.id) }),
        el("button", { class: "btn danger ghost", text: "✕ Delete", onclick: () => confirmDeleteClone(clone, () => go("#/dashboard")) })
      ])
    ]));
    wrap.appendChild(statsStrip);

    const cols = el("div", { class: "clone-cols" });

    /* ---- left column: task console ---- */
    const left = el("div", { class: "col" });
    const taskPanel = el("div", { class: "panel" });
    taskPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "▸ Task console" })]));

    const f = {};
    const typeSel = el("select", { class: "input" });
    const og1 = el("optgroup", { label: `${clone.role} specialty` });
    role.taskTypes.forEach(t => og1.appendChild(el("option", { value: t, text: t })));
    typeSel.appendChild(og1);
    const og2 = el("optgroup", { label: "Cross-training" });
    Object.entries(D.ROLES).forEach(([rName, r]) => {
      if (rName === clone.role) return;
      r.taskTypes.forEach(t => og2.appendChild(el("option", { value: t, text: `${t} (${rName})` })));
    });
    typeSel.appendChild(og2);
    taskPanel.appendChild(field("Task type", f, "type", typeSel));
    taskPanel.appendChild(field("Topic / product / goal", f, "topic", el("input", { class: "input", placeholder: "e.g. ghostwriting retainer, notion template drop…" })));
    taskPanel.appendChild(field("Target outcome", f, "outcome", el("input", { class: "input", placeholder: "e.g. 10 booked calls, $2k launch weekend" })));

    const extra = el("details", { class: "extra-fields" }, [
      el("summary", { text: "Optional targeting — objection · niche · urgency" }),
      field("Audience objection", f, "objection", el("input", { class: "input", placeholder: `e.g. "it's too expensive"` })),
      field("Niche", f, "niche", el("input", { class: "input", placeholder: "e.g. fitness coaches, indie SaaS" })),
      (() => {
        const s = el("select", { class: "input" });
        [["", "— none —"], ["high", "High — deadline is real"], ["medium", "Medium — soft scarcity"], ["low", "Low — evergreen"]].forEach(([v, t]) => s.appendChild(el("option", { value: v, text: t })));
        return field("Time urgency", f, "urgency", s);
      })()
    ]);
    taskPanel.appendChild(extra);

    /* collaboration partner */
    const partnerSel = el("select", { class: "input" });
    partnerSel.appendChild(el("option", { value: "", text: "— solo run —" }));
    S.state.clones.filter(c => c.id !== clone.id).forEach(c => partnerSel.appendChild(el("option", { value: c.id, text: `${c.name} (${c.role}) drafts the asset first` })));
    taskPanel.appendChild(field("Collaborate with", f, "partner", partnerSel));

    const repeatWrap = el("label", { class: "check-row" }, [
      el("input", { type: "checkbox", id: "repeat-weekly" }),
      el("span", { text: "⟲ Repeat weekly — GOD CORE re-runs this task every 7 days automatically" })
    ]);
    taskPanel.appendChild(repeatWrap);

    const execBtn = el("button", { class: "btn primary big full", text: "⚡ Execute Task" });
    taskPanel.appendChild(execBtn);
    left.appendChild(taskPanel);

    /* output area */
    const outputBox = el("div", { id: "task-output" });
    left.appendChild(outputBox);

    /* task history */
    const histPanel = el("div", { class: "panel" });
    histPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Task history" })]));
    const histList = el("div", { class: "hist-list" });
    function drawHistory() {
      histList.innerHTML = "";
      const tasks = S.state.tasks.filter(t => t.cloneId === clone.id).slice(-12).reverse();
      if (!tasks.length) histList.appendChild(el("p", { class: "empty-note", text: "No tasks yet — give this clone its first mission above." }));
      tasks.forEach(t => {
        histList.appendChild(el("div", {
          class: "hist-row", onclick: () => showOutput(t, clone, { drawStats, drawHistory, drawVault })
        }, [
          el("span", { class: "hist-type", text: t.type }),
          el("span", { class: "hist-topic", text: t.topic }),
          el("span", { class: "hist-meta", text: `${t.repeatWeekly ? "⟲ " : ""}${t.rating ? t.rating + "★" : "unrated"} · ${timeAgo(t.createdAt)}` })
        ]));
      });
    }
    drawHistory();
    histPanel.appendChild(histList);
    left.appendChild(histPanel);

    /* ---- right column: vault + memory ---- */
    const right = el("div", { class: "col" });

    const vaultPanel = el("div", { class: "panel" });
    vaultPanel.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "⛃ Clone vault" }),
      el("span", { class: "dim small-note", text: "everything it produces, saved" })
    ]));
    const tabs = el("div", { class: "vault-tabs" });
    let vaultFilter = "all";
    const tabDefs = [["all", "All"]].concat(Object.entries(D.VAULT_TYPES));
    tabDefs.forEach(([k, label]) => {
      tabs.appendChild(el("button", {
        class: "vtab" + (k === "all" ? " on" : ""), text: label, "data-k": k,
        onclick: (e) => { vaultFilter = k; U.$$(".vtab", tabs).forEach(b => b.classList.toggle("on", b.dataset.k === k)); drawVault(); }
      }));
    });
    vaultPanel.appendChild(tabs);
    const vaultList = el("div", { class: "vault-list" });
    vaultPanel.appendChild(vaultList);

    function drawVault() {
      vaultList.innerHTML = "";
      const items = clone.vault.filter(v => vaultFilter === "all" || v.type === vaultFilter).slice().reverse();
      if (!items.length) { vaultList.appendChild(el("p", { class: "empty-note", text: "Vault is empty in this category." })); return; }
      items.forEach(item => {
        vaultList.appendChild(el("div", { class: "vault-item" }, [
          el("div", { class: "vi-head", onclick: () => vaultItemModal(clone, item, drawVault) }, [
            el("span", { class: "vi-type", text: D.VAULT_TYPES[item.type] || item.type }),
            el("span", { class: "vi-title", text: item.title }),
            el("span", { class: "vi-meta", text: (item.rating ? item.rating + "★ · " : "") + timeAgo(item.createdAt) })
          ]),
          el("div", { class: "vi-actions" }, [
            el("button", { class: "btn tiny", text: "Copy", title: "Copy as markdown (paste into Notion)", onclick: () => U.copyText(vaultMarkdown(clone, item), "Copied as markdown — paste into Notion.") }),
            el("button", { class: "btn tiny", text: "PDF", onclick: () => U.pdfExport(`${clone.name} — ${item.title}`, item.body) }),
            el("button", { class: "btn tiny", text: "Email", onclick: () => U.emailExport(`[PRISM-X] ${item.title}`, item.body) }),
            el("button", { class: "btn tiny", text: "Post ↗", title: "Share to X", onclick: () => U.shareToX(item.body) }),
            el("button", { class: "btn tiny", text: "⌁", title: "Schedule for X (Broadcast Queue)", onclick: () => scheduleModal(clone, item.title, firstArtifactChunk(item.body)) }),
            el("button", { class: "btn tiny danger ghost", text: "✕", onclick: () => { S.deleteVaultItem(clone.id, item.id); drawVault(); } })
          ])
        ]));
      });
    }
    drawVault();
    right.appendChild(vaultPanel);

    /* memory panel */
    const memPanel = el("div", { class: "panel" });
    memPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "◌ Working memory" })]));
    const memList = el("div", { class: "mem-list" });
    const memories = clone.memory.slice(-10).reverse();
    if (!memories.length) memList.appendChild(el("p", { class: "empty-note", text: "Nothing learned yet. Use “Learn from This” on strong outputs." }));
    memories.forEach(m => memList.appendChild(el("div", { class: "mem-chip", text: m })));
    memPanel.appendChild(memList);
    right.appendChild(memPanel);

    cols.appendChild(left);
    cols.appendChild(right);
    wrap.appendChild(cols);
    main.appendChild(wrap);

    /* ---- execute wiring ---- */
    execBtn.addEventListener("click", async () => {
      const topic = f.topic.value.trim();
      if (!topic) { toast("Give the task a topic / product / goal.", "err"); f.topic.focus(); return; }
      execBtn.disabled = true;
      execBtn.textContent = "◈ SYNTHESIZING…";
      U.sfx("click");
      try {
        const input = {
          cloneId: clone.id,
          partnerId: f.partner.value || null,
          type: f.type.value, topic,
          outcome: f.outcome.value.trim(),
          objection: f.objection.value.trim(),
          niche: f.niche.value.trim(),
          urgency: f.urgency.value,
          repeatWeekly: $("#repeat-weekly").checked
        };

        let result;
        const partner = input.partnerId ? S.state.clones.find(c => c.id === input.partnerId) : null;
        if (partner) {
          /* collaboration: partner drafts with its own role/tone, this clone executes */
          const draft = await E.generate(partner, input, S.state.dna, S.state.settings);
          const main2 = await E.generate(clone, input, S.state.dna, S.state.settings);
          result = {
            engine: main2.engine,
            cta: main2.cta || draft.cta,
            text: [
              `◆ COLLAB DRAFT — ${partner.name} (${partner.role})`, "",
              draft.text, "",
              `◆ EXECUTION — ${clone.name} (${clone.role})`, "",
              main2.text
            ].join("\n")
          };
          partner.memory.push(`Collab: drafted ${input.type} on "${topic}" for ${clone.name}.`);
        } else {
          result = await E.generate(clone, input, S.state.dna, S.state.settings);
        }

        const task = S.addTask(input, result);
        S.addVaultItem(clone.id, D.TASK_VAULT[input.type] || "content", `${input.type} — ${topic}`, result.text, task);
        clone.lastTaskAt = Date.now();
        S.save();
        if (result.fallback) toast("Neural Link failed — Local Cortex answered instead.", "err");
        U.sfx("spawn");
        showOutput(task, clone, { drawStats, drawHistory, drawVault });
        drawHistory(); drawVault(); drawStats();
      } catch (err) {
        console.error(err);
        toast("Task failed: " + err.message, "err");
      } finally {
        execBtn.disabled = false;
        execBtn.textContent = "⚡ Execute Task";
      }
    });

    /* show most recent output on load */
    const last = S.state.tasks.filter(t => t.cloneId === clone.id).slice(-1)[0];
    if (last) showOutput(last, clone, { drawStats, drawHistory, drawVault });
  }

  /* ---- output card (result + feedback + toggles + export) ---- */
  function showOutput(task, clone, redraw) {
    const box = $("#task-output");
    if (!box) return;
    box.innerHTML = "";

    const card = el("div", { class: "panel output-card glow-in" });
    card.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: `◈ ${task.type} — ${task.topic}` }),
      el("span", { class: "engine-tag " + task.engine, text: task.engine === "neural" ? "NEURAL LINK" : "LOCAL CORTEX" })
    ]));
    card.appendChild(el("pre", { class: "output-pre", text: task.output }));

    /* feedback row */
    const fb = el("div", { class: "feedback-row" });
    fb.appendChild(el("span", { class: "fb-label", text: "Feedback score" }));
    const starsWrap = el("span", {});
    function drawStars() {
      starsWrap.innerHTML = "";
      starsWrap.appendChild(U.stars(task.rating, (n) => {
        const wasUnrated = task.rating === 0;
        S.rateTask(task.id, n);
        U.sfx("rate");
        if (wasUnrated && task.simLeads != null) {
          toast(`Logged: +${task.simLeads} leads${task.simEarnings ? ` · +${fmtMoney(task.simEarnings)}` : ""} attributed to ${clone.name}.`, "ok");
        }
        drawStars();
        if (redraw) { redraw.drawStats(); redraw.drawHistory(); }
      }));
    }
    drawStars();
    fb.appendChild(starsWrap);
    card.appendChild(fb);

    /* toggles */
    const togglesRow = el("div", { class: "toggle-row" });
    togglesRow.appendChild(toggleChip("◌ Learn from This", task.learn, (v) => { S.setTaskFlag(task.id, "learn", v); if (v) { toast(`${clone.name} committed this to memory.`, "ok"); if (redraw) redraw.drawVault(); } }));
    togglesRow.appendChild(toggleChip("⇪ Send to GOD CORE", task.shared, (v) => { S.setTaskFlag(task.id, "shared", v); if (v) { U.sfx("evolve"); toast("Logic broadcast to all clones via GOD CORE.", "ok"); } }));
    togglesRow.appendChild(toggleChip("⟲ Repeat Weekly", task.repeatWeekly, (v) => { S.setTaskFlag(task.id, "repeatWeekly", v); toast(v ? "Scheduled — re-runs every 7 days." : "Weekly repeat off.", "info"); }));
    card.appendChild(togglesRow);

    /* export row */
    card.appendChild(el("div", { class: "export-row" }, [
      el("span", { class: "fb-label", text: "Export" }),
      el("button", { class: "btn tiny", text: "Copy for Notion", onclick: () => U.copyText(taskMarkdown(clone, task), "Copied as markdown — paste into Notion.") }),
      el("button", { class: "btn tiny", text: "Local PDF", onclick: () => U.pdfExport(`${clone.name} — ${task.type}: ${task.topic}`, task.output) }),
      el("button", { class: "btn tiny", text: "Email", onclick: () => U.emailExport(`[PRISM-X] ${task.type} — ${task.topic}`, task.output) }),
      el("button", { class: "btn tiny", text: "Post to X ↗", onclick: () => U.shareToX(firstArtifactChunk(task.output)) }),
      el("button", { class: "btn tiny gold-btn", text: "⌁ Schedule", title: "Add to Broadcast Queue", onclick: () => scheduleModal(clone, `${task.type} — ${task.topic}`, firstArtifactChunk(task.output)) })
    ]));

    box.appendChild(card);
  }

  function toggleChip(label, initial, onChange) {
    const b = el("button", { class: "toggle-chip" + (initial ? " on" : ""), text: label });
    b.addEventListener("click", () => {
      const on = !b.classList.contains("on");
      b.classList.toggle("on", on);
      onChange(on);
    });
    return b;
  }

  function firstArtifactChunk(text) {
    const cut = text.indexOf("── EXECUTION PLAN ──");
    const chunk = cut > 0 ? text.slice(0, cut) : text;
    return chunk.replace(/^▸.*\n+/, "").trim().slice(0, 270);
  }

  function taskMarkdown(clone, task) {
    return [
      `# ${task.type} — ${task.topic}`,
      `> Clone: **${clone.name}** (${clone.role}, ${clone.tone}) · ${new Date(task.createdAt).toLocaleString()}${task.rating ? ` · rated ${task.rating}/5` : ""}`,
      "", "```", task.output, "```"
    ].join("\n");
  }
  function vaultMarkdown(clone, item) {
    return [
      `# ${item.title}`,
      `> Vault: ${D.VAULT_TYPES[item.type] || item.type} · Clone: **${clone.name}** · ${new Date(item.createdAt).toLocaleString()}`,
      "", "```", item.body, "```"
    ].join("\n");
  }

  function vaultItemModal(clone, item, after) {
    U.modal({
      title: `⛃ ${esc(item.title)}`,
      cls: "wide",
      body: (() => {
        const b = el("div", { class: "modal-body" });
        b.appendChild(el("pre", { class: "output-pre", text: item.body }));
        return b;
      })(),
      actions: [
        { label: "Copy for Notion", onClick: () => U.copyText(vaultMarkdown(clone, item), "Copied as markdown.") },
        { label: "Local PDF", onClick: () => U.pdfExport(`${clone.name} — ${item.title}`, item.body) },
        { label: "Close", cls: "ghost" }
      ]
    });
  }

  /* =============================== broadcast queue =============================== */
  function dtLocalValue(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtDue(ts) {
    return new Date(ts).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function scheduleModal(clone, title, text) {
    const ta = el("textarea", { class: "input", rows: 5, maxlength: 270 });
    ta.value = text.slice(0, 270);
    const tomorrow9 = new Date();
    tomorrow9.setDate(tomorrow9.getDate() + 1);
    tomorrow9.setHours(9, 0, 0, 0);
    const when = el("input", { class: "input", type: "datetime-local", value: dtLocalValue(tomorrow9.getTime()) });
    const body = el("div", { class: "modal-body" }, [
      el("p", { text: "Post text (X limit, editable):" }), ta,
      el("p", { style: "margin-top:12px", text: "Fire at:" }), when
    ]);
    U.modal({
      title: `⌁ Schedule for X — <span class="gold">${esc(title)}</span>`,
      body,
      actions: [
        { label: "Cancel", cls: "ghost" },
        {
          label: "Add to Broadcast Queue", cls: "gold-btn", keepOpen: true, onClick: () => {
            const t = ta.value.trim();
            const dueAt = when.value ? new Date(when.value).getTime() : NaN;
            if (!t) { toast("Post text is empty.", "err"); return; }
            if (!isFinite(dueAt)) { toast("Pick a valid date and time.", "err"); return; }
            U.closeModal();
            S.addQueueItem({ cloneId: clone ? clone.id : null, title, text: t, dueAt });
            U.sfx("click");
            toast(`Queued for ${fmtDue(dueAt)}.`, "ok");
            $$navActive("queue-refresh");
          }
        }
      ]
    });
  }

  function renderQueue(main) {
    const st = S.state;
    const wrap = el("div", { class: "page narrow" });
    const queued = st.queue.filter(q => q.status === "queued").sort((a, b) => a.dueAt - b.dueAt);
    const posted = st.queue.filter(q => q.status === "posted").sort((a, b) => b.postedAt - a.postedAt).slice(0, 10);

    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `BROADCAST QUEUE <span class="dim">// scheduled posts</span>` }),
        el("p", { class: "page-sub", text: `${queued.length} queued · ${posted.length} recently posted. Due posts fire to X in one click — this app is serverless, so nothing posts without you.` })
      ])
    ]));

    const qPanel = el("div", { class: "panel" });
    qPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "⌁ Queued" })]));
    if (!queued.length) {
      qPanel.appendChild(el("p", { class: "empty-note", text: "Nothing scheduled. Use “Schedule ↗” on any task output or vault item." }));
    }
    queued.forEach(q => {
      const isDue = q.dueAt <= Date.now();
      const clone = st.clones.find(c => c.id === q.cloneId);
      qPanel.appendChild(el("div", { class: "queue-row" + (isDue ? " due" : "") }, [
        el("div", { class: "q-when" }, [
          el("span", { class: "q-due" + (isDue ? " hot" : ""), text: isDue ? "DUE NOW" : fmtDue(q.dueAt) })
        ]),
        el("div", { class: "q-main" }, [
          el("div", { class: "q-title", text: q.title + (clone ? ` · ${clone.name}` : "") }),
          el("div", { class: "q-snippet", text: q.text })
        ]),
        el("div", { class: "q-actions" }, [
          el("button", {
            class: "btn tiny" + (isDue ? " gold-btn" : ""), text: "Post to X ↗", onclick: () => {
              U.shareToX(q.text);
              S.markPosted(q.id);
              U.sfx("evolve");
              toast("Fired — marked as posted.", "ok");
              route();
            }
          }),
          el("button", {
            class: "btn tiny ghost", text: "Reschedule", onclick: () => {
              const when = el("input", { class: "input", type: "datetime-local", value: dtLocalValue(q.dueAt) });
              U.modal({
                title: "Reschedule",
                body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(when); return b; })(),
                actions: [
                  { label: "Cancel", cls: "ghost" },
                  {
                    label: "Save", cls: "gold-btn", keepOpen: true, onClick: () => {
                      const t2 = when.value ? new Date(when.value).getTime() : NaN;
                      if (!isFinite(t2)) { toast("Pick a valid date and time.", "err"); return; }
                      U.closeModal();
                      q.dueAt = t2; S.save(); route();
                    }
                  }
                ]
              });
            }
          }),
          el("button", { class: "btn tiny danger ghost", text: "✕", onclick: () => { S.deleteQueueItem(q.id); route(); } })
        ])
      ]));
    });
    wrap.appendChild(qPanel);

    if (posted.length) {
      const pPanel = el("div", { class: "panel" });
      pPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Posted" })]));
      posted.forEach(q => {
        pPanel.appendChild(el("div", { class: "queue-row posted" }, [
          el("div", { class: "q-when" }, [el("span", { class: "q-due", text: fmtDue(q.postedAt) })]),
          el("div", { class: "q-main" }, [
            el("div", { class: "q-title", text: q.title }),
            el("div", { class: "q-snippet", text: q.text })
          ]),
          el("div", { class: "q-actions" }, [
            el("button", { class: "btn tiny ghost", text: "Repost ↗", onclick: () => U.shareToX(q.text) }),
            el("button", { class: "btn tiny danger ghost", text: "✕", onclick: () => { S.deleteQueueItem(q.id); route(); } })
          ])
        ]));
      });
      wrap.appendChild(pPanel);
    }

    main.appendChild(wrap);
  }

  /* =============================== PHASE 2: PRODUCT GHOSTS =============================== */
  let forgePrefill = null;

  function ghostBadge(g) {
    const st = G.ghostStatus(g);
    return el("span", { class: "badge " + st.cls, text: st.label });
  }

  function renderGhostDeck(main) {
    const st = S.state;
    const wrap = el("div", { class: "page" });
    const stats = G.stats();
    const offDays = Math.round((st.ghostSimOffset || 0) / 86400000);

    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `PRODUCT GHOSTS <span class="dim">// phase 2 — autonomous product agents</span>` }),
        el("p", { class: "page-sub", text: `${stats.ghosts} ghosts haunting ${new Set(st.ghosts.filter(g => g.merged !== "absorbed").map(g => g.niche)).size} niches · ${stats.launched} products launched` })
      ]),
      el("div", { class: "head-actions" }, [
        el("button", { class: "btn violet-btn", text: "👻 Launch Product Ghost", onclick: () => go("#/ghost-forge") }),
        el("button", { class: "btn", text: "🌀 Clone Best Seller", onclick: () => {
          const sub = G.cloneBestSeller();
          if (!sub) { toast("No best seller yet — a product has to hit its target first.", "err"); return; }
          U.sfx("spawn"); U.evolveFlash();
          toast(`Best seller cloned → sub-ghost ${sub.name} enters a fresh niche.`, "ok"); route();
        } }),
        el("button", { class: "btn", text: "📈 Auto-Relaunch Failed", onclick: async () => {
          const done = await G.relaunchFailed();
          if (!done.length) { toast("No retired products to relaunch.", "err"); return; }
          U.sfx("evolve");
          toast(`${done.length} product(s) relaunched with new angle + urgency headline.`, "ok"); route();
        } }),
        el("button", { class: "btn", text: "🚀 Launch Calendar", onclick: scheduleGhostCalendar }),
        el("button", { class: "btn", text: "💡 Creation Report", onclick: ghostReportModal }),
        el("button", { class: "btn", text: "🤖 Merge → SuperAgent", onclick: mergeModal })
      ])
    ]));

    /* GOD CORE directive */
    wrap.appendChild(el("div", { class: "directive-banner" }, [
      el("div", { class: "directive-label", text: "GOD CORE DIRECTIVE" }),
      el("p", { class: "directive-text", text: "“Every Product Ghost must generate, test, and launch at least one monetized digital product per week. Each must operate in a different niche, collect its own market data, and report back to the GOD CORE.”" })
    ]));

    /* KPIs + sim clock */
    wrap.appendChild(el("div", { class: "kpi-row" }, [
      kpiTile("Ghost revenue (simulated)", G.money(stats.revenue), null),
      kpiTile("Products launched", String(stats.launched), null),
      kpiTile("Hit rate", stats.launched ? stats.hitRate + "%" : "—", null),
      kpiTile("Active ghosts", String(stats.ghosts), null)
    ]));
    wrap.appendChild(el("div", { class: "sim-clock" }, [
      el("span", { class: "dim", text: `Market simulation clock: ${offDays ? "+" + offDays + " day(s)" : "real time"} · products track for ${G.TRACK_DAYS} days after launch` }),
      el("span", {}, [
        el("button", { class: "btn tiny", text: "⏩ +1 day", onclick: () => ffDays(1) }),
        el("button", { class: "btn tiny", text: "⏭ +7 days", onclick: () => ffDays(7), style: "margin-left:6px" })
      ])
    ]));

    if (!st.ghosts.length) {
      wrap.appendChild(el("div", { class: "hero-empty violet-hero" }, [
        el("div", { class: "hero-glyph violet", text: "👻" }),
        el("h2", { text: "No ghosts in the machine — yet." }),
        el("p", { text: "Product Ghosts detect niche pain points, build a digital product with full launch assets, ship it, track it for 7 days, and evolve on their own. Deploy one from a battle-tested template." }),
        el("button", { class: "btn violet-btn big", text: "👻 Launch First Product Ghost", onclick: () => go("#/ghost-forge") })
      ]));
    } else {
      const grid = el("div", { class: "clone-grid" });
      st.ghosts.filter(g => g.merged !== "absorbed").forEach(g => grid.appendChild(ghostCard(g)));
      const absorbed = st.ghosts.filter(g => g.merged === "absorbed");
      wrap.appendChild(grid);
      if (absorbed.length) {
        wrap.appendChild(el("p", { class: "empty-note", text: `${absorbed.length} ghost(s) absorbed into SuperAgents.` }));
      }
    }

    main.appendChild(wrap);

    /* autonomous pass — evaluate matured products, enforce the directive */
    G.process().then(events => {
      if (events.length && location.hash.startsWith("#/ghosts")) {
        events.slice(0, 4).forEach((e2, i) => setTimeout(() => toast(e2, "info"), i * 500));
        route();
      }
    }).catch(err => console.error(err));
  }

  function ffDays(n) {
    G.fastForward(n);
    U.sfx("click");
    const shellEvents = SH.process();
    const matrixEvents = M.process();
    G.process().then(events => {
      shellEvents.concat(matrixEvents, events).slice(0, 5).forEach((e2, i) => setTimeout(() => toast(e2, "info"), i * 500));
      route();
    });
  }

  function ghostCard(g) {
    const rev = G.ghostRevenue(g);
    const products = G.ghostProducts(g);
    return el("div", {
      class: "clone-card ghost-card" + (g.super ? " super" : ""),
      onclick: (e) => { if (e.target.closest("button")) return; go("#/ghost/" + g.id); }
    }, [
      el("div", { class: "cc-top" }, [
        el("div", { class: "cc-ident" }, [
          el("span", { class: "cc-icon ghost-icon", text: g.super ? "🤖" : "👻" }),
          el("div", {}, [
            el("div", { class: "cc-name", text: g.name + (g.generation > 1 ? ` · G${g.generation}` : "") }),
            el("div", { class: "cc-role", text: g.focus + " · " + g.niche })
          ])
        ]),
        ghostBadge(g)
      ]),
      el("div", { class: "cc-target", text: `◎ ${G.money(g.targetIncome)}/day · ${g.platform}` }),
      el("div", { class: "cc-metrics" }, [
        ccMetric("REVENUE", G.money(rev)),
        ccMetric("PRODUCTS", String(products.length)),
        ccMetric("HITS", String(products.filter(p => p.status === "hit").length)),
        ccMetric("TONE", g.tone.split(" ")[0])
      ]),
      el("div", { class: "cc-foot" }, [
        el("span", { class: "dim small-note", text: g.super ? "SUPERAGENT · +25% quality" : (g.template === "custom" ? "custom ghost" : "template: " + g.template) }),
        el("div", { class: "cc-actions" }, [
          el("button", { class: "btn small", text: "Open", onclick: () => go("#/ghost/" + g.id) }),
          el("button", { class: "btn small danger ghost", text: "✕", onclick: () => U.modal({
            title: `Decommission <span class="gold">${esc(g.name)}</span>?`,
            body: `<p>The ghost and its ${products.length} product(s) will be deleted.</p>`,
            actions: [
              { label: "Cancel", cls: "ghost" },
              { label: "Delete Ghost", cls: "danger", onClick: () => { G.deleteGhost(g.id); U.sfx("error"); route(); } }
            ]
          }) })
        ])
      ])
    ]);
  }

  /* ---- ghost forge ---- */
  function renderGhostForge(main) {
    const wrap = el("div", { class: "page narrow" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "back-link", href: "#/ghosts", text: "← ghost deck" }),
        el("h1", { class: "page-title", html: `GHOST FORGE <span class="dim">// deploy a product ghost</span>` }),
        el("p", { class: "page-sub", text: "Pick a battle-tested template or build custom. Every ghost is auto-trained in: " + G.GHOST_SKILLS.join(" · ") + "." })
      ])
    ]));

    const f = {};
    const form = el("div", { class: "panel form-panel" });

    /* template picker */
    const tRow = el("div", { class: "tpl-row" });
    G.TEMPLATES.forEach(t => {
      tRow.appendChild(el("button", {
        class: "tpl-card", onclick: (ev) => {
          f.name.value = t.name; f.niche.value = t.niche; f.type.value = t.type;
          f.tone.value = t.tone; f._focus = t.focus;
          const me = ev.currentTarget;
          U.$$(".tpl-card", tRow).forEach(b => b.classList.toggle("on", b === me));
          U.sfx("click");
        }
      }, [
        el("div", { class: "tpl-name", text: t.name }),
        el("div", { class: "tpl-focus", text: t.focus }),
        el("div", { class: "tpl-example", text: t.example })
      ]));
    });
    form.appendChild(el("div", { class: "field" }, [el("span", { class: "field-label", text: "Ghost templates" }), tRow]));

    form.appendChild(field("Ghost name", f, "name", el("input", { class: "input", maxlength: 20, placeholder: "e.g. CASHSCRIPT", value: "GHOST-" + (S.state.ghosts.length + 1) })));
    form.appendChild(field("Niche or topic", f, "niche", el("input", { class: "input", placeholder: `type a niche — or "random" to let the ghost pick` , value: "random" })));
    form.appendChild(field("Target income ($/day)", f, "target", el("input", { class: "input", type: "number", min: 10, step: 10, value: 100 })));

    const typeSel = el("select", { class: "input" });
    G.PRODUCT_TYPES.forEach(t => typeSel.appendChild(el("option", { value: t, text: t })));
    form.appendChild(field("Product type", f, "type", typeSel));

    const platSel = el("select", { class: "input" });
    G.PLATFORMS.forEach(p => platSel.appendChild(el("option", { value: p, text: p })));
    form.appendChild(field("Platform", f, "platform", platSel));

    const toneSel = el("select", { class: "input" });
    Object.entries(D.TONES).forEach(([t, meta]) => toneSel.appendChild(el("option", { value: t, text: `${t} — ${meta.desc}` })));
    form.appendChild(field("Tone", f, "tone", toneSel));

    form.appendChild(providerField(f));

    if (forgePrefill) {
      if (forgePrefill.niche) f.niche.value = forgePrefill.niche;
      if (forgePrefill.type) f.type.value = forgePrefill.type;
      if (forgePrefill.name) f.name.value = forgePrefill.name;
      forgePrefill = null;
    }

    const launchBtn = el("button", { class: "btn violet-btn big", text: "👻 Deploy Ghost & Run First Cycle" });
    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn ghost", text: "Cancel", onclick: () => go("#/ghosts") }),
      launchBtn
    ]));

    launchBtn.addEventListener("click", async () => {
      const name = f.name.value.trim().toUpperCase();
      if (!name) { toast("Name the ghost.", "err"); return; }
      if (S.state.ghosts.some(g => g.name === name)) { toast("A ghost with that name already exists.", "err"); return; }
      launchBtn.disabled = true;
      launchBtn.textContent = "◈ DETECTING DEMAND…";
      try {
        const ghost = G.createGhost({
          name, template: G.TEMPLATES.some(t => t.name === name) ? name.toLowerCase() : "custom",
          focus: f._focus || f.type.value,
          niche: f.niche.value, targetIncome: f.target.value,
          productType: f.type.value, platform: f.platform.value, tone: f.tone.value,
          provider: f.provider.value
        });
        launchBtn.textContent = "◈ BUILDING ASSETS…";
        const product = await G.runCycle(ghost);
        U.sfx("spawn"); U.evolveFlash();
        toast(`👻 ${ghost.name} launched "${product.name}" — tracking for ${G.TRACK_DAYS} days. Launch thread queued.`, "ok");
        go("#/ghost/" + ghost.id);
      } catch (err) {
        console.error(err);
        toast("Ghost deploy failed: " + err.message, "err");
        launchBtn.disabled = false;
        launchBtn.textContent = "👻 Deploy Ghost & Run First Cycle";
      }
    });

    wrap.appendChild(form);
    main.appendChild(wrap);
  }

  /* ---- ghost detail ---- */
  function renderGhostView(main, id) {
    const g = S.state.ghosts.find(x => x.id === id);
    if (!g) { go("#/ghosts"); return; }
    const wrap = el("div", { class: "page" });
    const products = G.ghostProducts(g).slice().reverse();

    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "back-link", href: "#/ghosts", text: "← ghost deck" }),
        el("h1", { class: "page-title clone-title" }, [
          el("span", { class: "cc-icon ghost-icon big", text: g.super ? "🤖" : "👻" }),
          el("span", { text: ` ${g.name}${g.generation > 1 ? " · G" + g.generation : ""} ` }),
          ghostBadge(g)
        ]),
        el("p", { class: "page-sub", text: `${g.focus} · ${g.niche} · ◎ ${G.money(g.targetIncome)}/day · ${g.platform} · ${g.tone}${g.merged && g.merged !== "absorbed" ? " · forged from " + g.merged.join(" + ") : ""}` })
      ]),
      el("div", { class: "head-actions" }, [
        el("button", { class: "btn violet-btn", text: "⚡ Run Cycle Now", onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = "◈ BUILDING…";
          const p = await G.runCycle(g);
          toast(`"${p.name}" launched — tracking begins.`, "ok");
          U.sfx("spawn"); route();
        } }),
        el("button", { class: "btn " + (g.humanLoop ? "blue-btn" : ""), text: g.humanLoop ? "🤝 Human Loop: ON" : "🤝 Human Loop", onclick: () => humanLoopModal(g, "ghost") }),
        el("button", { class: "btn danger ghost", text: "✕ Delete", onclick: () => { G.deleteGhost(g.id); go("#/ghosts"); } })
      ])
    ]));

    /* lifecycle strip */
    const stage = products.length === 0 ? 0 : (products[0].status === "tracking" ? ((products[0].daily || []).length ? 4 : 3) : 4);
    const steps = ["1 · Detect Demand", "2 · Ideate Product", "3 · Build Assets", "4 · Launch + Promote", "5 · Evolve"];
    wrap.appendChild(el("div", { class: "lifecycle" }, steps.map((s2, i) =>
      el("span", { class: "life-step" + (i <= stage ? " on" : ""), text: s2 })
    )));

    /* skills */
    wrap.appendChild(el("div", { class: "g-skills" }, g.skills.map(s2 => el("span", { class: "g-skill", text: s2 }))));

    /* products */
    const list = el("div", {});
    if (!products.length) list.appendChild(el("p", { class: "empty-note", text: "First cycle pending…" }));
    products.forEach(p => list.appendChild(productCard(g, p)));
    wrap.appendChild(list);

    /* memory */
    const memPanel = el("div", { class: "panel" });
    memPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "◌ Ghost memory — reports to GOD CORE" })]));
    const memList = el("div", { class: "mem-list" });
    g.memory.slice(-8).reverse().forEach(m => memList.appendChild(el("div", { class: "mem-chip violet-chip", text: m })));
    memPanel.appendChild(memList);
    wrap.appendChild(memPanel);

    main.appendChild(wrap);
  }

  function productCard(g, p) {
    const rev = G.totalRev(p);
    const days = (p.daily || []).length;
    const stMeta = {
      tracking:   { label: `TRACKING · DAY ${days}/${G.TRACK_DAYS}`, cls: "gst-track" },
      hit:        { label: "🎯 HIT TARGET", cls: "gst-hit" },
      relaunched: { label: "RELAUNCHED", cls: "gst-needs" },
      retired:    { label: "RETIRED", cls: "gst-dormant" }
    }[p.status] || { label: p.status.toUpperCase(), cls: "gst-scan" };

    const card = el("div", { class: "panel product-card" });
    card.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: `◆ ${p.name} — ${p.price > 0 ? G.money(p.price) : "affiliate"} · ${p.platform}` }),
      el("span", { class: "badge " + stMeta.cls, text: stMeta.label })
    ]));
    if (p.urgencyHeadline) card.appendChild(el("p", { class: "urgency-line", text: "⚡ " + p.urgencyHeadline }));
    card.appendChild(el("p", { class: "signal-line", text: p.signal }));
    card.appendChild(el("p", { class: "dim small-note", text: `Angle: ${p.angle} · engine: ${p.engine === "neural" ? "Neural Link" : "Local Cortex"}${p.relaunchOf ? " · relaunch" : ""}` }));

    /* tracking chart */
    const chartBox = el("div", { class: "chart-box" });
    if (days > 0) {
      card.appendChild(el("div", { class: "prod-stats" }, [
        ccMetric("REVENUE", G.money(rev)),
        ccMetric("SALES", String(G.totalSales(p))),
        ccMetric("AVG/DAY", G.money(days ? rev / days : 0)),
        ccMetric("TARGET", G.money(p.targetIncome) + "/d")
      ]));
      U.barChart(chartBox, {
        labels: p.daily.map((_, i) => "D" + (i + 1)),
        values: p.daily.map(d => d.revenue),
        seriesName: "Revenue (sim)",
        format: G.money, height: 150
      });
      card.appendChild(chartBox);
    } else {
      card.appendChild(el("p", { class: "empty-note", text: "First simulated market day pending — fast-forward the sim clock on the Ghost Deck, or come back tomorrow." }));
    }

    /* assets */
    const assets = p.assets || {};
    [["Sales page", assets.salesPage], ["Launch thread", assets.thread], ["DM flow", assets.dmFlow]].forEach(([label, body]) => {
      if (!body) return;
      card.appendChild(el("details", { class: "asset-fold" }, [
        el("summary", { text: label }),
        el("pre", { class: "output-pre", text: body })
      ]));
    });

    /* actions */
    card.appendChild(el("div", { class: "export-row" }, [
      el("button", { class: "btn tiny", text: "Copy sales page", onclick: () => U.copyText(assets.salesPage || "", "Sales page copied — paste into " + p.platform + ".") }),
      el("button", { class: "btn tiny", text: "Copy listing", onclick: () => U.copyText(`${p.name}\nPrice: ${p.price > 0 ? "$" + p.price : "free (affiliate)"}\n\n${(assets.salesPage || "").slice(0, 600)}`, "Listing copied for " + p.platform + ".") }),
      el("button", { class: "btn tiny", text: "Post thread ↗", onclick: () => U.shareToX((assets.thread || p.name).split("\n\n")[0]) }),
      p.status === "retired" ? el("button", { class: "btn tiny gold-btn", text: "📈 Relaunch", onclick: async () => { await G.relaunchFailed(); toast("Relaunched with new angle + urgency.", "ok"); route(); } }) : null,
      p.status === "hit" && !p.evolved ? el("button", { class: "btn tiny violet-btn", text: "🌀 Duplicate to sub-ghost", onclick: () => { p.evolved = true; const sub = G.spawnSubGhost(g, p); S.save(); toast(`Sub-ghost ${sub.name} spawned.`, "ok"); route(); } }) : null
    ].filter(Boolean)));

    return card;
  }

  /* ---- GOD CORE ghost commands ---- */
  function scheduleGhostCalendar() {
    const live = S.state.ghosts.filter(g => g.merged !== "absorbed");
    if (!live.length) { toast("No ghosts to schedule.", "err"); return; }
    let count = 0;
    live.forEach((g, i) => {
      const latest = G.ghostProducts(g).slice(-1)[0];
      if (!latest || !latest.assets) return;
      const d = new Date(); d.setDate(d.getDate() + 1 + i); d.setHours(9, 0, 0, 0);
      S.addQueueItem({
        cloneId: null,
        title: `👻 ${g.name} — ${latest.name}`,
        text: (latest.assets.thread || latest.name).split("\n\n")[0].slice(0, 270),
        dueAt: d.getTime()
      });
      count++;
    });
    if (count) { toast(`🚀 Launch calendar built — ${count} thread(s) staggered across the next ${count} day(s). See Queue.`, "ok"); $$navActive("ghosts"); }
    else toast("Ghosts have no launch assets yet.", "err");
  }

  function ghostReportModal() {
    const r = G.weeklyReport();
    const body = el("div", { class: "modal-body" });
    body.appendChild(el("div", { class: "report-list" }, [
      reportRow("👻", "Launches (last 7 sim days)", `${r.launches} product(s) · ${G.money(r.revenue)} simulated revenue`),
      reportRow("🎯", "Hits", r.hits.length ? r.hits.map(p => `"${p.name}" — ${G.money(G.totalRev(p))}`).join(" · ") : "none yet"),
      reportRow("♻", "Relaunched / retired", `${r.relaunched} relaunched · ${r.retired} retired`),
      ...r.perGhost.map(x => reportRow("·", x.g.name, `${G.money(x.revenue)} across ${x.products} product(s) · ${x.g.niche}`))
    ]));
    body.appendChild(el("p", { class: "suggestion-line", text: `💡 New idea: Product Ghost suggests ${r.suggestion.idea}. Build?` }));
    U.modal({
      title: "💡 Ghost Creation Report",
      cls: "wide",
      body,
      actions: [
        { label: "🔨 Build It", cls: "violet-btn", onClick: () => { forgePrefill = { niche: r.suggestion.niche, type: r.suggestion.type }; go("#/ghost-forge"); } },
        { label: "Close", cls: "ghost" }
      ]
    });
  }

  function mergeModal() {
    const live = S.state.ghosts.filter(g => g.merged !== "absorbed");
    if (live.length < 2) { toast("Need at least two active ghosts to merge.", "err"); return; }
    const selA = el("select", { class: "input" });
    const selB = el("select", { class: "input" });
    live.forEach(g => {
      selA.appendChild(el("option", { value: g.id, text: `${g.name} — ${g.focus}` }));
      selB.appendChild(el("option", { value: g.id, text: `${g.name} — ${g.focus}` }));
    });
    selB.selectedIndex = 1;
    const body = el("div", { class: "modal-body" }, [
      el("p", { text: "Combine two ghosts into a hybrid SuperAgent: combined skill matrix, merged focus, +25% conversion quality on all future products. The originals are absorbed." }),
      selA, el("p", { style: "text-align:center;margin:8px 0", html: "＋" }), selB
    ]);
    U.modal({
      title: "🤖 Merge Ghosts into SuperAgent",
      body,
      actions: [
        { label: "Cancel", cls: "ghost" },
        {
          label: "Fuse", cls: "violet-btn", keepOpen: true, onClick: () => {
            if (selA.value === selB.value) { toast("Pick two different ghosts.", "err"); return; }
            U.closeModal();
            const sup = G.mergeGhosts(selA.value, selB.value);
            if (sup) { U.evolveFlash(); U.sfx("evolve"); toast(`🤖 SuperAgent ${sup.name} is online.`, "ok"); go("#/ghost/" + sup.id); }
          }
        }
      ]
    });
  }

  /* =============================== PHASE 3: OUTER SHELLS =============================== */
  let shellForgePrefill = null;

  function shellGlowClass(shell) {
    const p = SH.powerMeter(shell);
    return p >= 75 ? "glow-3" : p >= 50 ? "glow-2" : "glow-1";
  }

  function powerMeterNode(shell) {
    const p = SH.powerMeter(shell);
    return el("div", { class: "meter-wrap", title: "Faceless Power Meter — virality potential from niche heat × persona fit × content quality" }, [
      el("div", { class: "meter-label" }, [
        el("span", { text: "FACELESS POWER" }),
        el("span", { class: "meter-val", text: p + "%" })
      ]),
      el("div", { class: "meter" }, [el("div", { class: "meter-fill", style: `width:${p}%` })])
    ]);
  }

  function renderShellDeck(main) {
    const st = S.state;
    const wrap = el("div", { class: "page" });
    const stats = SH.stats();
    const offDays = Math.round((st.ghostSimOffset || 0) / 86400000);

    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `OUTER SHELLS <span class="dim">// phase 3 — faceless content brands</span>` }),
        el("p", { class: "page-sub", text: `${stats.shells} shell(s) · ${U.fmtNum(stats.followers)} total followers · ${SH.money(stats.income)} attributed income · ${U.fmtNum(stats.emails)} emails collected` })
      ]),
      el("div", { class: "head-actions" }, [
        el("button", { class: "btn cyan-btn", text: "🎭 Deploy Outer Shell", onclick: () => go("#/shell-forge") }),
        el("button", { class: "btn", text: "🧱 Shell Builder AI", onclick: shellBuilderModal }),
        el("button", { class: "btn", text: "🔁 Cross-Pollinate", onclick: crossPollinateModal })
      ])
    ]));

    /* mission banner */
    wrap.appendChild(el("div", { class: "directive-banner cyan-banner" }, [
      el("div", { class: "directive-label cyan-label", text: "GOD CORE — SHELL DOCTRINE" }),
      el("p", { class: "directive-text", text: "“Shells don't sell products. They ARE the product. Grow the audience, earn the attention, feed the traffic back into the ghost economy — without ever showing a face.”" })
    ]));

    /* weekly growth chart + sim clock */
    if (st.shells.length) {
      const chartPanel = el("div", { class: "panel" });
      chartPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Weekly growth — network followers (simulated)" })]));
      const box = el("div", { class: "chart-box" });
      chartPanel.appendChild(box);
      wrap.appendChild(chartPanel);
      const s2 = SH.followerSeries();
      setTimeout(() => U.barChart(box, { labels: s2.labels, values: s2.values, seriesName: "Followers", format: U.fmtNum, height: 160, markClass: "cyan" }), 0);
    }
    wrap.appendChild(el("div", { class: "sim-clock" }, [
      el("span", { class: "dim", text: `Shared market sim clock: ${offDays ? "+" + offDays + " day(s)" : "real time"} — each elapsed day, every shell drops its content and the engagement sim runs.` }),
      el("span", {}, [
        el("button", { class: "btn tiny", text: "⏩ +1 day", onclick: () => ffDays(1) }),
        el("button", { class: "btn tiny", text: "⏭ +7 days", onclick: () => ffDays(7), style: "margin-left:6px" })
      ])
    ]));

    if (!st.shells.length) {
      wrap.appendChild(el("div", { class: "hero-empty cyan-hero" }, [
        el("div", { class: "hero-glyph cyan-glyph", text: "🎭" }),
        el("h2", { text: "No shells in orbit." }),
        el("p", { text: "Outer Shells are faceless AI content brands: they research their niche daily, drop platform-native content with one CTA per post, grow their following, and evolve their persona on engagement — feeding traffic back to your ghosts, affiliates and clones." }),
        el("button", { class: "btn cyan-btn big", text: "🎭 Deploy First Outer Shell", onclick: () => go("#/shell-forge") })
      ]));
    } else {
      const grid = el("div", { class: "clone-grid" });
      st.shells.forEach(s3 => grid.appendChild(shellCard(s3)));
      wrap.appendChild(grid);
    }

    main.appendChild(wrap);

    SH.process().length && route(); /* catch up missed sim days, redraw once */
  }

  function shellCard(shell) {
    const growth = SH.dailyGrowthPct(shell);
    return el("div", {
      class: "clone-card shell-card " + shellGlowClass(shell),
      onclick: (e) => { if (e.target.closest("button")) return; go("#/shell/" + shell.id); }
    }, [
      el("div", { class: "cc-top" }, [
        el("div", { class: "cc-ident" }, [
          el("span", { class: "cc-icon shell-mask", text: "🎭" }),
          el("div", {}, [
            el("div", { class: "cc-name", text: shell.name + (shell.generation > 1 ? ` · G${shell.generation}` : "") }),
            el("div", { class: "cc-role", text: `${shell.niche} · ${shell.persona}` })
          ])
        ]),
        shell.personaTest
          ? el("span", { class: "badge gst-needs", text: "PERSONA TEST" })
          : el("span", { class: "badge gst-track", text: shell.autoUpload ? "AUTO-UPLOAD" : "BROADCASTING" })
      ]),
      el("div", { class: "cc-target", text: `${shell.platforms.join(" · ")} · ${shell.postsPerDay}/day · ${shell.offerSource}` }),
      el("div", { class: "cc-metrics" }, [
        ccMetric("FOLLOWERS", U.fmtCompact(shell.followers)),
        ccMetric("TODAY", (growth >= 0 ? "+" : "") + growth.toFixed(1) + "%"),
        ccMetric("INCOME", SH.money(shell.daily.reduce((a, d) => a + d.income, 0))),
        ccMetric("POSTS", String(shell.posts.length))
      ]),
      powerMeterNode(shell),
      el("div", { class: "cc-foot" }, [
        el("span", { class: "dim small-note", text: shell.personaTest ? `testing ${shell.persona} until day's end` : "faceless · autonomous" }),
        el("div", { class: "cc-actions" }, [
          el("button", { class: "btn small", text: "Open", onclick: () => go("#/shell/" + shell.id) }),
          el("button", { class: "btn small ghost", text: "⧉", title: "Clone Shell", onclick: () => { const c = SH.cloneShell(shell.id); if (c) { U.sfx("spawn"); toast(`Shell cloned → ${c.name} (winning flows inherited).`, "ok"); route(); } } }),
          el("button", { class: "btn small danger ghost", text: "✕", onclick: () => U.modal({
            title: `Dissolve <span class="gold">${esc(shell.name)}</span>?`,
            body: `<p>The shell, its ${shell.posts.length} archived posts and vault data will be deleted.</p>`,
            actions: [
              { label: "Cancel", cls: "ghost" },
              { label: "Dissolve", cls: "danger", onClick: () => { SH.deleteShell(shell.id); U.sfx("error"); route(); } }
            ]
          }) })
        ])
      ])
    ]);
  }

  /* ---- shell forge ---- */
  function renderShellForge(main) {
    const st = S.state;
    const wrap = el("div", { class: "page narrow" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "back-link", href: "#/shells", text: "← shell deck" }),
        el("h1", { class: "page-title", html: `SHELL FORGE <span class="dim">// deploy a faceless brand</span>` }),
        el("p", { class: "page-sub", text: "No face, no name, no voice — just a persona, a niche, and a daily content engine." })
      ])
    ]));

    const f = {};
    const form = el("div", { class: "panel form-panel" });

    form.appendChild(field("Shell name", f, "name", el("input", { class: "input", maxlength: 20, placeholder: "e.g. SILENTWEALTH", value: "SHELL-" + (st.shells.length + 1) })));

    /* platform multi-select */
    const platWrap = el("div", { class: "plat-row" });
    const platChecks = {};
    SH.PLATFORMS.forEach((p, i) => {
      const cb = el("input", { type: "checkbox" });
      cb.checked = i === 0;
      platChecks[p] = cb;
      platWrap.appendChild(el("label", { class: "plat-chip" }, [cb, el("span", { text: p })]));
    });
    form.appendChild(el("div", { class: "field" }, [el("span", { class: "field-label", text: "Platform focus (multi-select)" }), platWrap]));

    const nicheSel = el("select", { class: "input" });
    Object.keys(SH.NICHES).forEach(n => nicheSel.appendChild(el("option", { value: n, text: n })));
    nicheSel.appendChild(el("option", { value: "__custom", text: "Custom niche…" }));
    const nicheCustom = el("input", { class: "input", placeholder: "type your niche", style: "display:none;margin-top:8px" });
    nicheSel.addEventListener("change", () => { nicheCustom.style.display = nicheSel.value === "__custom" ? "block" : "none"; });
    form.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: "Niche" }), nicheSel, nicheCustom]));

    const personaSel = el("select", { class: "input" });
    Object.entries(SH.PERSONAS).forEach(([p, meta]) => personaSel.appendChild(el("option", { value: p, text: `${p} — ${meta.desc}` })));
    form.appendChild(field("Persona style", f, "persona", personaSel));

    const offerSel = el("select", { class: "input" });
    SH.OFFER_SOURCES.forEach(o => offerSel.appendChild(el("option", { value: o, text: o })));
    form.appendChild(field("Main offer source", f, "offer", offerSel));

    /* conditional targets */
    const prodSel = el("select", { class: "input" });
    st.products.forEach(p => prodSel.appendChild(el("option", { value: p.id, text: `${p.name} (${p.status})` })));
    const prodField = el("label", { class: "field", style: st.products.length ? "" : "display:none" }, [el("span", { class: "field-label", text: "Ghost product to promote" }), prodSel]);
    form.appendChild(prodField);
    const cloneSel = el("select", { class: "input" });
    st.clones.forEach(c => cloneSel.appendChild(el("option", { value: c.id, text: `${c.name} (${c.role})` })));
    const cloneField = el("label", { class: "field", style: "display:none" }, [el("span", { class: "field-label", text: "Lead-gen clone to feed" }), cloneSel]);
    form.appendChild(cloneField);
    offerSel.addEventListener("change", () => {
      prodField.style.display = offerSel.value === "Promote Product Ghosts" && st.products.length ? "" : "none";
      cloneField.style.display = offerSel.value === "Drive Traffic to Lead Gen Clone" && st.clones.length ? "" : "none";
    });

    form.appendChild(field("Reference content for mimicry (optional)", f, "ref", el("textarea", { class: "input", rows: 3, placeholder: "Paste a post or two whose style this shell should mimic…" })));

    const ppd = el("input", { class: "input", type: "number", min: 1, max: 5, value: 2 });
    form.appendChild(field("Posts per day (1–5)", f, "ppd", ppd));

    form.appendChild(providerField(f));

    const autoCb = el("input", { type: "checkbox" });
    form.appendChild(el("label", { class: "check-row" }, [autoCb, el("span", { text: "Auto-Upload — queue each day's X post into the Broadcast Queue automatically (TikTok/IG/Shorts pending future API integrations)" })]));

    const deployBtn = el("button", { class: "btn cyan-btn big", text: "🎭 Deploy Shell & Run Day One" });
    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn ghost", text: "Cancel", onclick: () => go("#/shells") }),
      deployBtn
    ]));

    if (shellForgePrefill) {
      if (shellForgePrefill.niche && SH.NICHES[shellForgePrefill.niche]) nicheSel.value = shellForgePrefill.niche;
      if (shellForgePrefill.platform) { Object.values(platChecks).forEach(cb => cb.checked = false); if (platChecks[shellForgePrefill.platform]) platChecks[shellForgePrefill.platform].checked = true; }
      if (shellForgePrefill.name) f.name.value = shellForgePrefill.name;
      shellForgePrefill = null;
    }

    deployBtn.addEventListener("click", () => {
      const name = f.name.value.trim().toUpperCase();
      if (!name) { toast("Name the shell.", "err"); return; }
      if (st.shells.some(s2 => s2.name === name)) { toast("A shell with that name already exists.", "err"); return; }
      const platforms = SH.PLATFORMS.filter(p => platChecks[p].checked);
      if (!platforms.length) { toast("Pick at least one platform.", "err"); return; }
      const niche = nicheSel.value === "__custom" ? (nicheCustom.value.trim() || "AI Tools / Tech") : nicheSel.value;
      const shell = SH.createShell({
        name, platforms, niche,
        persona: f.persona.value,
        offerSource: f.offer.value,
        offerTargetProductId: f.offer.value === "Promote Product Ghosts" ? prodSel.value || null : null,
        leadGenCloneId: f.offer.value === "Drive Traffic to Lead Gen Clone" ? cloneSel.value || null : null,
        referenceContent: f.ref.value,
        postsPerDay: parseInt(ppd.value, 10) || 2,
        autoUpload: autoCb.checked,
        provider: f.provider.value
      });
      SH.process(); /* day one drop */
      U.sfx("spawn"); U.evolveFlash();
      toast(`🎭 ${shell.name} is live — day-one content drop generated.`, "ok");
      go("#/shell/" + shell.id);
    });

    wrap.appendChild(form);
    main.appendChild(wrap);
  }

  /* ---- shell detail ---- */
  function renderShellView(main, id) {
    const st = S.state;
    const shell = st.shells.find(s2 => s2.id === id);
    if (!shell) { go("#/shells"); return; }
    const wrap = el("div", { class: "page" });
    const wk = SH.weeklyGrowthPct(shell);

    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "back-link", href: "#/shells", text: "← shell deck" }),
        el("h1", { class: "page-title clone-title" }, [
          el("span", { class: "cc-icon shell-mask big " + shellGlowClass(shell), text: "🎭" }),
          el("span", { text: ` ${shell.name} ` }),
          shell.personaTest ? el("span", { class: "badge gst-needs", text: `PERSONA TEST: ${shell.persona}` }) : el("span", { class: "badge gst-track", text: "LIVE" })
        ]),
        el("p", { class: "page-sub", text: `${shell.niche} · ${shell.persona} · ${shell.platforms.join(" / ")} · ${shell.postsPerDay} post(s)/day · mission: ${shell.offerSource}` })
      ]),
      el("div", { class: "head-actions" }, [
        el("button", { class: "btn", text: "⧉ Clone Shell", onclick: () => { const c = SH.cloneShell(shell.id); if (c) { U.sfx("spawn"); toast(`Cloned → ${c.name}.`, "ok"); go("#/shell/" + c.id); } } }),
        el("button", { class: "btn", text: "👻 Inject Ghost Offer", onclick: () => injectGhostOfferModal(shell) }),
        el("button", { class: "btn", text: "🎭 Change Persona", onclick: () => changePersonaModal(shell) }),
        el("button", { class: "btn " + (shell.humanLoop ? "blue-btn" : ""), text: shell.humanLoop ? "🤝 Human Loop: ON" : "🤝 Human Loop", onclick: () => humanLoopModal(shell, "shell") }),
        el("button", { class: "btn " + (shell.autoUpload ? "cyan-btn" : ""), text: shell.autoUpload ? "⇪ Auto-Upload: ON" : "⇪ Auto-Upload: OFF", onclick: (e) => {
          shell.autoUpload = !shell.autoUpload; S.save();
          toast(shell.autoUpload ? "Auto-Upload ON — daily X drops flow into the Broadcast Queue. Other platforms await future API integrations." : "Auto-Upload OFF.", "info");
          route();
        } }),
        el("button", { class: "btn danger ghost", text: "✕", onclick: () => { SH.deleteShell(shell.id); go("#/shells"); } })
      ])
    ]));

    /* stat strip + meter */
    const strip = el("div", { class: "stat-strip" });
    [["FOLLOWERS", U.fmtNum(shell.followers)],
     ["DAILY", (SH.dailyGrowthPct(shell) >= 0 ? "+" : "") + SH.dailyGrowthPct(shell).toFixed(1) + "%"],
     ["WEEKLY", wk == null ? "—" : (wk >= 0 ? "+" : "") + wk.toFixed(1) + "%"],
     ["INCOME", SH.money(shell.daily.reduce((a, d) => a + d.income, 0))],
     ["EMAILS", U.fmtNum(shell.emailList || 0)],
     ["ARCHIVE", shell.posts.length + " posts"]]
      .forEach(([l, v]) => strip.appendChild(ccMetric(l, v)));
    wrap.appendChild(strip);
    wrap.appendChild(powerMeterNode(shell));

    const cols = el("div", { class: "clone-cols" });
    const left = el("div", { class: "col" });
    const right = el("div", { class: "col" });

    /* follower chart */
    if (shell.daily.length) {
      const cPanel = el("div", { class: "panel" });
      cPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Followers — last days (simulated)" })]));
      const box = el("div", { class: "chart-box" });
      cPanel.appendChild(box);
      left.appendChild(cPanel);
      const days = shell.daily.slice(-7);
      setTimeout(() => U.barChart(box, {
        labels: days.map(d => d.day.slice(5)), values: days.map(d => d.followers),
        seriesName: "Followers", format: U.fmtNum, height: 150, markClass: "cyan"
      }), 0);
    }

    /* posts preview by platform */
    const postsPanel = el("div", { class: "panel" });
    postsPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "📡 Latest drops by platform" })]));
    const recent = shell.posts.slice(-8).reverse();
    if (!recent.length) postsPanel.appendChild(el("p", { class: "empty-note", text: "First drop pending — fast-forward the sim clock on the Shell Deck." }));
    recent.forEach(p => {
      postsPanel.appendChild(el("details", { class: "asset-fold" }, [
        el("summary", {}, [
          el("span", { class: "post-plat", text: p.platform }),
          el("span", { text: ` ${p.format} — ${p.hook} ${p.topic}` }),
          p.metrics ? el("span", { class: "post-metrics", text: ` · ${U.fmtCompact(p.metrics.views)} views · +${p.metrics.follows} fo` }) : null
        ].filter(Boolean)),
        el("pre", { class: "output-pre", text: p.body + (p.broll ? "\n\nB-ROLL:\n• " + p.broll.join("\n• ") : "") + `\n\nTREND SOURCE (sim): ${p.trend}` }),
        el("div", { class: "vi-actions" }, [
          el("button", { class: "btn tiny", text: "Copy", onclick: () => U.copyText(p.body, "Post copied.") }),
          p.platform === "X" ? el("button", { class: "btn tiny", text: "Post ↗", onclick: () => U.shareToX(p.body.split("\n\n")[0]) }) : null
        ].filter(Boolean))
      ]));
    });
    left.appendChild(postsPanel);

    /* vault */
    const vaultPanel = el("div", { class: "panel" });
    vaultPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "📁 Shell vault" })]));
    const tabs = el("div", { class: "vault-tabs" });
    const body = el("div", {});
    const draw = {
      hooks: () => {
        const best = SH.bestHooks(shell, 5);
        if (!best.length) return [el("p", { class: "empty-note", text: "No performance data yet." })];
        return best.map(p => el("div", { class: "vault-item" }, [
          el("div", { class: "vi-head" }, [
            el("span", { class: "vi-type", text: p.platform }),
            el("span", { class: "vi-title", text: `${p.hook} ${p.topic}` }),
            el("span", { class: "vi-meta", text: `${U.fmtCompact(p.metrics.views)} views` })
          ])
        ]));
      },
      scripts: () => shell.posts.filter(p => p.format === "short-script" || p.format === "thread").slice(-6).reverse()
        .map(p => el("div", { class: "vault-item" }, [el("div", { class: "vi-head", onclick: () => U.modal({ title: esc(p.platform + " " + p.format), cls: "wide", body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(el("pre", { class: "output-pre", text: p.body })); return b; })(), actions: [{ label: "Copy", onClick: () => U.copyText(p.body) }, { label: "Close", cls: "ghost" }] }) }, [
          el("span", { class: "vi-type", text: p.platform }), el("span", { class: "vi-title", text: p.hook + " " + p.topic }), el("span", { class: "vi-meta", text: p.day })
        ])])),
      memes: () => {
        const memes = shell.posts.filter(p => p.format === "meme-card" || p.format === "carousel").slice(-6).reverse();
        if (!memes.length) return [el("p", { class: "empty-note", text: "No meme cards yet — IG Reels platform generates them." })];
        return memes.map(p => el("div", { class: "vault-item" }, [el("pre", { class: "output-pre small-pre", text: p.body })]));
      },
      cta: () => {
        const entries = Object.entries(shell.ctaStats);
        if (!entries.length) return [el("p", { class: "empty-note", text: "No CTA data yet." })];
        return entries.sort((a, b) => b[1].clicks - a[1].clicks).map(([style, s3]) =>
          el("div", { class: "report-row" }, [
            el("span", { class: "report-ico", text: "⌁" }),
            el("div", {}, [
              el("div", { class: "report-label", text: style }),
              el("div", { class: "report-text", text: `${s3.clicks} clicks across ${s3.posts} posts (${(s3.clicks / Math.max(1, s3.posts)).toFixed(1)}/post)` })
            ])
          ]));
      },
      conversions: () => {
        const logs = shell.memory.filter(m => /assisted sale|emails collected|leads routed/.test(m)).slice(-8).reverse();
        if (!logs.length) return [el("p", { class: "empty-note", text: "No conversions logged yet." })];
        return logs.map(m => el("div", { class: "mem-chip cyan-chip", text: m }));
      }
    };
    let vtab = "hooks";
    [["hooks", "Best hooks"], ["scripts", "Script archive"], ["memes", "Meme folder"], ["cta", "CTA performance"], ["conversions", "Conversion log"]].forEach(([k, label]) => {
      tabs.appendChild(el("button", {
        class: "vtab" + (k === "hooks" ? " on" : ""), text: label, "data-k": k,
        onclick: () => { vtab = k; U.$$(".vtab", tabs).forEach(b => b.classList.toggle("on", b.dataset.k === k)); body.innerHTML = ""; draw[vtab]().forEach(n => body.appendChild(n)); }
      }));
    });
    vaultPanel.appendChild(tabs);
    draw.hooks().forEach(n => body.appendChild(n));
    vaultPanel.appendChild(body);
    right.appendChild(vaultPanel);

    /* memory */
    const memPanel = el("div", { class: "panel" });
    memPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "◌ Shell memory" })]));
    const memList = el("div", { class: "mem-list" });
    shell.memory.slice(-8).reverse().forEach(m => memList.appendChild(el("div", { class: "mem-chip cyan-chip", text: m })));
    memPanel.appendChild(memList);
    right.appendChild(memPanel);

    cols.appendChild(left);
    cols.appendChild(right);
    wrap.appendChild(cols);
    main.appendChild(wrap);
  }

  /* ---- shell commands ---- */
  function injectGhostOfferModal(shell) {
    const products = S.state.products;
    if (!products.length) { toast("No ghost products yet — launch a Product Ghost first.", "err"); return; }
    const sel = el("select", { class: "input" });
    products.slice().reverse().forEach(p => sel.appendChild(el("option", { value: p.id, text: `${p.name} — ${p.status}${p.price ? " · $" + p.price : ""}` })));
    U.modal({
      title: "👻 Inject Ghost Offer",
      body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(el("p", { text: "Every future post's CTA will promote this Product Ghost product." })); b.appendChild(sel); return b; })(),
      actions: [
        { label: "Cancel", cls: "ghost" },
        { label: "Inject", cls: "cyan-btn", onClick: () => {
          shell.offerSource = "Promote Product Ghosts";
          shell.offerTargetProductId = sel.value;
          const p = products.find(x => x.id === sel.value);
          shell.memory.push(`Ghost offer injected: now promoting "${p ? p.name : "product"}".`);
          S.logMemory("shell", `🎭 ${shell.name} now funnels traffic to ghost product "${p ? p.name : "?"}".`);
          S.save(); toast("Offer injected — CTAs updated.", "ok"); route();
        } }
      ]
    });
  }

  function changePersonaModal(shell) {
    const sel = el("select", { class: "input" });
    Object.entries(SH.PERSONAS).forEach(([p, meta]) => {
      const o = el("option", { value: p, text: `${p} — ${meta.desc}` });
      if (p === shell.persona) o.selected = true;
      sel.appendChild(o);
    });
    U.modal({
      title: "🎭 Change Persona",
      body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(sel); return b; })(),
      actions: [
        { label: "Cancel", cls: "ghost" },
        { label: "Apply", cls: "cyan-btn", onClick: () => {
          shell.personaTest = null;
          shell.persona = sel.value;
          shell.memory.push(`Persona manually set to ${sel.value}.`);
          S.save(); toast(`Persona → ${sel.value}.`, "ok"); route();
        } }
      ]
    });
  }

  function crossPollinateModal() {
    const shells = S.state.shells;
    if (shells.length < 2) { toast("Need at least two shells to cross-pollinate.", "err"); return; }
    const from = el("select", { class: "input" }), to = el("select", { class: "input" });
    shells.forEach(s2 => {
      from.appendChild(el("option", { value: s2.id, text: `${s2.name} (source)` }));
      to.appendChild(el("option", { value: s2.id, text: `${s2.name} (target)` }));
    });
    to.selectedIndex = 1;
    U.modal({
      title: "🔁 Cross-Pollinate Shells",
      body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(el("p", { text: "Copy the best-performing CTA style and top hooks from one shell into another." })); b.appendChild(from); b.appendChild(el("p", { style: "text-align:center;margin:8px 0", text: "↓" })); b.appendChild(to); return b; })(),
      actions: [
        { label: "Cancel", cls: "ghost" },
        { label: "Pollinate", cls: "cyan-btn", keepOpen: true, onClick: () => {
          if (from.value === to.value) { toast("Pick two different shells.", "err"); return; }
          U.closeModal();
          if (SH.crossPollinate(from.value, to.value)) { U.sfx("evolve"); toast("Style transferred — target shell's quality boosted.", "ok"); route(); }
        } }
      ]
    });
  }

  function shellBuilderModal() {
    const ta = el("textarea", { class: "input", rows: 3, placeholder: `e.g. "Create me a faceless TikTok account that grows to 10k followers in the AI niche and sells my productivity planner."` });
    const out = el("div", {});
    let lastPlan = null;
    U.modal({
      title: "🧱 Shell Builder AI",
      cls: "wide",
      body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(el("p", { text: "Describe the faceless brand you want. Shell AI returns names, bio, a 10-day content plan, schedule, offer strategy and hook variations." })); b.appendChild(ta); b.appendChild(out); return b; })(),
      actions: [
        { label: "Summon Shell AI", cls: "cyan-btn", keepOpen: true, onClick: async (e) => {
          const q = ta.value.trim();
          if (!q) { toast("Describe the shell first.", "err"); return; }
          out.innerHTML = "";
          out.appendChild(el("p", { class: "dim", text: "◈ Shell AI composing…" }));
          const res = await SH.builderAI(q);
          lastPlan = res;
          out.innerHTML = "";
          out.appendChild(el("p", { class: "dim small-note", text: `engine: ${res.engine === "neural" ? "Neural Link" : "Local Cortex"} · detected niche: ${res.niche}` }));
          out.appendChild(el("pre", { class: "output-pre", text: res.text }));
          out.appendChild(el("div", { class: "vi-actions" }, [
            el("button", { class: "btn tiny", text: "Copy plan", onclick: () => U.copyText(res.text, "Plan copied.") }),
            el("button", { class: "btn tiny cyan-btn", text: "🎭 Deploy this Shell", onclick: () => {
              const nameMatch = res.text.match(/@([a-z0-9._]+)/i);
              shellForgePrefill = { niche: res.niche, platform: /tiktok/i.test(q) ? "TikTok" : /youtube|shorts/i.test(q) ? "YT Shorts" : /insta|reel/i.test(q) ? "IG Reels" : "X", name: nameMatch ? nameMatch[1].replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 16) : null };
              U.closeModal();
              go("#/shell-forge");
            } })
          ]));
        } },
        { label: "Close", cls: "ghost" }
      ]
    });
  }

  /* =============================== PHASE 4: THE MATRIX MERGE =============================== */
  function renderMatrix(main) {
    const st = S.state;
    const stats = M.stats();
    const wrap = el("div", { class: "page" });

    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `THE MATRIX MERGE <span class="dim">// phase 4 — human executor bridge</span>` }),
        el("p", { class: "page-sub", text: `${stats.executors} executor(s) in the network · ${stats.inFlight} task(s) in flight · ${stats.funnels} SuperFunnel(s) live` })
      ]),
      el("div", { class: "head-actions" }, [
        el("button", { class: "btn blue-btn", text: "👤 Auto-Onboard Freelancer", onclick: onboardModal }),
        el("button", { class: "btn", text: "⚡ Auto-Assign Work", onclick: () => {
          if (!st.executors.length) { toast("Onboard an executor first.", "err"); return; }
          const out = M.autoAssign();
          if (!out.length) { toast("No assignable ops right now (or executors are at capacity).", "err"); return; }
          out.forEach((e2, i) => setTimeout(() => toast(e2, "ok"), i * 400));
          route();
        } }),
        el("button", { class: "btn", text: "🔗 Create SuperFunnel", onclick: superFunnelModal })
      ])
    ]));

    /* KPIs */
    wrap.appendChild(el("div", { class: "kpi-row" }, [
      kpiTile("Human network", String(stats.executors), null),
      kpiTile("Gross routed (sim)", M.money(stats.grossRouted), null),
      kpiTile("Paid to humans", M.money(stats.paidHumans), null),
      kpiTile("Main vault", M.money(stats.vaultBalance), null),
      kpiTile("Reinvest pool", M.money(stats.reinvestPool), null)
    ]));

    /* ---- TASK GRID ---- */
    const gridPanel = el("div", { class: "panel" });
    const sortSel = el("select", { class: "input inline-select", "aria-label": "sort task grid" });
    [["priority", "Priority"], ["roi", "ROI"], ["member", "Team member"], ["agent", "Agent"]].forEach(([v, l]) => sortSel.appendChild(el("option", { value: v, text: "Sort: " + l })));
    gridPanel.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "🎮 Task grid — real-time task map" }),
      sortSel
    ]));
    gridPanel.appendChild(el("div", { class: "grid-legend" }, [
      el("span", { class: "leg ai", text: "■ AI tasks" }),
      el("span", { class: "leg human", text: "■ Human tasks" }),
      el("span", { class: "leg joint", text: "■ Joint (hybrid)" })
    ]));
    const gridBox = el("div", { class: "task-grid" });
    gridPanel.appendChild(gridBox);
    function drawGrid() {
      gridBox.innerHTML = "";
      let tiles = M.taskGrid();
      const w = { review: 0, live: 1, done: 2 };
      if (sortSel.value === "priority") tiles.sort((a, b) => (w[a.status] - w[b.status]) || (b.value - a.value));
      else if (sortSel.value === "roi") tiles.sort((a, b) => b.value - a.value);
      else if (sortSel.value === "member") tiles.sort((a, b) => a.who.localeCompare(b.who));
      else tiles.sort((a, b) => a.kind.localeCompare(b.kind) || a.who.localeCompare(b.who));
      if (!tiles.length) gridBox.appendChild(el("p", { class: "empty-note", text: "The grid is dark — run tasks, launch ghosts, deploy shells, assign humans." }));
      tiles.slice(0, 30).forEach(t => {
        gridBox.appendChild(el("div", {
          class: `grid-tile ${t.kind}` + (t.status === "review" ? " needs-review" : t.status === "done" ? " tile-done" : ""),
          onclick: t.taskId ? () => reviewTaskModal(t.taskId) : null,
          title: t.title
        }, [
          el("div", { class: "tile-top" }, [
            el("span", { class: "tile-tag", text: t.tag }),
            el("span", { class: "tile-status", text: t.status.toUpperCase() })
          ]),
          el("div", { class: "tile-title", text: t.title }),
          el("div", { class: "tile-meta" }, [
            el("span", { text: t.who }),
            el("span", { class: "tile-val", text: t.value ? M.money(t.value) : "—" })
          ])
        ]));
      });
    }
    sortSel.addEventListener("change", drawGrid);
    drawGrid();
    wrap.appendChild(gridPanel);

    const cols = el("div", { class: "dash-grid" });

    /* ---- executor roster ---- */
    const roster = el("div", { class: "panel" });
    roster.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "👤 Executor roster" })]));
    if (!st.executors.length) {
      roster.appendChild(el("p", { class: "empty-note", text: "No humans in the Matrix yet. Onboard a freelancer — DM closer, email closer, editor, designer or VA — and the agents start feeding them work." }));
    }
    st.executors.forEach(ex => {
      const open = st.mtasks.filter(t => t.executorId === ex.id && t.status === "assigned").length;
      const review = st.mtasks.filter(t => t.executorId === ex.id && t.status === "delivered").length;
      roster.appendChild(el("div", { class: "exec-card" }, [
        el("div", { class: "cc-top" }, [
          el("div", { class: "cc-ident" }, [
            el("span", { class: "cc-icon exec-icon", text: M.ROLES[ex.role] ? M.ROLES[ex.role].icon : "👤" }),
            el("div", {}, [
              el("div", { class: "cc-name", text: ex.name }),
              el("div", { class: "cc-role", text: `${ex.role} · ${ex.permission} · ${ex.contact || "no contact"}` })
            ])
          ]),
          el("span", { class: "badge " + (ex.streak >= 3 ? "gst-hit" : "gst-scan"), text: ex.streak >= 3 ? "TOP PERFORMER" : ex.payShare + "% PAYSHARE" })
        ]),
        el("div", { class: "exec-meter" }, [
          el("div", { class: "meter-label" }, [el("span", { text: "PERFORMANCE" }), el("span", { class: "meter-val blue-val", text: ex.score + "/99" })]),
          el("div", { class: "meter blue-track" }, [el("div", { class: "meter-fill blue-fill", style: `width:${ex.score}%` })])
        ]),
        el("div", { class: "cc-metrics" }, [
          ccMetric("DONE", String(ex.tasksDone)),
          ccMetric("OPEN", String(open)),
          ccMetric("EARNED", M.money(ex.earnings)),
          ccMetric("STREAK", ex.streak + "🔥")
        ]),
        el("div", { class: "cc-foot" }, [
          el("span", { class: "dim small-note", text: M.ROLES[ex.role] ? "feeds on: " + M.ROLES[ex.role].feeds : "" }),
          el("div", { class: "cc-actions" }, [
            el("button", { class: "btn small", text: "Assign", onclick: () => assignModal(ex) }),
            el("button", { class: "btn small", text: "Portal", title: "Preview what this executor sees", onclick: () => portalModal(ex) }),
            review ? el("button", { class: "btn small gold-btn", text: `Review (${review})`, onclick: () => { const t = st.mtasks.find(x => x.executorId === ex.id && x.status === "delivered"); if (t) reviewTaskModal(t.id); } }) : null,
            el("button", { class: "btn small danger ghost", text: "✕", onclick: () => U.modal({
              title: `Release <span class="gold">${esc(ex.name)}</span>?`,
              body: "<p>Their open tasks are cancelled; loops and funnels using them go inactive.</p>",
              actions: [{ label: "Cancel", cls: "ghost" }, { label: "Release", cls: "danger", onClick: () => { M.removeExecutor(ex.id); route(); } }]
            }) })
          ].filter(Boolean))
        ])
      ]));
    });
    cols.appendChild(roster);

    /* ---- income redistribution ---- */
    const income = el("div", { class: "panel" });
    income.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "📈 Intelligent income redistribution (sim)" })]));
    const pctIn = el("input", { class: "input inline-num", type: "number", min: 0, max: 100, value: st.matrixConfig.reinvestPct });
    pctIn.addEventListener("change", () => { st.matrixConfig.reinvestPct = Math.min(100, Math.max(0, parseInt(pctIn.value, 10) || 0)); S.save(); toast("Split updated — human PayShare comes off the top; the remainder splits vault/reinvest.", "info"); });
    income.appendChild(el("div", { class: "split-row" }, [
      el("span", { class: "dim small-note", text: "Of post-PayShare revenue, reinvest" }),
      pctIn,
      el("span", { class: "dim small-note", text: "% · rest goes to the main vault" })
    ]));
    const reports = M.weeklyReportLines();
    if (reports.length) {
      const repBox = el("div", { class: "report-list", style: "margin-top:12px" });
      reports.slice(0, 4).forEach(line => repBox.appendChild(reportRow("💰", "Weekly report", line)));
      income.appendChild(repBox);
    } else {
      income.appendChild(el("p", { class: "empty-note", text: "No revenue routed yet. Wire a SuperFunnel or a human loop, then fast-forward the sim clock." }));
    }
    const led = st.ledger.slice(-6).reverse();
    if (led.length) {
      const ll = el("div", { class: "log-list", style: "margin-top:10px" });
      led.forEach(l => ll.appendChild(el("div", { class: "log-row" }, [
        el("span", { class: "log-ico", text: "🧩" }),
        el("span", { class: "log-text", text: `${l.source}: ${M.money(l.gross)} → ${M.money(l.toHuman)} ${l.executorName || "human"} · ${M.money(l.toReinvest)} reinvest · ${M.money(l.toOperator)} vault` }),
        el("span", { class: "log-time", text: U.timeAgo(l.at) })
      ])));
      income.appendChild(ll);
    }
    income.appendChild(el("div", { class: "modal-actions", style: "justify-content:flex-start" }, [
      el("button", { class: "btn small blue-btn", text: `📈 Reinvest ${M.money(M.GHOST_COST)} → spawn Ghost`, onclick: () => {
        const g = M.reinvestIntoGhost();
        if (!g) { toast(`Reinvest pool below ${M.money(M.GHOST_COST)}.`, "err"); return; }
        U.sfx("spawn"); toast(`Reinvested — Product Ghost ${g.name} spawned from the pool.`, "ok"); route();
      } }),
      el("button", { class: "btn small", text: "💰 Withdraw pool → vault", onclick: () => { const amt = M.withdraw(); toast(amt ? `${M.money(amt)} moved to the main vault.` : "Pool is empty.", amt ? "ok" : "err"); route(); } })
    ]));
    cols.appendChild(income);
    wrap.appendChild(cols);

    /* ---- superfunnels ---- */
    const sfPanel = el("div", { class: "panel" });
    sfPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🔗 SuperFunnels — Shell audience → Ghost offer → Human closer" })]));
    const funnels = st.superFunnels.filter(f => f.active);
    if (!funnels.length) sfPanel.appendChild(el("p", { class: "empty-note", text: "No SuperFunnels yet. Wire a Shell, a Ghost product and a closer into one pipeline." }));
    funnels.forEach(f => {
      const shell = st.shells.find(s2 => s2.id === f.shellId);
      const product = st.products.find(p => p.id === f.productId);
      const ex = st.executors.find(x => x.id === f.executorId);
      sfPanel.appendChild(el("div", { class: "sf-row" }, [
        el("div", { class: "sf-pipe" }, [
          el("span", { class: "sf-node cyan-node", text: "🎭 " + (shell ? shell.name : "?") }),
          el("span", { class: "sf-arrow", text: "→" }),
          el("span", { class: "sf-node violet-node", text: "👻 " + (product ? product.name.slice(0, 24) : "?") }),
          el("span", { class: "sf-arrow", text: "→" }),
          el("span", { class: "sf-node blue-node", text: "👤 " + (ex ? ex.name : "?") })
        ]),
        el("div", { class: "sf-stats" }, [
          el("span", { class: "dim small-note", text: `${f.stats.days}d · ${f.stats.leads} leads · ${f.stats.closes} closes · ` }),
          el("b", { class: "sf-gross", text: M.money(f.stats.gross) + " gross" }),
          el("button", { class: "btn tiny danger ghost", text: "✕", style: "margin-left:10px", onclick: () => { f.active = false; S.save(); route(); } })
        ])
      ]));
    });
    wrap.appendChild(sfPanel);

    main.appendChild(wrap);

    /* catch up funnel/loop days + auto-deliveries */
    const evs = M.process();
    if (evs.length) { evs.slice(0, 4).forEach((e2, i) => setTimeout(() => toast(e2, "info"), i * 450)); route(); }
  }

  /* ---- matrix modals ---- */
  function onboardModal() {
    const f = {};
    const body = el("div", { class: "modal-body" });
    body.appendChild(field("Name / handle", f, "name", el("input", { class: "input", placeholder: "e.g. LENA K." })));
    const roleSel = el("select", { class: "input" });
    Object.entries(M.ROLES).forEach(([r2, meta]) => roleSel.appendChild(el("option", { value: r2, text: `${meta.icon}  ${r2} — ${meta.feeds}` })));
    body.appendChild(field("Role", f, "role", roleSel));
    body.appendChild(field("Telegram / Email", f, "contact", el("input", { class: "input", placeholder: "@handle or name@mail.com" })));
    const permSel = el("select", { class: "input" });
    M.PERMISSIONS.forEach(p => permSel.appendChild(el("option", { value: p, text: p + (p === "basic" ? " — task access only" : p === "trusted" ? " — sees agent context" : " — sees offers & splits") })));
    body.appendChild(field("Permission level", f, "perm", permSel));
    const share = el("input", { class: "input", type: "number", min: 1, max: 70, value: 30 });
    roleSel.addEventListener("change", () => { share.value = M.ROLES[roleSel.value].defaultShare; });
    body.appendChild(field("PayShare — % cut of revenue they close", f, "share", share));
    U.modal({
      title: "👤 Auto-Onboard Freelancer",
      body,
      actions: [
        { label: "Cancel", cls: "ghost" },
        { label: "Onboard", cls: "blue-btn", keepOpen: true, onClick: () => {
          if (!f.name.value.trim()) { toast("Name the executor.", "err"); return; }
          U.closeModal();
          const ex = M.onboard({ name: f.name.value, role: roleSel.value, contact: f.contact.value, permission: permSel.value, payShare: share.value });
          U.sfx("spawn");
          toast(`${ex.name} is in the Matrix — ${ex.role}, ${ex.payShare}% PayShare.`, "ok");
          route();
        } }
      ]
    });
  }

  function assignModal(ex) {
    const st = S.state;
    const srcSel = el("select", { class: "input" });
    const og1 = el("optgroup", { label: "Shells (audience ops)" });
    st.shells.forEach(s2 => og1.appendChild(el("option", { value: "shell:" + s2.id, text: `🎭 ${s2.name} — ${s2.niche}` })));
    const og2 = el("optgroup", { label: "Ghost products (offer ops)" });
    st.products.slice(-8).reverse().forEach(p => og2.appendChild(el("option", { value: "product:" + p.id, text: `👻 ${p.name} (${p.status})` })));
    if (og1.children.length) srcSel.appendChild(og1);
    if (og2.children.length) srcSel.appendChild(og2);
    srcSel.appendChild(el("option", { value: "core:", text: "◈ GOD CORE (generic op)" }));
    U.modal({
      title: `Assign task → <span class="gold">${esc(ex.name)}</span> (${esc(ex.role)})`,
      body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(el("p", { text: "Pick the agent feeding this task. The brief is generated from that agent's real assets." })); b.appendChild(srcSel); return b; })(),
      actions: [
        { label: "Cancel", cls: "ghost" },
        { label: "Generate Brief & Assign", cls: "blue-btn", keepOpen: true, onClick: () => {
          const [type, id] = srcSel.value.split(":");
          const source = { type, id: id || null };
          if (type === "shell") source.shell = st.shells.find(s2 => s2.id === id);
          if (type === "product") source.product = st.products.find(p => p.id === id);
          const t = M.assignTask(ex.id, source);
          if (t) { U.sfx("click"); briefModal(t, ex); }
        } }
      ]
    });
  }

  function briefModal(t, ex) {
    U.modal({
      title: `🧾 Brief packet — ${esc(t.title)}`,
      cls: "wide",
      body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(el("pre", { class: "output-pre", text: t.brief })); b.appendChild(el("p", { class: "dim tiny-note", text: "Send this packet to the freelancer over Telegram/Email/Upwork — that part is you; delivery tracking here is simulated." })); return b; })(),
      actions: [
        { label: "Copy packet", onClick: () => U.copyText(t.brief, "Brief packet copied — paste it to " + (ex.contact || "your freelancer") + ".") },
        { label: "Email packet", onClick: () => U.emailExport(`[PRISM-X] ${t.title}`, t.brief) },
        { label: "Done", cls: "ghost", onClick: () => route() }
      ]
    });
  }

  function portalModal(ex) {
    const st = S.state;
    const mine = st.mtasks.filter(t => t.executorId === ex.id && t.status !== "scored").slice(-5).reverse();
    const b = el("div", { class: "modal-body portal-body" });
    b.appendChild(el("div", { class: "portal-head" }, [
      el("div", {}, [
        el("b", { text: ex.name }), el("span", { class: "dim", text: ` · ${ex.role} · logged in` })
      ]),
      el("span", { class: "badge gst-hit", text: `SCORE ${ex.score} · ${ex.streak}🔥 STREAK` })
    ]));
    b.appendChild(el("p", { class: "dim small-note", text: `Lifetime earnings: ${M.money(ex.earnings)} · payout rails (Stripe/PayPal/crypto) connect in a future backend.` }));
    if (!mine.length) b.appendChild(el("p", { class: "empty-note", text: "No open tasks assigned." }));
    mine.forEach(t => {
      b.appendChild(el("div", { class: "portal-task" }, [
        el("div", { class: "pt-title", text: t.title }),
        el("div", { class: "dim small-note", text: `Deadline ${new Date(t.deadline).toLocaleString()} · ${t.revenueTask ? `you earn ${ex.payShare}% per sale` : "flat + bonus"} · status: ${t.status}` }),
        el("div", { class: "vi-actions" }, [
          el("button", { class: "btn tiny", text: "View brief", onclick: () => briefModal(t, ex) }),
          t.status === "assigned" ? el("button", { class: "btn tiny blue-btn", text: "Upload deliverable (sim)", onclick: () => { M.deliver(t); S.save(); toast(`"${t.title}" delivered${t.revenue ? ` — ${M.money(t.revenue)} attributed` : ""}. Review it in the Matrix.`, "ok"); U.closeModal(); route(); } }) : null
        ].filter(Boolean))
      ]));
    });
    b.appendChild(el("p", { class: "dim tiny-note", text: "Portal preview — what this executor would see. A real multi-user portal needs a backend; until then, ship work with the brief packets." }));
    U.modal({ title: `🌍 Executor portal — ${esc(ex.name)}`, cls: "wide", body: b, actions: [{ label: "Close", cls: "ghost" }] });
  }

  function reviewTaskModal(taskId) {
    const st = S.state;
    const t = st.mtasks.find(x => x.id === taskId);
    if (!t) return;
    const ex = st.executors.find(x => x.id === t.executorId);
    if (t.status === "assigned") { if (ex) briefModal(t, ex); return; }
    const b = el("div", { class: "modal-body" });
    b.appendChild(el("p", { html: `<b>${esc(ex ? ex.name : "?")}</b> delivered <b>${esc(t.title)}</b>${t.revenue ? ` — ${M.money(t.revenue)} revenue attributed (${M.money(t.payout)} PayShare)` : ""}.` }));
    if (t.status === "scored") b.appendChild(el("p", { class: "dim", text: `Already scored ${t.rating}/5.` }));
    else {
      b.appendChild(el("p", { class: "fb-label", text: "Score the delivery" }));
      b.appendChild(U.stars(0, (n) => {
        M.scoreTask(t.id, n);
        U.sfx("rate");
        toast(`Scored ${n}/5 — ${ex ? ex.name + "'s performance is now " + ex.score : "logged"}.`, "ok");
        U.closeModal(); route();
      }));
    }
    U.modal({ title: "📦 Review delivery", body: b, actions: [{ label: "Close", cls: "ghost" }] });
  }

  function superFunnelModal() {
    const st = S.state;
    const shells = st.shells, products = st.products.filter(p => p.status !== "retired");
    const closers = st.executors.filter(x => x.active && (x.role === "DM Closer" || x.role === "Cold Email Closer"));
    if (!shells.length) { toast("Need a Shell (Phase 3) for the audience layer.", "err"); return; }
    if (!products.length) { toast("Need a Ghost product (Phase 2) for the offer layer.", "err"); return; }
    if (!closers.length) { toast("Need a human closer (DM or Cold Email) — onboard one first.", "err"); return; }
    const sSel = el("select", { class: "input" }); shells.forEach(s2 => sSel.appendChild(el("option", { value: s2.id, text: "🎭 " + s2.name + " — " + U.fmtNum(s2.followers) + " followers" })));
    const pSel = el("select", { class: "input" }); products.slice().reverse().forEach(p => pSel.appendChild(el("option", { value: p.id, text: "👻 " + p.name + (p.price ? " · $" + p.price : "") })));
    const eSel = el("select", { class: "input" }); closers.forEach(x => eSel.appendChild(el("option", { value: x.id, text: "👤 " + x.name + " — score " + x.score + " · " + x.payShare + "%" })));
    const b = el("div", { class: "modal-body" }, [
      el("p", { text: "Shell grows the audience and captures leads → Ghost product solves their pain → human closer closes. GOD CORE feeds and tracks all three." }),
      sSel, el("p", { style: "text-align:center;margin:6px 0", text: "↓" }), pSel, el("p", { style: "text-align:center;margin:6px 0", text: "↓" }), eSel
    ]);
    U.modal({
      title: "🔗 Create SuperFunnel",
      body: b,
      actions: [
        { label: "Cancel", cls: "ghost" },
        { label: "Forge SuperFunnel", cls: "blue-btn", onClick: () => {
          const f = M.createSuperFunnel(sSel.value, pSel.value, eSel.value);
          if (f) { U.evolveFlash(); U.sfx("evolve"); toast(`🔗 SuperFunnel live: ${f.name}. Revenue splits auto-calculate each sim day.`, "ok"); route(); }
        } }
      ]
    });
  }

  function humanLoopModal(owner, ownerType) {
    const st = S.state;
    if (!st.executors.length) { toast("Onboard an executor in the Matrix first.", "err"); return; }
    const kindSel = el("select", { class: "input" });
    M.LOOP_KINDS.forEach(k => kindSel.appendChild(el("option", { value: k.id, text: k.label })));
    const exSel = el("select", { class: "input" });
    function fillExecs() {
      exSel.innerHTML = "";
      const kind = M.LOOP_KINDS.find(k => k.id === kindSel.value);
      const list = st.executors.filter(x => x.active && kind.roles.includes(x.role));
      (list.length ? list : st.executors.filter(x => x.active)).forEach(x =>
        exSel.appendChild(el("option", { value: x.id, text: `${x.name} — ${x.role} · score ${x.score}` })));
    }
    kindSel.addEventListener("change", fillExecs);
    fillExecs();
    const b = el("div", { class: "modal-body" }, [
      el("p", { text: "A standing hybrid loop: every sim day, this agent routes work to the human and the income split auto-calculates." }),
      kindSel, exSel
    ]);
    U.modal({
      title: `🤝 Human integration — ${esc(owner.name)}`,
      body: b,
      actions: [
        owner.humanLoop ? { label: "Remove loop", cls: "danger", onClick: () => { owner.humanLoop = null; S.save(); toast("Human loop removed.", "info"); route(); } } : null,
        { label: "Cancel", cls: "ghost" },
        { label: "Wire Loop", cls: "blue-btn", onClick: () => {
          const ex = st.executors.find(x => x.id === exSel.value);
          owner.humanLoop = { executorId: exSel.value, kind: kindSel.value };
          owner.memory.push(`Human loop wired: ${M.LOOP_KINDS.find(k => k.id === kindSel.value).label} → ${ex ? ex.name : "?"}.`);
          S.save(); U.sfx("evolve");
          toast(`Loop live — ${ex ? ex.name : "executor"} now rides ${owner.name}'s output.`, "ok");
          route();
        } }
      ].filter(Boolean)
    });
  }

  /* =============================== PHASE ALPHA: PRISM-X BRIDGE =============================== */
  const BRIDGE_TABS = [
    ["overview", "🩺 Health"],
    ["workers", "◎ Workers"],
    ["events", "📡 Command Center"],
    ["memory", "🧠 Shared Memory"],
    ["router", "🔀 AI Router"],
    ["integrations", "🔌 Integrations"],
    ["workflows", "⚙ Workflows"],
    ["permissions", "🔑 Permissions"],
    ["api", "🛰 Internal API"],
    ["dev", "🧪 Dev Console"]
  ];

  function renderBridge(main, tab) {
    tab = tab || "overview";
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `PRISM-X BRIDGE <span class="dim">// phase alpha — foundation protocol</span>` }),
        el("p", { class: "page-sub", text: "The nervous system. Every action routes through the Bridge; every module plugs into these interfaces." })
      ]),
      el("div", { class: "head-actions" }, [
        el("span", { class: "role-pill", html: `active role: <b>${esc(B.activeRole())}</b>` })
      ])
    ]));

    const tabs = el("div", { class: "bridge-tabs" });
    BRIDGE_TABS.forEach(([k, label]) => tabs.appendChild(el("a", {
      class: "bridge-tab" + (k === tab ? " on" : ""), href: "#/bridge/" + k, text: label
    })));
    wrap.appendChild(tabs);

    const body = el("div", { class: "bridge-body" });
    ({
      overview: bridgeOverview, workers: bridgeWorkers, events: bridgeEvents,
      memory: bridgeMemory, router: bridgeRouter, integrations: bridgeIntegrations,
      workflows: bridgeWorkflows, permissions: bridgePermissions, api: bridgeApi, dev: bridgeDev
    }[tab] || bridgeOverview)(body);
    wrap.appendChild(body);
    main.appendChild(wrap);
  }

  /* ---- Health / Overview ---- */
  function bridgeOverview(body) {
    const h = B.health();
    body.appendChild(el("div", { class: "kpi-row" }, [
      kpiTile("Bridge status", h.bridge === "online" ? "● ONLINE" : "◌ INIT", null),
      kpiTile("Workers", String(h.workers), null),
      kpiTile("Events logged", String(h.events), null),
      kpiTile("Shared memories", String(h.memory), null),
      kpiTile("Success rate", h.successRate + "%", null)
    ]));
    const grid = el("div", { class: "dash-grid" });

    const left = el("div", { class: "panel" });
    left.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "System health — mission control" })]));
    const rows = [
      ["Bridge", h.bridge, h.bridge === "online" ? "ok" : "warn"],
      ["Workers online", `${h.workers} (◈${h.byType.clone} 👻${h.byType.ghost} 🎭${h.byType.shell} 👤${h.byType.executor})`, "ok"],
      ["Workflows", `${h.workflows} registered · ${h.runningWorkflows} ready`, "ok"],
      ["Failed tasks (events)", String(h.failedTasks), h.failedTasks ? "warn" : "ok"],
      ["Integrations", `${h.integrations.enabled}/${h.integrations.total} enabled · ${h.integrations.healthy} healthy`, "ok"],
      ["Memory engine", `${h.memory} entries`, "ok"],
      ["Event throughput", `${h.throughput} in last hour`, "ok"],
      ["Database (localStorage)", "persistent", "ok"],
      ["System load", h.events > 300 ? "moderate" : "light", "ok"]
    ];
    const hl = el("div", { class: "health-list" });
    rows.forEach(([k, v, s]) => hl.appendChild(el("div", { class: "health-row" }, [
      el("span", { class: "health-dot " + s }),
      el("span", { class: "health-k", text: k }),
      el("span", { class: "health-v", text: v })
    ])));
    left.appendChild(hl);
    grid.appendChild(left);

    const right = el("div", { class: "panel" });
    right.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Recent events" }), el("a", { class: "dim small-note", href: "#/bridge/events", text: "command center →" })]));
    const feed = el("div", { class: "log-list" });
    B.events().slice(0, 8).forEach(e2 => feed.appendChild(eventRow(e2)));
    if (!B.events().length) feed.appendChild(el("p", { class: "empty-note", text: "No events yet." }));
    right.appendChild(feed);
    grid.appendChild(right);
    body.appendChild(grid);

    body.appendChild(el("div", { class: "panel arch-note" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Architecture" })]),
      el("p", { class: "dim", html: `Every Clone, Ghost, Shell and Human Executor is projected through one <b>Universal Worker</b> schema (identity · mission · knowledge · memory · tools · workflows · metrics · revenue · status · evolution). All four phases feed the <b>Event Bus</b> via the Bridge. New AI providers, integrations or Worker types plug into these interfaces without redesigning the architecture.` })
    ]));
  }

  function eventRow(e2) {
    return el("div", { class: "log-row event-row" }, [
      el("span", { class: "ev-time", text: new Date(e2.at).toLocaleTimeString() }),
      el("span", { class: "ev-cat cat-" + e2.category, text: e2.category }),
      el("span", { class: "log-text", text: e2.text }),
      e2.priority === "high" ? el("span", { class: "ev-pri", text: "!" }) : null
    ].filter(Boolean));
  }

  /* ---- Universal Worker registry ---- */
  function bridgeWorkers(body) {
    if (!B.can("Workers", "read")) { body.appendChild(permDenied("Workers")); return; }
    const ws = B.workers();
    body.appendChild(el("p", { class: "dim small-note", text: `${ws.length} workers, one schema. UI still shows them as Clones/Ghosts/Shells — only the internal architecture is unified.` }));
    const showRev = B.can("Revenue", "read");
    const table = el("div", { class: "worker-table" });
    table.appendChild(el("div", { class: "wt-head" }, [
      el("span", { text: "TYPE" }), el("span", { text: "WORKER" }), el("span", { text: "MISSION" }),
      el("span", { text: "STATUS" }), el("span", { text: showRev ? "REVENUE" : "—" })
    ]));
    ws.forEach(w => {
      const meta = B.WORKER_TYPES[w.type];
      table.appendChild(el("div", { class: "wt-row", onclick: () => workerModal(w) }, [
        el("span", { class: "wt-type", html: `${meta.icon} ${meta.label}` }),
        el("span", { class: "wt-name", text: w.name }),
        el("span", { class: "wt-mission", text: w.mission }),
        el("span", { class: "wt-status", text: w.status }),
        el("span", { class: "wt-rev", text: showRev ? "$" + Math.round(w.revenue).toLocaleString() : "—" })
      ]));
    });
    if (!ws.length) table.appendChild(el("p", { class: "empty-note", text: "No workers yet." }));
    body.appendChild(table);
  }

  function workerModal(w) {
    const meta = B.WORKER_TYPES[w.type];
    const b = el("div", { class: "modal-body" });
    b.appendChild(el("pre", { class: "output-pre", text: JSON.stringify({
      identity: w.name, type: meta.label, mission: w.mission,
      knowledge: w.knowledge, tools: w.tools, metrics: w.metrics,
      revenue: w.revenue, status: w.status,
      workflows: w.workflows.length, memory_entries: w.memory.length,
      evolution: w.evolution
    }, null, 2) }));
    U.modal({ title: `${meta.icon} Worker — ${esc(w.name)}`, cls: "wide", body: b, actions: [{ label: "Close", cls: "ghost" }] });
  }

  /* ---- Command Center (event feed + filters) ---- */
  function bridgeEvents(body) {
    const catSel = el("select", { class: "input inline-select" });
    B.eventCategories().forEach(c => catSel.appendChild(el("option", { value: c, text: "Category: " + c })));
    const priSel = el("select", { class: "input inline-select" });
    [["all", "Priority: all"], ["high", "high"], ["normal", "normal"], ["medium", "medium"]].forEach(([v, l]) => priSel.appendChild(el("option", { value: v, text: l })));
    const wkSel = el("select", { class: "input inline-select" });
    wkSel.appendChild(el("option", { value: "all", text: "Worker: all" }));
    B.workers().forEach(w => wkSel.appendChild(el("option", { value: w.id, text: `${B.WORKER_TYPES[w.type].icon} ${w.name}` })));
    const timeSel = el("select", { class: "input inline-select" });
    [["all", "Time: all"], ["hour", "last hour"], ["day", "last 24h"], ["week", "last 7d"]].forEach(([v, l]) => timeSel.appendChild(el("option", { value: v, text: l })));
    body.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "📡 Command center — live activity" }),
      el("div", { class: "filter-row" }, [catSel, priSel, wkSel, timeSel])
    ]));
    const feed = el("div", { class: "log-list cc-feed" });
    function draw() {
      feed.innerHTML = "";
      const list = B.events({ category: catSel.value, priority: priSel.value, worker: wkSel.value, time: timeSel.value });
      if (!list.length) feed.appendChild(el("p", { class: "empty-note", text: "No events match." }));
      list.slice(0, 60).forEach(e2 => feed.appendChild(eventRow(e2)));
    }
    [catSel, priSel, wkSel, timeSel].forEach(s => s.addEventListener("change", draw));
    draw();
    body.appendChild(feed);
  }

  /* ---- Shared Memory Engine ---- */
  function bridgeMemory(body) {
    if (!B.can("Memory", "read")) { body.appendChild(permDenied("Memory")); return; }
    const canWrite = B.can("Memory", "write");
    if (canWrite) {
      const f = {};
      const form = el("div", { class: "panel form-panel mem-form" });
      form.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧠 Store a memory" })]));
      form.appendChild(field("Title", f, "title", el("input", { class: "input", placeholder: "e.g. Best cold-open for AI niche" })));
      form.appendChild(field("Body", f, "body", el("textarea", { class: "input", rows: 2, placeholder: "prompt · successful output · decision · lesson…" })));
      const scopeSel = el("select", { class: "input" }); B.MEMORY_SCOPES.forEach(s => scopeSel.appendChild(el("option", { value: s, text: s + (s === "global" ? " — system-wide intelligence" : s === "private" ? " — one worker" : " — cross-worker") })));
      const kindSel = el("select", { class: "input" }); ["lesson", "prompt", "success", "failure", "decision"].forEach(k => kindSel.appendChild(el("option", { value: k, text: k })));
      form.appendChild(el("div", { class: "two-col" }, [
        el("label", { class: "field" }, [el("span", { class: "field-label", text: "Scope" }), scopeSel]),
        el("label", { class: "field" }, [el("span", { class: "field-label", text: "Kind" }), kindSel])
      ]));
      form.appendChild(el("div", { class: "form-actions" }, [
        el("button", { class: "btn primary", text: "Store", onclick: () => {
          if (!f.title.value.trim()) { toast("Title required.", "err"); return; }
          B.addMemory({ title: f.title.value, body: f.body.value, scope: scopeSel.value, kind: kindSel.value });
          toast("Memory stored to the engine.", "ok"); go("#/bridge/memory");
        } })
      ]));
      body.appendChild(form);
    }

    const search = el("input", { class: "input", placeholder: "Search all memory…" });
    const scopeFilter = el("select", { class: "input inline-select" });
    ["all"].concat(B.MEMORY_SCOPES).forEach(s => scopeFilter.appendChild(el("option", { value: s, text: "Scope: " + s })));
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Memory engine" }), el("div", { class: "filter-row" }, [search, scopeFilter])]));
    const list = el("div", { class: "mem-list" });
    function draw() {
      list.innerHTML = "";
      const items = B.searchMemory(search.value, scopeFilter.value);
      if (!items.length) list.appendChild(el("p", { class: "empty-note", text: "No memories match. GOD CORE can promote a private memory to global to make it system-wide." }));
      items.forEach(m => list.appendChild(el("div", { class: "mem-entry" }, [
        el("div", {}, [
          el("span", { class: "mem-scope scope-" + m.scope, text: m.scope }),
          el("span", { class: "mem-kind", text: m.kind }),
          el("b", { class: "mem-title", text: " " + m.title })
        ]),
        m.body ? el("div", { class: "dim small-note", text: m.body }) : null,
        canWrite ? el("div", { class: "vi-actions" }, [
          m.scope !== "global" ? el("button", { class: "btn tiny", text: "↑ Promote to global", onclick: () => { B.promoteMemory(m.id, "global"); go("#/bridge/memory"); } }) : null,
          el("button", { class: "btn tiny danger ghost", text: "✕", onclick: () => { B.deleteMemory(m.id); draw(); } })
        ].filter(Boolean)) : null
      ].filter(Boolean))));
    }
    search.addEventListener("input", draw); scopeFilter.addEventListener("change", draw);
    draw();
    panel.appendChild(list);
    body.appendChild(panel);
  }

  /* ---- AI Router ---- */
  function bridgeRouter(body) {
    const r = B.router();
    body.appendChild(el("p", { class: "dim small-note", text: "Which provider handles each task category. Claude routes execute live (the Neural Link picks the model per category); GPT/Gemini routes await their integrations. Future Workers inherit this table." }));
    const panel = el("div", { class: "panel" });
    const table = el("div", { class: "router-table" });
    table.appendChild(el("div", { class: "rt-head" }, [el("span", { text: "TASK CATEGORY" }), el("span", { text: "PROVIDER" }), el("span", { text: "MODEL" })]));
    r.routes.forEach(route => {
      const provSel = el("select", { class: "input" });
      B.PROVIDERS.forEach(p => { const o = el("option", { value: p, text: p }); if (p === route.provider) o.selected = true; provSel.appendChild(o); });
      const modelSel = el("select", { class: "input" });
      B.CLAUDE_MODELS.forEach(m => { const o = el("option", { value: m, text: m }); if (m === route.model) o.selected = true; modelSel.appendChild(o); });
      const usable = route.provider === "Claude" || route.provider === "Multi-model";
      modelSel.disabled = !usable;
      provSel.addEventListener("change", () => { B.setRoute(route.id, { provider: provSel.value }); go("#/bridge/router"); });
      modelSel.addEventListener("change", () => B.setRoute(route.id, { model: modelSel.value }));
      table.appendChild(el("div", { class: "rt-row" }, [
        el("span", { class: "rt-cat", text: route.category }),
        provSel,
        el("span", {}, [modelSel, usable ? null : el("span", { class: "rt-flag", text: " awaits integration" })].filter(Boolean))
      ]));
    });
    panel.appendChild(table);
    body.appendChild(panel);
  }

  /* ---- Integration Manager ---- */
  function bridgeIntegrations(body) {
    if (!B.can("Integrations", "read")) { body.appendChild(permDenied("Integrations")); return; }
    B.ensureIntegrations();
    const canManage = B.can("Integrations", "write");
    body.appendChild(el("p", { class: "dim small-note" }, [
      el("span", { text: "Phase Alpha placeholder framework. The full control panel — adapters, action registry, credential vault, dry/live modes, worker permissions — now lives in the " }),
      el("a", { href: "#/integrations", text: "Phase Gamma Integration Center →" })
    ]));
    const grid = el("div", { class: "int-grid" });
    S.state.integrations.forEach(it => {
      grid.appendChild(el("div", { class: "int-card" }, [
        el("div", { class: "int-top" }, [
          el("div", {}, [el("b", { text: it.name }), el("span", { class: "dim small-note", text: " · " + it.group })]),
          el("span", { class: "int-status st-" + it.status, text: it.status.replace("_", " ") })
        ]),
        el("div", { class: "int-meta", text: `last sync: ${it.lastSync ? U.timeAgo(it.lastSync) : "never"} · ${it.logs.length} log(s)${it.config ? " · credentials stored" : ""}` }),
        canManage ? el("div", { class: "vi-actions" }, [
          el("button", { class: "btn tiny " + (it.enabled ? "cyan-btn" : ""), text: it.enabled ? "Enabled" : "Enable", onclick: () => { B.toggleIntegration(it.id); go("#/bridge/integrations"); } }),
          el("button", { class: "btn tiny", text: "Configure", onclick: () => {
            const ta = el("textarea", { class: "input", rows: 3, placeholder: "API key / webhook URL / account — stored locally, unused until live APIs connect" });
            ta.value = it.config || "";
            const b = el("div", { class: "modal-body" }, [
              el("p", { class: "dim small-note", text: "Future credentials for " + it.name + ". Nothing is transmitted in Phase Alpha — this only provisions the slot." }),
              el("label", { class: "field" }, [el("span", { class: "field-label", text: "Configuration" }), ta])
            ]);
            U.modal({ title: "⚙ Configure " + it.name, body: b, actions: [
              { label: "Save configuration", cls: "primary", onClick: () => { B.configureIntegration(it.id, ta.value); toast(it.name + " configuration stored.", "ok"); go("#/bridge/integrations"); } },
              { label: "Cancel", cls: "ghost" }
            ] });
          } }),
          el("button", { class: "btn tiny", text: "Health check", onclick: () => { const s = B.healthCheck(it.id); toast(`${it.name}: ${s} (mock).`, s === "healthy" ? "ok" : "info"); go("#/bridge/integrations"); } }),
          el("button", { class: "btn tiny", text: "Logs", onclick: () => U.modal({ title: it.name + " — logs", cls: "wide", body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(el("pre", { class: "output-pre", text: it.logs.join("\n") })); return b; })(), actions: [{ label: "Close", cls: "ghost" }] }) })
        ]) : el("div", { class: "dim tiny-note", text: "read-only for this role" })
      ]));
    });
    body.appendChild(grid);
  }

  /* ---- Workflow Registry ---- */
  function bridgeWorkflows(body) {
    if (!B.can("Automation", "read")) { body.appendChild(permDenied("Automation")); return; }
    const canManage = B.can("Automation", "write");
    if (canManage) {
      const f = {};
      const form = el("div", { class: "panel form-panel" });
      form.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "⚙ Register a workflow" })]));
      form.appendChild(field("Name", f, "name", el("input", { class: "input", placeholder: "e.g. Daily shell drop → editor" })));
      form.appendChild(field("Description", f, "desc", el("input", { class: "input", placeholder: "what it does" })));
      const wkSel = el("select", { class: "input" });
      wkSel.appendChild(el("option", { value: "", text: "— no worker —" }));
      B.workers().forEach(w => wkSel.appendChild(el("option", { value: w.id, text: `${B.WORKER_TYPES[w.type].icon} ${w.name}` })));
      const trSel = el("select", { class: "input" }); B.WF_TRIGGERS.forEach(t => trSel.appendChild(el("option", { value: t, text: t })));
      form.appendChild(el("div", { class: "two-col" }, [
        el("label", { class: "field" }, [el("span", { class: "field-label", text: "Connected worker" }), wkSel]),
        el("label", { class: "field" }, [el("span", { class: "field-label", text: "Trigger" }), trSel])
      ]));
      B.ensureIntegrations();
      const intSel = el("select", { class: "input" });
      intSel.appendChild(el("option", { value: "", text: "— no connected tool —" }));
      S.state.integrations.forEach(it => intSel.appendChild(el("option", { value: it.id, text: it.name })));
      form.appendChild(field("Expected result", f, "expected", el("input", { class: "input", placeholder: "e.g. edited script delivered to vault" })));
      form.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: "Connected tool (integration)" }), intSel]));
      form.appendChild(field("Execution steps (one per line)", f, "steps", el("textarea", { class: "input", rows: 3, placeholder: "detect drop\nsend to editor\npublish to queue" })));
      form.appendChild(el("div", { class: "form-actions" }, [
        el("button", { class: "btn primary", text: "Register", onclick: () => {
          if (!f.name.value.trim()) { toast("Name required.", "err"); return; }
          B.addWorkflow({
            name: f.name.value, description: f.desc.value, workerId: wkSel.value || null, trigger: trSel.value,
            integrationId: intSel.value || null, expectedResult: f.expected.value,
            steps: f.steps.value.split("\n").map(s => s.trim()).filter(Boolean)
          });
          toast("Workflow registered.", "ok"); go("#/bridge/workflows");
        } })
      ]));
      body.appendChild(form);
    }
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Workflow registry" }), el("span", { class: "dim small-note", text: "execution simulated — Make.com / n8n connect later" })]));
    const list = el("div", {});
    if (!S.state.workflows.length) list.appendChild(el("p", { class: "empty-note", text: "No workflows registered." }));
    S.state.workflows.forEach(wf => {
      const w = B.worker(wf.workerId);
      const tool = wf.integrationId ? (S.state.integrations.find(i => i.id === wf.integrationId) || {}).name : null;
      const extras = [
        (wf.steps && wf.steps.length) ? `${wf.steps.length} step(s)` : null,
        tool ? "tool: " + tool : null,
        wf.expectedResult ? "→ " + wf.expectedResult : null
      ].filter(Boolean).join(" · ");
      list.appendChild(el("div", { class: "wf-row" }, [
        el("div", {}, [
          el("b", { text: wf.name }),
          el("span", { class: "wf-badge st-" + wf.status, text: wf.status }),
          el("div", { class: "dim small-note", text: `${wf.trigger}${w ? " · " + w.name : ""}${wf.description ? " · " + wf.description : ""} · ${wf.runs} run(s) · ${B.successRate(wf)}% success` }),
          extras ? el("div", { class: "dim tiny-note", text: extras }) : null
        ].filter(Boolean)),
        canManage ? el("div", { class: "vi-actions" }, [
          el("button", { class: "btn tiny primary", text: "▶ Run (sim)", onclick: () => { const ok = B.runWorkflow(wf.id); toast(`"${wf.name}" ${ok ? "completed" : "failed"} (simulated).`, ok ? "ok" : "err"); go("#/bridge/workflows"); } }),
          el("button", { class: "btn tiny danger ghost", text: "✕", onclick: () => { B.deleteWorkflow(wf.id); go("#/bridge/workflows"); } })
        ]) : null
      ].filter(Boolean)));
    });
    panel.appendChild(list);
    body.appendChild(panel);
  }

  /* ---- Permission Engine ---- */
  function bridgePermissions(body) {
    body.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🔑 Permission engine" })]),
      el("p", { class: "dim small-note", text: "Role-based access control. Switch the active role to see enforcement across the Bridge (Workers, Revenue, Integrations, Automation, Memory gate live)." }),
      (() => {
        const sel = el("select", { class: "input", style: "max-width:260px;margin-bottom:14px" });
        B.ROLES.forEach(r => { const o = el("option", { value: r, text: r }); if (r === B.activeRole()) o.selected = true; sel.appendChild(o); });
        sel.addEventListener("change", () => { B.setRole(sel.value); toast(`Active role: ${sel.value}.`, "info"); go("#/bridge/permissions"); });
        return el("label", { class: "field" }, [el("span", { class: "field-label", text: "Active role" }), sel]);
      })(),
      (() => {
        const table = el("div", { class: "perm-table" });
        const head = el("div", { class: "perm-row perm-head" }, [el("span", { text: "ROLE" })].concat(B.RESOURCES.map(r => el("span", { text: r }))));
        table.appendChild(head);
        B.ROLES.forEach(role => {
          const row = el("div", { class: "perm-row" + (role === B.activeRole() ? " active" : "") }, [el("span", { class: "perm-role", text: role })]);
          B.RESOURCES.forEach(res => {
            const a = B.access(res, role);
            row.appendChild(el("span", { class: "perm-cell a-" + a, text: a === "full" ? "●" : a === "read" ? "◐" : "○" }));
          });
          table.appendChild(row);
        });
        return table;
      })(),
      el("p", { class: "dim tiny-note", text: "● full · ◐ read-only · ○ no access" })
    ]));
  }

  /* ---- Internal API Layer ---- */
  function bridgeApi(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Standardized internal endpoints. Future modules call these interfaces instead of reaching into each other's data. Try one:" }));
    const out = el("pre", { class: "output-pre", text: "// response appears here" });
    const runners = {
      "GET /workers": () => B.api.workers.list(),
      "GET /tasks": () => B.api.tasks.list(),
      "GET /memory": () => B.api.memory.search(""),
      "GET /events": () => B.api.events.list(),
      "GET /analytics/summary": () => B.api.analytics.summary(),
      "GET /vault": () => B.api.vault.list(),
      "GET /workflows": () => B.api.workflows.list(),
      "GET /providers": () => B.api.providers.list(),
      "GET /providers/analytics": () => B.api.providers.analytics(),
      "GET /actions": () => B.api.actions.list(),
      "GET /executions": () => B.api.executions.list(),
      "GET /knowledge": () => B.api.knowledge.list(),
      "GET /knowledge/search": () => B.api.knowledge.search("cold email"),
      "GET /missions": () => B.api.missions.list(),
      "GET /evolution": () => B.api.evolution.summary(),
      "GET /enterprise": () => B.api.enterprise.summary(),
      "GET /network": () => B.api.network.summary(),
      "GET /readiness": () => B.api.readiness.latest()
    };
    const btns = el("div", { class: "api-btns" });
    Object.keys(runners).forEach(ep => btns.appendChild(el("button", {
      class: "btn small", text: ep, onclick: () => {
        const res = runners[ep]();
        const preview = Array.isArray(res) ? { endpoint: ep, count: res.length, sample: res.slice(0, 3) } : res;
        out.textContent = JSON.stringify(preview, (k, v) => k === "raw" ? undefined : v, 2);
      }
    })));
    body.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🛰 Internal API playground" })]),
      btns, out
    ]));
  }

  /* ---- Developer Console ---- */
  function bridgeDev(body) {
    const st = S.state;
    const sections = [
      ["Workers", B.workers().map(w => ({ id: w.id, type: w.type, name: w.name }))],
      ["Events (last 10)", B.events().slice(0, 10)],
      ["Shared memory", st.sharedMemory],
      ["Workflows", st.workflows],
      ["Integrations", st.integrations.map(i => ({ name: i.name, enabled: i.enabled, status: i.status }))],
      ["AI Router", B.router().routes],
      ["API call log", st.apiLog.slice(-10)],
      ["Counts", { clones: st.clones.length, ghosts: st.ghosts.length, shells: st.shells.length, executors: st.executors.length, products: st.products.length, events: st.events.length, memory: st.sharedMemory.length }]
    ];
    body.appendChild(el("p", { class: "dim small-note", text: "Raw system inspection — debugging and future expansion only." }));
    sections.forEach(([title, data]) => {
      body.appendChild(el("details", { class: "asset-fold dev-fold" }, [
        el("summary", { text: `${title} (${Array.isArray(data) ? data.length : Object.keys(data).length})` }),
        el("pre", { class: "output-pre", text: JSON.stringify(data, null, 2) })
      ]));
    });
  }

  function permDenied(resource) {
    return el("div", { class: "panel perm-denied" }, [
      el("div", { class: "hero-glyph", text: "🔒" }),
      el("h2", { text: "Access restricted" }),
      el("p", { class: "dim", text: `The active role (${B.activeRole()}) has no access to ${resource}. Switch to Owner or Administrator in the Permissions tab.` }),
      el("button", { class: "btn", text: "Open Permissions", onclick: () => go("#/bridge/permissions") })
    ]);
  }

  /* =============================== intelligence center (PHASE H0) =============================== */
  const INT_TABS = [
    ["providers", "🧠 Providers"],
    ["manager", "🔀 Manager"],
    ["capabilities", "⚡ Capabilities"],
    ["analytics", "📊 Analytics"],
    ["health", "🩺 Health"],
    ["registry", "🗂 Registry"],
    ["future", "🔌 Future"]
  ];

  function renderIntelligence(main, tab) {
    tab = tab || "providers";
    P.ensure();
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `INTELLIGENCE CENTER <span class="dim">// phase h0 — provider layer</span>` }),
        el("p", { class: "page-sub", text: "Every intelligence request flows Worker → Bridge → Provider Manager → provider. Workers never know which provider answered. No live third-party APIs in Phase H0 — Claude (Neural Link) and the Local Cortex execute; everything else is provisioned." })
      ])
    ]));

    const tabs = el("div", { class: "bridge-tabs" });
    INT_TABS.forEach(([k, label]) => tabs.appendChild(el("a", {
      class: "bridge-tab" + (k === tab ? " on" : ""), href: "#/intelligence/" + k, text: label
    })));
    wrap.appendChild(tabs);

    const body = el("div", { class: "bridge-body" });
    ({
      providers: intProviders, manager: intManager, capabilities: intCapabilities,
      analytics: intAnalytics, health: intHealth, registry: intRegistry, future: intFuture
    }[tab] || intProviders)(body);
    wrap.appendChild(body);
    main.appendChild(wrap);
  }

  function healthDot(h) {
    return el("span", { class: "health-dot h-" + h, title: P.HEALTH_LABEL[h] || h });
  }
  function connState(p) {
    if (!p.enabled) return "disconnected";
    if (p.id === "local") return "embedded — always on";
    if (p.id === "claude") return S.state.settings.apiKey ? "connected via Neural Link" : "awaiting API key";
    return "provisioned — awaiting live API";
  }

  /* ---- MODULE 1 — provider cards ---- */
  function intProviders(body) {
    const grid = el("div", { class: "prov-grid" });
    P.list().forEach(p => {
      const h = P.healthOf(p.id);
      const caps = Object.entries(p.capabilities || {});
      grid.appendChild(el("div", { class: "prov-card" + (p.enabled ? "" : " off") }, [
        el("div", { class: "prov-top" }, [
          el("div", {}, [
            el("b", { class: "prov-name", text: p.name }),
            el("span", { class: "dim small-note", text: " · v" + p.version })
          ]),
          el("span", { class: "prov-status " + (p.enabled ? "st-on" : "st-off"), text: p.enabled ? "enabled" : "disabled" })
        ]),
        el("div", { class: "prov-health" }, [
          healthDot(h),
          el("span", { text: P.HEALTH_LABEL[h] }),
          el("span", { class: "dim small-note", text: " · " + connState(p) })
        ]),
        el("p", { class: "dim small-note", text: p.description }),
        caps.length ? el("div", { class: "cap-row" }, caps.slice(0, 6).map(([c, on]) =>
          el("span", { class: "cap-chip " + (on ? "on" : "off"), text: (on ? "✔ " : "✖ ") + c }))) : null,
        el("div", { class: "int-meta", text: `last activity: ${p.lastActivity ? timeAgo(p.lastActivity) : "never"} · ${p.analytics.requests} request(s)${p.config && Object.keys(p.config).some(k => p.config[k]) ? " · credentials stored" : ""}` }),
        el("div", { class: "vi-actions" }, [
          el("button", { class: "btn tiny " + (p.enabled ? "cyan-btn" : ""), text: p.enabled ? "Enabled" : "Enable", onclick: () => { P.toggle(p.id); go("#/intelligence"); } }),
          el("button", { class: "btn tiny", text: "Configure", onclick: () => intConfigureModal(p) }),
          el("button", { class: "btn tiny", text: "Test connection", onclick: () => {
            const s2 = P.testConnection(p.id);
            toast(`${p.name}: ${P.HEALTH_LABEL[s2]} (placeholder test).`, s2 === "healthy" || s2 === "online" ? "ok" : "info");
            go("#/intelligence");
          } })
        ])
      ].filter(Boolean)));
    });
    body.appendChild(grid);
  }

  function intConfigureModal(p) {
    const schema = (p.configSchema && p.configSchema.length) ? p.configSchema : [{ key: "apiKey", label: "API Key", type: "password" }];
    const inputs = {};
    const b = el("div", { class: "modal-body" }, [
      el("p", { class: "dim small-note", text: `Future credentials for ${p.name}. Stored locally only — nothing is transmitted in Phase H0.` })
    ]);
    schema.forEach(fld => {
      const inp = el("input", { class: "input", type: fld.type === "password" ? "password" : "text", placeholder: fld.label });
      inp.value = (p.config && p.config[fld.key]) || "";
      inputs[fld.key] = inp;
      b.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: fld.label }), inp]));
    });
    U.modal({
      title: "⚙ Configure " + p.name, body: b, actions: [
        { label: "Save configuration", cls: "primary", onClick: () => {
          const cfg = {};
          Object.keys(inputs).forEach(k => { cfg[k] = inputs[k].value.trim(); });
          P.configure(p.id, cfg);
          toast(`${p.name} configuration stored.`, "ok");
          go("#/intelligence");
        } },
        { label: "Cancel", cls: "ghost" }
      ]
    });
  }

  /* ---- MODULE 2 — the Provider Manager funnel ---- */
  function intManager(body) {
    const flowPanel = el("div", { class: "panel" });
    flowPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🔀 Provider Manager — the single funnel" })]));
    const flow = el("div", { class: "flow-diagram" });
    ["Worker", "PRISM-X Bridge", "Provider Manager", "Selected Provider", "Provider Response", "Bridge", "Worker"].forEach((n, i, arr) => {
      flow.appendChild(el("div", { class: "flow-node" + (n === "Provider Manager" ? " hot" : ""), text: n }));
      if (i < arr.length - 1) flow.appendChild(el("div", { class: "flow-arrow", text: "↓" }));
    });
    flowPanel.appendChild(flow);
    flowPanel.appendChild(el("p", { class: "dim small-note", text: "No Worker, Ghost, Shell or future module talks to an AI model directly — engine.complete() delegates every request here, and Workers never know which provider answered. Unavailable providers fail over to the Local Cortex with the switch logged." }));
    body.appendChild(flowPanel);

    /* live resolution preview per AI worker */
    const ws = B.workers().filter(w => w.type !== "executor").slice(0, 14);
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Live routing — who executes for whom" })]));
    const table = el("div", { class: "router-table" });
    table.appendChild(el("div", { class: "rt-head" }, [el("span", { text: "WORKER" }), el("span", { text: "PROVIDER FIELD" }), el("span", { text: "EXECUTES VIA" })]));
    ws.forEach(w => {
      const sel = P.resolve(w.provider || "auto", "Copywriting / content");
      table.appendChild(el("div", { class: "rt-row" }, [
        el("span", { class: "rt-cat", text: `${B.WORKER_TYPES[w.type].icon} ${w.name}` }),
        el("span", { text: w.provider || "auto" }),
        el("span", {}, [
          el("span", { text: P.name(sel.id) }),
          sel.switched ? el("span", { class: "rt-flag", text: ` (requested ${P.name(sel.requested)} — ${sel.reason})` }) : null
        ].filter(Boolean))
      ]));
    });
    if (!ws.length) panel.appendChild(el("p", { class: "empty-note", text: "No AI workers yet — forge a clone, ghost or shell." }));
    else panel.appendChild(table);
    body.appendChild(panel);

    /* MODULE 8 — recent provider events */
    const evPanel = el("div", { class: "panel" });
    evPanel.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "📡 Provider events" }),
      el("a", { class: "dim small-note", href: "#/bridge/events", text: "full Command Center →" })
    ]));
    const evs = B.events({ category: "intelligence" }).slice(0, 15);
    const list = el("div", { class: "log-list" });
    if (!evs.length) list.appendChild(el("p", { class: "empty-note", text: "No provider events yet — run any task." }));
    evs.forEach(e2 => list.appendChild(eventRow(e2)));
    evPanel.appendChild(list);
    body.appendChild(evPanel);
  }

  /* ---- MODULE 5 — capability registry ---- */
  function intCapabilities(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "What each provider can do. Later phases use this to select providers intelligently (Auto already routes by category via the AI Router)." }));
    const panel = el("div", { class: "panel", style: "overflow-x:auto" });
    const table = el("div", { class: "cap-table", style: `grid-template-columns: 140px repeat(${P.CAPS.length}, 1fr)` });
    table.appendChild(el("div", { class: "cap-head", text: "PROVIDER" }));
    P.CAPS.forEach(c => table.appendChild(el("div", { class: "cap-head", text: c })));
    P.list().forEach(p => {
      table.appendChild(el("div", { class: "cap-prov", text: p.name }));
      P.CAPS.forEach(c => {
        const on = (p.capabilities || {})[c];
        table.appendChild(el("div", { class: "cap-cell " + (on ? "on" : "off"), text: on ? "✔" : "✖" }));
      });
    });
    panel.appendChild(table);
    body.appendChild(panel);
  }

  /* ---- MODULE 6 — provider analytics ---- */
  function intAnalytics(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Live counters for Claude and the Local Cortex (requests, timings, token/cost estimates); unconnected providers hold their placeholder zeros until their APIs arrive." }));
    const panel = el("div", { class: "panel", style: "overflow-x:auto" });
    const table = el("div", { class: "pa-table" });
    table.appendChild(el("div", { class: "pa-row pa-head" }, ["PROVIDER", "REQUESTS", "SUCCESS", "FAILURE", "AVG RESPONSE", "AVG TASK", "TOKENS (EST)", "COST (EST)", "LAST ERROR"].map(h => el("span", { text: h }))));
    P.list().forEach(p => {
      const a = P.analyticsOf(p.id);
      table.appendChild(el("div", { class: "pa-row" }, [
        el("span", { class: "pa-name", text: a.name }),
        el("span", { text: String(a.requests) }),
        el("span", { text: a.successRate == null ? "—" : a.successRate + "%" }),
        el("span", { text: a.failureRate == null ? "—" : a.failureRate + "%" }),
        el("span", { text: a.requests ? (a.avgMs < 50 ? "instant" : (a.avgMs / 1000).toFixed(1) + "s") : "—" }),
        el("span", { text: a.requests ? (a.avgTaskMs < 50 ? "instant" : (a.avgTaskMs / 1000).toFixed(1) + "s") : "—" }),
        el("span", { text: fmtNum(a.tokensEst) }),
        el("span", { text: a.costEst ? "$" + a.costEst.toFixed(4) : "$0" }),
        el("span", { class: "dim pa-err", text: a.lastError ? a.lastError.slice(0, 60) : "—" })
      ]));
    });
    panel.appendChild(table);
    body.appendChild(panel);
  }

  /* ---- MODULE 7 — health monitor ---- */
  function intHealth(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Placeholder monitoring — future API integrations update these automatically. Possible states: Online · Offline · Maintenance · Authentication Required · Rate Limited · Healthy." }));
    const panel = el("div", { class: "panel" });
    P.list().forEach(p => {
      const h = P.healthOf(p.id);
      panel.appendChild(el("div", { class: "hm-row" }, [
        healthDot(h),
        el("b", { class: "hm-name", text: p.name }),
        el("span", { class: "hm-state", text: P.HEALTH_LABEL[h] }),
        el("span", { class: "dim small-note", text: p.lastActivity ? "last activity " + timeAgo(p.lastActivity) : "no activity yet" }),
        el("button", { class: "btn tiny", text: "Test", onclick: () => { const s2 = P.testConnection(p.id); toast(`${p.name}: ${P.HEALTH_LABEL[s2]}.`, "info"); go("#/intelligence/health"); } })
      ]));
    });
    body.appendChild(panel);
  }

  /* ---- MODULE 9 — provider registry ---- */
  function intRegistry(body) {
    const f = {};
    const form = el("div", { class: "panel form-panel" });
    form.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🗂 Register a provider" })]));
    form.appendChild(el("p", { class: "dim small-note", text: "Registration is all a future provider needs — no Worker architecture changes. It gets the Universal Provider Interface (8 standardized functions) and appears everywhere providers are listed." }));
    form.appendChild(el("div", { class: "two-col" }, [
      field("Provider id", f, "pid", el("input", { class: "input", placeholder: "e.g. mistral" })),
      field("Display name", f, "pname", el("input", { class: "input", placeholder: "e.g. Mistral" }))
    ]));
    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn primary", text: "Register provider", onclick: () => {
        const res = P.registerProvider({ id: f.pid.value.trim().toLowerCase(), name: f.pname.value.trim() || f.pid.value.trim() });
        if (!res.ok) { toast(res.reason, "err"); return; }
        toast(`${res.provider.name} registered — interface standardized.`, "ok");
        go("#/intelligence/registry");
      } })
    ]));
    body.appendChild(form);

    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Registry — every available provider" })]));
    P.list().forEach(p => {
      const feats = Object.entries(p.capabilities || {}).filter(([, v]) => v).map(([k]) => k);
      panel.appendChild(el("div", { class: "reg-row" }, [
        el("div", {}, [
          el("b", { text: p.name }),
          el("span", { class: "wf-badge " + (p.live ? "st-success" : "st-idle"), text: p.live ? "live" : "placeholder" }),
          el("span", { class: "dim small-note", text: ` v${p.version} · priority ${p.priority}` }),
          el("div", { class: "dim small-note", text: p.description }),
          el("div", { class: "dim tiny-note", text: `features: ${feats.length ? feats.join(", ") : "—"} · credentials: ${(p.requiredCredentials || []).join(", ") || "none"} · config schema: ${(p.configSchema || []).map(s2 => s2.key).join(", ") || "none"} · interface: ${P.interfaceComplete(p.id) ? "8/8 standardized ✔" : "incomplete"}` })
        ])
      ]));
    });
    body.appendChild(panel);
  }

  /* ---- MODULE 10 — future integration framework ---- */
  function intFuture(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Provisioned placeholders — no real integrations are created in Phase H0. Each slot activates when live provider APIs connect." }));
    const grid = el("div", { class: "int-grid" });
    [
      ["🔑 API Keys", "Per-provider key storage wired to the Configure editors — held locally, never transmitted."],
      ["🪪 OAuth", "Authorization-code flow slot for providers that use OAuth instead of static keys."],
      ["🪝 Webhooks", "Inbound event endpoints so providers can push results back into the Bridge."],
      ["🛡 Authentication", "Session/token refresh handling for long-lived provider connections."],
      ["🧰 Tool Permissions", "Per-provider allowlists (browser, terminal, filesystem) enforced by the Permission Engine."],
      ["🧭 Capability Detection", "Live capability probing to replace the static registry entries."],
      ["⬆ Version Updates", "Provider version tracking + migration notes when APIs change."]
    ].forEach(([t, d]) => grid.appendChild(el("div", { class: "int-card" }, [
      el("div", { class: "int-top" }, [el("b", { text: t }), el("span", { class: "int-status st-not_connected", text: "provisioned" })]),
      el("p", { class: "dim small-note", text: d })
    ])));
    body.appendChild(grid);
  }

  /* =============================== worker runtime (PHASE BETA) =============================== */
  function renderRuntime(main) {
    RT.ensure();
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `FIRST INTELLIGENCE <span class="dim">// phase beta — worker runtime</span>` }),
        el("p", { class: "page-sub", text: "One Worker, fully operational: every run loads memory, routes through the Bridge + Provider Manager, executes its registered workflow, updates Shared Memory, logs events and reports back for evaluation. One task at a time — reliability before expansion." })
      ])
    ]));

    const c = RT.worker();
    if (!c) { wrap.appendChild(runtimeActivation()); main.appendChild(wrap); return; }

    /* ---- Module 1 — the Worker as executable intelligence ---- */
    const wf = RT.missionWorkflow();
    const sel = P.resolve(c.provider || "auto", "Copywriting / content");
    const st8 = RT.stats();
    const status = RT.isRunning() ? "running" : (RT.waitingTasks().length ? "waiting" : "idle");
    const objInput = el("input", { class: "input", value: RT.rt().objective });
    wrap.appendChild(el("div", { class: "panel rt-status" }, [
      el("div", { class: "panel-head" }, [
        el("h2", { class: "panel-title", text: "⚡ " + c.name + " — executable worker" }),
        el("div", { class: "head-actions" }, [
          el("span", { class: "rt-state s-" + status, text: status }),
          el("a", { class: "btn tiny", href: "#/worker/" + c.id, text: "🔍 Inspector" })
        ])
      ]),
      el("div", { class: "rt-grid" }, [
        rtFact("MISSION", c.target || c.role),
        rtFact("ASSIGNED PROVIDER", `${c.provider || "auto"} → executes via ${P.name(sel.id)}`),
        rtFact("CURRENT WORKFLOW", wf ? wf.name : "—"),
        rtFact("MEMORY CONTEXT", `${(c.memory || []).length} worker entries · DNA + Decision Framework · shared memory search`),
        rtFact("EXECUTIONS", `${st8.executions} run(s)${st8.successRate != null ? " · " + st8.successRate + "% success" : ""} · est cost $${st8.totalCost}`),
        rtFact("PROGRESS", st8.lastExec ? `last: ${st8.lastExec.taskType} in ${(st8.lastExec.ms / 1000).toFixed(1)}s (quality ${st8.lastExec.quality}/100)` : "no missions yet")
      ]),
      el("div", { class: "rt-obj" }, [
        el("span", { class: "field-label", text: "Current objective" }),
        objInput,
        el("button", { class: "btn tiny", text: "Save", onclick: () => { RT.setObjective(objInput.value); toast("Objective updated.", "ok"); } })
      ])
    ]));

    /* ---- Module 6 — live execution monitor (fills during a run) ---- */
    const monitor = el("div", { class: "panel rt-monitor", hidden: true });
    wrap.appendChild(monitor);

    /* ---- Module 10 — waiting evaluations ---- */
    const evalWrap = el("div", {});
    function drawEvals() {
      evalWrap.innerHTML = "";
      RT.waitingTasks().forEach(t => {
        const exec = RT.rt().executions.find(x => x.id === t.execId);
        if (!exec) return;
        evalWrap.appendChild(el("div", { class: "panel eval-card" }, [
          el("div", { class: "panel-head" }, [
            el("h2", { class: "panel-title", text: `📋 Awaiting evaluation — ${exec.taskType}: ${exec.topic}` }),
            el("span", { class: "dim small-note", text: `${exec.provider} · ${(exec.ms / 1000).toFixed(1)}s · est $${exec.costEst}` })
          ]),
          el("pre", { class: "output-pre eval-pre", text: exec.output.slice(0, 900) + (exec.output.length > 900 ? "\n…" : "") }),
          el("div", { class: "eval-row" }, [
            el("span", { class: "dim small-note", text: `auto quality ${exec.quality}/100 · completion ${exec.completion}% · your score:` }),
            U.stars(0, (n) => {
              const res = RT.evaluate(exec.id, n);
              if (res.ok) { U.sfx("rate"); toast(`Evaluation stored — ${n}/5. Lesson written to memory.`, "ok"); go("#/runtime"); }
            }),
            el("button", { class: "btn tiny", text: "📤 Publish via Execution Layer", onclick: async () => {
              const res = await X.execute({ workerId: c.id, actionId: "queue.publish", params: { text: exec.output.slice(0, 400), title: exec.taskType + " — " + exec.topic }, mode: "live" });
              if (res.ok) toast("Queued to the Broadcast Queue via the Execution Engine.", "ok");
              else if (res.denied) toast("Denied — grant this worker Publishing in Integration Permissions.", "err");
              else toast(res.rec.error, "err");
            } })
          ])
        ]));
      });
    }
    drawEvals();
    wrap.appendChild(evalWrap);

    /* ---- Module 4 — task queue + Module 9 — Run Worker ---- */
    const qPanel = el("div", { class: "panel" });
    const runBtn = el("button", { class: "btn primary", text: "▶ Run Worker" });
    runBtn.disabled = RT.isRunning() || !RT.nextTask();
    qPanel.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "🗂 Task queue — one at a time" }),
      runBtn
    ]));
    const f = {};
    const typeSel = el("select", { class: "input inline-select" });
    ((D.ROLES[c.role] || {}).taskTypes || ["Write Tweet"]).forEach(t => typeSel.appendChild(el("option", { value: t, text: t })));
    const topicInput = el("input", { class: "input", placeholder: "topic / objective for this mission (defaults to the standing objective)", style: "flex:1" });
    qPanel.appendChild(el("div", { class: "rt-addrow" }, [
      typeSel, topicInput,
      el("button", { class: "btn small", text: "+ Queue task", onclick: () => {
        RT.addTask({ type: typeSel.value, topic: topicInput.value });
        toast("Task queued.", "ok"); go("#/runtime");
      } })
    ]));
    const qList = el("div", { class: "rt-queue" });
    function drawQueue() {
      qList.innerHTML = "";
      const q = RT.queue().slice().reverse().slice(0, 12);
      if (!q.length) qList.appendChild(el("p", { class: "empty-note", text: "Queue empty — add the first mission above." }));
      q.forEach(t => qList.appendChild(el("div", { class: "rt-task" }, [
        el("span", { class: "q-state q-" + t.state, text: t.state, title: RT.STATE_HELP[t.state] }),
        el("span", { class: "rt-task-name", text: `${t.type} — ${t.topic}` }),
        el("span", { class: "dim tiny-note", text: t.finishedAt ? timeAgo(t.finishedAt) : timeAgo(t.queuedAt) }),
        t.state === "pending" ? el("button", { class: "btn tiny danger ghost", text: "✕", onclick: () => { RT.cancelTask(t.id); go("#/runtime"); } }) : null
      ].filter(Boolean))));
    }
    drawQueue();
    qPanel.appendChild(qList);
    qPanel.appendChild(el("p", { class: "dim tiny-note", text: "states: pending → running → waiting (owner evaluation) → completed · failed · cancelled" }));
    wrap.appendChild(qPanel);

    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      runBtn.textContent = "◈ EXECUTING…";
      monitor.hidden = false;
      const res = await RT.run((live) => drawMonitor(monitor, live));
      if (res.ok) { U.sfx("spawn"); U.evolveFlash(); toast(`Mission complete via ${res.exec.provider} — evaluate the output below.`, "ok"); }
      else toast(res.reason, "err");
      go("#/runtime");
    });

    /* auto-show monitor with last state if a run just finished */

    /* ---- Module 8 — execution logs ---- */
    const logPanel = el("div", { class: "panel" });
    logPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧾 Execution logs" })]));
    const execs = RT.rt().executions.slice().reverse();
    if (!execs.length) logPanel.appendChild(el("p", { class: "empty-note", text: "No executions yet — queue a task and Run Worker." }));
    execs.slice(0, 10).forEach(x => logPanel.appendChild(el("div", { class: "exec-row", onclick: () => execModal(x) }, [
      el("span", { class: "exec-ok " + (x.success ? "ok" : "bad"), text: x.success ? "✓" : "✗" }),
      el("span", { class: "exec-name", text: `${x.taskType} — ${x.topic}` }),
      el("span", { class: "dim tiny-note", text: `${x.provider} · ${(x.ms / 1000).toFixed(1)}s · $${x.costEst} · mem ${x.memoryAccessed} · ev ${x.eventsGenerated}${x.feedback ? " · ★" + x.feedback : ""}` })
    ])));
    wrap.appendChild(logPanel);

    /* recent runtime events */
    const evs = B.events({ category: "execution" }).slice(0, 8);
    if (evs.length) {
      const evPanel = el("div", { class: "panel" });
      evPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "📡 Runtime events" }), el("a", { class: "dim small-note", href: "#/bridge/events", text: "Command Center →" })]));
      const list = el("div", { class: "log-list" });
      evs.forEach(e2 => list.appendChild(eventRow(e2)));
      evPanel.appendChild(list);
      wrap.appendChild(evPanel);
    }

    main.appendChild(wrap);
  }

  function rtFact(label, value) {
    return el("div", { class: "rt-fact" }, [
      el("span", { class: "rt-fact-label", text: label }),
      el("span", { class: "rt-fact-value", text: value })
    ]);
  }

  function runtimeActivation() {
    const panel = el("div", { class: "panel form-panel rt-activate" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "⚡ Activate the First Intelligence" })]));
    panel.appendChild(el("p", { class: "dim small-note", text: "Pick one clone to become the first fully operational Worker. It gains the runtime engine, a registered mission workflow, a task queue and an execution log. Only one Worker in Phase Beta — expansion comes after it performs reliably." }));
    const sel = el("select", { class: "input" });
    const sorted = S.state.clones.slice().sort((a, b) => b.stats.earnings - a.stats.earnings);
    sorted.forEach(c => sel.appendChild(el("option", { value: c.id, text: `${(D.ROLES[c.role] || {}).icon || "◈"} ${c.name} — ${c.role} ($${c.stats.earnings} lifetime)` })));
    panel.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: "Worker" }), sel]));
    const obj = el("input", { class: "input", placeholder: "standing objective, e.g. Ship one revenue asset per mission" });
    panel.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: "Current objective" }), obj]));
    panel.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn primary big", text: "⚡ Activate First Intelligence", onclick: () => {
        if (!S.state.clones.length) { toast("Forge a clone first.", "err"); return; }
        const res = RT.designate(sel.value, obj.value);
        if (res.ok) { U.sfx("spawn"); U.evolveFlash(); toast(`${res.worker.name} is now executable intelligence.`, "ok"); go("#/runtime"); }
      } })
    ]));
    if (!S.state.clones.length) panel.appendChild(el("p", { class: "empty-note", text: "No clones yet — forge one first." }));
    return panel;
  }

  function drawMonitor(monitor, live) {
    monitor.hidden = false;
    monitor.innerHTML = "";
    const etaLeft = Math.max(0, live.etaMs - (Date.now() - live.startedAt));
    monitor.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "🔴 Live execution monitor" }),
      el("span", { class: "dim small-note", text: live.done ? "finished" : `est. completion ~${Math.ceil(etaLeft / 1000)}s` })
    ]));
    const bar = el("div", { class: "rt-bar" }, [el("div", { class: "rt-bar-fill", style: `width:${live.progress}%` })]);
    monitor.appendChild(bar);
    monitor.appendChild(el("div", { class: "rt-grid" }, [
      rtFact("CURRENT STEP", `${live.stage} (${live.i}/${live.n})`),
      rtFact("ACTIVE PROVIDER", live.provider || `resolving… (requested ${live.requested})`),
      rtFact("WORKFLOW", live.wfName),
      rtFact("WORKFLOW STAGE", live.wfStep),
      rtFact("PROGRESS", live.progress + "%"),
      rtFact("TASK", `${live.taskType} — ${live.topic}`)
    ]));
    if (live.memory && live.memory.length) {
      const mem = el("div", { class: "rt-mem" });
      mem.appendChild(el("span", { class: "rt-fact-label", text: "MEMORY RETRIEVED (" + live.memory.length + ")" }));
      live.memory.forEach(m => mem.appendChild(el("div", { class: "dim tiny-note", text: "• " + m })));
      monitor.appendChild(mem);
    }
    if (live.error) monitor.appendChild(el("p", { class: "empty-note", text: "⚠ " + live.error }));
  }

  function execModal(x) {
    const b = el("div", { class: "modal-body" });
    b.appendChild(el("pre", { class: "output-pre", text: [
      `Execution ID:      ${x.id}`,
      `Worker:            ${x.workerName} (${x.workerId})`,
      `Task:              ${x.taskType} — ${x.topic}`,
      `Provider used:     ${x.provider}${x.requested !== x.provider ? " (requested " + x.requested + ")" : ""}`,
      `Workflow:          ${x.wfName}`,
      `Runtime:           ${(x.ms / 1000).toFixed(2)}s`,
      `Estimated cost:    $${x.costEst}`,
      `Success:           ${x.success ? "yes" : "NO — " + (x.error || "unknown error")}`,
      `Memory accessed:   ${x.memoryAccessed} item(s)`,
      `Events generated:  ${x.eventsGenerated}`,
      `Auto quality:      ${x.quality}/100 · completion ${x.completion}%`,
      `Owner feedback:    ${x.feedback ? x.feedback + "/5" : "not yet rated"}`
    ].join("\n") }));
    if (x.output) {
      b.appendChild(el("div", { class: "field-label", text: "OUTPUT", style: "margin-top:10px" }));
      b.appendChild(el("pre", { class: "output-pre", text: x.output }));
    }
    U.modal({ title: "🧾 Execution — " + x.topic, cls: "wide", body: b, actions: [
      { label: "Copy output", onClick: () => U.copyText(x.output) },
      { label: "Close", cls: "ghost" }
    ] });
  }

  /* ---- Module 7 — Worker Inspector (any worker on the universal schema) ---- */
  function renderWorkerInspector(main, id) {
    const w = B.worker(id);
    if (!w) { go("#/runtime"); return; }
    const meta = B.WORKER_TYPES[w.type];
    const st = S.state;
    const isFirst = RT.rt().workerId === id;
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "back-link", href: isFirst ? "#/runtime" : "#/bridge/workers", text: isFirst ? "← runtime" : "← workers" }),
        el("h1", { class: "page-title", html: `${meta.icon} ${esc(w.name)} <span class="dim">// worker inspector</span>` }),
        el("p", { class: "page-sub", text: `${meta.label} · ${w.status}${isFirst ? " · FIRST INTELLIGENCE" : ""}` })
      ])
    ]));

    const wfs = B.workflowsFor(id);
    const execs = RT.rt().executions.filter(x => x.workerId === id).slice().reverse();
    const dna = st.dna;
    const grid = el("div", { class: "insp-grid" });

    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🎯 Mission" })]),
      el("p", { text: w.mission }),
      isFirst ? el("p", { class: "dim small-note", text: "Objective: " + RT.rt().objective }) : null,
      el("div", { class: "dim small-note", text: `knowledge/tools: ${w.knowledge || (w.tools || []).join(", ") || "—"}` })
    ].filter(Boolean)));

    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧬 DNA" })]),
      el("div", { class: "dim small-note", text: "Inherited GOD CORE layers:" }),
      dna.tone ? el("div", { class: "tiny-note", text: "• Voice: " + dna.tone.split("\n")[0] }) : null,
      dna.mindset ? el("div", { class: "tiny-note", text: "• Mindset: " + dna.mindset.split("\n")[0] }) : null,
      dna.logic ? el("div", { class: "tiny-note", text: "• Strategy: " + dna.logic.split("\n")[0] }) : null,
      dna.decision ? el("div", { class: "tiny-note", text: "• Decision Framework: " + dna.decision.split("\n")[0] }) : null,
      w.raw && w.raw.tone ? el("div", { class: "tiny-note", text: "• Worker tone: " + w.raw.tone }) : null
    ].filter(Boolean)));

    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧠 Assigned provider" })]),
      (() => {
        const pv = w.provider || "auto";
        if (pv === "human") return el("p", { text: "Human executor — no AI provider." });
        const sel = P.resolve(pv, "Copywriting / content");
        return el("div", {}, [
          el("p", { text: `${pv} → executes via ${P.name(sel.id)}` }),
          sel.switched ? el("p", { class: "dim tiny-note", text: `requested ${P.name(sel.requested)} — ${sel.reason}` }) : null
        ].filter(Boolean));
      })()
    ]));

    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "📊 Metrics" })]),
      el("pre", { class: "output-pre", text: JSON.stringify(Object.assign({ revenue: "$" + Math.round(w.revenue) }, w.metrics), null, 2) })
    ]));

    wrap.appendChild(grid);

    const memPanel = el("div", { class: "panel" });
    memPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `🧠 Memory (${(w.memory || []).length})` })]));
    (w.memory || []).slice(-8).reverse().forEach(m => memPanel.appendChild(el("div", { class: "dim small-note", text: "• " + m })));
    if (!(w.memory || []).length) memPanel.appendChild(el("p", { class: "empty-note", text: "No memory entries yet." }));
    wrap.appendChild(memPanel);

    const wfPanel = el("div", { class: "panel" });
    wfPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `⚙ Workflows (${wfs.length})` })]));
    wfs.forEach(wf => wfPanel.appendChild(el("div", { class: "dim small-note", text: `• ${wf.name} — ${wf.trigger} · ${wf.runs} run(s) · ${B.successRate(wf)}% success` })));
    if (!wfs.length) wfPanel.appendChild(el("p", { class: "empty-note", text: "No workflows attached." }));
    wrap.appendChild(wfPanel);

    if (isFirst) {
      const qPanel = el("div", { class: "panel" });
      qPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🗂 Task queue" })]));
      RT.queue().slice().reverse().slice(0, 8).forEach(t => qPanel.appendChild(el("div", { class: "rt-task" }, [
        el("span", { class: "q-state q-" + t.state, text: t.state }),
        el("span", { class: "rt-task-name", text: `${t.type} — ${t.topic}` })
      ])));
      if (!RT.queue().length) qPanel.appendChild(el("p", { class: "empty-note", text: "Queue empty." }));
      wrap.appendChild(qPanel);
    }

    const exPanel = el("div", { class: "panel" });
    exPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `🧾 Execution history (${execs.length})` })]));
    execs.slice(0, 8).forEach(x => exPanel.appendChild(el("div", { class: "exec-row", onclick: () => execModal(x) }, [
      el("span", { class: "exec-ok " + (x.success ? "ok" : "bad"), text: x.success ? "✓" : "✗" }),
      el("span", { class: "exec-name", text: `${x.taskType} — ${x.topic}` }),
      el("span", { class: "dim tiny-note", text: `${x.provider} · ${(x.ms / 1000).toFixed(1)}s${x.feedback ? " · ★" + x.feedback : ""}` })
    ])));
    if (!execs.length) exPanel.appendChild(el("p", { class: "empty-note", text: w.type === "clone" ? "No runtime executions — designate this worker in Runtime and run a mission." : "The runtime engine currently attaches to clones only (one Worker in Phase Beta)." }));
    wrap.appendChild(exPanel);

    main.appendChild(wrap);
  }

  /* =============================== integration center (PHASE GAMMA) =============================== */
  const XC_TABS = [
    ["integrations", "🔌 Integrations"],
    ["actions", "⚡ Actions"],
    ["monitor", "🖥 Monitor"],
    ["history", "🧾 History"],
    ["vault", "🔐 Vault"],
    ["permissions", "🛡 Worker Permissions"]
  ];

  function renderIntegrationCenter(main, tab) {
    tab = tab || "integrations";
    X.ensure();
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `INTEGRATION CENTER <span class="dim">// phase gamma — real-world execution layer</span>` }),
        el("p", { class: "page-sub", text: "Every external action routes Worker → Bridge → Execution Engine → adapter. Dry Run (default) touches nothing; Live mode is real only where the browser can genuinely reach (Telegram, webhooks, Supabase, Broadcast Queue) — everything else says so instead of pretending. No silent failures." })
      ])
    ]));
    const tabs = el("div", { class: "bridge-tabs" });
    XC_TABS.forEach(([k, label]) => tabs.appendChild(el("a", {
      class: "bridge-tab" + (k === tab ? " on" : ""), href: "#/integrations/" + k, text: label
    })));
    wrap.appendChild(tabs);
    const body = el("div", { class: "bridge-body" });
    ({
      integrations: xcIntegrations, actions: xcActions, monitor: xcMonitor,
      history: xcHistory, vault: xcVault, permissions: xcPermissions
    }[tab] || xcIntegrations)(body);
    wrap.appendChild(body);
    main.appendChild(wrap);
  }

  /* ---- MODULE 1 — integration cards ---- */
  function xcIntegrations(body) {
    if (!B.can("Integrations", "read")) { body.appendChild(permDenied("Integrations")); return; }
    const canManage = B.can("Integrations", "write");
    const grid = el("div", { class: "int-grid" });
    X.gammaIntegrations().forEach(it => {
      const def = X.DEFS[it.key];
      const nActions = (def.actions || []).filter(a => !a.inbound).length;
      const auth = def.internal ? "internal — no credentials needed" : (X.vaultHas(it.key) ? `credentials in vault (${X.vaultFields(it.key).length})` : "no credentials");
      grid.appendChild(el("div", { class: "int-card" + (it.mode === "live" ? " live-card" : "") }, [
        el("div", { class: "int-top" }, [
          el("div", {}, [el("b", { text: it.name }), el("span", { class: "dim small-note", text: " · " + it.group })]),
          el("span", { class: "int-status st-" + it.status, text: it.status.replace("_", " ") })
        ]),
        el("div", { class: "int-meta", text: `auth: ${auth}` }),
        el("div", { class: "int-meta", text: `last sync: ${it.lastSync ? timeAgo(it.lastSync) : "never"} · ${nActions} action(s) · ${it.logs.length} log(s)` }),
        el("div", { class: "int-meta", text: def.internal ? "transport: internal (REAL)" : def.live ? `live transport: ${def.live} (browser-reachable)` : "live: needs server relay — dry run only" }),
        canManage ? el("div", { class: "vi-actions" }, [
          el("button", { class: "btn tiny " + (it.mode === "live" ? "gold-btn" : ""), text: it.mode === "live" ? "LIVE" : "Dry Run", title: "toggle test mode", onclick: () => { X.setMode(it.key, it.mode === "live" ? "dry" : "live"); go("#/integrations"); } }),
          def.credSchema.length ? el("button", { class: "btn tiny", text: "Configure", onclick: () => xcVaultModal(it.key) }) : null,
          el("button", { class: "btn tiny", text: "Logs", onclick: () => U.modal({ title: it.name + " — logs", cls: "wide", body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(el("pre", { class: "output-pre", text: it.logs.slice(-30).join("\n") })); return b; })(), actions: [{ label: "Close", cls: "ghost" }] }) })
        ].filter(Boolean)) : el("div", { class: "dim tiny-note", text: "read-only for this role" })
      ]));
    });
    body.appendChild(grid);
  }

  /* ---- MODULE 5 — vault configure modal (schema-driven) ---- */
  function xcVaultModal(intKey) {
    const def = X.DEFS[intKey];
    const inputs = {};
    const b = el("div", { class: "modal-body" }, [
      el("p", { class: "dim small-note", text: `Credentials for ${def.name} — encrypted at rest (AES-GCM, device key) and decrypted only inside the Execution Engine. Workers never see them. Note: browser-local encryption protects casual inspection, not a compromised device.` })
    ]);
    def.credSchema.forEach(fld => {
      const inp = el("input", { class: "input", type: fld.type === "password" ? "password" : "text", placeholder: fld.label });
      inputs[fld.key] = inp;
      b.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: fld.label }), inp]));
    });
    if (X.vaultHas(intKey)) b.appendChild(el("p", { class: "dim tiny-note", text: "Stored: " + X.vaultFields(intKey).map(f => f.field + " " + f.masked).join(" · ") + " (leave blank to keep)" }));
    U.modal({
      title: "🔐 Configure " + def.name, body: b, actions: [
        { label: "Save to vault", cls: "primary", onClick: async () => {
          for (const k of Object.keys(inputs)) {
            if (inputs[k].value.trim()) await X.vaultSet(intKey, k, inputs[k].value.trim());
          }
          toast(def.name + " credentials stored in the vault.", "ok");
          go("#/integrations");
        } },
        { label: "Cancel", cls: "ghost" }
      ]
    });
  }

  /* ---- MODULE 4 + 9 — action registry + execute ---- */
  function xcActions(body) {
    if (!B.can("Integrations", "read")) { body.appendChild(permDenied("Integrations")); return; }
    const acts = X.actions();
    const form = el("div", { class: "panel form-panel" });
    form.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "⚡ Execute an action" })]));
    const wSel = el("select", { class: "input" });
    wSel.appendChild(el("option", { value: "", text: "GOD CORE (owner — manual)" }));
    B.workers().filter(w => w.type !== "executor").forEach(w => wSel.appendChild(el("option", { value: w.id, text: `${B.WORKER_TYPES[w.type].icon} ${w.name}` })));
    const aSel = el("select", { class: "input" });
    acts.forEach(a => aSel.appendChild(el("option", { value: a.id, text: `${a.label} — ${a.integrationName}` })));
    const mSel = el("select", { class: "input" });
    [["dry", "Dry Run — simulate, touch nothing"], ["live", "Live — real (where reachable)"]].forEach(([v, l]) => mSel.appendChild(el("option", { value: v, text: l })));
    form.appendChild(el("div", { class: "two-col" }, [
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Acting worker" }), wSel]),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Mode (Module 9 — test mode)" }), mSel])
    ]));
    form.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: "Action (from the registry — workers never call integrations directly)" }), aSel]));
    const paramBox = el("div", {});
    const paramInputs = {};
    function drawParams() {
      paramBox.innerHTML = "";
      Object.keys(paramInputs).forEach(k => delete paramInputs[k]);
      const a = X.action(aSel.value);
      (a ? a.params : []).forEach(p => {
        const inp = el("input", { class: "input", placeholder: p.ph || p.label });
        paramInputs[p.key] = inp;
        paramBox.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: p.label }), inp]));
      });
    }
    aSel.addEventListener("change", drawParams);
    drawParams();
    form.appendChild(paramBox);
    const monitor = el("div", { class: "panel rt-monitor xc-live", hidden: true });
    const result = el("pre", { class: "output-pre", hidden: true });
    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn primary", text: "▶ Execute through the Engine", onclick: async () => {
        const params = {};
        Object.keys(paramInputs).forEach(k => { params[k] = paramInputs[k].value; });
        monitor.hidden = false;
        const res = await X.execute({ workerId: wSel.value || null, actionId: aSel.value, params, mode: mSel.value }, (rec) => xcDrawMonitor(monitor, rec));
        result.hidden = false;
        result.textContent = (res.ok ? "✓ " : res.denied ? "🛡 " : "✗ ") + (res.rec.result || res.rec.error);
        toast(res.ok ? "Action completed." : res.denied ? "Denied — least privilege." : "Action failed — see history.", res.ok ? "ok" : "err");
      } })
    ]));
    form.appendChild(monitor);
    form.appendChild(result);
    body.appendChild(form);

    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `Action registry (${acts.length})` })]));
    acts.forEach(a => panel.appendChild(el("div", { class: "act-row" }, [
      el("span", { class: "cap-chip on", text: X.CATEGORIES[a.category] }),
      el("b", { text: a.label }),
      el("span", { class: "dim small-note", text: a.integrationName }),
      el("span", { class: "dim tiny-note", text: a.liveTransport ? "live-capable" : "dry run only" })
    ])));
    body.appendChild(panel);
  }

  function xcDrawMonitor(monitor, rec) {
    monitor.hidden = false;
    monitor.innerHTML = "";
    monitor.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "🖥 Execution monitor" }),
      el("span", { class: "q-state q-" + (rec.status === "success" ? "completed" : rec.status === "running" ? "running" : "failed"), text: rec.status })
    ]));
    monitor.appendChild(el("div", { class: "rt-grid" }, [
      rtFact("CURRENT ACTION", rec.action),
      rtFact("INTEGRATION", rec.integration + " (" + rec.mode + ")"),
      rtFact("WORKER", rec.workerName),
      rtFact("DURATION", rec.ms ? (rec.ms / 1000).toFixed(2) + "s" : "running…"),
      rtFact("RETRY COUNT", String(rec.retries)),
      rtFact("COST", "$" + (rec.cost || 0))
    ]));
    if (rec.error) monitor.appendChild(el("p", { class: "empty-note", text: "⚠ " + rec.error + (rec.manualReview ? " — manual review suggested." : "") }));
  }

  /* ---- MODULE 6 — monitoring ---- */
  function xcMonitor(body) {
    const s2 = X.stats();
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "EXECUTIONS" }), el("div", { class: "kpi-value", text: String(s2.total) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "SUCCESS / FAILED / DENIED" }), el("div", { class: "kpi-value", text: `${s2.success} / ${s2.failed} / ${s2.denied}` })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "AVG DURATION" }), el("div", { class: "kpi-value", text: s2.avgMs < 50 ? "instant" : (s2.avgMs / 1000).toFixed(1) + "s" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "MANUAL REVIEW" }), el("div", { class: "kpi-value", text: String(s2.review) })])
    ]));
    const panel = el("div", { class: "panel rt-monitor", style: "border-color: var(--line-strong); box-shadow: none;" });
    if (s2.inFlight) xcDrawMonitor(panel, s2.inFlight);
    else if (s2.last) { xcDrawMonitor(panel, s2.last); panel.insertBefore(el("p", { class: "dim small-note", text: "No execution in flight — showing the most recent." }), panel.firstChild); }
    else panel.appendChild(el("p", { class: "empty-note", text: "No executions yet — run an action from the Actions tab." }));
    body.appendChild(panel);
  }

  /* ---- MODULE 8 — history ---- */
  function xcHistory(body) {
    const h = X.history();
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `🧾 Execution history (${h.length})` }), el("span", { class: "dim small-note", text: "timestamp · worker · provider · integration · action · result · runtime · status" })]));
    if (!h.length) panel.appendChild(el("p", { class: "empty-note", text: "Nothing executed yet." }));
    h.slice(0, 25).forEach(x => panel.appendChild(el("div", { class: "exec-row", onclick: () => U.modal({
      title: "🧾 " + x.action, cls: "wide",
      body: (() => { const b = el("div", { class: "modal-body" }); b.appendChild(el("pre", { class: "output-pre", text: JSON.stringify(x, null, 2) })); return b; })(),
      actions: [{ label: "Close", cls: "ghost" }]
    }) }, [
      el("span", { class: "exec-ok " + (x.status === "success" ? "ok" : "bad"), text: x.status === "success" ? "✓" : x.status === "denied" ? "🛡" : "✗" }),
      el("span", { class: "exec-name", text: `${x.action} · ${x.integration}` }),
      el("span", { class: "dim tiny-note", text: `${new Date(x.at).toLocaleTimeString()} · ${x.workerName} · ${x.mode} · ${(x.ms / 1000).toFixed(1)}s · ${x.retries} retr${x.retries === 1 ? "y" : "ies"}${x.manualReview ? " · ⚠ review" : ""}` })
    ])));
    body.appendChild(panel);
  }

  /* ---- MODULE 5 — vault tab ---- */
  function xcVault(body) {
    if (!B.can("Integrations", "write")) { body.appendChild(permDenied("the Credential Vault")); return; }
    body.appendChild(el("p", { class: "dim small-note", text: "API keys, OAuth tokens, secrets and webhook URLs — encrypted at rest (AES-GCM with a device key), never exposed to Workers, decrypted only inside the Execution Engine. Browser-local encryption deters casual inspection; a server vault takes over when PRISM-X grows a backend." }));
    const panel = el("div", { class: "panel" });
    X.gammaIntegrations().forEach(it => {
      const def = X.DEFS[it.key];
      if (!def.credSchema.length) return;
      const fields = X.vaultFields(it.key);
      panel.appendChild(el("div", { class: "vault-row" }, [
        el("b", { class: "hm-name", text: it.name }),
        el("span", { class: "dim small-note", text: fields.length ? fields.map(f => `${f.field}: ${f.masked}`).join(" · ") : "empty" }),
        el("div", { class: "vi-actions", style: "margin-left:auto" }, [
          el("button", { class: "btn tiny", text: "Configure", onclick: () => xcVaultModal(it.key) }),
          fields.length ? el("button", { class: "btn tiny danger ghost", text: "Clear", onclick: () => { X.vaultClear(it.key); go("#/integrations/vault"); } }) : null
        ].filter(Boolean))
      ]));
    });
    body.appendChild(panel);
  }

  /* ---- MODULE 10 — worker permissions ---- */
  function xcPermissions(body) {
    if (!B.can("Integrations", "write")) { body.appendChild(permDenied("Integration Permissions")); return; }
    body.appendChild(el("p", { class: "dim small-note", text: "Least privilege by default — a Worker with no grant is denied. GOD CORE owner actions pass through the Phase Alpha Permission Engine instead." }));
    const ws = B.workers().filter(w => w.type !== "executor");
    if (!ws.length) { body.appendChild(el("p", { class: "empty-note", text: "No AI workers yet." })); return; }
    const cats = Object.keys(X.CATEGORIES);
    const panel = el("div", { class: "panel", style: "overflow-x:auto" });
    const table = el("div", { class: "cap-table", style: `grid-template-columns: 160px repeat(${cats.length}, 1fr); min-width: ${160 + cats.length * 92}px` });
    table.appendChild(el("div", { class: "cap-head", text: "WORKER" }));
    cats.forEach(cx => table.appendChild(el("div", { class: "cap-head", text: X.CATEGORIES[cx] })));
    ws.slice(0, 14).forEach(w => {
      table.appendChild(el("div", { class: "cap-prov", text: `${B.WORKER_TYPES[w.type].icon} ${w.name}` }));
      cats.forEach(cx => {
        const on = !!X.permsFor(w.id)[cx];
        const cell = el("div", { class: "cap-cell perm-toggle " + (on ? "on" : "off"), text: on ? "✔" : "✖", title: "click to toggle" });
        cell.addEventListener("click", () => { X.setPerm(w.id, cx, !on); go("#/integrations/permissions"); });
        table.appendChild(cell);
      });
    });
    panel.appendChild(table);
    body.appendChild(panel);
  }

  /* =============================== knowledge network (PHASE DELTA) =============================== */
  const K_TABS = [
    ["vault", "📚 Vault"],
    ["search", "🔎 Semantic Search"],
    ["graph", "🕸 Graph"],
    ["dashboard", "📈 Intelligence Dashboard"]
  ];

  function renderKnowledge(main, tab) {
    tab = tab || "vault";
    K.ensure();
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `KNOWLEDGE NETWORK <span class="dim">// phase delta — long-term memory</span>` }),
        el("p", { class: "page-sub", text: "The vault every Worker consults before executing and feeds after. Search is meaning-expanded lexical retrieval (synonym graph + weighted scoring, re-ranked by confidence and freshness) — labeled honestly; true embeddings arrive with a vector store." })
      ])
    ]));
    const tabs = el("div", { class: "bridge-tabs" });
    K_TABS.forEach(([k2, label]) => tabs.appendChild(el("a", {
      class: "bridge-tab" + (k2 === tab ? " on" : ""), href: "#/knowledge/" + k2, text: label
    })));
    wrap.appendChild(tabs);
    const body = el("div", { class: "bridge-body" });
    ({ vault: kVault, search: kSearch, graph: kGraph, dashboard: kDashboard }[tab] || kVault)(body);
    wrap.appendChild(body);
    main.appendChild(wrap);
  }

  function kDocRow(d) {
    return el("div", { class: "kd-row", onclick: () => kDocModal(d) }, [
      el("span", { class: "cap-chip on", text: d.category }),
      el("span", { class: "kd-layer l-" + d.layer, text: d.layer }),
      el("b", { class: "kd-title", text: d.title }),
      el("span", { class: "dim tiny-note", text: `${d.type} · conf ${K.confidence(d)} · fresh ${K.freshness(d)} · ${d.uses || 0} use(s) · ${K.linksFor(d.id).length} link(s)${d.verified === "verified" ? " · ✔ verified" : ""}` })
    ]);
  }

  function kDocModal(d) {
    const linked = K.linksFor(d.id).map(l => K.doc(l.from === d.id ? l.to : l.from)).filter(Boolean);
    const b = el("div", { class: "modal-body" });
    b.appendChild(el("div", { class: "dim small-note", text: [
      `category ${d.category} · layer ${d.layer} · type ${d.type}`,
      `source ${d.source} · owner ${d.owner}`,
      `created ${new Date(d.createdAt).toLocaleString()} · updated ${timeAgo(d.updatedAt)}`,
      `confidence ${K.confidence(d)}/100 · freshness ${K.freshness(d)}/100 · ${d.verified} · ${d.uses || 0} retrieval(s)`
    ].join("\n"), style: "white-space:pre-line;margin-bottom:10px" }));
    if (d.body) b.appendChild(el("pre", { class: "output-pre", text: d.body }));
    if (linked.length) {
      b.appendChild(el("div", { class: "field-label", text: "LINKED KNOWLEDGE", style: "margin-top:10px" }));
      linked.forEach(o => b.appendChild(el("a", { class: "kd-link", text: "🔗 " + o.title, onclick: () => { U.closeModal(); setTimeout(() => kDocModal(o), 220); } })));
    }
    const linkSel = el("select", { class: "input", style: "margin-top:10px" });
    linkSel.appendChild(el("option", { value: "", text: "— link to another document —" }));
    K.docs().filter(o => o.id !== d.id && !linked.some(x => x.id === o.id)).forEach(o => linkSel.appendChild(el("option", { value: o.id, text: o.title })));
    b.appendChild(linkSel);
    U.modal({
      title: "📚 " + d.title, cls: "wide", body: b, actions: [
        { label: d.verified === "verified" ? "Un-verify" : "✔ Verify", onClick: () => { K.verifyDoc(d.id); toast("Verification updated — confidence " + K.confidence(K.doc(d.id)) + "/100.", "ok"); go("#/knowledge"); } },
        { label: "Add link", onClick: () => { if (linkSel.value) { K.addLink(d.id, linkSel.value, "manual"); toast("Documents linked.", "ok"); } go("#/knowledge/graph"); } },
        { label: "Delete", cls: "danger ghost", onClick: () => { K.deleteDoc(d.id); toast("Document removed.", "info"); go("#/knowledge"); } },
        { label: "Close", cls: "ghost" }
      ]
    });
  }

  /* ---- MODULE 1 + 5 — vault browser + add form ---- */
  function kVault(body) {
    const f = {};
    const form = el("div", { class: "panel form-panel" });
    form.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "📥 Add knowledge" })]));
    form.appendChild(field("Title", f, "title", el("input", { class: "input", placeholder: "e.g. Cold Email Framework v2" })));
    form.appendChild(field("Content (markdown / notes / paste anything)", f, "body", el("textarea", { class: "input", rows: 4, placeholder: "frameworks · SOPs · research · prompts · lessons · playbooks · meeting notes · decisions…" })));
    const typeSel = el("select", { class: "input" });
    K.TYPES.forEach(t => typeSel.appendChild(el("option", { value: t, text: t })));
    const catSel = el("select", { class: "input" });
    catSel.appendChild(el("option", { value: "auto", text: "Auto-classify" }));
    K.CATEGORIES.forEach(c2 => catSel.appendChild(el("option", { value: c2, text: c2 })));
    const layerSel = el("select", { class: "input" });
    Object.entries(K.LAYERS).forEach(([k2, l]) => layerSel.appendChild(el("option", { value: k2, text: l })));
    layerSel.value = "intelligence";
    form.appendChild(el("div", { class: "two-col" }, [
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Type" }), typeSel]),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Category" }), catSel])
    ]));
    form.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: "Memory layer" }), layerSel]));
    form.appendChild(field("Tags (comma-separated)", f, "tags", el("input", { class: "input", placeholder: "cold-email, outreach" })));
    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn primary", text: "Store & index", onclick: () => {
        if (!f.title.value.trim()) { toast("Title required.", "err"); return; }
        const d = K.addDoc({ title: f.title.value, body: f.body.value, type: typeSel.value, category: catSel.value, layer: layerSel.value, tags: f.tags.value.split(","), source: "manual" });
        toast(`Stored — auto-classified ${d.category}, ${K.linksFor(d.id).length} auto-link(s).`, "ok");
        go("#/knowledge");
      } })
    ]));
    body.appendChild(form);

    const catFilter = el("select", { class: "input inline-select" });
    ["all"].concat(K.CATEGORIES).forEach(c2 => catFilter.appendChild(el("option", { value: c2, text: "Category: " + c2 })));
    const layerFilter = el("select", { class: "input inline-select" });
    [["all", "Layer: all"]].concat(Object.keys(K.LAYERS).map(k2 => [k2, "Layer: " + k2])).forEach(([v, l]) => layerFilter.appendChild(el("option", { value: v, text: l })));
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: `Knowledge Vault (${K.docs().length})` }),
      el("div", { class: "filter-row" }, [catFilter, layerFilter])
    ]));
    const list = el("div", {});
    function draw() {
      list.innerHTML = "";
      const ds = K.docs().slice().reverse().filter(d =>
        (catFilter.value === "all" || d.category === catFilter.value) &&
        (layerFilter.value === "all" || d.layer === layerFilter.value));
      if (!ds.length) list.appendChild(el("p", { class: "empty-note", text: "Nothing here yet — add knowledge above or let the Learning Engine feed the vault." }));
      ds.slice(0, 30).forEach(d => list.appendChild(kDocRow(d)));
    }
    catFilter.addEventListener("change", draw); layerFilter.addEventListener("change", draw);
    draw();
    panel.appendChild(list);
    body.appendChild(panel);
  }

  /* ---- MODULE 3 — semantic search ---- */
  function kSearch(body) {
    const q = el("input", { class: "input", placeholder: `try: "what did we learn about cold email" · "my best landing page framework"` });
    const results = el("div", {});
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🔎 Search by meaning, not filename" })]));
    panel.appendChild(q);
    panel.appendChild(el("p", { class: "dim tiny-note", text: "meaning-expanded retrieval: synonym graph + weighted title/tag/body scoring, re-ranked by confidence & freshness" }));
    function draw() {
      results.innerHTML = "";
      if (!q.value.trim()) return;
      const hits = K.search(q.value, { limit: 10 });
      if (!hits.length) { results.appendChild(el("p", { class: "empty-note", text: "No knowledge matches — feed the vault and try again." })); return; }
      hits.forEach(h => {
        const row = kDocRow(h.doc);
        row.appendChild(el("span", { class: "dim tiny-note", text: ` · matched: ${h.matched.slice(0, 5).join(", ")}` }));
        results.appendChild(row);
      });
    }
    q.addEventListener("input", draw);
    panel.appendChild(results);
    body.appendChild(panel);
  }

  /* ---- MODULE 4 + 9 — knowledge graph + explorer ---- */
  function kGraph(body) {
    const ds = K.docs().slice(-24);
    const ls = K.links().filter(l => ds.some(d => d.id === l.from) && ds.some(d => d.id === l.to));
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: `🕸 Knowledge graph — ${ds.length} node(s), ${K.links().length} link(s)` }),
      el("span", { class: "dim small-note", text: "node size = retrievals · color = memory layer · click to open" })
    ]));
    if (ds.length < 2) panel.appendChild(el("p", { class: "empty-note", text: "Add a few documents to grow the graph." }));
    else {
      const W = 720, H = 420, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 50;
      const pos = {};
      ds.forEach((d, i) => {
        const ang = (i / ds.length) * Math.PI * 2 - Math.PI / 2;
        pos[d.id] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
      });
      const LAYER_COLOR = { personal: "#f5c542", operational: "#0f9bbd", business: "#0ca30c", intelligence: "#9085e9", system: "#85847c" };
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("class", "kg-svg");
      ls.forEach(l => {
        const a = pos[l.from], b2 = pos[l.to];
        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
        line.setAttribute("x2", b2.x); line.setAttribute("y2", b2.y);
        line.setAttribute("class", "kg-edge");
        svg.appendChild(line);
      });
      ds.forEach(d => {
        const p2 = pos[d.id];
        const g = document.createElementNS(svgNS, "g");
        g.setAttribute("class", "kg-node");
        g.addEventListener("click", () => kDocModal(d));
        const c2 = document.createElementNS(svgNS, "circle");
        c2.setAttribute("cx", p2.x); c2.setAttribute("cy", p2.y);
        c2.setAttribute("r", 6 + Math.min(10, (d.uses || 0) * 2));
        c2.setAttribute("fill", LAYER_COLOR[d.layer] || "#85847c");
        const t = document.createElementNS(svgNS, "text");
        t.setAttribute("x", p2.x); t.setAttribute("y", p2.y + (p2.y > cy ? 26 : -16));
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("class", "kg-label");
        t.textContent = d.title.slice(0, 22) + (d.title.length > 22 ? "…" : "");
        g.appendChild(c2); g.appendChild(t);
        svg.appendChild(g);
      });
      const box = el("div", { class: "kg-box" });
      box.appendChild(svg);
      panel.appendChild(box);
    }
    body.appendChild(panel);

    const s2 = K.stats();
    const grid = el("div", { class: "insp-grid" });
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Recent additions" })]),
      ...s2.recent.map(d => kDocRow(d))
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Most used knowledge" })]),
      ...(s2.mostUsed.filter(d => d.uses > 0).length ? s2.mostUsed.filter(d => d.uses > 0).map(d => kDocRow(d)) : [el("p", { class: "empty-note", text: "No retrievals yet." })])
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Most referenced" })]),
      ...(s2.mostRef.filter(x => x.n > 0).length ? s2.mostRef.filter(x => x.n > 0).map(x => kDocRow(x.d)) : [el("p", { class: "empty-note", text: "No links yet." })])
    ]));
    body.appendChild(grid);
  }

  /* ---- MODULE 10 — intelligence dashboard ---- */
  function kDashboard(body) {
    const s2 = K.stats();
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "KNOWLEDGE ITEMS" }), el("div", { class: "kpi-value", text: String(s2.items) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "LINKS" }), el("div", { class: "kpi-value", text: String(s2.links) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "RETRIEVALS" }), el("div", { class: "kpi-value", text: String(s2.retrievals) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "QUALITY (AVG CONF · VERIFIED)" }), el("div", { class: "kpi-value", text: s2.avgConfidence + " · " + s2.verifiedPct + "%" })])
    ]));

    /* knowledge growth — docs per day, last 14 days */
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d2 = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days.push({ label: d2.slice(5), value: s2.perDay[d2] || 0 });
    }
    const growth = el("div", { class: "panel" });
    growth.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Knowledge growth — items added per day" })]));
    const chartBox = el("div", { class: "chart-box" });
    growth.appendChild(chartBox);
    U.barChart(chartBox, { labels: days.map(d2 => d2.label), values: days.map(d2 => d2.value), height: 150, label: "knowledge growth" });
    body.appendChild(growth);

    const grid = el("div", { class: "insp-grid" });
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Most active categories" })]),
      ...(s2.byCat.length ? s2.byCat.slice(0, 6).map(([c2, n]) => el("div", { class: "act-row" }, [el("span", { class: "cap-chip on", text: c2 }), el("b", { text: n + " item(s)" })])) : [el("p", { class: "empty-note", text: "Empty vault." })])
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Recently learned (Learning Engine)" })]),
      ...(s2.recentLearned.length ? s2.recentLearned.map(d2 => kDocRow(d2)) : [el("p", { class: "empty-note", text: "Rate a runtime mission 4★+ and the Learning Engine writes the lesson here." })])
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Retrieval frequency" })]),
      ...(s2.mostUsed.filter(d2 => d2.uses > 0).length ? s2.mostUsed.filter(d2 => d2.uses > 0).map(d2 => el("div", { class: "act-row" }, [el("b", { text: d2.title.slice(0, 40) }), el("span", { class: "dim small-note", text: d2.uses + " retrieval(s)" })])) : [el("p", { class: "empty-note", text: "Workers haven't retrieved yet — run a mission." })])
    ]));
    body.appendChild(grid);
  }

  /* =============================== mission control (PHASE EPSILON) =============================== */
  const MS_TABS = [
    ["control", "🎯 Mission Control"],
    ["templates", "🧩 Templates"],
    ["analytics", "📊 Mission Analytics"]
  ];

  function renderMissions(main, tab) {
    tab = tab || "control";
    MS.ensure();
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `MISSION CONTROL <span class="dim">// phase epsilon — autonomous orchestration</span>` }),
        el("p", { class: "page-sub", text: "A high-level objective becomes a dependency graph of tasks executed by collaborating Workers under GOD CORE supervision. Each Worker builds on the previous one's output; failures recover (retry → reassign → escalate) from checkpoints — completed work is never redone." })
      ])
    ]));
    const tabs = el("div", { class: "bridge-tabs" });
    MS_TABS.forEach(([k2, label]) => tabs.appendChild(el("a", {
      class: "bridge-tab" + (k2 === tab ? " on" : ""), href: "#/missions/" + k2, text: label
    })));
    wrap.appendChild(tabs);
    const body = el("div", { class: "bridge-body" });
    ({ control: msControl, templates: msTemplates, analytics: msAnalytics }[tab] || msControl)(body);
    wrap.appendChild(body);
    main.appendChild(wrap);
  }

  /* ---- MODULES 1 + 8 — control + live dashboard ---- */
  function msControl(body) {
    const s2 = MS.stats();
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "ACTIVE" }), el("div", { class: "kpi-value", text: String(s2.active) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "COMPLETED" }), el("div", { class: "kpi-value", text: String(s2.completed) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "DELAYED / PAUSED" }), el("div", { class: "kpi-value", text: s2.delayed + " / " + s2.paused })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "TASKS DELIVERED" }), el("div", { class: "kpi-value", text: String(s2.outputs) })])
    ]));

    /* launch form */
    const f = {};
    const form = el("div", { class: "panel form-panel" });
    form.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🚀 Launch a mission" })]));
    const tplSel = el("select", { class: "input" });
    tplSel.appendChild(el("option", { value: "", text: "— custom objective (generic pipeline) —" }));
    MS.templates().forEach(t => tplSel.appendChild(el("option", { value: t.id, text: `${t.icon} ${t.name} — ${t.steps.length} tasks` })));
    const priSel = el("select", { class: "input" });
    [["high", "High"], ["normal", "Normal"], ["low", "Low"]].forEach(([v, l]) => priSel.appendChild(el("option", { value: v, text: l })));
    priSel.value = "normal";
    form.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: "Template (one click = full mission structure)" }), tplSel]));
    form.appendChild(field("Mission name", f, "name", el("input", { class: "input", placeholder: "e.g. Launch AI Prompt Pack" })));
    form.appendChild(field("Objective", f, "objective", el("input", { class: "input", placeholder: "the high-level outcome this mission must produce" })));
    const dl = el("input", { class: "input", type: "number", min: 1, value: 7 });
    form.appendChild(el("div", { class: "two-col" }, [
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Priority" }), priSel]),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Deadline (days)" }), dl])
    ]));
    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn primary", text: "🎯 Plan Mission", onclick: () => {
        const m = MS.plan({
          templateId: tplSel.value || null,
          name: f.name.value, objective: f.objective.value,
          priority: priSel.value,
          deadline: Date.now() + (parseInt(dl.value, 10) || 7) * 86400000
        });
        U.sfx("spawn");
        toast(`Mission planned — ${m.tasks.length} tasks in the graph.`, "ok");
        go("#/mission/" + m.id);
      } })
    ]));
    body.appendChild(form);

    /* live mission board */
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `Missions (${MS.missions().length})` })]));
    if (!MS.missions().length) panel.appendChild(el("p", { class: "empty-note", text: "No missions yet — launch one above." }));
    MS.missions().slice().reverse().forEach(m => {
      const h = MS.health(m);
      const bn = MS.bottleneck(m);
      panel.appendChild(el("div", { class: "ms-row", onclick: () => go("#/mission/" + m.id) }, [
        el("div", { class: "ms-top" }, [
          el("b", { text: `${m.icon} ${m.name}` }),
          el("span", { class: "ms-health h-" + h.replace(/\s+/g, "-"), text: h }),
          el("span", { class: "dim tiny-note", text: `${m.priority} · due ${new Date(m.deadline).toLocaleDateString()}` })
        ]),
        el("div", { class: "rt-bar ms-bar" }, [el("div", { class: "rt-bar-fill", style: `width:${MS.progress(m)}%` })]),
        el("div", { class: "dim tiny-note", text: [
          `${MS.progress(m)}% · ${m.tasks.filter(t => t.status === "done").length}/${m.tasks.length} tasks`,
          `workers: ${Array.from(new Set(m.tasks.map(t => t.assignedWorkerName).filter(Boolean))).join(", ") || "unassigned"}`,
          bn ? "next: " + bn : null,
          m.status === "active" ? `est ${Math.ceil(MS.estCompletion(m) / 1000)}s remaining` : m.status
        ].filter(Boolean).join(" · ") })
      ]));
    });
    body.appendChild(panel);
  }

  /* ---- MODULE 7 — templates ---- */
  function msTemplates(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "One click creates the full mission structure. Completed missions saved as templates appear here too — the flywheel." }));
    const grid = el("div", { class: "int-grid" });
    MS.templates().forEach(t => grid.appendChild(el("div", { class: "int-card" }, [
      el("div", { class: "int-top" }, [
        el("b", { text: `${t.icon} ${t.name}` }),
        t.custom ? el("span", { class: "int-status st-configured", text: "learned" }) : el("span", { class: "int-status", text: "built-in" })
      ]),
      el("p", { class: "dim small-note", text: t.objective }),
      el("div", { class: "int-meta", text: t.steps.map(s2 => s2.label).join(" → ") }),
      el("div", { class: "vi-actions" }, [
        el("button", { class: "btn tiny primary", text: "🎯 Create mission", onclick: () => {
          const m = MS.plan({ templateId: t.id });
          toast(`"${m.name}" planned — ${m.tasks.length} tasks.`, "ok");
          go("#/mission/" + m.id);
        } })
      ])
    ])));
    body.appendChild(grid);
  }

  /* ---- MODULE 10 — analytics ---- */
  function msAnalytics(body) {
    const s2 = MS.stats();
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "SUCCESS RATE" }), el("div", { class: "kpi-value", text: s2.successRate == null ? "—" : s2.successRate + "%" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "AVG COMPLETION" }), el("div", { class: "kpi-value", text: s2.avgTimeMs ? (s2.avgTimeMs / 1000).toFixed(1) + "s" : "—" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "AVG MISSION SCORE" }), el("div", { class: "kpi-value", text: s2.avgScore == null ? "—" : s2.avgScore + "/100" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "EST COST" }), el("div", { class: "kpi-value", text: "$" + s2.totalCost })])
    ]));
    const grid = el("div", { class: "insp-grid" });
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Worker performance" })]),
      ...(Object.keys(s2.byWorker).length ? Object.entries(s2.byWorker).map(([w, v]) => el("div", { class: "act-row" }, [
        el("b", { text: w }),
        el("span", { class: "dim small-note", text: `${v.done}/${v.tasks} tasks · avg ${v.done ? (v.ms / v.done / 1000).toFixed(1) : "—"}s` })
      ])) : [el("p", { class: "empty-note", text: "No mission tasks executed yet." })])
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Provider usage" })]),
      ...(Object.keys(s2.byProvider).length ? Object.entries(s2.byProvider).map(([p2, n]) => el("div", { class: "act-row" }, [
        el("b", { text: p2 }), el("span", { class: "dim small-note", text: n + " task(s)" })
      ])) : [el("p", { class: "empty-note", text: "—" })])
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Mission output (honest ROI)" })]),
      el("div", { class: "act-row" }, [el("b", { text: "Artifacts delivered" }), el("span", { class: "dim small-note", text: s2.outputs + " task output(s)" })]),
      el("div", { class: "act-row" }, [el("b", { text: "Knowledge generated" }), el("span", { class: "dim small-note", text: s2.knowledgeDocs + " vault doc(s)" })]),
      el("div", { class: "act-row" }, [el("b", { text: "Automation actions" }), el("span", { class: "dim small-note", text: s2.automation + " execution-layer call(s)" })]),
      el("p", { class: "dim tiny-note", text: "ROI shown as real outputs vs estimated cost — no simulated revenue is attributed to missions." })
    ]));
    body.appendChild(grid);
  }

  /* ---- MODULES 2/3/4/5/6/9 — mission detail + dependency graph ---- */
  function renderMissionView(main, id) {
    const m = MS.mission(id);
    if (!m) { go("#/missions"); return; }
    MS.refreshGraph(m);
    const wrap = el("div", { class: "page" });
    const h = MS.health(m);
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "back-link", href: "#/missions", text: "← mission control" }),
        el("h1", { class: "page-title", html: `${m.icon} ${esc(m.name)} <span class="dim">// ${esc(m.status)}</span>` }),
        el("p", { class: "page-sub", text: `${m.objective} · priority ${m.priority} · due ${new Date(m.deadline).toLocaleDateString()} · health: ${h}` })
      ]),
      el("div", { class: "head-actions" }, [
        m.status === "active" ? el("button", { class: "btn small", text: "▶ Run Next Task", onclick: async () => {
          const res = await MS.runTask(m.id, null);
          toast(res.ok ? `"${res.task.label}" done by ${res.task.assignedWorkerName}.` : res.reason + (res.recovery ? ` (recovery: ${res.recovery})` : ""), res.ok ? "ok" : "err");
          go("#/mission/" + m.id);
        } }) : null,
        m.status === "active" ? el("button", { class: "btn small primary", text: "⚡ Run Mission (auto)", onclick: async (ev) => {
          ev.currentTarget.disabled = true;
          const res = await MS.runMission(m.id, () => {});
          toast(res.ok ? "Mission completed — memory stored." : "Mission halted — see tasks.", res.ok ? "ok" : "info");
          U.sfx(res.ok ? "evolve" : "click");
          go("#/mission/" + m.id);
        } }) : null,
        m.status === "active" ? el("button", { class: "btn small ghost", text: "⏸ Pause", onclick: () => { MS.pauseMission(m.id); go("#/mission/" + m.id); } }) : null,
        m.status === "paused" ? el("button", { class: "btn small gold-btn", text: "⏵ Resume from checkpoint", onclick: () => { MS.resumeMission(m.id); toast("Resumed — completed tasks preserved.", "ok"); go("#/mission/" + m.id); } }) : null,
        m.status === "completed" ? el("button", { class: "btn small gold-btn", text: "⭐ Save as Template", onclick: () => { MS.saveAsTemplate(m.id); toast("Blueprint saved to Templates.", "ok"); go("#/missions/templates"); } }) : null
      ].filter(Boolean))
    ]));

    /* dependency graph (M4) — layered DAG */
    const graphPanel = el("div", { class: "panel" });
    graphPanel.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "🕸 Dependency graph" }),
      el("div", { class: "rt-bar ms-bar", style: "width:180px" }, [el("div", { class: "rt-bar-fill", style: `width:${MS.progress(m)}%` })])
    ]));
    graphPanel.appendChild(msGraph(m));
    wrap.appendChild(graphPanel);

    /* required context */
    wrap.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Mission requirements" })]),
      el("div", { class: "dim small-note", text: `knowledge: ${m.requiredKnowledge.join(" · ") || "none matched yet"}` }),
      el("div", { class: "dim small-note", text: `integrations: ${m.requiredIntegrations.join(" · ") || "none"}` })
    ]));

    /* task list (M3/M5) */
    const tPanel = el("div", { class: "panel" });
    tPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Tasks" })]));
    m.tasks.forEach(t => {
      const reSel = el("select", { class: "input inline-select" });
      reSel.appendChild(el("option", { value: "", text: "reassign…" }));
      S.state.clones.forEach(c2 => reSel.appendChild(el("option", { value: c2.id, text: c2.name })));
      reSel.addEventListener("change", () => { if (reSel.value) { MS.assign(m, t, reSel.value); toast(`"${t.label}" → manual override.`, "info"); go("#/mission/" + m.id); } });
      tPanel.appendChild(el("div", { class: "ms-task" }, [
        el("span", { class: "q-state q-" + (t.status === "done" ? "completed" : t.status === "running" ? "running" : t.status === "failed" ? "failed" : t.status === "ready" ? "waiting" : "pending"), text: t.status }),
        el("div", { class: "ms-task-mid" }, [
          el("b", { text: t.label }),
          el("div", { class: "dim tiny-note", text: [
            t.taskType,
            t.needs.length ? "needs: " + t.needs.join(", ") : "root",
            t.assignedWorkerName ? `→ ${t.assignedWorkerName} (${t.assignmentReason})` : "unassigned (auto-assigns on run)",
            t.contextFrom.length ? `context from: ${t.contextFrom.join("; ")}` : null,
            t.attempts > 1 ? `attempts: ${t.attempts}` : null,
            t.note
          ].filter(Boolean).join(" · ") })
        ]),
        t.status === "done" ? el("button", { class: "btn tiny", text: "Output", onclick: () => U.modal({ title: t.label, cls: "wide", body: (() => { const b2 = el("div", { class: "modal-body" }); b2.appendChild(el("pre", { class: "output-pre", text: t.output })); return b2; })(), actions: [{ label: "Copy", onClick: () => U.copyText(t.output) }, { label: "Close", cls: "ghost" }] }) }) : null,
        (t.status === "ready" && m.status === "active") ? el("button", { class: "btn tiny primary", text: "▶", title: "run this task", onclick: async () => {
          const res = await MS.runTask(m.id, t.id);
          toast(res.ok ? `Done by ${res.task.assignedWorkerName}.` : res.reason, res.ok ? "ok" : "err");
          go("#/mission/" + m.id);
        } }) : null,
        reSel
      ].filter(Boolean)));
    });
    wrap.appendChild(tPanel);

    /* mission memory (M6) */
    wrap.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧠 Mission memory" })]),
      el("div", { class: "dim small-note", text: `time: ${m.timeTakenMs ? (m.timeTakenMs / 1000).toFixed(1) + "s" : "—"} · est cost: $${m.costEst} · success score: ${m.successScore != null ? m.successScore + "/100" : "—"}` }),
      el("div", { class: "field-label", text: "DECISIONS", style: "margin-top:8px" }),
      ...m.decisions.map(d2 => el("div", { class: "dim tiny-note", text: "• " + d2 })),
      m.lessons.length ? el("div", { class: "field-label", text: "LESSONS", style: "margin-top:8px" }) : null,
      ...m.lessons.map(l => el("div", { class: "dim tiny-note", text: "• " + l }))
    ].filter(Boolean)));

    main.appendChild(wrap);
  }

  function msGraph(m) {
    const cols = {};
    m.tasks.forEach(t => {
      const d2 = MS.depthOf(m, t);
      (cols[d2] = cols[d2] || []).push(t);
    });
    const depths = Object.keys(cols).map(Number).sort((a2, b2) => a2 - b2);
    const W = Math.max(560, depths.length * 150), H = Math.max(200, Math.max(...depths.map(d2 => cols[d2].length)) * 74 + 40);
    const pos = {};
    depths.forEach(d2 => {
      cols[d2].forEach((t, i) => {
        pos[t.key] = { x: 80 + d2 * 150, y: 50 + i * 74 + (H - 80 - (cols[d2].length - 1) * 74) / 2 };
      });
    });
    const COLOR = { done: "#0ca30c", running: "#f5c542", ready: "#c98500", blocked: "#4a4a55", failed: "#e66767" };
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "kg-svg ms-svg");
    m.tasks.forEach(t => t.needs.forEach(k2 => {
      const a2 = pos[k2], b2 = pos[t.key];
      if (!a2 || !b2) return;
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", a2.x + 12); line.setAttribute("y1", a2.y);
      line.setAttribute("x2", b2.x - 12); line.setAttribute("y2", b2.y);
      line.setAttribute("class", "kg-edge");
      svg.appendChild(line);
    }));
    m.tasks.forEach(t => {
      const p2 = pos[t.key];
      const g = document.createElementNS(svgNS, "g");
      const c2 = document.createElementNS(svgNS, "circle");
      c2.setAttribute("cx", p2.x); c2.setAttribute("cy", p2.y); c2.setAttribute("r", 11);
      c2.setAttribute("fill", COLOR[t.status] || "#4a4a55");
      if (t.status === "running") c2.setAttribute("class", "ms-node-running");
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", p2.x); label.setAttribute("y", p2.y + 28);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "kg-label");
      label.textContent = t.label.slice(0, 20);
      g.appendChild(c2); g.appendChild(label);
      svg.appendChild(g);
    });
    const box = el("div", { class: "kg-box" });
    box.appendChild(svg);
    return box;
  }

  /* =============================== evolution engine (PHASE ZETA) =============================== */
  const EV_TABS = [
    ["center", "🧬 Evolution Center"],
    ["analyzer", "📐 Analyzer"],
    ["suggestions", "✅ Suggestions"],
    ["experiments", "⚗ Experiments"],
    ["prompts", "📝 Prompt Versions"],
    ["timeline", "🕰 Timeline"]
  ];

  function renderEvolution(main, tab) {
    tab = tab || "center";
    EV.ensure();
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `EVOLUTION ENGINE <span class="dim">// phase zeta — safe continuous improvement</span>` }),
        el("p", { class: "page-sub", text: "The system measures itself, proposes improvements and runs controlled experiments — but deploys nothing without your approval. suggested → pending → approved → applied → monitored → accepted or rolled back." })
      ])
    ]));
    const tabs = el("div", { class: "bridge-tabs" });
    EV_TABS.forEach(([k2, label]) => tabs.appendChild(el("a", {
      class: "bridge-tab" + (k2 === tab ? " on" : ""), href: "#/evolution/" + k2, text: label
    })));
    wrap.appendChild(tabs);
    const body = el("div", { class: "bridge-body" });
    ({
      center: evCenter, analyzer: evAnalyzer, suggestions: evSuggestions,
      experiments: evExperiments, prompts: evPrompts, timeline: evTimeline
    }[tab] || evCenter)(body);
    wrap.appendChild(body);
    main.appendChild(wrap);
  }

  /* ---- MODULES 1 + 10 — center + dashboard ---- */
  function evCenter(body) {
    EV.snapshotScores();
    const s2 = EV.stats();
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "SYSTEM EVOLUTION SCORE" }), el("div", { class: "kpi-value", text: s2.score + "/100" }), s2.trend.length > 1 ? U.sparkline(s2.trend, 120, 26) : null].filter(Boolean)),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "WEEKLY IMPROVEMENTS" }), el("div", { class: "kpi-value", text: String(s2.weeklyImprovements) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "PENDING / MONITORED" }), el("div", { class: "kpi-value", text: s2.pending + " / " + s2.monitored })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "ACCEPTED / REJECTED" }), el("div", { class: "kpi-value", text: s2.accepted + " / " + s2.rejected })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "EXPERIMENTS" }), el("div", { class: "kpi-value", text: String(s2.experiments) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "LEARNING VELOCITY" }), el("div", { class: "kpi-value", text: s2.learningVelocity + "/wk" })])
    ]));
    const grid = el("div", { class: "insp-grid" });
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Most improved worker" })]),
      s2.mostImproved
        ? el("div", { class: "act-row" }, [el("b", { text: s2.mostImproved.name }), el("span", { class: "dim small-note", text: `${s2.mostImproved.score}/100 (${s2.mostImproved.delta >= 0 ? "+" : ""}${s2.mostImproved.delta} since tracking began)` })])
        : el("p", { class: "empty-note", text: "Tracking begins with the first analysis." })
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Highest-ROI optimization" })]),
      s2.bestOpt
        ? el("div", { class: "act-row" }, [el("b", { text: s2.bestOpt.title }), el("span", { class: "dim small-note", text: "impact " + s2.bestOpt.impact + "/10 · accepted" })])
        : el("p", { class: "empty-note", text: "Accept an improvement to crown one." })
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Most successful experiment" })]),
      s2.bestExp
        ? el("div", { class: "act-row" }, [el("b", { text: s2.bestExp.name }), el("span", { class: "dim small-note", text: `winner ${s2.bestExp.winner} · Δquality ${Math.abs(s2.bestExp.b.quality - s2.bestExp.a.quality)}` })])
        : el("p", { class: "empty-note", text: "Run an experiment from the Experiments tab." })
    ]));
    body.appendChild(grid);
    body.appendChild(el("div", { class: "form-actions", style: "justify-content:flex-start" }, [
      el("button", { class: "btn primary", text: "📐 Run Performance Analysis", onclick: () => {
        const r = EV.analyze();
        const added = EV.generateSuggestions();
        toast(`${r.insights.length} insight(s) · ${added.length} new suggestion(s) awaiting approval.`, "ok");
        go("#/evolution/suggestions");
      } })
    ]));
  }

  /* ---- MODULES 2 + 6 + 7 — analyzer + scorecards ---- */
  function evAnalyzer(body) {
    const r = EV.analyze();
    const s2 = EV.stats();
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🎓 Intelligence scorecards" })]));
    s2.cards.forEach(c2 => {
      const hist = (S.state.evolution.scoreHistory.workers[c2.id] || []).map(x => x.score);
      panel.appendChild(el("div", { class: "sc-row" }, [
        el("b", { class: "hm-name", text: c2.name }),
        el("span", { class: "sc-score", text: c2.composite + "/100" }),
        hist.length > 1 ? U.sparkline(hist, 90, 22) : el("span", { class: "dim tiny-note", text: "trend pending" }),
        el("span", { class: "dim tiny-note", text: `acc ${c2.accuracy} · spd ${c2.speed} · rel ${c2.reliability} · cost ${c2.costEff} · knw ${c2.knowledgeUsage} · collab ${c2.collaboration}${c2.missionRate != null ? " · missions " + c2.missionRate + "%" : ""}` })
      ]));
    });
    body.appendChild(panel);

    const iPanel = el("div", { class: "panel" });
    iPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `📐 Measured insights (${r.insights.length})` })]));
    r.insights.forEach(i2 => iPanel.appendChild(el("div", { class: "act-row" }, [
      el("span", { class: "cap-chip on", text: i2.kind }),
      el("b", { text: i2.target }),
      el("span", { class: "dim small-note", text: i2.text })
    ])));
    body.appendChild(iPanel);

    const wPanel = el("div", { class: "panel" });
    wPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "⚙ Workflow & mission optimization" })]));
    if (!r.bottlenecks.length && !r.idle.length) wPanel.appendChild(el("p", { class: "empty-note", text: "No bottlenecks, duplicate steps or idle workers detected right now." }));
    r.bottlenecks.forEach(b2 => wPanel.appendChild(el("div", { class: "act-row" }, [
      el("span", { class: "cap-chip off", text: b2.dup ? "duplicate step" : "bottleneck" }),
      el("b", { text: b2.mission }),
      el("span", { class: "dim small-note", text: b2.task + (b2.ms ? ` — ${(b2.ms / 1000).toFixed(1)}s` : " — same task type as its predecessor") })
    ])));
    if (r.idle.length) wPanel.appendChild(el("div", { class: "act-row" }, [
      el("span", { class: "cap-chip off", text: "idle workers" }),
      el("span", { class: "dim small-note", text: r.idle.join(", ") + " — no tasks in 7 days" })
    ]));
    body.appendChild(wPanel);
  }

  /* ---- MODULES 3 + 9 — suggestions + safe evolution flow ---- */
  function evSuggestions(body) {
    body.appendChild(el("div", { class: "form-actions", style: "justify-content:flex-start;margin-bottom:14px" }, [
      el("button", { class: "btn small", text: "🔁 Generate suggestions", onclick: () => { const n = EV.generateSuggestions().length; toast(n ? n + " new suggestion(s)." : "Nothing new to suggest — system already analyzed.", "info"); go("#/evolution/suggestions"); } })
    ]));
    const groups = [
      ["pending", "Pending approval — your call"],
      ["approved", "Approved — ready to apply"],
      ["monitored", "Applied & monitored — accept or roll back"],
      ["accepted", "Accepted"],
      ["rejected", "Rejected"],
      ["rolled_back", "Rolled back"]
    ];
    groups.forEach(([state2, label]) => {
      const list = EV.suggestions().filter(s2 => s2.state === state2);
      if (!list.length && state2 !== "pending") return;
      const panel = el("div", { class: "panel" });
      panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: label + ` (${list.length})` })]));
      if (!list.length) panel.appendChild(el("p", { class: "empty-note", text: "Run a Performance Analysis to generate proposals — nothing deploys without you." }));
      list.forEach(s2 => panel.appendChild(el("div", { class: "sg-row" }, [
        el("div", { class: "ms-task-mid" }, [
          el("b", { text: s2.title }),
          el("div", { class: "dim tiny-note", text: `${s2.kind} · impact ${s2.impact}/10 · ${s2.auto ? "auto-appliable (reversible)" : "manual action"} · ${s2.detail}` })
        ]),
        el("div", { class: "vi-actions" }, [
          state2 === "pending" ? el("button", { class: "btn tiny primary", text: "✓ Approve", onclick: () => { EV.approve(s2.id); go("#/evolution/suggestions"); } }) : null,
          state2 === "pending" ? el("button", { class: "btn tiny danger ghost", text: "✕ Reject", onclick: () => { EV.reject(s2.id); go("#/evolution/suggestions"); } }) : null,
          state2 === "approved" ? el("button", { class: "btn tiny gold-btn", text: "⚡ Apply", onclick: () => { EV.apply(s2.id); toast("Applied — now monitored.", "ok"); go("#/evolution/suggestions"); } }) : null,
          state2 === "monitored" ? el("button", { class: "btn tiny", text: "✓ Accept", onclick: () => { EV.acceptChange(s2.id); toast("Locked in.", "ok"); go("#/evolution/suggestions"); } }) : null,
          state2 === "monitored" ? el("button", { class: "btn tiny danger ghost", text: "↩ Roll back", onclick: () => { EV.rollback(s2.id); toast("Previous state restored.", "info"); go("#/evolution/suggestions"); } }) : null
        ].filter(Boolean))
      ])));
      body.appendChild(panel);
    });
  }

  /* ---- MODULE 4 — experiments ---- */
  function evExperiments(body) {
    const form = el("div", { class: "panel form-panel" });
    form.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "⚗ Run a controlled experiment" })]));
    const wSel = el("select", { class: "input" });
    S.state.clones.forEach(c2 => wSel.appendChild(el("option", { value: c2.id, text: c2.name })));
    const kSel = el("select", { class: "input" });
    [["knowledge-ablation", "A: with vault knowledge · B: without (ablation)"], ["tone-swap", "A: current tone · B: alternate tone"]].forEach(([v, l]) => kSel.appendChild(el("option", { value: v, text: l })));
    const topic = el("input", { class: "input", placeholder: "experiment topic, e.g. cold email opener" });
    form.appendChild(el("div", { class: "two-col" }, [
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Worker" }), wSel]),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Variant design" }), kSel])
    ]));
    form.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: "Topic" }), topic]));
    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn primary", text: "⚗ Run A/B (two real generations)", onclick: async (ev2) => {
        ev2.currentTarget.disabled = true;
        const ex = await EV.runExperiment({ cloneId: wSel.value, kind: kSel.value, topic: topic.value });
        toast(ex ? `Winner: ${ex.winner} — ${ex.recommendation}` : "No worker available.", ex ? "ok" : "err");
        go("#/evolution/experiments");
      } })
    ]));
    body.appendChild(form);

    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `Experiments (${EV.experiments().length})` })]));
    if (!EV.experiments().length) panel.appendChild(el("p", { class: "empty-note", text: "No experiments yet." }));
    EV.experiments().slice().reverse().forEach(ex => panel.appendChild(el("div", { class: "sg-row" }, [
      el("div", { class: "ms-task-mid" }, [
        el("b", { text: `${ex.name} — winner ${ex.winner}` }),
        el("div", { class: "dim tiny-note", text: `${ex.a.label}: quality ${ex.a.quality}, ${(ex.a.ms / 1000).toFixed(1)}s, $${ex.a.cost} · ${ex.b.label}: quality ${ex.b.quality}, ${(ex.b.ms / 1000).toFixed(1)}s, $${ex.b.cost}` }),
        el("div", { class: "dim tiny-note", text: "→ " + ex.recommendation })
      ])
    ])));
    body.appendChild(panel);
  }

  /* ---- MODULE 5 — prompt versioning ---- */
  function evPrompts(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Every Worker's prompt (tone · mindset · skills · target) is version-controlled. Save a version before editing; roll back instantly." }));
    S.state.clones.forEach(c2 => {
      const versions = EV.promptVersions(c2.id);
      const panel = el("div", { class: "panel" });
      panel.appendChild(el("div", { class: "panel-head" }, [
        el("h2", { class: "panel-title", text: `📝 ${c2.name} — v${versions.length || 0}` }),
        el("button", { class: "btn tiny", text: "+ Save current as new version", onclick: () => {
          const v = EV.savePromptVersion(c2.id, "manual snapshot");
          toast(`${c2.name} prompt saved as v${v.v}.`, "ok");
          go("#/evolution/prompts");
        } })
      ]));
      versions.slice().reverse().forEach(v => panel.appendChild(el("div", { class: "act-row" }, [
        el("span", { class: "cap-chip on", text: "v" + v.v }),
        el("div", { class: "ms-task-mid" }, [
          el("span", { class: "dim small-note", text: `${new Date(v.at).toLocaleString()} · ${v.author}${v.notes ? " · " + v.notes : ""}` }),
          el("div", { class: "dim tiny-note", text: `tone ${v.snapshot.tone} · perf since: ${EV.versionPerf(c2, v) != null ? EV.versionPerf(c2, v) + "/5 avg" : "no ratings yet"}` })
        ]),
        el("button", { class: "btn tiny", text: "↩ Restore", onclick: () => {
          EV.rollbackPrompt(c2.id, v.v);
          toast(`${c2.name} restored to prompt v${v.v}.`, "ok");
          go("#/evolution/prompts");
        } })
      ])));
      body.appendChild(panel);
    });
  }

  /* ---- MODULE 8 — timeline ---- */
  function evTimeline(body) {
    const list = EV.timelineList();
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `🕰 Evolution timeline (${list.length})` })]));
    if (!list.length) panel.appendChild(el("p", { class: "empty-note", text: "The evolutionary history starts with your first analysis." }));
    list.forEach(t => panel.appendChild(el("div", { class: "log-row" }, [
      el("span", { class: "ev-time", text: new Date(t.at).toLocaleString() }),
      el("span", { class: "cap-chip on", text: t.kind }),
      el("span", { class: "log-text", text: t.text })
    ])));
    body.appendChild(panel);
  }

  /* =============================== enterprise OS (PHASE ETA) =============================== */
  const EN_TABS = [
    ["executive", "🏛 Executive"],
    ["orgs", "🏢 Organizations"],
    ["crm", "🤝 CRM"],
    ["revenue", "💰 Revenue"],
    ["projects", "📁 Projects"],
    ["team", "👥 Team"],
    ["automations", "🔁 Automations"]
  ];

  function renderEnterprise(main, tab) {
    tab = tab || "executive";
    EN.ensure();
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `ENTERPRISE OS <span class="dim">// phase eta — the business operating system</span>` }),
        el("p", { class: "page-sub", text: "Every business built inside PRISM-X runs on the same infrastructure: organizations, CRM, ledger, projects wired to Mission Control, teams, automations and executive reporting. The ledger is real bookkeeping — simulated agent-network earnings can be imported but are always tagged [SIM], never mixed in silently." })
      ])
    ]));
    const tabs = el("div", { class: "bridge-tabs" });
    EN_TABS.forEach(([k2, label]) => tabs.appendChild(el("a", {
      class: "bridge-tab" + (k2 === tab ? " on" : ""), href: "#/enterprise/" + k2, text: label
    })));
    wrap.appendChild(tabs);
    const body = el("div", { class: "bridge-body" });
    ({
      executive: enExecutive, orgs: enOrgs, crm: enCrm, revenue: enRevenue,
      projects: enProjects, team: enTeam, automations: enAutomations
    }[tab] || enExecutive)(body);
    wrap.appendChild(body);
    main.appendChild(wrap);
  }

  /* ---- MODULES 8 + 10 — executive dashboard + reports ---- */
  function enExecutive(body) {
    const ex = EN.executive();
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "REVENUE (LEDGER)" }), el("div", { class: "kpi-value", text: EN.money(ex.revenue) }), ex.simulated ? el("div", { class: "kpi-delta", text: EN.money(ex.simulated) + " tagged [SIM]" }) : null].filter(Boolean)),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "PROFIT · MRR" }), el("div", { class: "kpi-value", text: EN.money(ex.profit) + " · " + EN.money(ex.mrr) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "BUSINESS HEALTH" }), el("div", { class: "kpi-value", text: ex.health + "/100" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "ACTIVE MISSIONS" }), el("div", { class: "kpi-value", text: String(ex.activeMissions) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "WORKER UTILIZATION" }), el("div", { class: "kpi-value", text: ex.workerUtilization + "%" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "CLIENTS (WON / AT RISK)" }), el("div", { class: "kpi-value", text: `${ex.clientHealth.total} (${ex.clientHealth.won} / ${ex.clientHealth.atRisk})` })])
    ]));
    const grid = el("div", { class: "insp-grid" });
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "⚠ Upcoming risks" })]),
      ...(ex.risks.length ? ex.risks.map(r => el("div", { class: "dim small-note", text: "• " + r })) : [el("p", { class: "empty-note", text: "No risks detected." })])
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🏆 Recent wins" })]),
      ...(ex.wins.length ? ex.wins.map(w => el("div", { class: "dim small-note", text: "• " + w })) : [el("p", { class: "empty-note", text: "Wins land here — close a client or complete a mission." })])
    ]));
    body.appendChild(grid);

    const repPanel = el("div", { class: "panel" });
    const perSel = el("select", { class: "input inline-select" });
    Object.keys(EN.PERIODS).forEach(p2 => perSel.appendChild(el("option", { value: p2, text: p2 })));
    perSel.value = "weekly";
    repPanel.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: `📄 Executive reports (${EN.reports().length})` }),
      el("div", { class: "filter-row" }, [perSel, el("button", { class: "btn small primary", text: "Generate report", onclick: () => {
        EN.generateReport(perSel.value);
        toast("Report generated from live system data.", "ok");
        go("#/enterprise");
      } })])
    ]));
    EN.reports().slice(0, 5).forEach(r => repPanel.appendChild(el("div", { class: "exec-row", onclick: () => U.modal({
      title: "📄 " + r.period + " report — " + new Date(r.at).toLocaleDateString(), cls: "wide",
      body: (() => { const b2 = el("div", { class: "modal-body" }); b2.appendChild(el("pre", { class: "output-pre", text: r.text })); return b2; })(),
      actions: [{ label: "Copy", onClick: () => U.copyText(r.text) }, { label: "Close", cls: "ghost" }]
    }) }, [
      el("span", { class: "exec-ok ok", text: "📄" }),
      el("span", { class: "exec-name", text: r.period.toUpperCase() + " — " + new Date(r.at).toLocaleString() })
    ])));
    if (!EN.reports().length) repPanel.appendChild(el("p", { class: "empty-note", text: "Generate the first report — it compiles revenue, growth, missions, worker performance, recommendations and priorities from live data." }));
    body.appendChild(repPanel);
  }

  /* ---- MODULES 1 + 9 — organizations + business templates ---- */
  function enOrgs(body) {
    const tplPanel = el("div", { class: "panel" });
    tplPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧩 Business templates — one click deploys a complete workspace" })]));
    const tplGrid = el("div", { class: "int-grid" });
    EN.BIZ_TEMPLATES.forEach(t => tplGrid.appendChild(el("div", { class: "int-card" }, [
      el("div", { class: "int-top" }, [el("b", { text: `${t.icon} ${t.name}` }), el("span", { class: "dim small-note", text: t.industry })]),
      el("div", { class: "int-meta", text: "KPIs: " + t.kpis.join(" · ") },),
      el("div", { class: "int-meta", text: `deploys: org + CRM + ${t.cloneRole} worker + playbook + ops workflow + automation` }),
      el("div", { class: "vi-actions" }, [
        el("button", { class: "btn tiny primary", text: "🏛 Deploy", onclick: () => {
          const res = EN.deployTemplate(t.id);
          U.sfx("spawn"); U.evolveFlash();
          toast(`${res.org.name} deployed — worker ${res.clone.name} forged, workspace ready.`, "ok");
          go("#/enterprise/orgs");
        } })
      ])
    ])));
    tplPanel.appendChild(tplGrid);
    body.appendChild(tplPanel);

    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `Organizations (${EN.orgs().length})` })]));
    if (!EN.orgs().length) panel.appendChild(el("p", { class: "empty-note", text: "No organizations yet — deploy a template above." }));
    EN.orgs().forEach(o => {
      const fs = EN.financeStats(o.id);
      const activeMissions = o.missionIds.map(id => MS.mission(id)).filter(m => m && m.status === "active").length;
      panel.appendChild(el("div", { class: "ms-row", onclick: () => enOrgModal(o) }, [
        el("div", { class: "ms-top" }, [
          el("b", { text: `${o.logo} ${o.name}` }),
          el("span", { class: "ms-health h-" + (o.status === "active" ? "on-track" : "paused"), text: o.status }),
          el("span", { class: "dim tiny-note", text: o.industry })
        ]),
        el("div", { class: "dim tiny-note", text: `revenue ${EN.money(fs.revenue)} · expenses ${EN.money(fs.expenses)} · profit ${EN.money(fs.profit)} · team ${o.team.length} · ${activeMissions} active mission(s) · integrations ${o.integrationKeys.length || "org-wide"}` })
      ]));
    });
    body.appendChild(panel);
  }

  function enOrgModal(o) {
    const fs = EN.financeStats(o.id);
    const b = el("div", { class: "modal-body" });
    b.appendChild(el("pre", { class: "output-pre", text: [
      `${o.logo} ${o.name} — ${o.industry} · ${o.status}`,
      o.description,
      ``,
      `Revenue:  ${EN.money(fs.revenue)}   Expenses: ${EN.money(fs.expenses)}   Profit: ${EN.money(fs.profit)}`,
      `MRR: ${EN.money(fs.mrr)} · ARR: ${EN.money(fs.arr)}`,
      `Team: ${o.team.map(t => `${t.name} (${t.role})`).join(", ") || "—"}`,
      `KPIs: ${o.kpis.join(" · ") || "—"}`,
      `Missions: ${o.missionIds.length}`
    ].join("\n") }));
    U.modal({ title: o.logo + " " + o.name, cls: "wide", body: b, actions: [{ label: "Close", cls: "ghost" }] });
  }

  /* ---- MODULE 2 — CRM ---- */
  function enCrm(body) {
    const f = {};
    const form = el("div", { class: "panel form-panel" });
    form.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "➕ Add client" })]));
    const orgSel = el("select", { class: "input" });
    EN.orgs().forEach(o => orgSel.appendChild(el("option", { value: o.id, text: `${o.logo} ${o.name}` })));
    form.appendChild(el("div", { class: "two-col" }, [
      field("Name", f, "name", el("input", { class: "input", placeholder: "client name" })),
      field("Company", f, "company", el("input", { class: "input", placeholder: "company" }))
    ]));
    form.appendChild(el("div", { class: "two-col" }, [
      field("Email", f, "email", el("input", { class: "input", placeholder: "email" })),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Organization" }), orgSel])
    ]));
    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn primary", text: "Add to pipeline", onclick: () => {
        if (!f.name.value.trim()) { toast("Name required.", "err"); return; }
        if (!EN.orgs().length) { toast("Deploy an organization first.", "err"); return; }
        EN.addClient({ name: f.name.value, company: f.company.value, email: f.email.value, orgId: orgSel.value });
        toast("Client added as a lead.", "ok");
        go("#/enterprise/crm");
      } })
    ]));
    body.appendChild(form);

    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: `Pipeline (${EN.clients().length})` }),
      el("span", { class: "dim small-note", text: EN.STAGES.join(" → ") })
    ]));
    if (!EN.clients().length) panel.appendChild(el("p", { class: "empty-note", text: "Empty pipeline — add the first lead." }));
    EN.clients().slice().reverse().forEach(c => panel.appendChild(el("div", { class: "ms-row", onclick: () => enClientModal(c) }, [
      el("div", { class: "ms-top" }, [
        el("b", { text: c.name }),
        el("span", { class: "q-state q-" + (c.stage === "won" ? "completed" : c.stage === "lost" ? "failed" : "waiting"), text: c.stage }),
        el("span", { class: "dim tiny-note", text: (c.company ? c.company + " · " : "") + EN.money(EN.clientRevenue(c.id)) + " lifetime" })
      ]),
      el("div", { class: "dim tiny-note", text: c.timeline.slice(-1).map(t => t.text).join("") })
    ])));
    body.appendChild(panel);
  }

  function enClientModal(c) {
    const b = el("div", { class: "modal-body" });
    b.appendChild(el("div", { class: "dim small-note", style: "white-space:pre-line;margin-bottom:8px", text: [
      `${c.name}${c.company ? " · " + c.company : ""}`,
      `${c.email || "no email"} · ${c.phone || "no phone"}`,
      `Lifetime revenue: ${EN.money(EN.clientRevenue(c.id))} · contracts: ${c.contracts.length}`
    ].join("\n") }));
    const stageSel = el("select", { class: "input" });
    EN.STAGES.forEach(s2 => { const o = el("option", { value: s2, text: "stage: " + s2 }); if (s2 === c.stage) o.selected = true; stageSel.appendChild(o); });
    stageSel.addEventListener("change", () => { EN.setStage(c.id, stageSel.value); toast("Stage updated.", "ok"); });
    const wSel = el("select", { class: "input" });
    wSel.appendChild(el("option", { value: "", text: "assigned worker: —" }));
    S.state.clones.forEach(cl => { const o = el("option", { value: cl.id, text: "worker: " + cl.name }); if (cl.id === c.assignedWorkerId) o.selected = true; wSel.appendChild(o); });
    wSel.addEventListener("change", () => { c.assignedWorkerId = wSel.value || null; S.save(); });
    const hSel = el("select", { class: "input" });
    hSel.appendChild(el("option", { value: "", text: "assigned human: —" }));
    S.state.executors.forEach(x => { const o = el("option", { value: x.id, text: "human: " + x.name }); if (x.id === c.assignedHumanId) o.selected = true; hSel.appendChild(o); });
    hSel.addEventListener("change", () => { c.assignedHumanId = hSel.value || null; S.save(); });
    b.appendChild(el("div", { class: "two-col" }, [
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Pipeline stage" }), stageSel]),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Assignments" }), el("div", {}, [wSel, hSel])])
    ]));
    const note = el("input", { class: "input", placeholder: "add a note…" });
    b.appendChild(el("div", { class: "rt-addrow" }, [note, el("button", { class: "btn small", text: "+ Note", onclick: () => {
      if (!note.value.trim()) return;
      c.notes.push({ at: Date.now(), text: note.value.trim() });
      EN.clientTimeline(c.id, "note", note.value.trim());
      note.value = "";
      toast("Note saved to the timeline.", "ok");
    } })]));
    b.appendChild(el("div", { class: "field-label", text: "COMMUNICATION TIMELINE", style: "margin-top:10px" }));
    c.timeline.slice().reverse().slice(0, 10).forEach(t => b.appendChild(el("div", { class: "dim tiny-note", text: `${new Date(t.at).toLocaleString()} · ${t.kind} — ${t.text}` })));
    U.modal({ title: "🤝 " + c.name, cls: "wide", body: b, actions: [{ label: "Close", cls: "ghost" }] });
  }

  /* ---- MODULES 3 + 7 — revenue center + financial intelligence ---- */
  function enRevenue(body) {
    if (!B.can("Revenue", "read")) { body.appendChild(permDenied("Revenue")); return; }
    const fs = EN.financeStats(null);
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "REVENUE" }), el("div", { class: "kpi-value", text: EN.money(fs.revenue) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "EXPENSES · REFUNDS" }), el("div", { class: "kpi-value", text: EN.money(fs.expenses) + " · " + EN.money(fs.refunds) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "PROFIT" }), el("div", { class: "kpi-value", text: EN.money(fs.profit) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "MRR · ARR" }), el("div", { class: "kpi-value", text: EN.money(fs.mrr) + " · " + EN.money(fs.arr) })])
    ]));
    if (fs.simulated) body.appendChild(el("p", { class: "dim small-note", text: `⚠ ${EN.money(fs.simulated)} of the ledger is tagged [SIM] — imported from the agent networks' labeled simulations, kept separate from bookkeeping truth.` }));

    const f = {};
    const form = el("div", { class: "panel form-panel" });
    form.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "➕ Record an entry" })]));
    const kindSel = el("select", { class: "input" });
    ["revenue", "expense", "refund"].forEach(k2 => kindSel.appendChild(el("option", { value: k2, text: k2 })));
    const catSel = el("select", { class: "input" });
    function drawCats() {
      catSel.innerHTML = "";
      (kindSel.value === "expense" ? EN.EXP_CATS : EN.REV_CATS).forEach(c2 => catSel.appendChild(el("option", { value: c2, text: c2 })));
    }
    kindSel.addEventListener("change", drawCats);
    drawCats();
    const rec = el("input", { type: "checkbox" });
    form.appendChild(el("div", { class: "two-col" }, [
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Kind" }), kindSel]),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Category" }), catSel])
    ]));
    form.appendChild(el("div", { class: "two-col" }, [
      field("Amount ($)", f, "amount", el("input", { class: "input", type: "number", min: 0, step: 1 })),
      field("Note", f, "note", el("input", { class: "input", placeholder: "what was this?" }))
    ]));
    form.appendChild(el("label", { class: "check-row" }, [rec, el("span", { text: "Recurring (counts toward MRR/ARR)" })]));
    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn primary", text: "Record", onclick: () => {
        const amt = +f.amount.value;
        if (!amt) { toast("Amount required.", "err"); return; }
        EN.addFinance({ kind: kindSel.value, category: catSel.value, amount: amt, note: f.note.value, recurring: rec.checked });
        toast("Recorded in the ledger.", "ok");
        go("#/enterprise/revenue");
      } }),
      el("button", { class: "btn ghost", text: "Import SIM earnings (labeled)", onclick: () => {
        const n = EN.importSimEarnings(EN.orgs()[0] ? EN.orgs()[0].id : null);
        toast(n == null ? "Already imported." : n ? n + " simulated line(s) imported — tagged [SIM]." : "No simulated earnings to import.", "info");
        go("#/enterprise/revenue");
      } })
    ]));
    body.appendChild(form);

    const fi = EN.intelligence(null);
    const grid = el("div", { class: "insp-grid" });
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧮 Financial intelligence" })]),
      el("div", { class: "act-row" }, [el("b", { text: "Customer lifetime value" }), el("span", { class: "dim small-note", text: EN.money(fi.clv) })]),
      el("div", { class: "act-row" }, [el("b", { text: "Acquisition cost (CAC)" }), el("span", { class: "dim small-note", text: EN.money(fi.cac) })]),
      el("div", { class: "act-row" }, [el("b", { text: "Revenue growth (wk/wk)" }), el("span", { class: "dim small-note", text: fi.growthPct + "%" })]),
      el("div", { class: "act-row" }, [el("b", { text: "Provider costs (real est)" }), el("span", { class: "dim small-note", text: "$" + fi.providerCosts })]),
      el("div", { class: "act-row" }, [el("b", { text: "Tool costs" }), el("span", { class: "dim small-note", text: EN.money(fi.toolCosts) })])
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Most profitable clients" })]),
      ...(fi.topClients.length ? fi.topClients.map(c2 => el("div", { class: "act-row" }, [el("b", { text: c2.name }), el("span", { class: "dim small-note", text: `${c2.stage} · ${EN.money(c2.revenue)}` })])) : [el("p", { class: "empty-note", text: "No client revenue yet." })])
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Revenue by category" })]),
      ...fi.byCat.map(([c2, v]) => el("div", { class: "act-row" }, [el("b", { text: c2 }), el("span", { class: "dim small-note", text: EN.money(v) })]))
    ]));
    body.appendChild(grid);

    const list = el("div", { class: "panel" });
    list.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `Ledger (${fs.entries})` })]));
    EN.ensure().finance.slice().reverse().slice(0, 12).forEach(fe => list.appendChild(el("div", { class: "act-row" }, [
      el("span", { class: "exec-ok " + (fe.kind === "revenue" ? "ok" : "bad"), text: fe.kind === "revenue" ? "+" : "−" }),
      el("b", { text: EN.money(fe.amount) }),
      el("span", { class: "dim small-note", text: `${fe.kind} · ${fe.category}${fe.recurring ? " · recurring" : ""}${fe.simulated ? " · [SIM]" : ""}${fe.note ? " · " + fe.note : ""} · ${new Date(fe.at).toLocaleDateString()}` })
    ])));
    body.appendChild(list);
  }

  /* ---- MODULE 4 — projects ---- */
  function enProjects(body) {
    const f = {};
    const form = el("div", { class: "panel form-panel" });
    form.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "➕ Open a project" })]));
    form.appendChild(field("Project name", f, "name", el("input", { class: "input", placeholder: "e.g. Client onboarding sprint" })));
    form.appendChild(field("Objectives", f, "obj", el("input", { class: "input", placeholder: "what done looks like" })));
    form.appendChild(field("Budget ($)", f, "budget", el("input", { class: "input", type: "number", min: 0 })));
    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn primary", text: "Open project", onclick: () => {
        if (!f.name.value.trim()) { toast("Name required.", "err"); return; }
        EN.addProject({ name: f.name.value, objectives: f.obj.value, budget: f.budget.value });
        toast("Project opened.", "ok");
        go("#/enterprise/projects");
      } })
    ]));
    body.appendChild(form);

    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `Projects (${EN.projects().length})` })]));
    if (!EN.projects().length) panel.appendChild(el("p", { class: "empty-note", text: "No projects yet." }));
    EN.projects().slice().reverse().forEach(p2 => {
      const prog = EN.projectProgress(p2);
      const m = p2.missionId && MS.mission(p2.missionId);
      panel.appendChild(el("div", { class: "ms-row" }, [
        el("div", { class: "ms-top" }, [
          el("b", { text: "📁 " + p2.name }),
          m ? el("span", { class: "ms-health h-on-track", text: "mission: " + m.status }) : el("button", { class: "btn tiny gold-btn", text: "🎯 Connect to Mission Control", onclick: (ev2) => { ev2.stopPropagation(); EN.connectMission(p2.id); toast("Mission planned from the project.", "ok"); go("#/enterprise/projects"); } }),
          el("span", { class: "dim tiny-note", text: `due ${new Date(p2.deadline).toLocaleDateString()}${p2.budget ? " · budget " + EN.money(p2.budget) : ""}` })
        ]),
        el("div", { class: "rt-bar ms-bar" }, [el("div", { class: "rt-bar-fill", style: `width:${prog}%` })]),
        el("div", { class: "deliv-row" }, p2.deliverables.map(d2 => el("label", { class: "check-row", style: "margin:0 14px 0 0" }, [
          (() => { const cb = el("input", { type: "checkbox" }); cb.checked = d2.done; cb.addEventListener("change", () => { d2.done = cb.checked; S.save(); go("#/enterprise/projects"); }); return cb; })(),
          el("span", { class: "small-note", text: d2.title })
        ])))
      ]));
    });
    body.appendChild(panel);
  }

  /* ---- MODULE 5 — team ---- */
  function enTeam(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Humans, Workers, Ghosts and Shells on one roster per organization. Enterprise roles map onto the Phase Alpha Permission Engine: " + Object.entries(EN.ROLE_MAP).map(([a, b2]) => `${a}→${b2}`).join(" · ") }));
    if (!EN.orgs().length) { body.appendChild(el("p", { class: "empty-note", text: "Deploy an organization first." })); return; }
    EN.orgs().forEach(o => {
      const panel = el("div", { class: "panel" });
      panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `${o.logo} ${o.name} — team (${o.team.length})` })]));
      const kindSel = el("select", { class: "input inline-select" });
      [["worker", "Worker (clone)"], ["human", "Human (executor)"], ["ghost", "Ghost"], ["shell", "Shell"]].forEach(([v, l]) => kindSel.appendChild(el("option", { value: v, text: l })));
      const refSel = el("select", { class: "input inline-select" });
      const roleSel = el("select", { class: "input inline-select" });
      EN.TEAM_ROLES.forEach(r => roleSel.appendChild(el("option", { value: r, text: r })));
      function drawRefs() {
        refSel.innerHTML = "";
        const pool = { human: S.state.executors, worker: S.state.clones, ghost: S.state.ghosts, shell: S.state.shells }[kindSel.value] || [];
        pool.filter(x => !o.team.some(t => t.refId === x.id)).forEach(x => refSel.appendChild(el("option", { value: x.id, text: x.name })));
      }
      kindSel.addEventListener("change", drawRefs);
      drawRefs();
      panel.appendChild(el("div", { class: "rt-addrow" }, [kindSel, refSel, roleSel,
        el("button", { class: "btn small", text: "+ Add", onclick: () => {
          if (!refSel.value) { toast("Nobody left to add of that kind.", "err"); return; }
          EN.addTeamMember(o.id, kindSel.value, refSel.value, roleSel.value);
          go("#/enterprise/team");
        } })
      ]));
      o.team.forEach(t => panel.appendChild(el("div", { class: "act-row" }, [
        el("span", { class: "cap-chip on", text: t.kind }),
        el("b", { text: t.name }),
        el("span", { class: "dim small-note", text: `${t.role} → permissions: ${EN.ROLE_MAP[t.role] || "Viewer"}` })
      ])));
      if (!o.team.length) panel.appendChild(el("p", { class: "empty-note", text: "No team yet." }));
      body.appendChild(panel);
    });
  }

  /* ---- MODULE 6 — automation hub ---- */
  function enAutomations(body) {
    if (!EN.orgs().length) { body.appendChild(el("p", { class: "empty-note", text: "Deploy an organization first." })); return; }
    EN.orgs().forEach(o => {
      EN.automations(o.id).forEach(a => {
        const panel = el("div", { class: "panel" });
        panel.appendChild(el("div", { class: "panel-head" }, [
          el("h2", { class: "panel-title", text: `🔁 ${a.name} — ${o.name}` }),
          el("span", { class: "dim small-note", text: `${a.runs} run(s)${a.lastRun ? " · last " + timeAgo(a.lastRun) : ""}` })
        ]));
        const flow = el("div", { class: "flow-diagram", style: "flex-direction:row;flex-wrap:wrap;gap:6px" });
        a.steps.forEach((s2, i) => {
          flow.appendChild(el("div", { class: "flow-node" + (i === 2 ? " hot" : ""), text: s2 }));
          if (i < a.steps.length - 1) flow.appendChild(el("div", { class: "flow-arrow", text: "→" }));
        });
        panel.appendChild(flow);
        const cliSel = el("select", { class: "input inline-select" });
        EN.clients().filter(c => c.orgId === o.id || !c.orgId).forEach(c => cliSel.appendChild(el("option", { value: c.id, text: c.name + " (" + c.stage + ")" })));
        const runBtn = el("button", { class: "btn small primary", text: "▶ Run pipeline (real: CRM → mission → ledger)" });
        runBtn.addEventListener("click", async () => {
          if (!cliSel.value) { toast("Add a CRM client first.", "err"); return; }
          runBtn.disabled = true;
          runBtn.textContent = "◈ ORCHESTRATING…";
          const res = await EN.runAutomation(a.id, cliSel.value);
          toast(res.ok ? "Pipeline complete — mission done, stage advanced, draft invoice logged." : res.reason, res.ok ? "ok" : "err");
          U.sfx(res.ok ? "evolve" : "click");
          go("#/enterprise/automations");
        });
        panel.appendChild(el("div", { class: "rt-addrow", style: "margin-top:10px" }, [cliSel, runBtn]));
        body.appendChild(panel);
      });
    });
  }

  /* =============================== extension ecosystem (PHASE THETA) =============================== */
  const XT_TABS = [
    ["center", "📦 Extension Center"],
    ["registry", "🗄 Registry"],
    ["marketplace", "🛍 Marketplace"],
    ["dev", "🧪 Developer"]
  ];

  function renderExtensions(main, tab) {
    tab = tab || "center";
    XT.ensure();
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `EXTENSION CENTER <span class="dim">// phase theta — the platform layer · core v${XT.CORE_VERSION}</span>` }),
        el("p", { class: "page-sub", text: "Every future capability installs as an extension through one manager — the core never changes. One SDK, permission-gated APIs, a pub/sub event bus, owner approval before activation. Today's catalog is private (owner-authored); community extensions plug in later with zero redesign." })
      ])
    ]));
    const tabs = el("div", { class: "bridge-tabs" });
    XT_TABS.forEach(([k2, label]) => tabs.appendChild(el("a", {
      class: "bridge-tab" + (k2 === tab ? " on" : ""), href: "#/extensions/" + k2, text: label
    })));
    wrap.appendChild(tabs);
    const body = el("div", { class: "bridge-body" });
    ({ center: xtCenter, registry: xtRegistry, marketplace: xtMarketplace, dev: xtDev }[tab] || xtCenter)(body);
    wrap.appendChild(body);
    main.appendChild(wrap);
  }

  function xtCard(m, rec) {
    const installedNow = !!rec;
    const active = installedNow && XT.isActive(m.id);
    const upd = installedNow && XT.updateAvailable(m.id);
    return el("div", { class: "int-card xt-card" + (active ? " live-card" : "") }, [
      el("div", { class: "int-top" }, [
        el("div", {}, [el("b", { text: m.name }), el("span", { class: "dim small-note", text: ` v${installedNow ? rec.version : m.version} · ${m.author}` })]),
        el("span", { class: "int-status " + (active ? "st-healthy" : installedNow && !rec.approved ? "st-configured" : ""), text: !installedNow ? "available" : !rec.approved ? "awaiting approval" : rec.enabled ? "active" : "disabled" })
      ]),
      el("div", { class: "int-meta", text: m.category + (m.dependencies.length ? " · needs: " + m.dependencies.join(", ") : "") + " · requires core " + m.requires }),
      el("p", { class: "dim small-note", text: m.description }),
      el("div", { class: "int-meta", text: "permissions: " + (m.permissions.join(", ") || "none") }),
      installedNow ? el("div", { class: "int-meta", text: `health: ${rec.health} · installed ${timeAgo(rec.installedAt)}${upd ? " · ⬆ UPDATE AVAILABLE v" + m.version : ""}` }) : null,
      el("div", { class: "vi-actions" }, [
        !installedNow ? el("button", { class: "btn tiny primary", text: "⬇ Install", onclick: () => {
          const r = XT.install(m.id);
          toast(r.ok ? (r.pendingApproval ? "Installed — approve its permissions to activate." : "Installed and active.") : r.reason, r.ok ? "ok" : "err");
          go("#/extensions");
        } }) : null,
        installedNow && !rec.approved ? el("button", { class: "btn tiny gold-btn", text: "🛡 Approve permissions", onclick: () => {
          U.modal({
            title: "🛡 " + m.name + " requests permissions",
            body: (() => { const b2 = el("div", { class: "modal-body" }); m.permissions.forEach(p2 => b2.appendChild(el("div", { class: "small-note", text: "• " + p2 }))); b2.appendChild(el("p", { class: "dim tiny-note", text: "Owner approval is mandatory before activation. The extension will only reach these APIs." })); return b2; })(),
            actions: [
              { label: "Approve & activate", cls: "primary", onClick: () => { XT.approve(m.id); toast(m.name + " active.", "ok"); go("#/extensions"); } },
              { label: "Not now", cls: "ghost" }
            ]
          });
        } }) : null,
        upd ? el("button", { class: "btn tiny gold-btn", text: "⬆ Update", onclick: () => { XT.update(m.id); toast("Updated to v" + m.version + ".", "ok"); go("#/extensions"); } }) : null,
        installedNow && rec.approved ? el("button", { class: "btn tiny " + (rec.enabled ? "cyan-btn" : ""), text: rec.enabled ? "Enabled" : "Enable", onclick: () => { XT.setEnabled(m.id, !rec.enabled); go("#/extensions"); } }) : null,
        installedNow && (m.configSchema || []).length ? el("button", { class: "btn tiny", text: "Configure", onclick: () => xtConfigModal(m, rec) }) : null,
        installedNow ? el("button", { class: "btn tiny danger ghost", text: "Uninstall", onclick: () => {
          const r = XT.uninstall(m.id);
          toast(r.ok ? m.name + " removed — core untouched." : r.reason, r.ok ? "info" : "err");
          go("#/extensions");
        } }) : null,
        ...XT.pages().filter(x => x.extId === m.id).map(x => el("a", { class: "btn tiny", href: "#/ext/" + m.id + "/" + x.page.id, text: (x.page.icon || "📄") + " Open " + x.page.title }))
      ].filter(Boolean))
    ].filter(Boolean));
  }

  function xtConfigModal(m, rec) {
    const inputs = {};
    const b = el("div", { class: "modal-body" });
    (m.configSchema || []).forEach(f => {
      const inp = el("input", { class: "input", placeholder: f.label });
      inp.value = rec.config[f.key] != null ? rec.config[f.key] : (f.def || "");
      inputs[f.key] = inp;
      b.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: f.label }), inp]));
    });
    U.modal({
      title: "⚙ Configure " + m.name, body: b, actions: [
        { label: "Save", cls: "primary", onClick: () => {
          const cfg = {};
          Object.keys(inputs).forEach(k2 => { cfg[k2] = inputs[k2].value; });
          XT.setConfig(m.id, cfg);
          toast("Configuration saved.", "ok");
          go("#/extensions");
        } },
        { label: "Cancel", cls: "ghost" }
      ]
    });
  }

  /* ---- MODULE 1 — center ---- */
  function xtCenter(body) {
    const s2 = XT.stats();
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "INSTALLED / ACTIVE" }), el("div", { class: "kpi-value", text: s2.installed + " / " + s2.active })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "AVAILABLE" }), el("div", { class: "kpi-value", text: String(s2.available) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "AWAITING APPROVAL" }), el("div", { class: "kpi-value", text: String(s2.pending) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "UPDATES" }), el("div", { class: "kpi-value", text: String(s2.updates) })])
    ]));
    const inst = XT.installed();
    if (inst.length) {
      const p1 = el("div", { class: "panel" });
      p1.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Installed extensions" })]));
      const g1 = el("div", { class: "int-grid" });
      inst.forEach(x => g1.appendChild(xtCard(x.manifest, x)));
      p1.appendChild(g1);
      body.appendChild(p1);
    }
    const avail = XT.catalog().filter(m => !XT.stateOf(m.id));
    const p2 = el("div", { class: "panel" });
    p2.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Available (private catalog)" }), el("span", { class: "dim small-note", text: "system + private extensions · community slot reserved" })]));
    const g2 = el("div", { class: "int-grid" });
    avail.forEach(m => g2.appendChild(xtCard(m, null)));
    if (!avail.length) p2.appendChild(el("p", { class: "empty-note", text: "Everything from the catalog is installed." }));
    p2.appendChild(g2);
    body.appendChild(p2);
  }

  /* ---- MODULE 8 — registry ---- */
  function xtRegistry(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Every installed module tracked: version, compatibility, dependencies, permissions, author, update history, signature (future), health." }));
    const inst = XT.installed();
    if (!inst.length) { body.appendChild(el("p", { class: "empty-note", text: "Nothing installed yet." })); return; }
    inst.forEach(x => body.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: x.manifest.name }), el("span", { class: "dim small-note", text: "health: " + x.health })]),
      el("pre", { class: "output-pre", text: [
        `installed: v${x.version} · catalog: v${x.manifest.version} · compatible: core ≥ ${x.manifest.requires} (running ${XT.CORE_VERSION})`,
        `author: ${x.manifest.author} · category: ${x.manifest.category}`,
        `dependencies: ${x.manifest.dependencies.join(", ") || "none"}`,
        `permissions: requested [${x.manifest.permissions.join(", ") || "none"}] · granted [${(x.granted || []).join(", ") || "none"}]`,
        `signature: unsigned (digital signatures arrive with community extensions)`,
        `update history:`,
        ...x.updateHistory.map(h => `  ${new Date(h.at).toLocaleString()} — ${h.note}`)
      ].join("\n") })
    ])));
  }

  /* ---- MODULE 10 — marketplace foundation ---- */
  function xtMarketplace(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "The marketplace foundation: categories are live, the catalog is private (owner-authored) today, and community extensions plug into the same SDK + manager later — no redesign required." }));
    XT.CATEGORIES.forEach(cat => {
      const items = XT.catalog().filter(m => m.category === cat);
      const panel = el("div", { class: "panel" });
      panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: cat + ` (${items.length})` })]));
      if (!items.length) panel.appendChild(el("p", { class: "empty-note", text: "Open slot — future extensions land here." }));
      items.forEach(m => panel.appendChild(el("div", { class: "act-row" }, [
        el("b", { text: m.name }),
        el("span", { class: "cap-chip " + (XT.stateOf(m.id) ? "on" : "off"), text: XT.stateOf(m.id) ? "installed" : "available" }),
        el("span", { class: "dim small-note", text: m.description })
      ])));
      body.appendChild(panel);
    });
  }

  /* ---- MODULE 9 — developer console ---- */
  function xtDev(body) {
    const d2 = XT.devData();
    body.appendChild(el("p", { class: "dim small-note", text: "⚠ " + d2.contractNote }));
    const grid = el("div", { class: "insp-grid" });
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🛰 Installed APIs" })]),
      ...d2.apis.map(a => el("div", { class: "tiny-note dim", text: "api." + a }))
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🛡 Permission viewer" })]),
      ...(d2.permissions.length ? d2.permissions.map(p2 => el("div", { class: "tiny-note dim", text: `${p2.name}: ${p2.approved ? "granted [" + p2.granted.join(", ") + "]" : "PENDING [" + p2.requested.join(", ") + "]"}` })) : [el("p", { class: "empty-note", text: "No extensions installed." })])
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "⏱ Performance monitor" })]),
      ...(Object.keys(d2.perf).length ? Object.entries(d2.perf).map(([id, v]) => el("div", { class: "tiny-note dim", text: `${id}: ${v.calls} listener call(s) · ${v.ms.toFixed(1)}ms total · ${v.errors} error(s)` })) : [el("p", { class: "empty-note", text: "No listener activity yet." })])
    ]));
    body.appendChild(grid);

    const evPanel = el("div", { class: "panel" });
    evPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `📡 Event monitor (${d2.busRing.length})` }), el("span", { class: "dim small-note", text: "the extension bus — core events + named platform events" })]));
    d2.busRing.slice(0, 15).forEach(e2 => evPanel.appendChild(el("div", { class: "log-row" }, [
      el("span", { class: "ev-time", text: new Date(e2.at).toLocaleTimeString() }),
      el("span", { class: "cap-chip on", text: e2.name }),
      el("span", { class: "log-text dim", text: e2.payload })
    ])));
    if (!d2.busRing.length) evPanel.appendChild(el("p", { class: "empty-note", text: "Bus is quiet — do anything and events flow." }));
    body.appendChild(evPanel);

    const logPanel = el("div", { class: "panel" });
    logPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧾 Extension logs" })]));
    const logKeys = Object.keys(d2.logs);
    if (!logKeys.length) logPanel.appendChild(el("p", { class: "empty-note", text: "No logs yet." }));
    logKeys.forEach(id => {
      logPanel.appendChild(el("div", { class: "field-label", text: id, style: "margin-top:6px" }));
      d2.logs[id].slice(-4).forEach(l => logPanel.appendChild(el("div", { class: "tiny-note dim", text: `${new Date(l.at).toLocaleTimeString()} · ${l.text}` })));
    });
    body.appendChild(logPanel);

    /* sandbox — disabled in the production environment profile (Omega) */
    if (S.state.settings.envProfile === "production") {
      body.appendChild(el("div", { class: "panel" }, [
        el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧪 Sandbox" })]),
        el("p", { class: "empty-note", text: "Disabled in the production environment profile — switch to development in Production → Deploy to test snippets." })
      ]));
      return;
    }
    const sb = el("div", { class: "panel form-panel" });
    sb.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧪 Sandbox — test against the scoped API" })]));
    const code = el("textarea", { class: "input", rows: 3, placeholder: `return api.knowledge.top("cold email", 2);` });
    const out = el("pre", { class: "output-pre", text: "// result appears here" });
    sb.appendChild(code);
    sb.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn small primary", text: "▶ Run snippet", onclick: () => {
        const r = XT.sandbox(code.value || "return 'nothing to run';");
        out.textContent = (r.ok ? "" : "✗ ") + r.result;
      } }),
      el("button", { class: "btn small", text: "📣 Publish test event", onclick: () => {
        XT.publish("MissionCompleted", { text: "🎯 Mission COMPLETED — sandbox test event (Developer Console)" });
        toast("Test MissionCompleted published to the bus.", "info");
        go("#/extensions/dev");
      } })
    ]));
    sb.appendChild(out);
    body.appendChild(sb);
  }

  /* ---- MODULE 7 — extension-provided sidebar pages ---- */
  function renderExtensionPage(main, extId, pageId) {
    const hit = XT.page(extId, pageId);
    if (!hit) { go("#/extensions"); return; }
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "back-link", href: "#/extensions", text: "← extension center" }),
        el("h1", { class: "page-title", html: `${hit.page.icon || "📄"} ${esc(hit.page.title.toUpperCase())} <span class="dim">// 📦 ${esc(hit.extName)}</span>` })
      ])
    ]));
    const mountEl = el("div", {});
    try { hit.page.render(mountEl, XT.api(extId)); }
    catch (err) { mountEl.appendChild(el("p", { class: "empty-note", text: "extension page error: " + err.message })); }
    wrap.appendChild(mountEl);
    main.appendChild(wrap);
  }

  /* =============================== distributed network (PHASE IOTA) =============================== */
  const NW_TABS = [
    ["control", "🌍 Control"],
    ["missions", "🎯 Distribution"],
    ["sync", "🔄 Knowledge Sync"],
    ["pool", "👥 Worker Pool"],
    ["federation", "🏢 Federation"],
    ["recovery", "🛟 Recovery"],
    ["monitor", "📊 Monitor"]
  ];

  function renderNetwork(main, tab) {
    tab = tab || "control";
    NW.ensure();
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `NETWORK CONTROL CENTER <span class="dim">// phase iota — distributed intelligence</span>` }),
        el("p", { class: "page-sub", text: "This browser is the real PRIME node. Registered nodes are provisioned topology — coordination, scheduling, failover, sync and backups are fully real; remote telemetry is a labeled simulation and remote tasks execute locally on behalf of their node until remote runtimes connect. Enterprise path: swap the store for a server adapter, every API stays identical." })
      ])
    ]));
    const tabs = el("div", { class: "bridge-tabs" });
    NW_TABS.forEach(([k2, label]) => tabs.appendChild(el("a", {
      class: "bridge-tab" + (k2 === tab ? " on" : ""), href: "#/network/" + k2, text: label
    })));
    wrap.appendChild(tabs);
    const body = el("div", { class: "bridge-body" });
    ({
      control: nwControl, missions: nwMissions, sync: nwSync, pool: nwPool,
      federation: nwFederation, recovery: nwRecovery, monitor: nwMonitor
    }[tab] || nwControl)(body);
    wrap.appendChild(body);
    main.appendChild(wrap);
  }

  /* ---- MODULES 1 + 2 — control center + nodes ---- */
  function nwControl(body) {
    const s2 = NW.stats();
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "NODES (ONLINE / FAILED)" }), el("div", { class: "kpi-value", text: `${s2.nodes} (${s2.online} / ${s2.failed})` })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "ORGS · WORKERS" }), el("div", { class: "kpi-value", text: s2.orgs + " · " + s2.workers })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "RUNNING MISSIONS" }), el("div", { class: "kpi-value", text: String(s2.missionsRunning) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "NETWORK HEALTH" }), el("div", { class: "kpi-value", text: s2.health + "/100" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "SESSION UPTIME" }), el("div", { class: "kpi-value", text: Math.round(s2.uptimeMs / 60000) + "m" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "GLOBAL EVENTS" }), el("div", { class: "kpi-value", text: String(s2.events) })])
    ]));

    const f = {};
    const form = el("div", { class: "panel form-panel" });
    form.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "➕ Register a node" })]));
    const kindSel = el("select", { class: "input" });
    NW.NODE_KINDS.forEach(k2 => kindSel.appendChild(el("option", { value: k2, text: k2 })));
    const polSel = el("select", { class: "input" });
    NW.SYNC_POLICIES.forEach(p2 => polSel.appendChild(el("option", { value: p2, text: "sync: " + p2 })));
    form.appendChild(el("div", { class: "two-col" }, [
      field("Node name", f, "name", el("input", { class: "input", placeholder: "e.g. Hetzner VPS · EU-1" })),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Kind" }), kindSel])
    ]));
    form.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: "Sync policy" }), polSel]));
    form.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn primary", text: "🌍 Register node", onclick: () => {
        if (!f.name.value.trim()) { toast("Name the node.", "err"); return; }
        NW.registerNode({ name: f.name.value, kind: kindSel.value, syncPolicy: polSel.value });
        toast("Node registered — provisioned topology.", "ok");
        go("#/network");
      } })
    ]));
    body.appendChild(form);

    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `Nodes (${NW.nodes().length})` })]));
    NW.nodes().forEach(n => {
      const t = NW.telemetry(n);
      const h = NW.nodeHealth(n);
      panel.appendChild(el("div", { class: "ms-row" }, [
        el("div", { class: "ms-top" }, [
          el("b", { text: (n.real ? "⭐ " : "🌐 ") + n.name }),
          el("span", { class: "ms-health h-" + (n.status === "failed" ? "delayed" : n.real ? "on-track" : "paused"), text: n.status }),
          el("span", { class: "dim tiny-note", text: `${n.kind} · v${n.version} · sync ${n.syncPolicy}` })
        ]),
        el("div", { class: "dim tiny-note", text: t.real
          ? `REAL telemetry — heap ${t.memMB != null ? t.memMB + "MB" : "n/a"} · state ${t.storageKB}KB · queue ${t.queue} · ${t.missions} active mission(s) · load ${NW.nodeLoad(n)}`
          : `SIMULATED telemetry (no live link) — cpu ${t.cpu}% · mem ${t.memMB}MB · queue ${t.queue} · load ${NW.nodeLoad(n)} · ${h}` }),
        !n.real ? el("div", { class: "vi-actions", style: "margin-top:6px" }, [
          n.status !== "failed"
            ? el("button", { class: "btn tiny danger ghost", text: "⚡ Simulate failure", onclick: () => { NW.failNode(n.id); toast("Node failed — failover engaged.", "err"); go("#/network"); } })
            : el("button", { class: "btn tiny gold-btn", text: "↻ Revive", onclick: () => { NW.reviveNode(n.id); go("#/network"); } }),
          el("button", { class: "btn tiny danger ghost", text: "Remove", onclick: () => { NW.removeNode(n.id); go("#/network"); } })
        ]) : null
      ].filter(Boolean)));
    });
    body.appendChild(panel);
  }

  /* ---- MODULE 3 — distributed missions ---- */
  function nwMissions(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Distribute a mission's task graph across online nodes. Coordination is real; remote tasks execute locally on behalf of their node (and the mission log says so) until remote runtimes connect." }));
    const ms2 = MS.missions();
    if (!ms2.length) { body.appendChild(el("p", { class: "empty-note", text: "No missions — plan one in Mission Control." })); return; }
    ms2.slice().reverse().forEach(m => {
      const used = Array.from(new Set(m.tasks.filter(t => t.nodeName).map(t => t.nodeName)));
      const panel = el("div", { class: "panel" });
      panel.appendChild(el("div", { class: "panel-head" }, [
        el("h2", { class: "panel-title", text: `${m.icon} ${m.name} — ${m.status}` }),
        m.status === "active" ? el("button", { class: "btn small gold-btn", text: "🌍 Distribute across nodes", onclick: () => {
          const r = NW.distributeMission(m.id);
          toast(`Distributed across ${r.nodesUsed.length} node(s).`, "ok");
          go("#/network/missions");
        } }) : el("span", { class: "dim small-note", text: used.length ? used.join(" → ") : "" })
      ]));
      m.tasks.forEach(t => panel.appendChild(el("div", { class: "act-row" }, [
        el("span", { class: "q-state q-" + (t.status === "done" ? "completed" : t.status === "ready" ? "waiting" : "pending"), text: t.status }),
        el("b", { text: t.label }),
        el("span", { class: "dim tiny-note", text: t.nodeName ? "🌐 " + t.nodeName + (t.assignedWorkerName ? " · " + t.assignedWorkerName : "") : "unrouted" })
      ])));
      body.appendChild(panel);
    });
  }

  /* ---- MODULE 4 — knowledge sync ---- */
  function nwSync(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Knowledge scopes: local (this node) · organization (owner-tagged docs) · global (shared memory). Export a sync payload, import one with automatic conflict resolution (higher confidence wins, freshness breaks ties), or hold a node read-only." }));
    const out = el("textarea", { class: "input", rows: 4, placeholder: "sync payload (JSON) — export fills this, or paste an incoming payload here" });
    const polSel = el("select", { class: "input inline-select" });
    NW.SYNC_POLICIES.forEach(p2 => polSel.appendChild(el("option", { value: p2, text: "policy: " + p2 })));
    const panel = el("div", { class: "panel form-panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🔄 Synchronize knowledge" })]));
    panel.appendChild(out);
    panel.appendChild(el("div", { class: "form-actions" }, [
      el("button", { class: "btn small", text: "⬆ Export from this node", onclick: () => { out.value = NW.exportKnowledge(); toast("Sync payload exported.", "ok"); } }),
      polSel,
      el("button", { class: "btn small primary", text: "⬇ Import payload", onclick: () => {
        const r = NW.importKnowledge(out.value, polSel.value);
        toast(r.ok ? (r.readOnly ? "Read-only — inspected, wrote nothing." : `Synced: +${r.added} new · ${r.resolved} incoming won · ${r.kept} local kept.`) : r.reason, r.ok ? "ok" : "err");
        go("#/network/sync");
      } })
    ]));
    body.appendChild(panel);
    const logPanel = el("div", { class: "panel" });
    logPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Synchronization log" })]));
    const log = NW.syncLog();
    if (!log.length) logPanel.appendChild(el("p", { class: "empty-note", text: "No sync activity yet." }));
    log.slice(0, 12).forEach(l => logPanel.appendChild(el("div", { class: "dim tiny-note", text: `${new Date(l.at).toLocaleTimeString()} · ${l.text}` })));
    body.appendChild(logPanel);
  }

  /* ---- MODULES 5 + 6 — worker pool + scheduler ---- */
  function nwPool(body) {
    body.appendChild(el("div", { class: "form-actions", style: "justify-content:flex-start;margin-bottom:12px" }, [
      el("button", { class: "btn small primary", text: "⚖ Balance workloads across nodes", onclick: () => {
        const r = NW.balance();
        toast(r.moves ? `${r.moves} worker(s) redistributed.` : r.note || "Already balanced.", "info");
        go("#/network/pool");
      } })
    ]));
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `Network worker pool (${NW.pool().length})` })]));
    NW.pool().forEach(w => panel.appendChild(el("div", { class: "act-row" }, [
      el("b", { text: w.name }),
      el("span", { class: "cap-chip on", text: w.role }),
      el("span", { class: "dim small-note", text: `🌐 ${w.node}${w.org ? " · 🏢 " + w.org : " · common pool"} · load ${w.load}${w.rating ? " · ★" + w.rating : ""}` })
    ])));
    body.appendChild(panel);

    const test = el("div", { class: "panel form-panel" });
    test.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧮 Ask the scheduler" })]));
    const typeSel = el("select", { class: "input inline-select" });
    ["Write Tweet", "Build Offer", "Landing Page Copy", "Market Narrative Scan", "Opening DM"].forEach(t => typeSel.appendChild(el("option", { value: t, text: t })));
    const res = el("pre", { class: "output-pre", text: "// pick a task type and ask" });
    test.appendChild(el("div", { class: "rt-addrow" }, [typeSel, el("button", { class: "btn small", text: "Who should take this?", onclick: () => {
      const r = NW.schedule({ taskType: typeSel.value });
      res.textContent = r.pick
        ? `→ ${r.pick.worker} on ${r.pick.node}\n   ${r.pick.reason}` + (r.excluded.length ? `\n\nexcluded by federation:\n` + r.excluded.map(x => `   ${x.worker} — ${x.reason}`).join("\n") : "")
        : "no eligible worker";
    } })]));
    test.appendChild(res);
    body.appendChild(test);
  }

  /* ---- MODULE 7 — federation ---- */
  function nwFederation(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Organizations are isolated by default — the scheduler will not hand their workers to other orgs' missions. Opt into sharing per asset class." }));
    const orgs = EN.orgs();
    if (!orgs.length) { body.appendChild(el("p", { class: "empty-note", text: "No organizations yet — deploy one in the Enterprise OS." })); return; }
    orgs.forEach(o => {
      const fed = NW.federation(o.id);
      const panel = el("div", { class: "panel" });
      panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `${o.logo} ${o.name} — shares with the network` })]));
      const row = el("div", { class: "deliv-row" });
      NW.SHAREABLES.forEach(sh => {
        const cb = el("input", { type: "checkbox" });
        cb.checked = !!fed[sh];
        cb.addEventListener("change", () => { NW.setShare(o.id, sh, cb.checked); });
        row.appendChild(el("label", { class: "check-row", style: "margin:0 16px 6px 0" }, [cb, el("span", { class: "small-note", text: sh })]));
      });
      panel.appendChild(row);
      body.appendChild(panel);
    });
  }

  /* ---- MODULE 8 — disaster recovery ---- */
  function nwRecovery(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Automatic snapshots on boot (max every 6h), manual restore points, and node failover (a failed node's tasks and workers move to the healthiest survivor — missions continue). Restoring swaps the live state and reloads." }));
    body.appendChild(el("div", { class: "form-actions", style: "justify-content:flex-start;margin-bottom:12px" }, [
      el("button", { class: "btn small primary", text: "📸 Take snapshot now", onclick: () => {
        const r = NW.takeSnapshot("manual");
        toast(r.ok ? "Restore point captured." : r.reason, r.ok ? "ok" : "err");
        go("#/network/recovery");
      } })
    ]));
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: `🛟 Restore points (${NW.snapshots().length}/5)` })]));
    if (!NW.snapshots().length) panel.appendChild(el("p", { class: "empty-note", text: "No restore points yet — take one above." }));
    NW.snapshots().forEach(s2 => panel.appendChild(el("div", { class: "act-row" }, [
      el("b", { text: s2.label }),
      el("span", { class: "dim small-note", text: `${new Date(s2.at).toLocaleString()} · ${s2.sizeKB} KB` }),
      el("div", { class: "vi-actions", style: "margin-left:auto" }, [
        el("button", { class: "btn tiny gold-btn", text: "↻ Restore", onclick: () => {
          U.modal({
            title: "🛟 Recovery wizard", body: (() => {
              const b2 = el("div", { class: "modal-body" });
              b2.appendChild(el("p", { text: `Restore "${s2.label}" from ${new Date(s2.at).toLocaleString()}? The current state will be replaced and PRISM-X will reload.` }));
              return b2;
            })(),
            actions: [
              { label: "Restore & reload", cls: "primary", onClick: () => { const r = NW.restoreSnapshot(s2.key); if (r.ok) location.reload(); else toast(r.reason, "err"); } },
              { label: "Cancel", cls: "ghost" }
            ]
          });
        } }),
        el("button", { class: "btn tiny danger ghost", text: "✕", onclick: () => { NW.deleteSnapshot(s2.key); go("#/network/recovery"); } })
      ])
    ])));
    body.appendChild(panel);
  }

  /* ---- MODULES 9 + 10 — global monitoring + scalability ---- */
  function nwMonitor(body) {
    const s2 = NW.stats();
    const al = NW.alerts();
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "NETWORK HEALTH" }), el("div", { class: "kpi-value", text: s2.health + "/100" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "WORKER UTILIZATION" }), el("div", { class: "kpi-value", text: (EN.executive().workerUtilization) + "%" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "PROVIDER COST (EST)" }), el("div", { class: "kpi-value", text: "$" + EN.executive().providerCosts })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "KNOWLEDGE OBJECTS" }), el("div", { class: "kpi-value", text: String(K.docs().length) })])
    ]));
    const grid = el("div", { class: "insp-grid" });
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🚨 Alerts" })]),
      ...(al.length ? al.map(a => el("div", { class: "dim small-note", text: "• " + a })) : [el("p", { class: "empty-note", text: "All clear." })])
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Mission distribution" })]),
      ...NW.nodes().map(n => el("div", { class: "act-row" }, [
        el("b", { text: n.name }),
        el("span", { class: "dim small-note", text: NW.nodeLoad(n) + " task load" + (n.real ? " (real)" : " (sim)") })
      ]))
    ]));
    body.appendChild(grid);

    const cap = el("div", { class: "panel" });
    cap.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "📈 Scalability framework — capacity headroom" }),
      el("span", { class: "dim small-note", text: "rings + caps keep the browser tier honest; horizontal scale = more nodes; the server adapter swap keeps every API identical" })
    ]));
    NW.capacity().forEach(c2 => {
      const pct = Math.min(100, Math.round((c2.used / c2.cap) * 100));
      cap.appendChild(el("div", { class: "act-row" }, [
        el("b", { text: c2.name }),
        el("div", { class: "rt-bar ms-bar", style: "width:160px;margin:0" }, [el("div", { class: "rt-bar-fill", style: `width:${pct}%` })]),
        el("span", { class: "dim small-note", text: `${c2.used} / ${c2.cap} (${pct}%)` })
      ]));
    });
    body.appendChild(cap);
  }

  /* =============================== production readiness (PHASE OMEGA) =============================== */
  const OM_TABS = [
    ["security", "🛡 Security"],
    ["health", "🩺 Health Center"],
    ["logs", "🧾 Observability"],
    ["recovery", "🛟 Recovery"],
    ["config", "⚙ Configuration"],
    ["deploy", "🚀 Deploy"],
    ["docs", "📖 Docs"],
    ["setup", "🧭 Guided Setup"],
    ["validate", "✅ Validation"]
  ];

  function renderProduction(main, tab) {
    tab = tab || "security";
    OM.ensure();
    const wrap = el("div", { class: "page" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `PRODUCTION CENTER <span class="dim">// phase omega — core v${OM.CORE_VERSION}</span>` }),
        el("p", { class: "page-sub", text: "No new empire features — this is where everything already built becomes secure, observable, recoverable, fast, configurable, documented and validated as one platform." })
      ])
    ]));
    const tabs = el("div", { class: "bridge-tabs" });
    OM_TABS.forEach(([k2, label]) => tabs.appendChild(el("a", {
      class: "bridge-tab" + (k2 === tab ? " on" : ""), href: "#/production/" + k2, text: label
    })));
    wrap.appendChild(tabs);
    const body = el("div", { class: "bridge-body" });
    ({
      security: omSecurity, health: omHealth, logs: omLogs, recovery: omRecovery,
      config: omConfig, deploy: omDeploy, docs: omDocs, setup: omSetup, validate: omValidate
    }[tab] || omSecurity)(body);
    wrap.appendChild(body);
    main.appendChild(wrap);
  }

  /* ---- MODULE 1 — security & identity ---- */
  function omSecurity(body) {
    const sec = S.state.security;
    body.appendChild(el("p", { class: "dim small-note", text: "Honest scope: the passcode (SHA-256 + salt, WebCrypto) keeps casual hands off this app on a shared machine — it cannot stop someone with access to this browser profile's disk. Credentials live AES-GCM-encrypted in the Gamma vault; roles gate the Bridge; workers and extensions hold least-privilege grants." }));
    const lockPanel = el("div", { class: "panel form-panel" });
    lockPanel.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "🔐 Access lock & sessions" }),
      el("span", { class: "int-status " + (sec.enabled ? "st-healthy" : ""), text: sec.enabled ? "enabled" : "disabled" })
    ]));
    const pass = el("input", { class: "input", type: "password", placeholder: sec.enabled ? "enter passcode to disable" : "set a passcode (min 4 chars)" });
    lockPanel.appendChild(el("div", { class: "rt-addrow" }, [
      pass,
      !sec.enabled ? el("button", { class: "btn small primary", text: "Enable lock", onclick: async () => {
        const r = await OM.enableLock(pass.value);
        toast(r.ok ? "Lock enabled — passcode required on load." : r.reason, r.ok ? "ok" : "err");
        go("#/production/security");
      } }) : null,
      sec.enabled ? el("button", { class: "btn small danger ghost", text: "Disable", onclick: async () => {
        const r = await OM.unlock(pass.value);
        if (r.ok) { OM.disableLock(); toast("Lock disabled.", "info"); } else toast("Wrong passcode.", "err");
        go("#/production/security");
      } }) : null,
      sec.enabled ? el("button", { class: "btn small", text: "🔒 Lock now", onclick: () => { OM.lockNow(); renderLockScreen(); } }) : null
    ].filter(Boolean)));
    lockPanel.appendChild(el("p", { class: "dim tiny-note", text: `session timeout: ${S.state.settings.sessionTimeoutMin} min (Configuration tab) · session ${sec.session && sec.session.until > Date.now() ? "active until " + new Date(sec.session.until).toLocaleTimeString() : "none"}` }));
    body.appendChild(lockPanel);

    const grid = el("div", { class: "insp-grid" });
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🔑 Key inventory" })]),
      ...OM.keyInventory().map(k2 => el("div", { class: "act-row" }, [
        el("b", { text: k2.name }),
        el("span", { class: "dim small-note", text: `${k2.where} · ${k2.masked || (k2.present ? "present" : "—")}` })
      ]))
    ]));
    grid.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧬 RBAC & fine-grained permissions" })]),
      el("div", { class: "act-row" }, [el("b", { text: "Roles × resources" }), el("a", { class: "dim small-note", href: "#/bridge/permissions", text: B.ROLES.length + " roles · " + B.RESOURCES.length + " resources →" })]),
      el("div", { class: "act-row" }, [el("b", { text: "Worker action grants" }), el("a", { class: "dim small-note", href: "#/integrations/permissions", text: Object.keys(S.state.execPerms).length + " worker grant set(s) →" })]),
      el("div", { class: "act-row" }, [el("b", { text: "Extension permissions" }), el("a", { class: "dim small-note", href: "#/extensions/registry", text: XT.installed().length + " extension(s), approval-gated →" })])
    ]));
    body.appendChild(grid);

    const audit = el("div", { class: "panel" });
    audit.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "📋 Audit trail — every sensitive action, traceable" })]));
    OM.auditTrail(25).forEach(a => audit.appendChild(el("div", { class: "log-row" }, [
      el("span", { class: "ev-time", text: new Date(a.at).toLocaleString() }),
      el("span", { class: "cap-chip on", text: a.action }),
      el("span", { class: "log-text dim", text: `[${a.actor}] ${a.detail}` })
    ])));
    body.appendChild(audit);
  }

  function renderLockScreen() {
    const root = $("#modal-root");
    root.innerHTML = "";
    const pass = el("input", { class: "input", type: "password", placeholder: "passcode", style: "max-width:280px" });
    const msg = el("p", { class: "dim small-note", text: "PRISM-X is locked. Enter your passcode to open a session." });
    const tryUnlock = async () => {
      const r = await OM.unlock(pass.value);
      if (r.ok) { root.innerHTML = ""; toast("Session opened.", "ok"); route(); }
      else { msg.textContent = "Wrong passcode — attempt logged."; pass.value = ""; }
    };
    pass.addEventListener("keydown", (ev2) => { if (ev2.key === "Enter") tryUnlock(); });
    const box = el("div", { class: "modal-box lock-box" }, [
      el("div", { class: "hero-glyph", text: "🔒" }),
      el("h2", { text: "GOD CORE SECURED" }),
      msg, pass,
      el("div", { class: "modal-actions" }, [el("button", { class: "btn primary", text: "Unlock", onclick: tryUnlock })])
    ]);
    root.appendChild(el("div", { class: "modal-overlay show lock-overlay" }, [box]));
    setTimeout(() => pass.focus(), 50);
  }

  /* ---- MODULE 2 — health center ---- */
  function omHealth(body) {
    const h = OM.overallHealth();
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "OVERALL SYSTEM HEALTH" }), el("div", { class: "kpi-value", text: h.score + "/100" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "COMPONENTS" }), el("div", { class: "kpi-value", text: h.comps.length + " checked" })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "WARNINGS / FAILURES" }), el("div", { class: "kpi-value", text: h.warns + " / " + h.fails })])
    ]));
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Component diagnostics + recommended actions" })]));
    h.comps.forEach(c2 => panel.appendChild(el("div", { class: "hm-row" }, [
      healthDot(c2.status === "ok" ? "online" : c2.status === "warn" ? "auth_required" : "rate_limited"),
      el("b", { class: "hm-name", text: c2.name }),
      el("div", { class: "ms-task-mid" }, [
        el("div", { class: "small-note", text: c2.diag }),
        el("div", { class: "dim tiny-note", text: "→ " + c2.rec })
      ])
    ])));
    body.appendChild(panel);
  }

  /* ---- MODULE 3 — observability ---- */
  function omLogs(body) {
    const q = el("input", { class: "input inline-select", placeholder: "search logs…", style: "width:220px" });
    const catSel = el("select", { class: "input inline-select" });
    B.eventCategories().forEach(c2 => catSel.appendChild(el("option", { value: c2, text: "Component: " + c2 })));
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title", text: "🧾 Structured logs" }),
      el("div", { class: "filter-row" }, [q, catSel, el("button", { class: "btn tiny", text: "⬇ Export", onclick: () => { U.copyText(OM.exportLogs(), "Log bundle copied — paste into a file to archive."); } })])
    ]));
    const list = el("div", { class: "log-list" });
    function draw() {
      list.innerHTML = "";
      const rows = OM.logs({ q: q.value, category: catSel.value });
      if (!rows.length) list.appendChild(el("p", { class: "empty-note", text: "No log lines match." }));
      rows.forEach(e2 => list.appendChild(eventRow(e2)));
    }
    q.addEventListener("input", draw);
    catSel.addEventListener("change", draw);
    draw();
    panel.appendChild(list);
    body.appendChild(panel);

    const tPanel = el("div", { class: "panel" });
    tPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🔬 Execution traces" })]));
    const trs = OM.traces();
    if (!trs.length) tPanel.appendChild(el("p", { class: "empty-note", text: "No traces yet — run a mission or an action." }));
    trs.slice(0, 12).forEach(t => tPanel.appendChild(el("div", { class: "exec-row", onclick: () => U.modal({
      title: "🔬 Trace — " + t.label, body: (() => { const b2 = el("div", { class: "modal-body" }); b2.appendChild(el("pre", { class: "output-pre", text: [`id: ${t.id}`, `at: ${new Date(t.at).toLocaleString()}`, `duration: ${(t.ms / 1000).toFixed(2)}s`, ``, ...t.steps.map((s2, i) => `${i + 1}. ${s2}`)].join("\n") })); return b2; })(),
      actions: [{ label: "Close", cls: "ghost" }]
    }) }, [
      el("span", { class: "exec-ok ok", text: t.kind === "runtime" ? "⚡" : "🔌" }),
      el("span", { class: "exec-name", text: t.label }),
      el("span", { class: "dim tiny-note", text: `${new Date(t.at).toLocaleTimeString()} · ${(t.ms / 1000).toFixed(1)}s` })
    ])));
    body.appendChild(tPanel);
  }

  /* ---- MODULE 4 — recovery ---- */
  function omRecovery(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "Full restore lives in Network → Recovery. This adds selective recovery (restore one slice, leave everything else), snapshot validation before any restore, and configuration export/import." }));
    const snaps = NW.snapshots();
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🎯 Selective recovery" })]));
    if (!snaps.length) panel.appendChild(el("p", { class: "empty-note", text: "No snapshots yet — take one in Network → Recovery." }));
    else {
      const snapSel = el("select", { class: "input inline-select" });
      snaps.forEach(s2 => snapSel.appendChild(el("option", { value: s2.key, text: `${s2.label} — ${new Date(s2.at).toLocaleString()}` })));
      const sliceSel = el("select", { class: "input inline-select" });
      Object.keys(OM.RECOVERY_SLICES).forEach(s2 => sliceSel.appendChild(el("option", { value: s2, text: "restore only: " + s2 })));
      const valOut = el("pre", { class: "output-pre", text: "// validation report appears here", style: "margin-top:10px" });
      panel.appendChild(el("div", { class: "rt-addrow" }, [
        snapSel, sliceSel,
        el("button", { class: "btn small", text: "🔍 Validate", onclick: () => {
          const v = OM.validateSnapshot(NW.snapshotJson(snapSel.value) || "");
          valOut.textContent = v.ok
            ? `✓ VALID — ${v.stats.clones} clone(s) · ${v.stats.docs} doc(s) · ${v.stats.missions} mission(s) · ${v.stats.sizeKB}KB`
            : "✗ INVALID — " + v.problems.join(", ");
        } }),
        el("button", { class: "btn small primary", text: "↻ Restore slice", onclick: () => {
          const r = OM.selectiveRestore(snapSel.value, sliceSel.value);
          toast(r.ok ? `"${sliceSel.value}" restored — everything else untouched.` : r.reason, r.ok ? "ok" : "err");
          go("#/production/recovery");
        } })
      ]));
      panel.appendChild(valOut);
    }
    body.appendChild(panel);

    body.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🗂 Configuration export / import" })]),
      el("p", { class: "dim small-note", text: "The full-system JSON export (Settings → Data) doubles as the configuration bundle; import validates before applying. Scheduled backups run automatically on boot (max one per 6h) — see Network → Recovery for restore points." }),
      el("div", { class: "vi-actions" }, [
        el("button", { class: "btn small", text: "⬇ Export full config", onclick: () => U.copyText(S.exportJSON(), "Full configuration copied — save it as a .json file.") }),
        el("a", { class: "btn small", href: "#/settings", text: "Import via Settings →" })
      ])
    ]));
  }

  /* ---- MODULE 6 — configuration center ---- */
  function omConfig(body) {
    body.appendChild(el("p", { class: "dim small-note", text: "One place for every knob. Deep systems keep their own pages — linked here — while platform-wide policies live below." }));
    const st = S.state.settings;
    const panel = el("div", { class: "panel form-panel" });
    panel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Platform policies" })]));
    const mkToggle = (label, key, onChange) => {
      const cb = el("input", { type: "checkbox" });
      cb.checked = !!st[key];
      cb.addEventListener("change", () => { st[key] = cb.checked; S.save(); if (onChange) onChange(cb.checked); });
      return el("label", { class: "check-row" }, [cb, el("span", { text: label })]);
    };
    panel.appendChild(mkToggle("Compact appearance (denser paddings across the whole UI)", "compact", (on) => document.documentElement.classList.toggle("compact", on)));
    panel.appendChild(mkToggle("Wake-up digest toasts (ghost/shell/matrix catch-up notifications)", "digests"));
    panel.appendChild(mkToggle("Sound FX", "sound"));
    const timeout = el("input", { class: "input", type: "number", min: 5, max: 480, value: st.sessionTimeoutMin, style: "max-width:120px" });
    timeout.addEventListener("change", () => { st.sessionTimeoutMin = Math.max(5, parseInt(timeout.value, 10) || 60); S.save(); });
    panel.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label", text: "Security session timeout (minutes)" }), timeout]));
    body.appendChild(panel);

    const links = el("div", { class: "panel" });
    links.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Deep configuration" })]));
    [
      ["Providers & models", "#/intelligence", P.list().length + " providers"],
      ["Integrations & vault", "#/integrations", S.state.integrations.length + " integrations"],
      ["Organizations & teams", "#/enterprise/orgs", EN.orgs().length + " org(s)"],
      ["Users & roles (RBAC)", "#/bridge/permissions", B.ROLES.length + " roles"],
      ["Workers", "#/dashboard", S.state.clones.length + " clone(s)"],
      ["Knowledge", "#/knowledge", K.docs().length + " doc(s)"],
      ["Extensions", "#/extensions", XT.installed().length + " installed"],
      ["Generation engine & data", "#/settings", st.engine + " engine"]
    ].forEach(([label, href, meta]) => links.appendChild(el("div", { class: "act-row" }, [
      el("b", { text: label }),
      el("span", { class: "dim small-note", text: meta }),
      el("a", { class: "btn tiny", href, text: "Open →", style: "margin-left:auto" })
    ])));
    body.appendChild(links);
  }

  /* ---- MODULE 7 — deploy & versioning ---- */
  function omDeploy(body) {
    const vi = OM.versionInfo();
    body.appendChild(el("div", { class: "kpi-row" }, [
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "CORE VERSION" }), el("div", { class: "kpi-value", text: "v" + vi.core })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "STATE VERSION" }), el("div", { class: "kpi-value", text: "v" + vi.stateVersion })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "MODULES LOADED" }), el("div", { class: "kpi-value", text: String(vi.modules) })]),
      el("div", { class: "kpi" }, [el("div", { class: "kpi-label", text: "PHASES SHIPPED" }), el("div", { class: "kpi-value", text: String(vi.phases) })])
    ]));

    const envPanel = el("div", { class: "panel form-panel" });
    envPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🌐 Environment profile" })]));
    const envSel = el("select", { class: "input", style: "max-width:260px" });
    OM.ENV_PROFILES.forEach(p2 => { const o = el("option", { value: p2, text: p2 }); if (p2 === vi.profile) o.selected = true; envSel.appendChild(o); });
    envSel.addEventListener("change", () => { OM.setProfile(envSel.value); toast("Profile: " + envSel.value + (envSel.value === "production" ? " — sandboxes disabled." : "."), "info"); go("#/production/deploy"); });
    envPanel.appendChild(envSel);
    envPanel.appendChild(el("p", { class: "dim tiny-note", text: "production disables the extension sandbox and expects a green Validation Suite before deploys; development keeps every tool open." }));
    const cfg = OM.validateConfig();
    envPanel.appendChild(el("div", { class: "act-row" }, [
      el("b", { text: "Configuration validation" }),
      el("span", { class: "exec-ok " + (cfg.ok ? "ok" : "bad"), text: cfg.ok ? "✓ valid" : "✗ " + cfg.problems.join("; ") })
    ]));
    envPanel.appendChild(el("div", { class: "act-row" }, [
      el("b", { text: "Startup health checks" }),
      el("span", { class: "dim small-note", text: "boot runs migrations (snapshot-first, rollback kept), storage probe, module census — see Health Center" })
    ]));
    body.appendChild(envPanel);

    const notes = el("div", { class: "panel" });
    notes.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "📜 Release notes — the full evolutionary arc" })]));
    OM.CHANGELOG.slice().reverse().forEach(c2 => notes.appendChild(el("div", { class: "act-row" }, [
      el("span", { class: "cap-chip on", text: "v" + c2.v }),
      el("b", { text: c2.name }),
      el("span", { class: "dim small-note", text: c2.note })
    ])));
    body.appendChild(notes);
  }

  /* ---- MODULE 8 — documentation hub ---- */
  function omDocs(body) {
    const sections = [
      ["System Overview", () => `PRISM-X is a zero-dependency, browser-native Intelligence Operating System. One state tree (localStorage), ${OM.versionInfo().modules} modules, every phase verified end-to-end. Agent classes: Clones (specialist workers), Ghosts (product agents), Shells (content brands), Executors (humans). Coordination: Bridge → Provider Manager → Runtime → Execution Layer → Knowledge → Missions → Evolution → Enterprise → Extensions → Network.`],
      ["Architecture Guide", () => `Script order is the dependency order: data → engine → store → ui → ghosts → shells → matrix → bridge → providers → runtime → execution → knowledge → missions → evolution → enterprise → extensions → network → omega → app. Every module is an IIFE on window.PRISM with lazy cross-references. All inter-module traffic flows through the Bridge (events, shared memory, permissions, internal API); the extension bus taps bridge.emit with a single line. Simulations (revenue, engagement, remote telemetry) are labeled at every surface; generated content and coordination logic are real.`],
      ["User Guide", () => `1) Onboard — train the five DNA layers. 2) Forge clones and run tasks from their consoles. 3) Deploy Ghosts/Shells for product + content loops (sim clock ⏩). 4) Activate the First Intelligence in Runtime and evaluate missions. 5) Plan multi-worker missions in Mission Control. 6) Let the Evolution Engine propose improvements — you approve. 7) Run the business in Enterprise (CRM feeds missions, ledger stays honest). 8) Install extensions; register nodes; take snapshots. Every page's sub-title states what's real vs simulated.`],
      ["Developer Guide", () => `Add capability as an extension, never a core edit: define a manifest (id, name, version, author, category, requires, permissions, requiredApis, dependencies, configSchema, ui.widgets/pages, listeners, init, docs), register it in the catalog, install through the manager, get a permission-scoped api object. State additions go through store defaults + ensure() migrations. Emit events via bridge kinds; they auto-flow to the Command Center, extension bus and audit trail.`],
      ["API Reference (live)", () => "Bridge internal endpoints:\n" + B.API_ENDPOINTS.map(e2 => "  " + e2).join("\n") + "\n\nExtension API surface (permission-scoped):\n" + XT.devData().apis.map(a => "  api." + a).join("\n")],
      ["Extension SDK Guide", () => `Manifest contract (validated before install): metadata + version + permissions[] (from: ${XT.PERMISSIONS.join(", ")}) + requiredApis + dependencies + configSchema + ui + listeners + docs. Events you can subscribe to: ${XT.EVENTS.join(", ")} plus raw core:<kind>. Honest caveat: the API contract is convention-enforced in a same-page runtime; iframe sandboxing is the planned hardening.`],
      ["Troubleshooting", () => `Blank page → check the browser console; state resets happen only on corrupt JSON (a backup snapshot is kept). Neural Link errors fall back to the Local Cortex automatically and say so in the notes. Locked out → the passcode has no recovery by design (browser-local); clear site data to reset (state is lost — export backups first). Storage full → Network → Monitor shows capacity; delete old snapshots. Something misbehaving → run the Validation Suite; it normalizes known schema gaps.`],
      ["FAQ", () => `Is the revenue real? Ledger entries you record are real bookkeeping; agent-network earnings are labeled simulations and never mix silently. Does it post to X automatically? No — the Broadcast Queue pre-fills the composer; you always click send. Can it run multi-node for real? The coordination layer is ready; remote runtimes need a server adapter (the API surface is already stable for it). Where are my API keys? AES-GCM-encrypted in the vault, decrypted only inside the Execution Engine.`],
      ["Changelog", () => OM.CHANGELOG.map(c2 => `v${c2.v} — ${c2.name}: ${c2.note}`).join("\n")]
    ];
    const nav2 = el("div", { class: "bridge-tabs docs-nav" });
    const content = el("div", { class: "panel" });
    const pre = el("pre", { class: "output-pre docs-pre" });
    content.appendChild(pre);
    function show(i) {
      nav2.querySelectorAll(".bridge-tab").forEach((t, j) => t.classList.toggle("on", j === i));
      pre.textContent = sections[i][1]();
    }
    sections.forEach(([title], i) => nav2.appendChild(el("a", { class: "bridge-tab" + (i === 0 ? " on" : ""), text: title, onclick: () => show(i) })));
    body.appendChild(nav2);
    body.appendChild(content);
    show(0);
  }

  /* ---- MODULE 9 — guided setup ---- */
  function omSetup(body) {
    const p2 = OM.setupProgress();
    body.appendChild(el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [
        el("h2", { class: "panel-title", text: `🧭 Guided setup — ${p2.done}/${p2.total} complete` }),
        el("div", { class: "rt-bar ms-bar", style: "width:180px" }, [el("div", { class: "rt-bar-fill", style: `width:${Math.round((p2.done / p2.total) * 100)}%` })])
      ]),
      el("p", { class: "dim small-note", text: "Each step is detected from live state — no checkboxes to fake. Finish all seven and the platform is fully in motion." }),
      ...p2.steps.map(s2 => el("div", { class: "act-row" }, [
        el("span", { class: "exec-ok " + (s2.done ? "ok" : "bad"), text: s2.done ? "✓" : "○" }),
        el("b", { text: s2.label }),
        s2.done ? el("span", { class: "dim small-note", text: "done" }) : el("a", { class: "btn tiny gold-btn", href: s2.link, text: "Do it →", style: "margin-left:auto" })
      ]))
    ]));
  }

  /* ---- MODULE 10 — validation suite ---- */
  function omValidate(body) {
    body.appendChild(el("div", { class: "form-actions", style: "justify-content:flex-start;margin-bottom:12px" }, [
      el("button", { class: "btn primary", text: "✅ Run Production Validation Suite", onclick: () => {
        const r = OM.runValidation();
        U.sfx(r.ready ? "evolve" : "click");
        toast(r.summary, r.ready ? "ok" : "err");
        go("#/production/validate");
      } })
    ]));
    const reps = OM.reports();
    if (!reps.length) { body.appendChild(el("p", { class: "empty-note", text: "No readiness reports yet — run the suite." })); return; }
    reps.slice(0, 3).forEach((r, i) => {
      const panel = el("div", { class: "panel" + (i === 0 ? " rt-monitor" : "") });
      panel.appendChild(el("div", { class: "panel-head" }, [
        el("h2", { class: "panel-title", text: `📑 Readiness report — ${new Date(r.at).toLocaleString()} (${r.profile})` }),
        el("span", { class: "ms-health " + (r.ready ? "h-on-track" : "h-delayed"), text: r.ready ? "READY" : "NOT READY" })
      ]));
      panel.appendChild(el("p", { class: (r.ready ? "" : "dim ") + "small-note", text: r.summary }));
      r.checks.forEach(c2 => panel.appendChild(el("div", { class: "act-row" }, [
        el("span", { class: "exec-ok " + (c2.status === "pass" ? "ok" : "bad"), text: c2.status === "pass" ? "✓" : c2.status === "warn" ? "⚠" : "✗" }),
        el("b", { text: c2.name }),
        el("span", { class: "dim small-note", text: c2.msg })
      ])));
      body.appendChild(panel);
    });
  }

  /* =============================== system memory =============================== */
  function renderMemory(main) {
    const st = S.state;
    const wrap = el("div", { class: "page narrow" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `SYSTEM MEMORY <span class="dim">// brain v${st.godBrainVersion}</span>` }),
        el("p", { class: "page-sub", text: "GOD CORE DNA + the permanent log of every evolution." })
      ])
    ]));

    /* DNA trainer */
    const dnaPanel = el("div", { class: "panel form-panel" });
    dnaPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "🧬 GOD CORE DNA" })]));
    const f = {};
    dnaPanel.appendChild(field("Your voice / tone", f, "tone", el("textarea", { class: "input", rows: 2, text: st.dna.tone })));
    dnaPanel.appendChild(field("Your mindset", f, "mindset", el("textarea", { class: "input", rows: 3, text: st.dna.mindset })));
    dnaPanel.appendChild(field("Your strategy / logic", f, "logic", el("textarea", { class: "input", rows: 3, text: st.dna.logic })));
    dnaPanel.appendChild(field("Decision framework", f, "decision", el("textarea", { class: "input", rows: 3, placeholder: "e.g. Prioritize long-term value over short-term gains. Explain uncertainty. Protect user trust. Optimize for leverage, not vanity.", text: st.dna.decision || "" })));
    dnaPanel.appendChild(el("p", { class: "dna-note", text: "These principles become the decision-making laws inherited by every intelligence created inside PRISM-X." }));
    dnaPanel.appendChild(field("Signature CTA", f, "cta", el("input", { class: "input", value: st.dna.cta })));
    dnaPanel.appendChild(el("div", { class: "form-actions" }, [
      el("button", {
        class: "btn gold-btn", text: "⟳ Retrain GOD CORE", onclick: () => {
          S.trainDNA({ tone: f.tone.value.trim(), mindset: f.mindset.value.trim(), logic: f.logic.value.trim(), decision: f.decision.value.trim(), cta: f.cta.value.trim() });
          U.evolveFlash(); U.sfx("evolve");
          toast(`GOD CORE retrained — brain v${S.state.godBrainVersion}. DNA-linked clones are updating.`, "ok");
          route();
        }
      })
    ]));
    wrap.appendChild(dnaPanel);

    /* log */
    const logPanel = el("div", { class: "panel" });
    logPanel.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "Evolution log" })]));
    const icons = { spawn: "◈", replicate: "⧉", delete: "✕", audit: "◉", upgrade: "⇪", dna: "🧬", share: "⇪", repeat: "⟲", queue: "⌁", ghost: "👻", shell: "🎭", matrix: "🧩" };
    const list = el("div", { class: "log-list" });
    const entries = st.systemMemory.slice().reverse();
    if (!entries.length) list.appendChild(el("p", { class: "empty-note", text: "Nothing logged yet." }));
    entries.forEach(e2 => {
      list.appendChild(el("div", { class: "log-row" }, [
        el("span", { class: "log-ico", text: icons[e2.kind] || "·" }),
        el("span", { class: "log-text", text: e2.text }),
        el("span", { class: "log-time", text: timeAgo(e2.at) })
      ]));
    });
    logPanel.appendChild(list);
    wrap.appendChild(logPanel);
    main.appendChild(wrap);
  }

  /* =============================== settings =============================== */
  function renderSettings(main) {
    const st = S.state;
    const wrap = el("div", { class: "page narrow" });
    wrap.appendChild(el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "page-title", html: `SETTINGS <span class="dim">// engine & data</span>` }),
        el("p", { class: "page-sub", text: "Everything lives in this browser. No accounts, no servers." })
      ])
    ]));

    /* engine panel */
    const eng = el("div", { class: "panel form-panel" });
    eng.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "⚙ Generation engine" })]));

    const localRadio = el("input", { type: "radio", name: "engine", value: "local" });
    const neuralRadio = el("input", { type: "radio", name: "engine", value: "neural" });
    (st.settings.engine === "neural" ? neuralRadio : localRadio).checked = true;

    eng.appendChild(el("label", { class: "radio-row" }, [localRadio, el("div", {}, [
      el("b", { text: "Local Cortex" }), el("p", { class: "dim", text: "Offline template engine. Instant, free, private. Good structure, fixed creativity." })
    ])]));
    eng.appendChild(el("label", { class: "radio-row" }, [neuralRadio, el("div", {}, [
      el("b", { text: "Neural Link — live Claude API" }), el("p", { class: "dim", text: "Each clone becomes a real AI agent: its role, tone, mindset and DNA are compiled into a system prompt. Requires your Anthropic API key." })
    ])]));

    const keyInput = el("input", { class: "input", type: "password", placeholder: "sk-ant-…", value: st.settings.apiKey, autocomplete: "off" });
    eng.appendChild(field("Anthropic API key", {}, "k", keyInput));
    eng.appendChild(el("p", { class: "dim tiny-note", text: "Stored only in this browser's localStorage and sent only to api.anthropic.com. Don't use this on a shared computer." }));

    const modelSel = el("select", { class: "input" });
    E.MODELS.forEach(m => modelSel.appendChild(el("option", { value: m, text: m + (m === "claude-opus-4-8" ? "  (recommended)" : "") })));
    modelSel.value = st.settings.model;
    eng.appendChild(field("Model", {}, "m", modelSel));

    eng.appendChild(el("div", { class: "form-actions" }, [
      el("button", {
        class: "btn", text: "Test Neural Link", onclick: async (e) => {
          const btn = e.target;
          const key = keyInput.value.trim();
          if (!key) { toast("Enter your API key first.", "err"); return; }
          btn.disabled = true; btn.textContent = "Pinging…";
          try {
            const res = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "content-type": "application/json", "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "anthropic-dangerous-direct-browser-access": "true"
              },
              body: JSON.stringify({ model: modelSel.value, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: online" }] })
            });
            if (res.ok) { toast("Neural Link online — Claude responded. ✓", "ok"); U.sfx("evolve"); }
            else {
              let msg = "HTTP " + res.status;
              try { const j = await res.json(); if (j.error) msg = j.error.message; } catch (_) {}
              toast("Neural Link failed: " + msg, "err");
            }
          } catch (err) { toast("Network error: " + err.message, "err"); }
          btn.disabled = false; btn.textContent = "Test Neural Link";
        }
      }),
      el("button", {
        class: "btn gold-btn", text: "Save Engine Settings", onclick: () => {
          const engine = neuralRadio.checked ? "neural" : "local";
          if (engine === "neural" && !keyInput.value.trim()) { toast("Neural Link needs an API key.", "err"); return; }
          S.setSettings({ engine, apiKey: keyInput.value.trim(), model: modelSel.value });
          toast("Engine settings saved.", "ok");
          $$navActive("settings");
        }
      })
    ]));
    wrap.appendChild(eng);

    /* experience panel */
    const xp = el("div", { class: "panel form-panel" });
    xp.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "◈ Experience" })]));
    const soundChk = el("input", { type: "checkbox" });
    soundChk.checked = st.settings.sound;
    soundChk.addEventListener("change", () => { S.setSettings({ sound: soundChk.checked }); if (soundChk.checked) U.sfx("spawn"); });
    xp.appendChild(el("label", { class: "check-row" }, [soundChk, el("span", { text: "Sound FX on clone spawn / evolution" })]));
    wrap.appendChild(xp);

    /* data panel */
    const data = el("div", { class: "panel form-panel" });
    data.appendChild(el("div", { class: "panel-head" }, [el("h2", { class: "panel-title", text: "⛃ Data" })]));
    data.appendChild(el("div", { class: "form-actions wrap" }, [
      el("button", {
        class: "btn", text: "Export backup (.json)", onclick: () => {
          const blob = new Blob([S.exportJSON()], { type: "application/json" });
          const a = el("a", { href: URL.createObjectURL(blob), download: "prism-x-backup.json" });
          document.body.appendChild(a); a.click(); a.remove();
        }
      }),
      el("button", {
        class: "btn", text: "Import backup", onclick: () => {
          const inp = el("input", { type: "file", accept: ".json,application/json" });
          inp.addEventListener("change", () => {
            const file = inp.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
              try { S.importJSON(reader.result); toast("Backup restored.", "ok"); go("#/dashboard"); }
              catch (err) { toast("Import failed: " + err.message, "err"); }
            };
            reader.readAsText(file);
          });
          inp.click();
        }
      }),
      el("button", {
        class: "btn", text: "Deploy demo squadron", onclick: () => { S.seedDemoClones(); toast("APEX, QUILL and VULCAN deployed.", "ok"); U.sfx("spawn"); }
      }),
      el("button", {
        class: "btn danger ghost", text: "⚠ Factory reset", onclick: () => U.modal({
          title: "Factory reset?",
          body: "<p>Deletes every clone, task, vault item and your GOD CORE DNA from this browser. This cannot be undone.</p>",
          actions: [
            { label: "Cancel", cls: "ghost" },
            { label: "Erase Everything", cls: "danger", onClick: () => { S.reset(); location.hash = "#/dashboard"; location.reload(); } }
          ]
        })
      })
    ]));
    wrap.appendChild(data);
    main.appendChild(wrap);
  }

  /* =============================== onboarding =============================== */
  function renderOnboarding() {
    const rootBox = el("div", { class: "onboard-box" });
    let step = 0;

    function draw() {
      rootBox.innerHTML = "";
      if (step === 0) {
        rootBox.appendChild(el("div", { class: "ob-glyph", text: "◈" }));
        rootBox.appendChild(el("h1", { class: "ob-title", html: `PRISM<span class="gold">-X</span>` }));
        rootBox.appendChild(el("p", { class: "ob-sub", text: "A self-replicating clone army for your business. Each clone is a specialized piece of your brain — closing DMs, writing copy, building offers — all commanded by GOD CORE." }));
        rootBox.appendChild(el("div", { class: "ob-steps" }, [
          el("div", { class: "ob-step", html: "<b>1</b> Train GOD CORE with your DNA" }),
          el("div", { class: "ob-step", html: "<b>2</b> Forge specialized clones" }),
          el("div", { class: "ob-step", html: "<b>3</b> Task them · rate them · evolve weekly" })
        ]));
        rootBox.appendChild(el("button", { class: "btn primary big", text: "⚡ Initialize GOD CORE", onclick: () => { step = 1; draw(); } }));
      } else if (step === 1) {
        rootBox.appendChild(el("h1", { class: "ob-title small", html: `Train <span class="gold">GOD CORE</span>` }));
        rootBox.appendChild(el("p", { class: "ob-sub", text: "This is the DNA every clone inherits. One minute now, compounding forever. You can retrain anytime in System Memory." }));
        const f = onboardRefs;
        rootBox.appendChild(field("Your voice / tone", f, "tone", el("textarea", { class: "input", rows: 2, placeholder: `e.g. "Direct, confident, a little dry. Short sentences. No emojis in serious posts."`, text: f._tone || "" })));
        rootBox.appendChild(field("Your mindset", f, "mindset", el("textarea", { class: "input", rows: 2, placeholder: `e.g. "Systems over hustle. Never chase — attract. Proof beats promises."`, text: f._mindset || "" })));
        rootBox.appendChild(field("Your strategy / logic", f, "logic", el("textarea", { class: "input", rows: 2, placeholder: `e.g. "Content pulls leads → DMs qualify → one offer closes. One channel at a time."`, text: f._logic || "" })));
        rootBox.appendChild(field("Decision framework", f, "decision", el("textarea", { class: "input", rows: 2, placeholder: "e.g. Prioritize long-term value over short-term gains. Explain uncertainty. Protect user trust. Optimize for leverage, not vanity.", text: f._decision || "" })));
        rootBox.appendChild(el("p", { class: "dna-note", text: "These principles become the decision-making laws inherited by every intelligence created inside PRISM-X." }));
        rootBox.appendChild(field("Signature CTA", f, "cta", el("input", { class: "input", placeholder: `e.g. "DM me 'SYSTEM' and I'll send the playbook."`, value: f._cta || "" })));
        rootBox.appendChild(el("div", { class: "form-actions" }, [
          el("button", { class: "btn ghost", text: "← Back", onclick: () => { saveRefs(); step = 0; draw(); } }),
          el("button", { class: "btn primary big", text: "Encode DNA →", onclick: () => { saveRefs(); step = 2; draw(); } })
        ]));
      } else {
        rootBox.appendChild(el("div", { class: "ob-glyph pulse", text: "◈" }));
        rootBox.appendChild(el("h1", { class: "ob-title small", html: `GOD CORE <span class="gold">online</span>` }));
        rootBox.appendChild(el("p", { class: "ob-sub", text: "DNA encoded. Choose your starting conditions:" }));
        const demoChk = el("input", { type: "checkbox", checked: "checked" });
        const soundChk = el("input", { type: "checkbox" });
        rootBox.appendChild(el("label", { class: "check-row" }, [demoChk, el("span", { text: "Deploy demo squadron (APEX · QUILL · VULCAN) with sample history — recommended" })]));
        rootBox.appendChild(el("label", { class: "check-row" }, [soundChk, el("span", { text: "Enable sound FX" })]));
        rootBox.appendChild(el("div", { class: "form-actions" }, [
          el("button", { class: "btn ghost", text: "← Back", onclick: () => { step = 1; draw(); } }),
          el("button", {
            class: "btn primary big", text: "⚡ Enter GOD CORE", onclick: () => {
              S.setSettings({ sound: soundChk.checked });
              S.completeOnboarding({
                tone: onboardRefs._tone || "", mindset: onboardRefs._mindset || "",
                logic: onboardRefs._logic || "", decision: onboardRefs._decision || "",
                cta: onboardRefs._cta || ""
              }, demoChk.checked);
              K.boot(); /* Phase Delta: the freshly trained DNA seeds the Knowledge Vault */
              EV.boot(); /* Phase Zeta: baseline prompt versions for the new squadron */
              EN.boot(); /* Phase Eta: enterprise OS comes online with the operator */
              XT.boot(); /* Phase Theta: extension platform announces itself */
              NW.boot(); /* Phase Iota: the network comes online with the operator */
              U.sfx("evolve"); U.evolveFlash();
              overlay.classList.remove("show");
              setTimeout(() => overlay.remove(), 400);
              route();
              toast("GOD CORE online — brain v1. Welcome, operator.", "ok");
            }
          })
        ]));
      }
    }

    const onboardRefs = {};
    function saveRefs() {
      if (onboardRefs.tone) onboardRefs._tone = onboardRefs.tone.value;
      if (onboardRefs.mindset) onboardRefs._mindset = onboardRefs.mindset.value;
      if (onboardRefs.logic) onboardRefs._logic = onboardRefs.logic.value;
      if (onboardRefs.decision) onboardRefs._decision = onboardRefs.decision.value;
      if (onboardRefs.cta) onboardRefs._cta = onboardRefs.cta.value;
    }

    const overlay = el("div", { class: "onboard-overlay show" }, [rootBox]);
    document.body.appendChild(overlay);
    draw();
  }

  /* =============================== boot =============================== */
  function boot() {
    B.boot(); /* Phase Alpha: bring the Bridge online, provision placeholders */
    P.boot(); /* Phase H0: register providers, route intelligence through the Manager */
    X.boot(); /* Phase Gamma: arm the Execution Layer (integrations, actions, vault) */
    K.boot(); /* Phase Delta: seed + index the Knowledge & Memory Network */
    EV.boot(); /* Phase Zeta: version prompts, start the evolution timeline */
    EN.boot(); /* Phase Eta: bring the Enterprise OS online */
    XT.boot(); /* Phase Theta: load enabled extensions through the manager */
    NW.boot(); /* Phase Iota: register PRIME, arm auto-backups + failover */
    OM.boot(); /* Phase Omega: migrations, security, production layer */
    /* Omega performance: throttled saves flush on any exit path */
    window.addEventListener("beforeunload", () => S.flush());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") S.flush(); });
    document.documentElement.classList.toggle("compact", !!S.state.settings.compact);
    U.$$(".nav-link").forEach(a => a.addEventListener("click", () => U.sfx("click")));
    window.addEventListener("hashchange", route);
    route();
    if (S.state.onboarded && S.state.security.enabled && !OM.sessionValid()) renderLockScreen();
    if (!S.state.onboarded) renderOnboarding();
    else {
      S.runWeeklyRepeats().then(ran => {
        if (ran.length) toast(`⟲ ${ran.length} weekly task(s) re-executed while you were away — outputs saved to vaults.`, "ok");
      }).catch(() => {});
      const due = S.dueQueue();
      if (due.length) toast(`⌁ ${due.length} scheduled post${due.length > 1 ? "s" : ""} due — open the Broadcast Queue.`, "info");
      /* wake-up digest: ghosts, shells and the human matrix while you were away */
      const shellEvents = SH.process();
      const matrixEvents = M.process();
      G.process().then(events => {
        shellEvents.concat(matrixEvents, events).slice(0, 5).forEach((e2, i) => setTimeout(() => toast(e2, "info"), 800 + i * 700));
        if (events.length || shellEvents.length || matrixEvents.length) $$navActive(location.hash.replace(/^#\//, "").split("/")[0] || "dashboard");
      }).catch(() => {});
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
