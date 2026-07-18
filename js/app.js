/* PRISM-X — app.js
 * Views, router, onboarding, and event wiring. No build step, no backend.
 */
(function () {
  "use strict";
  const D = PRISM.data, E = PRISM.engine, S = PRISM.store, U = PRISM.ui, G = PRISM.ghosts, SH = PRISM.shells, M = PRISM.matrix, B = PRISM.bridge;
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
            learningSource: f.learningSource.value
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
          productType: f.type.value, platform: f.platform.value, tone: f.tone.value
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
        autoUpload: autoCb.checked
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
    body.appendChild(el("p", { class: "dim small-note", text: "Placeholder framework — cards are provisioned but no live APIs connect in Phase Alpha (both specs mandate this). Future credentials plug in here." }));
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
      "GET /workflows": () => B.api.workflows.list()
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
    U.$$(".nav-link").forEach(a => a.addEventListener("click", () => U.sfx("click")));
    window.addEventListener("hashchange", route);
    route();
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
