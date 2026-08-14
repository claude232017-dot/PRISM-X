/* PRISM-X — shell.js
 * The mobile half of the navigation: the bottom tab bar and the group sheet.
 *
 * Everything here is derived from the rail in index.html rather than declared
 * a second time. Twenty destinations listed twice is twenty chances for the
 * two lists to disagree — and the one that disagrees is always the one only
 * phone users see, so nobody notices for months. The rail is the source of
 * truth; this file reads it.
 *
 * No dependencies, no build step. Loads before app.js and touches nothing it
 * owns: routing, active-link highlighting and view rendering are unchanged.
 */
window.PRISM = window.PRISM || {};

PRISM.shell = (function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* One glyph per group for the tab bar. Deliberately not the same glyphs as
     the rail links: these stand for a *group*, not a destination. */
  const GROUP_GLYPH = {
    COMMAND: "◈",
    AGENTS: "✦",
    INTELLIGENCE: "◉",
    INFRASTRUCTURE: "▲",
    PLATFORM: "⬢",
  };

  /* Short labels, written out rather than truncated. Slicing the group name
     to a fixed length produced "COMMA" and "AGENT" — a word cut mid-syllable
     reads as a rendering fault, and "COMMA" means something else entirely.
     Five tabs across 375px leaves ~75px each, which fits all of these. */
  const GROUP_SHORT = {
    COMMAND: "CMD",
    AGENTS: "AGENTS",
    INTELLIGENCE: "INTEL",
    INFRASTRUCTURE: "INFRA",
    PLATFORM: "SYSTEM",
  };

  /** Reads the rail into [{ name, glyph, links: [{href, label, view}] }]. */
  function groups() {
    return $$(".rail-group").map((block) => {
      const name = ($(".rail-group-label", block)?.textContent || "").trim();
      return {
        name,
        glyph: GROUP_GLYPH[name] || "◈",
        links: $$(".rail-link", block).map((a) => ({
          href: a.getAttribute("href"),
          view: a.getAttribute("data-view"),
          // `textContent` would pull in the glyph and the queue badge count.
          label: ($("span", a)?.textContent || "").trim(),
        })),
      };
    });
  }

  let openGroup = null;

  function closeSheet() {
    const sheet = $("#nav-sheet");
    if (!sheet) return;
    sheet.hidden = true;
    // Belt as well as braces. `.sheet[hidden]{display:none}` in the stylesheet
    // is the real fix, but a full-screen overlay that fails to disappear
    // swallows every tap on the page and leaves no visible trace of why — so
    // the class comes off here too, and neither mechanism is load-bearing
    // alone.
    sheet.className = "";
    sheet.innerHTML = "";
    openGroup = null;
    syncTabs();
  }

  function openSheet(group) {
    const sheet = $("#nav-sheet");
    if (!sheet) return;

    sheet.className = "sheet";
    sheet.innerHTML =
      '<div class="sheet-panel" role="dialog" aria-modal="true" aria-label="' +
      group.name +
      '">' +
      '<p class="rail-group-label">' + group.name + "</p>" +
      group.links
        .map(
          (l) =>
            '<a class="sheet-link" href="' + l.href + '" data-view="' + l.view + '">' +
            "<span>" + l.label + "</span></a>",
        )
        .join("") +
      "</div>";
    sheet.hidden = false;
    openGroup = group.name;

    // A tap on the scrim dismisses; a tap inside the panel must not.
    // Assigned rather than added: `addEventListener` here would stack another
    // handler on every open, since the element itself is never replaced.
    sheet.onclick = (e) => {
      if (e.target === sheet) closeSheet();
    };
    $$(".sheet-link", sheet).forEach((a) =>
      a.addEventListener("click", () => {
        // Let the hash change first, then tear the sheet down, so the router
        // sees the navigation rather than a detached node.
        setTimeout(closeSheet, 0);
      }),
    );

    // Focus moves into the sheet so a keyboard or screen-reader user is not
    // left behind on the tab bar.
    $(".sheet-link", sheet)?.focus();
    syncTabs();
  }

  /** Marks the tab whose group owns the current view, or the open sheet. */
  function syncTabs() {
    const active = $(".rail-link.nav-link.active");
    const view = active ? active.getAttribute("data-view") : null;

    $$("#tabbar .tab-btn").forEach((btn) => {
      const name = btn.getAttribute("data-group");
      const owns = (btn.getAttribute("data-views") || "").split(",").includes(view || "");
      const on = openGroup ? name === openGroup : owns;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-expanded", name === openGroup ? "true" : "false");
    });
  }

  function mount() {
    const bar = $("#tabbar");
    if (!bar) return;
    const list = groups();
    if (!list.length) return;

    bar.innerHTML = list
      .map(
        (g) =>
          '<button type="button" class="tab-btn" data-group="' + g.name +
          '" data-views="' + g.links.map((l) => l.view).join(",") +
          '" aria-haspopup="dialog" aria-expanded="false">' +
          '<span aria-hidden="true" style="font-size:15px;line-height:1">' + g.glyph + "</span>" +
          "<span>" + (GROUP_SHORT[g.name] || g.name) + "</span>" +
          "</button>",
      )
      .join("");

    $$("#tabbar .tab-btn").forEach((btn, index) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (openGroup === list[index].name) closeSheet();
        else openSheet(list[index]);
      }),
    );

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && openGroup) closeSheet();
    });
    // The router runs on hashchange; re-sync after it, not before.
    window.addEventListener("hashchange", () => setTimeout(syncTabs, 0));

    syncTabs();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  return { mount, closeSheet, syncTabs };
})();
