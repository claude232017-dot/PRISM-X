/* PRISM-X — app.js
 * Views, router, onboarding, and event wiring. No build step, no backend.
 */
(function () {
  "use strict";
  const D = PRISM.data, E = PRISM.engine, S = PRISM.store, U = PRISM.ui;
  const { $, el, esc, fmtMoney, fmtNum, timeAgo, toast } = U;

  /* =============================== router =============================== */
  function route() {
    const hash = location.hash || "#/dashboard";
    const parts = hash.replace(/^#\//, "").split("/");
    const view = parts[0] || "dashboard";
    $$navActive(view);
    const main = $("#view");
    main.innerHTML = "";
    if (view === "forge") renderForge(main);
    else if (view === "clone" && parts[1]) renderClone(main, parts[1]);
    else if (view === "memory") renderMemory(main);
    else if (view === "settings") renderSettings(main);
    else renderDashboard(main);
    window.scrollTo(0, 0);
  }

  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  function $$navActive(view) {
    U.$$(".nav-link").forEach(a => {
      a.classList.toggle("active", a.dataset.view === view || (view === "clone" && a.dataset.view === "dashboard"));
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
      el("button", { class: "btn tiny", text: "Post to X ↗", onclick: () => U.shareToX(firstArtifactChunk(task.output)) })
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
    dnaPanel.appendChild(field("Signature CTA", f, "cta", el("input", { class: "input", value: st.dna.cta })));
    dnaPanel.appendChild(el("div", { class: "form-actions" }, [
      el("button", {
        class: "btn gold-btn", text: "⟳ Retrain GOD CORE", onclick: () => {
          S.trainDNA({ tone: f.tone.value.trim(), mindset: f.mindset.value.trim(), logic: f.logic.value.trim(), cta: f.cta.value.trim() });
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
    const icons = { spawn: "◈", replicate: "⧉", delete: "✕", audit: "◉", upgrade: "⇪", dna: "🧬", share: "⇪", repeat: "⟲" };
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
                logic: onboardRefs._logic || "", cta: onboardRefs._cta || ""
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
      if (onboardRefs.cta) onboardRefs._cta = onboardRefs.cta.value;
    }

    const overlay = el("div", { class: "onboard-overlay show" }, [rootBox]);
    document.body.appendChild(overlay);
    draw();
  }

  /* =============================== boot =============================== */
  function boot() {
    U.$$(".nav-link").forEach(a => a.addEventListener("click", () => U.sfx("click")));
    window.addEventListener("hashchange", route);
    route();
    if (!S.state.onboarded) renderOnboarding();
    else {
      S.runWeeklyRepeats().then(ran => {
        if (ran.length) toast(`⟲ ${ran.length} weekly task(s) re-executed while you were away — outputs saved to vaults.`, "ok");
      }).catch(() => {});
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
