const { chromium } = require('playwright-core');

const OUT = '/tmp/claude-0/-home-user-PRISM-X/a426672d-e8c8-552b-aef5-645e725d9aae/scratchpad';
const WIDTHS = [
  { name: 'iphone-se', w: 375, h: 812 },
  { name: 'android', w: 412, h: 892 },
  { name: 'tablet', w: 768, h: 1024 },
  { name: 'laptop', w: 1280, h: 900 },
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  let failures = 0;

  for (const size of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width: size.w, height: size.h },
      hasTouch: size.w < 768,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Seed the onboarded flag before any script runs. Clicking through the
    // onboarding each time would test the onboarding, not the shell.
    await ctx.addInitScript(() => {
      try {
        const raw = localStorage.getItem('prismx_state_v1');
        const s = raw ? JSON.parse(raw) : {};
        s.onboarded = true;
        localStorage.setItem('prismx_state_v1', JSON.stringify(s));
      } catch (e) { /* first run, nothing stored yet */ }
    });

    await page.goto('http://127.0.0.1:8899/index.html');
    await page.waitForTimeout(1500);

    const r = await page.evaluate(() => {
      const railVisible = (el) => el && getComputedStyle(el).display !== 'none';
      const rail = document.querySelector('.rail');
      const bar = document.querySelector('#tabbar');
      return {
        railShown: railVisible(rail),
        tabbarShown: railVisible(bar),
        tabCount: document.querySelectorAll('#tabbar .tab-btn').length,
        railLinks: document.querySelectorAll('.rail-link').length,
        hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
        // Element-level, because `html,body{overflow-x:hidden}` clips the
        // overflow and clamps scrollWidth — the document check reported a
        // clean page while Settings was cut off by 32px.
        clipped: (() => {
          const W = document.documentElement.clientWidth;
          return Array.from(document.querySelectorAll('#view *'))
            .filter((e) => { const r = e.getBoundingClientRect();
                             return r.width > 0 && r.right > W + 1; })
            .slice(0, 3)
            .map((e) => e.tagName.toLowerCase() +
              (typeof e.className === 'string' && e.className
                ? '.' + e.className.trim().split(/\s+/)[0] : ''));
        })(),
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        labelShown: (() => {
          const s = document.querySelector('.rail-link span');
          return s ? getComputedStyle(s).display !== 'none' : null;
        })(),
        icoShown: (() => {
          const i = document.querySelector('.rail-ico');
          return i ? getComputedStyle(i).display !== 'none' : null;
        })(),
        // Geometry, not just visibility. The rail rendered at 768px wide and
        // after the content once, and every display-based check still passed.
        railBox: (() => {
          const r = document.querySelector('#nav.rail');
          const v = document.querySelector('#view');
          if (!r || !v) return null;
          const a = r.getBoundingClientRect(), b = v.getBoundingClientRect();
          return { x: Math.round(a.x), w: Math.round(a.width),
                   viewX: Math.round(b.x), viewW: Math.round(b.width) };
        })(),
        // Nothing inside the rail may spill out of it.
        railOverflow: (() => {
          const rail = document.querySelector('#nav.rail');
          if (!rail || getComputedStyle(rail).display === 'none') return 0;
          const r = rail.getBoundingClientRect();
          return Array.from(rail.querySelectorAll('*')).filter((e) => {
            const b = e.getBoundingClientRect();
            return b.width > 0 && b.right > r.right + 1;
          }).length;
        })(),
        // Metric tiles: two-up on a phone, four-up on a laptop. Four tiles
        // stacked single-column filled an entire 375px screen.
        kpiCols: (() => {
          const row = document.querySelector('.kpi-row');
          if (!row) return null;
          return getComputedStyle(row).gridTemplateColumns.split(' ').length;
        })(),
        tabLabels: Array.from(document.querySelectorAll('#tabbar .tab-btn'))
          .map((b) => b.lastElementChild.textContent.trim()),
        fabOverlapsTabbar: (() => {
          const fab = document.querySelector('.ac-fab');
          const bar = document.querySelector('#tabbar');
          if (!fab || !bar || fab.hidden) return false;
          if (getComputedStyle(bar).display === 'none') return false;
          const f = fab.getBoundingClientRect(), b = bar.getBoundingClientRect();
          return !(f.bottom <= b.top || f.top >= b.bottom);
        })(),
      };
    });

    // Mobile: every destination must be reachable in two taps.
    let reach = null;
    if (size.w < 768) {
      await page.locator('#tabbar .tab-btn').nth(3).click(); // INFRASTRUCTURE
      await page.waitForTimeout(400);
      reach = await page.evaluate(() => {
        const sheet = document.querySelector('#nav-sheet');
        const links = Array.from(document.querySelectorAll('#nav-sheet .sheet-link'));
        return {
          open: sheet && !sheet.hidden,
          count: links.length,
          minTap: Math.min(...links.map((a) => a.getBoundingClientRect().height)),
          labels: links.map((a) => a.textContent.trim()),
          // Nothing may float above an open modal sheet and cover its links.
          covered: (() => {
            const fab = document.querySelector('.ac-fab');
            if (!fab || fab.hidden) return false;
            const f = fab.getBoundingClientRect();
            const mid = document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2);
            return !!(mid && mid.closest('.ac-fab'));
          })(),
        };
      });
      await page.screenshot({ path: `${OUT}/shot-${size.name}-sheet.png` });

      // Pick a destination and confirm the whole round trip. The previous
      // version pressed Escape and screenshotted, which is why it missed a
      // closed sheet still swallowing every tap on the page.
      await page.locator('#nav-sheet .sheet-link').first().click();
      await page.waitForTimeout(700);
      reach.navigated = await page.evaluate(() => location.hash);
      reach.stillOpen = await page.evaluate(
        () => { const s = document.querySelector('#nav-sheet'); return !!s && !s.hidden; },
      );

      // The killer: a hidden overlay that still intercepts pointer events.
      // `hidden` is only display:none from the UA sheet, and any author
      // `display` beats it — so the page looks fine and nothing is tappable.
      reach.blocksTaps = await page.evaluate(() => {
        const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 3);
        return !!(hit && hit.closest('#nav-sheet'));
      });

      // The tab bar must stay usable while a group is open, or switching
      // groups costs two taps and the close-by-tapping-again toggle is dead.
      await page.locator('#tabbar .tab-btn').nth(0).click();
      await page.waitForTimeout(350);
      const opened = await page.evaluate(
        () => { const s = document.querySelector('#nav-sheet'); return !!s && !s.hidden; },
      );
      await page.locator('#tabbar .tab-btn').nth(0).click();
      await page.waitForTimeout(350);
      const closed = await page.evaluate(
        () => { const s = document.querySelector('#nav-sheet'); return !!s && !s.hidden; },
      );
      reach.toggles = opened && !closed;
    }

    // Form fields must stay visible while being typed into. The tab bar is
    // position:fixed and overlays the viewport, and the browser's
    // scroll-into-view has no idea it is there — the last field on Settings
    // sat 46px underneath it.
    let form = null;
    if (size.w < 768) {
      await page.goto('http://127.0.0.1:8899/index.html#/settings');
      await page.waitForTimeout(1000);
      // Shrink the viewport the way a software keyboard does, so the field
      // is judged against the space actually left for it.
      await page.setViewportSize({ width: size.w, height: 420 });
      await page.waitForTimeout(200);
      const TEXT_FIELD =
        'input[type=text]:visible, input[type=password]:visible, input[type=email]:visible, ' +
        'input[type=number]:visible, input[type=search]:visible, input[type=url]:visible, ' +
        'input:not([type]):visible, textarea:visible';
      const n = await page.locator(TEXT_FIELD).count();
      if (n) {
        const last = page.locator(TEXT_FIELD).nth(n - 1);
        await last.scrollIntoViewIfNeeded().catch(() => {});
        await last.focus().catch(() => {});
        await page.waitForTimeout(400);
        form = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return { focused: false };
          const bar = document.querySelector('#tabbar');
          const shown = bar && getComputedStyle(bar).display !== 'none';
          const barTop = shown ? bar.getBoundingClientRect().top : Infinity;
          const f = el.getBoundingClientRect();
          return {
            focused: true,
            barHidden: !shown,
            underBar: f.bottom > barTop,
            offscreen: f.bottom > window.innerHeight || f.top < 0,
          };
        });
      }
      await page.screenshot({ path: `${OUT}/shot-${size.name}-typing.png` });
      await page.setViewportSize({ width: size.w, height: size.h });
      await page.goto('http://127.0.0.1:8899/index.html#/dashboard');
      await page.waitForTimeout(800);
    }

    await page.screenshot({ path: `${OUT}/shot-${size.name}.png`, fullPage: false });

    const bad = [];
    const wantCols = size.w >= 1100 ? 4 : 2;
    if (r.kpiCols !== null && r.kpiCols !== wantCols) {
      bad.push(`metric grid has ${r.kpiCols} columns, expected ${wantCols}`);
    }
    if (r.hScroll) bad.push(`horizontal scroll (${r.scrollW} > ${r.innerW})`);
    if (r.clipped && r.clipped.length) {
      bad.push(`content clipped past the viewport: ${r.clipped.join(', ')}`);
    }
    if (r.railLinks !== 20) bad.push(`rail has ${r.railLinks} links, expected 20`);
    if (size.w < 768) {
      if (r.railShown) bad.push('rail visible on mobile');
      if (!r.tabbarShown) bad.push('tab bar missing on mobile');
      if (r.tabCount !== 5) bad.push(`tab bar has ${r.tabCount} tabs, expected 5`);
      if (!reach || !reach.open) bad.push('group sheet did not open');
      if (reach && reach.count !== 6) bad.push(`INFRASTRUCTURE sheet has ${reach.count}, expected 6`);
      if (reach && reach.minTap < 44) bad.push(`sheet tap target ${reach.minTap}px < 44px`);
      // A label cut mid-word ("COMMA", "AGENT") reads as a rendering fault.
      const CUT = ['COMMA', 'AGENT', 'INTEL', 'INFRA', 'PLATF'];
      const cut = r.tabLabels.filter((l, i) => l === CUT[i] && CUT[i] !== 'INTEL' && CUT[i] !== 'INFRA');
      if (cut.length) bad.push(`truncated tab labels: ${cut.join(', ')}`);
      if (r.fabOverlapsTabbar) bad.push('help FAB overlaps the tab bar');
      if (reach && reach.covered) bad.push('help FAB floats above the open sheet');
      if (reach && !/#\//.test(reach.navigated || '')) bad.push('choosing a sheet link did not navigate');
      if (reach && reach.stillOpen) bad.push('sheet stayed open after choosing a destination');
      if (reach && reach.blocksTaps) bad.push('closed sheet still intercepts taps');
      if (reach && !reach.toggles) bad.push('tab bar unusable while the sheet is open');
      if (form && form.focused) {
        if (!form.barHidden) bad.push('tab bar still shown while typing');
        if (form.underBar) bad.push('focused field sits under the tab bar');
        if (form.offscreen) bad.push('focused field scrolled off screen');
      }
    } else {
      if (!r.railShown) bad.push('rail hidden on desktop/tablet');
      if (r.tabbarShown) bad.push('tab bar visible on desktop/tablet');
      if (!r.icoShown) bad.push('rail glyph hidden');
      if (size.w >= 1100 && !r.labelShown) bad.push('rail labels hidden at 1280');
      if (size.w === 768 && r.labelShown) bad.push('rail labels shown in collapsed strip');
      const rb = r.railBox;
      if (!rb) bad.push('rail or view missing');
      else {
        if (rb.x !== 0) bad.push(`rail starts at x=${rb.x}, expected 0 (left edge)`);
        if (rb.x + rb.w > rb.viewX + 1) bad.push('rail overlaps the content column');
        const cap = size.w >= 1100 ? 260 : 80;
        if (rb.w > cap) bad.push(`rail is ${rb.w}px wide, expected <= ${cap}`);
        if (rb.viewW < size.w * 0.5) bad.push(`content column only ${rb.viewW}px of ${size.w}`);
        if (r.railOverflow) bad.push(`${r.railOverflow} element(s) overflow the rail`);
      }
    }
    const real = errors.filter((e) => !/_vercel\/insights|404 \(File not found\)/.test(e));
    if (real.length) bad.push(`js errors: ${real.slice(0, 2).join(' | ')}`);

    failures += bad.length;
    console.log(
      `${size.name.padEnd(10)} ${String(size.w).padStart(4)}px  ` +
        (bad.length ? 'FAIL  ' + bad.join('; ') : 'ok') +
        (reach ? `  [sheet: ${reach.count} links, min tap ${reach.minTap}px]` : ''),
    );
    await ctx.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} problem(s)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
