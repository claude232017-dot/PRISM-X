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
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    await page.screenshot({ path: `${OUT}/shot-${size.name}.png`, fullPage: false });

    const bad = [];
    if (r.hScroll) bad.push(`horizontal scroll (${r.scrollW} > ${r.innerW})`);
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
