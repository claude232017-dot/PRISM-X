/* verify-views.js — the turn-2 view redesigns, asserted at three widths.
 *
 * verify-shell.js covers the navigation shell. This covers what sits inside
 * it: the seven redesigned destinations and the component vocabulary they
 * share. The assertions are geometry and content, not "does the class exist" —
 * every defect these caught while the views were being built passed a
 * class-based check while the layout was visibly wrong.
 *
 *   node test/verify-views.js          # needs a static server on :8899
 *   VERIFY_OUT=/some/dir node test/verify-views.js
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.env.VERIFY_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'prismx-views-'));
const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:8899/index.html';

const WIDTHS = [
  { name: 'phone', w: 375, h: 812 },
  { name: 'tablet', w: 768, h: 1024 },
  { name: 'laptop', w: 1280, h: 900 },
];

const DNA = {
  tone: 'Calm alpha. Short sentences. Never hype.',
  mindset: 'Leverage over effort. Say no by default.',
  logic: 'Value stack, then risk reversal, then price.',
  decision: 'Protect trust over short-term revenue. Explain uncertainty.',
  cta: 'Want me to send the breakdown?',
};

/* Drive the app's own seeding rather than hand-writing state: a fixture that
   drifts from what the app actually produces tests the fixture. */
async function seed(page) {
  await page.evaluate((dna) => {
    const S = window.PRISM.store;
    S.completeOnboarding(dna, true);
    S.state.godBrainVersion = 4;
    const first = S.state.clones[0];
    const gen2 = S.replicate(first.id);
    S.replicate(gen2.id); // depth 2, so lineage indentation is exercised
    const now = Date.now(), day = 86400000;
    S.state.queue = [
      { id: 'bq1', cloneId: first.id, title: 'Offer teardown thread', text: 'Six ways the offer page leaks trust.', dueAt: now - 3600000, status: 'queued', approved: true, createdAt: now, postedAt: null },
      { id: 'bq2', cloneId: null, title: 'Warm-list DM sequence', text: 'Three touches over five days.', dueAt: now + 7200000, status: 'queued', approved: false, createdAt: now, postedAt: null },
      { id: 'bq3', cloneId: null, title: 'Weekly briefing', text: 'What moved, what stalled.', dueAt: now + day, status: 'queued', approved: false, createdAt: now, postedAt: null },
      { id: 'bq4', cloneId: null, title: 'Retro thread', text: 'What the last launch taught me.', dueAt: now - day, status: 'posted', approved: true, createdAt: now - day, postedAt: now - day },
    ];
    const RT = window.PRISM.runtime; RT.ensure();
    const r = RT.rt();
    r.workerId = first.id;
    [820, 940, 760, 1120, 880, 910, 4200, 870, 930, 1010, 890, 940].forEach((ms, i) => {
      r.executions.push({ id: 'ex' + i, ms, success: true, costEst: 0.002, quality: 80, completion: 100,
        taskType: 'Write Thread', topic: 'lead machine', provider: 'local', output: 'x', at: Date.now() - (12 - i) * 60000 });
    });
    S.save();
  }, DNA);
}

