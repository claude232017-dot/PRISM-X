/* PRISM-X — ui.js
 * DOM helpers, toasts, modals, sound FX, and chart builders (inline SVG).
 * Chart marks follow the dataviz spec: bars ≤24px with 4px rounded data-ends,
 * 2px surface gaps, hairline gridlines, hover tooltips, text in ink tokens.
 */
window.PRISM = window.PRISM || {};

PRISM.ui = (function () {
  "use strict";

  /* ---------------- DOM helpers ---------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v; /* trusted, template-authored strings only */
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    (children || []).forEach(c => { if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return node;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  const fmtMoney = n => "$" + Math.round(n).toLocaleString();
  const fmtNum = n => Math.round(n).toLocaleString();
  function fmtCompact(n) {
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(Math.round(n));
  }
  function timeAgo(ts) {
    if (!ts) return "never";
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  /* ---------------- view chrome (turn-2 vocabulary) ----------------
     Every redesigned view opens with the same three things: a title, the
     rail group it belongs to, and its tab strip. Built here once so a new
     view cannot invent a fourth header shape. */

  /* viewHead — title + breadcrumb + optional right-hand actions.
     `crumb` is the rail group and view, e.g. "AGENTS / FORGE"; a
     deep-linked screen still says where it sits in the navigation. */
  function viewHead(opts) {
    const titles = el("div", { class: "view-head-titles" }, [
      el("h1", { class: "view-title", text: opts.title }),
      opts.crumb ? el("p", { class: "view-crumb", text: opts.crumb }) : null
    ]);
    const head = el("div", { class: "view-head" }, [titles]);
    const actions = (opts.actions || []).filter(Boolean);
    if (actions.length) head.appendChild(el("div", { class: "view-head-actions" }, actions));
    return head;
  }

  /* tabStrip — 6–9 pills, horizontally scrollable at 375, wrapping at 768.
     Never a <select>: a dropdown hides how many destinations exist. */
  function tabStrip(items, currentKey, onPick) {
    const strip = el("div", { class: "tabs", role: "tablist" });
    items.forEach(it => {
      const on = it.key === currentKey;
      strip.appendChild(el("button", {
        class: "tab" + (on ? " active" : ""),
        role: "tab", "aria-selected": on ? "true" : "false",
        text: it.label,
        onclick: () => { if (!on && onPick) onPick(it.key); }
      }));
    });
    return strip;
  }

  /* badge — the status vocabulary. Colour is reinforcement only: the glyph
     comes from the ::before rule and the border style (solid / dashed /
     dotted / double) is what survives greyscale, so never pass a bare
     colour where a status key belongs. */
  function badge(statusKey, labelOverride) {
    const meta = PRISM.data.STATUS_META[statusKey] || PRISM.data.STATUS_META.dormant;
    return el("span", { class: "badge " + meta.cls, text: labelOverride || meta.label });
  }

  /* ---------------- toasts ---------------- */
  function toast(msg, kind) {
    const root = $("#toast-root");
    const t = el("div", { class: "toast " + (kind || "info") }, [
      el("span", { class: "toast-dot" }),
      el("span", { text: msg })
    ]);
    root.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 350); }, 3800);
  }

  /* ---------------- modal ---------------- */
  function modal(opts) {
    const root = $("#modal-root");
    root.innerHTML = "";
    const box = el("div", { class: "modal-box " + (opts.cls || "") });
    if (opts.title) box.appendChild(el("div", { class: "modal-title", html: opts.title }));
    if (opts.body) {
      if (typeof opts.body === "string") box.appendChild(el("div", { class: "modal-body", html: opts.body }));
      else box.appendChild(opts.body);
    }
    const row = el("div", { class: "modal-actions" });
    (opts.actions || []).forEach(a => {
      row.appendChild(el("button", {
        class: "btn " + (a.cls || ""),
        text: a.label,
        onclick: () => { if (!a.keepOpen) closeModal(); if (a.onClick) a.onClick(); }
      }));
    });
    if (row.children.length) box.appendChild(row);
    const overlay = el("div", { class: "modal-overlay", onclick: (e) => { if (e.target === overlay && !opts.locked) closeModal(); } }, [box]);
    root.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("show"));
    return { overlay, box };
  }
  function closeModal() {
    const root = $("#modal-root");
    const ov = $(".modal-overlay", root);
    if (ov) { ov.classList.remove("show"); setTimeout(() => (root.innerHTML = ""), 200); }
  }

  /* ---------------- sound FX (WebAudio, optional) ---------------- */
  let audioCtx = null;
  function sfx(name) {
    if (!PRISM.store.state.settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = audioCtx.currentTime;
      const seqs = {
        click:  [[880, 0.04, 0.02]],
        spawn:  [[440, 0.08, 0], [660, 0.08, 0.08], [880, 0.12, 0.16]],
        evolve: [[330, 0.1, 0], [495, 0.1, 0.1], [660, 0.1, 0.2], [990, 0.2, 0.3]],
        rate:   [[660, 0.05, 0], [990, 0.07, 0.06]],
        error:  [[220, 0.15, 0], [180, 0.2, 0.12]]
      };
      (seqs[name] || seqs.click).forEach(([freq, dur, delay]) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "triangle";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + delay);
        gain.gain.exponentialRampToValueAtTime(0.12, now + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + delay);
        osc.stop(now + delay + dur + 0.05);
      });
    } catch (_) { /* audio blocked — fine */ }
  }

  /* ---------------- evolve flash ---------------- */
  function evolveFlash() {
    const f = el("div", { class: "evolve-flash" });
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 1400);
  }

  /* ---------------- shared tooltip ---------------- */
  function tip() { return $("#viz-tip"); }
  function showTip(html, x, y) {
    const t = tip();
    t.innerHTML = html;
    t.style.display = "block";
    const pad = 14;
    const rect = t.getBoundingClientRect();
    let left = x + pad, top = y - rect.height - pad;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
    if (top < 8) top = y + pad;
    t.style.left = left + "px";
    t.style.top = top + "px";
  }
  function hideTip() { tip().style.display = "none"; }

  /* ---------------- bar chart (single series, gold) ---------------- */
  const NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  }

  function niceMax(v) {
    if (v <= 0) return 10;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  /* Rounded top (4px), square baseline */
  function barPath(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
  }

  function barChart(container, cfg) {
    const labels = cfg.labels, values = cfg.values;
    const W = cfg.width || Math.max(320, container.clientWidth || 560);
    const H = cfg.height || 190;
    const m = { t: 14, r: 8, b: 24, l: 44 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const maxV = niceMax(Math.max(...values, 1));
    const fmt = cfg.format || fmtNum;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": cfg.label || "bar chart" });

    /* hairline gridlines + y ticks (clean numbers) */
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (maxV / ticks) * i;
      const y = m.t + ih - (v / maxV) * ih;
      svg.appendChild(svgEl("line", { x1: m.l, x2: m.l + iw, y1: y, y2: y, class: i === 0 ? "axis-line" : "grid-line" }));
      const t = svgEl("text", { x: m.l - 8, y: y + 3.5, class: "tick-label", "text-anchor": "end" });
      t.textContent = fmtCompact(v);
      svg.appendChild(t);
    }

    const band = iw / values.length;
    const barW = Math.min(24, Math.max(6, band - Math.max(2, band * 0.35)));

    values.forEach((v, i) => {
      const h = Math.max(v > 0 ? 3 : 0, (v / maxV) * ih);
      const x = m.l + band * i + (band - barW) / 2;
      const y = m.t + ih - h;
      if (h > 0) {
        const p = svgEl("path", { d: barPath(x, y, barW, h), class: "bar-mark" + (cfg.markClass ? " " + cfg.markClass : "") });
        svg.appendChild(p);
      }
      /* x label */
      const xl = svgEl("text", { x: m.l + band * i + band / 2, y: H - 7, class: "tick-label", "text-anchor": "middle" });
      xl.textContent = labels[i];
      svg.appendChild(xl);
      /* hover hit target — full band height, bigger than the mark */
      const hit = svgEl("rect", { x: m.l + band * i, y: m.t, width: band, height: ih, fill: "transparent", class: "bar-hit" });
      hit.addEventListener("mousemove", (e) => {
        showTip(`<b>${esc(labels[i])}</b><br>${esc(cfg.seriesName || "Value")}: <b>${esc(fmt(v))}</b>`, e.clientX, e.clientY);
        hit.classList.add("hot");
      });
      hit.addEventListener("mouseleave", () => { hideTip(); hit.classList.remove("hot"); });
      svg.appendChild(hit);
    });

    container.innerHTML = "";
    container.appendChild(svg);
  }

  /* ---------------- sparkline (stat tiles / clone cards) ---------------- */
  function sparkline(values, w, h) {
    w = w || 96; h = h || 26;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const step = w / (values.length - 1 || 1);
    const pts = values.map((v, i) => [i * step, h - 3 - ((v - min) / span) * (h - 6)]);
    const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, class: "spark", "aria-hidden": "true" });
    svg.appendChild(svgEl("polyline", { points: pts.map(p => p.map(n => n.toFixed(1)).join(",")).join(" "), class: "spark-line" }));
    const last = pts[pts.length - 1];
    svg.appendChild(svgEl("circle", { cx: last[0], cy: last[1], r: 3, class: "spark-dot" }));
    return svg;
  }

  /* ---------------- star rating ---------------- */
  function stars(current, onRate) {
    const wrap = el("div", { class: "stars", role: "radiogroup", "aria-label": "feedback score" });
    for (let i = 1; i <= 5; i++) {
      const s = el("button", {
        class: "star" + (i <= current ? " on" : ""),
        text: i <= current ? "★" : "☆",
        title: i + "/5",
        onclick: () => onRate(i)
      });
      wrap.appendChild(s);
    }
    return wrap;
  }

  /* ---------------- export helpers ---------------- */
  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg || "Copied to clipboard — paste anywhere (Notion, docs, DMs).", "ok");
    } catch (_) {
      const ta = el("textarea", { style: "position:fixed;left:-9999px" });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); toast(okMsg || "Copied to clipboard.", "ok"); }
      catch (e) { toast("Copy failed — select and copy manually.", "err"); }
      ta.remove();
    }
  }

  function emailExport(subject, body) {
    const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.slice(0, 1800))}`;
    window.location.href = url;
  }

  function pdfExport(title, body) {
    const w = window.open("", "_blank");
    if (!w) { toast("Popup blocked — allow popups to export PDF.", "err"); return; }
    w.document.write(`<!DOCTYPE html><html><head><title>${esc(title)}</title>
      <style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#111}
      h1{font-size:20px;border-bottom:2px solid #c98500;padding-bottom:8px}
      pre{white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace;background:#f6f6f2;padding:16px;border-radius:8px}</style>
      </head><body><h1>${esc(title)}</h1><pre>${esc(body)}</pre>
      <p style="color:#888;font-size:11px">Exported from PRISM-X · ${new Date().toLocaleString()}</p></body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 300);
  }

  function shareToX(text) {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text.slice(0, 270))}`;
    window.open(url, "_blank", "noopener");
  }

  return {
    $, $$, el, esc, fmtMoney, fmtNum, fmtCompact, timeAgo,
    viewHead, tabStrip, badge,
    toast, modal, closeModal, sfx, evolveFlash,
    barChart, sparkline, stars,
    copyText, emailExport, pdfExport, shareToX, showTip, hideTip
  };
})();