/* Every redesigned view opens with the shared header. */
const VIEWS = [
  ['forge', 'Forge Clone', 'AGENTS / FORGE'],
  ['queue', 'Broadcast Queue', 'COMMAND / QUEUE'],
  ['matrix', 'Task Matrix', 'AGENTS / MATRIX'],
  ['intelligence/analytics', 'Intelligence', 'INTELLIGENCE / PROVIDERS'],
  ['runtime', 'Runtime', 'INFRASTRUCTURE / RUNTIME'],
  ['missions', 'Missions', 'COMMAND / MISSIONS'],
  ['evolution/lineage', 'Evolution', 'INTELLIGENCE / EVOLUTION'],
  ['shells', 'Outer Shells', 'AGENTS / SHELLS'],
  ['memory', 'System Memory', 'INTELLIGENCE / MEMORY'],
  ['settings', 'Settings', 'PLATFORM / SETTINGS'],
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  let failures = 0;
  const log = (label, bad) => {
    failures += bad.length;
    console.log(`${label.padEnd(34)} ${bad.length ? 'FAIL  ' + bad.join('; ') : 'ok'}`);
  };

  for (const size of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width: size.w, height: size.h },
      hasTouch: size.w < 768,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(BASE);
    await page.waitForTimeout(900);
    await seed(page);
    await page.reload();          // onboarding renders before the seed lands
    await page.waitForTimeout(700);

    console.log(`\n── ${size.name} ${size.w}px ─────────────────────────`);

    for (const [hash, title, crumb] of VIEWS) {
      await page.goto(`${BASE}#/${hash}`);
      await page.waitForTimeout(700);
      const bad = [];

      const head = await page.evaluate(() => {
        const t = document.querySelector('#view .view-title');
        const c = document.querySelector('#view .view-crumb');
        return { title: t && t.textContent.trim(), crumb: c && c.textContent.trim() };
      });
      if (head.title !== title) bad.push(`title "${head.title}" != "${title}"`);
      if (head.crumb !== crumb) bad.push(`crumb "${head.crumb}" != "${crumb}"`);

      /* No horizontal page scroll at any width, and nothing spilling out of
         the content column. Deliberate scrollers are excluded by name: the
         matrix grid and the tab strip are allowed to scroll inside
         themselves, which is what makes the page itself not need to. */
      const over = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const out = [];
        document.querySelectorAll('#view *').forEach((e) => {
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.right > vw + 1 && !e.closest('.mx-wrap,.tabs,.view-head-actions,.panel[style*="overflow-x"]')) {
            out.push((e.className || e.tagName).toString().slice(0, 40));
          }
        });
        return {
          spill: [...new Set(out)].slice(0, 3),
          hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      if (over.hScroll) bad.push('horizontal page scroll');
      if (over.spill.length) bad.push(`overflows content column: ${over.spill.join(', ')}`);

      /* Touch targets. The design fixes 44px as the floor everywhere and 52/56
         for the DNA and settings rows specifically. */
      if (size.w < 768) {
        const small = await page.evaluate(() => {
          const sel = '#view .tab, #view .btn, #view .dna-row, #view .set-row, #view .sheet-link';
          return [...document.querySelectorAll(sel)]
            .filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.height < 44; })
            .map((e) => `${(e.className || '').toString().split(' ')[0]}@${Math.round(e.getBoundingClientRect().height)}px`)
            .slice(0, 3);
        });
        if (small.length) bad.push(`tap targets under 44px: ${small.join(', ')}`);
      }

      log(`${hash}`, bad);
    }

    /* ---- per-view rules the design states explicitly ---- */

    // Matrix: a real grid on the laptop, stacked cards below it. Never both.
    await page.goto(`${BASE}#/matrix`);
    await page.waitForTimeout(700);
    {
      const m = await page.evaluate(() => {
        const vis = (s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; };
        return { grid: vis('.mx-wrap'), cards: vis('.mx-cards'),
                 cols: document.querySelectorAll('.mx-head .mx-th').length,
                 rows: document.querySelectorAll('.mx-row').length };
      });
      const bad = [];
      if (size.w >= 1100) {
        if (!m.grid) bad.push('grid hidden at 1280');
        if (m.cards) bad.push('card fallback also visible at 1280');
      } else {
        if (m.grid) bad.push('grid visible below 1100 (would scroll sideways)');
        if (!m.cards) bad.push('card fallback missing below 1100');
      }
      if (m.rows === 0) bad.push('no task rows rendered');
      log('matrix: grid vs cards', bad);
    }

    // Intelligence: no simulated figure may sit in an unlabelled column.
    await page.goto(`${BASE}#/intelligence/analytics`);
    await page.waitForTimeout(700);
    {
      const s = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.dt tbody tr')];
        const simRows = rows.filter((r) => r.classList.contains('sim'));
        return {
          rows: rows.length,
          sim: simRows.length,
          banner: !!document.querySelector('.sim-banner'),
          // every row states its provenance, simulated or not
          missingSource: rows.filter((r) => !r.querySelector('.src-tag')).length,
          // every simulated row is hatched and chipped, not just tagged
          unhatched: simRows.filter((r) => !getComputedStyle(r.querySelector('td')).backgroundImage.includes('gradient')).length,
          unchipped: simRows.filter((r) => !r.querySelector('.sim-chip')).length,
        };
      });
      const bad = [];
      if (!s.rows) bad.push('no provider rows');
      if (s.missingSource) bad.push(`${s.missingSource} row(s) with no SOURCE tag`);
      if (s.sim && !s.banner) bad.push('simulated rows present but no SIM banner');
      if (s.unhatched) bad.push(`${s.unhatched} simulated row(s) not hatched`);
      if (s.unchipped) bad.push(`${s.unchipped} simulated row(s) with no SIM chip`);
      log('intelligence: SIM treatment', bad);
    }

    // Runtime: 12 dispatches, one over budget, drawn as a spike.
    await page.goto(`${BASE}#/runtime`);
    await page.waitForTimeout(700);
    {
      const r = await page.evaluate(() => {
        const bars = [...document.querySelectorAll('#view svg rect')];
        const flag = document.querySelector('.chart-flag');
        return { bars: bars.length, red: bars.filter((b) => b.getAttribute('fill') === '#e66767').length,
                 flag: flag && flag.textContent.trim(), stream: document.querySelectorAll('.stream-row').length,
                 cortex: document.querySelectorAll('.cortex').length };
      });
      const bad = [];
      if (r.bars !== 12) bad.push(`${r.bars} latency bars, expected 12`);
      if (r.red !== 1) bad.push(`${r.red} spike bars, expected 1`);
      if (r.flag !== '1 SPIKE') bad.push(`flag reads "${r.flag}", expected "1 SPIKE"`);
      if (r.cortex !== 2) bad.push(`${r.cortex} cortex tiles, expected 2`);
      if (!r.stream) bad.push('log stream empty');
      log('runtime: latency + log', bad);
    }

    // Queue: approval owns the top, and nothing unapproved offers a post action.
    await page.goto(`${BASE}#/queue`);
    await page.waitForTimeout(700);
    {
      const q = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.q-item')];
        return {
          bar: !!document.querySelector('.approve-bar'),
          barText: (document.querySelector('.approve-count') || {}).textContent,
          cols: document.querySelectorAll('.q-cols > div').length,
          needsOk: items.filter((i) => i.classList.contains('needs-ok')).length,
          // an unapproved item must not offer "Post to X"
          leaky: items.filter((i) => i.classList.contains('needs-ok') &&
            [...i.querySelectorAll('.btn')].some((b) => /Post to X/.test(b.textContent))).length,
          everyItemBadged: items.every((i) => i.querySelector('.badge')),
        };
      });
      const bad = [];
      if (!q.bar) bad.push('approval bar missing');
      if (!/2 items need your approval/.test(q.barText || '')) bad.push(`bar reads "${(q.barText || '').trim()}"`);
      if (q.cols !== 2) bad.push(`${q.cols} day columns, expected 2`);
      if (!q.needsOk) bad.push('no NEEDS OK items rendered');
      if (q.leaky) bad.push(`${q.leaky} unapproved item(s) offer "Post to X"`);
      if (!q.everyItemBadged) bad.push('an item carries no approval badge');
      log('queue: approval gate', bad);
    }

    // Evolution: replicas indent under their parent.
    await page.goto(`${BASE}#/evolution/lineage`);
    await page.waitForTimeout(700);
    {
      const l = await page.evaluate(() => [...document.querySelectorAll('.lineage-row')].map((e) => ({
        depth: +e.style.getPropertyValue('--depth'), left: Math.round(e.getBoundingClientRect().left),
      })));
      const bad = [];
      const depths = l.map((x) => x.depth);
      if (!l.length) bad.push('no lineage rows');
      if (Math.max(...depths, 0) < 2) bad.push(`max depth ${Math.max(...depths, 0)}, expected 2`);
      // deeper rows must actually sit further right
      for (let i = 1; i < l.length; i++) {
        if (l[i].depth > l[i - 1].depth && l[i].left <= l[i - 1].left) {
          bad.push('a child row is not indented past its parent'); break;
        }
      }
      log('evolution: lineage indent', bad);
    }

    // Settings: 56px rows, and the switch must be a real focusable checkbox.
    await page.goto(`${BASE}#/settings`);
    await page.waitForTimeout(700);
    {
      const s = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.set-row')];
        return {
          rows: rows.length,
          short: rows.filter((r) => r.getBoundingClientRect().height < 56).length,
          realInputs: document.querySelectorAll('.switch input[type=checkbox]').length,
          switches: document.querySelectorAll('.switch').length,
        };
      });
      const bad = [];
      if (s.rows < 4) bad.push(`${s.rows} setting rows, expected >= 4`);
      if (s.short) bad.push(`${s.short} row(s) under 56px`);
      if (s.switches !== s.realInputs) bad.push('a switch is not backed by a checkbox');
      log('settings: toggle rows', bad);
    }

    // Shells: 1-up phone, 2-up tablet, 3-up laptop.
    await page.goto(`${BASE}#/shells`);
    await page.waitForTimeout(700);
    {
      const cols = await page.evaluate(() => {
        const g = document.querySelector('.clone-grid');
        return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : null;
      });
      const want = size.w >= 1100 ? 3 : size.w >= 560 ? 2 : 1;
      const bad = [];
      if (cols !== null && cols !== want) bad.push(`shell grid has ${cols} columns, expected ${want}`);
      log('shells: grid columns', bad);
    }

    // Forge: the action bar must clear the tab bar rather than hide under it.
    await page.goto(`${BASE}#/forge`);
    await page.waitForTimeout(700);
    {
      const f = await page.evaluate(() => {
        const btn = document.querySelector('.btn.forge');
        const bar = document.querySelector('#tabbar');
        const fab = document.querySelector('.ac-fab');
        const box = (e) => (e && getComputedStyle(e).display !== 'none' ? e.getBoundingClientRect() : null);
        const b = box(btn), t = box(bar), a = box(fab);
        /* A missing or hidden box cannot overlap anything. Returning true here
           made the desktop widths, where the tab bar is display:none, report a
           collision that could not exist. */
        const hit = (x, y) => (!x || !y ? false
          : !(x.right < y.left || x.left > y.right || x.bottom < y.top || x.top > y.bottom));
        return {
          hasBtn: !!b,
          onScreen: b ? b.bottom <= window.innerHeight + 1 && b.top >= 0 : false,
          overTabbar: hit(b, t),
          overFab: hit(b, a),
          dnaRows: document.querySelectorAll('.dna-row').length,
        };
      });
      const bad = [];
      if (!f.hasBtn) bad.push('forge button missing');
      if (!f.onScreen) bad.push('forge button off-screen without scrolling');
      if (f.overTabbar) bad.push('forge button overlaps the tab bar');
      if (f.overFab) bad.push('help FAB covers the forge button');
      // DNA rows live on the third step; switch to it and count.
      await page.evaluate(() => {
        const t = [...document.querySelectorAll('.tabs .tab')].find((b) => b.textContent.trim() === 'DNA');
        if (t) t.click();
      });
      await page.waitForTimeout(300);
      const rows = await page.evaluate(() => ({
        n: document.querySelectorAll('.dna-row').length,
        short: [...document.querySelectorAll('.dna-row')].filter((r) => r.getBoundingClientRect().height < 52).length,
        binding: [...document.querySelectorAll('.dna-row')].filter((r) => r.disabled).length,
      }));
      if (rows.n !== 5) bad.push(`${rows.n} DNA layers, expected 5`);
      if (rows.short) bad.push(`${rows.short} DNA row(s) under 52px`);
      if (rows.binding !== 1) bad.push(`${rows.binding} locked layer(s), expected 1 (Decision Framework)`);
      log('forge: action bar + DNA', bad);
    }

    await page.screenshot({ path: `${OUT}/views-${size.name}.png` });

    const real = errors.filter((e) => !/_vercel\/insights|404 \(File not found\)|Failed to load resource/.test(e));
    if (real.length) log('javascript errors', [...new Set(real)].slice(0, 3));

    await ctx.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} problem(s)` : '\nall checks passed');
  console.log(`screenshots: ${OUT}`);
  process.exit(failures ? 1 : 0);
})();
