/* 真实 Chrome 布局锁：1280×800 + 最近项目 + 登录轻提示可见时，卡片必须稳定完整露出。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const work = path.join(root, 'runtime/temp/home-list-layout');

function library() {
  try { return require('playwright'); } catch {}
  const cache = path.join(os.homedir(), '.npm/_npx');
  if (fs.existsSync(cache)) {
    for (const entry of fs.readdirSync(cache)) {
      const p = path.join(cache, entry, 'node_modules/playwright');
      if (fs.existsSync(p)) return require(p);
    }
  }
  throw Error('未安装 Playwright；不会安装依赖');
}

function listItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    url: `https://www.douyin.com/video/${i + 1}`,
    title: `条目${i + 1}`,
    cover: '',
  }));
}

function projectsOf(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'p' + (i + 1),
    name: '项目 ' + (i + 1),
    created_at: '2026-11-23 10:00:00',
  }));
}

async function openHome(browser, { width, height, projectCount, hint }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => { page.__pageErrors = (page.__pageErrors || []).concat(e.message); });
  await page.route('**/*', (route) => route.abort());
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]*>/g, '')
    .replace('<head>', '<head><base href="http://home.invalid/">');
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: `(() => {
    const mem = new Map();
    const store = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(String(k), String(v)); },
      removeItem: (k) => { mem.delete(k); },
      clear: () => mem.clear(),
      key: (i) => [...mem.keys()][i] ?? null,
      get length() { return mem.size; },
    };
    try { void window.localStorage; } catch (_) {
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => store });
    }
  })();` });
  await page.addStyleTag({ path: path.join(root, 'web/style.css') });
  const appSrc = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8').replace(/boot\(\)\.catch\([^\n]+\);/, '');
  await page.addScriptTag({ content: appSrc });
  await page.evaluate(({ projectCount, hint, items }) => {
    localStorage.setItem('vrc.aboutAutoSeen', '1');
    if (!hint) localStorage.setItem('vrc.fvCaptureHintDismissed', '1');
    else localStorage.removeItem('vrc.fvCaptureHintDismissed');
    window.__browse = {
      available: true,
      open() { return Promise.resolve({ ok: true, url: 'https://www.douyin.com/', newWindow: false }); },
      layout() { return Promise.resolve(true); },
      hide() { return Promise.resolve(true); },
      act() { return Promise.resolve(true); },
      startLogin() { return Promise.resolve({ ok: true }); },
      probeLogin() { return Promise.resolve({ ok: true, platform: 'douyin', loginChecking: true, loggedIn: false }); },
      search(opts) {
        return Promise.resolve({ ok: true, items, note: '目前只展示这一批', platform: opts.platform, keyword: opts.keyword });
      },
      captureItem() { return Promise.resolve({ ok: true, projectId: 'p-new' }); },
      onState(cb) { this._onState = cb; },
      onImported() {},
      onLoggedIn() {},
      onLoginClosed() {},
    };
    const projects = Array.from({ length: projectCount }, (_, i) => ({
      id: 'p' + (i + 1),
      name: '项目 ' + (i + 1),
      created_at: '2026-11-23 10:00:00',
    }));
    window.api = async (method, route) => {
      if (route === 'status') return { providers: {}, ffmpeg: true, asr: true, runtime: { running_in_venv: true }, default_llm: '', routes: {} };
      if (route === 'projects') return projects;
      return {};
    };
  }, { projectCount, hint, items: listItems(16) });
  await page.addScriptTag({ path: path.join(root, 'web/flow.js') });
  await page.evaluate(async () => {
    await boot();
    if (window.__browse && window.__browse._onState) {
      window.__browse._onState({ url: 'https://www.douyin.com/', loggedIn: true, loginChecking: false, canBack: false, canForward: false });
    }
  });
  await page.waitForFunction(() => document.querySelectorAll('.fv-card').length >= 2, { timeout: 8000 });
  await page.evaluate(() => { if (typeof fillDesktopEmbedHeight === 'function') fillDesktopEmbedHeight(); });
  await page.waitForTimeout(50);
  return { context, page };
}

async function measure(page) {
  return page.evaluate(() => {
    const wrap = document.querySelector('#fvListWrap');
    const fv = document.querySelector('.fv');
    const dock = document.querySelector('.home-dock');
    const hint = document.querySelector('#fvCaptureHint');
    const cover = document.querySelector('.fv-cover');
    const title = document.querySelector('.fv-card h3');
    const btn = document.querySelector('.fv-same');
    const grid = document.querySelector('.fv-grid');
    const results = document.querySelector('#fvResults');
    const cs = fv ? getComputedStyle(fv) : null;
    const padBottom = cs ? (parseFloat(cs.paddingBottom) || 0) : 0;
    const fvBox = fv ? fv.getBoundingClientRect() : { bottom: 0 };
    const clipParentBottom = fvBox.bottom - padBottom;
    const wr = wrap.getBoundingClientRect();
    const visible = Math.max(0, Math.min(wr.bottom, clipParentBottom) - wr.top);
    const clipTop = Math.max(results.getBoundingClientRect().top, grid.getBoundingClientRect().top);
    const clipBottom = Math.min(results.getBoundingClientRect().bottom, grid.getBoundingClientRect().bottom, clipParentBottom);
    function info(el) {
      if (!el) return { height: 0, clipped: true };
      const r = el.getBoundingClientRect();
      return {
        height: r.height,
        top: r.top,
        bottom: r.bottom,
        clipped: r.height <= 0 || r.top < clipTop - 1 || r.bottom > clipBottom + 1,
      };
    }
    const dockBox = dock.getBoundingClientRect();
    return {
      wrapStyle: wrap && wrap.style ? parseFloat(wrap.style.height) || 0 : 0,
      wrapVisible: visible,
      wrapRect: wr.height,
      wrapTop: wr.top,
      coverH: cover ? cover.getBoundingClientRect().height : 0,
      title: info(title),
      same: info(btn),
      dockH: dockBox.height,
      dockTop: dockBox.top,
      dockBottom: dockBox.bottom,
      hintOn: !!(hint && !hint.hidden),
      padBottom,
      cards: document.querySelectorAll('.fv-card').length,
      pageText: (document.querySelector('.fv-page-status') || {}).textContent || '',
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
}

function assertComplete(m, label, { minVisible }) {
  assert.ok(m.cards >= 2, `${label}: 应露出至少 2 张卡，实际 ${m.cards}`);
  assert.ok(m.coverH > 0, `${label}: 封面高度应大于 0，实际 ${m.coverH}`);
  assert.ok(m.title.height > 0, `${label}: 标题高度应大于 0，实际 ${m.title.height}`);
  assert.ok(!m.title.clipped, `${label}: 标题被裁切 top=${m.title.top} bottom=${m.title.bottom}`);
  assert.ok(!m.same.clipped, `${label}: 「同款」被裁切 top=${m.same.top} bottom=${m.same.bottom}`);
  assert.ok(m.wrapVisible + 0.5 >= minVisible, `${label}: 可见列表高度 ${m.wrapVisible} 低于 ${minVisible}`);
  assert.ok(m.dockH > 0 && m.dockTop < m.viewport.h && m.dockBottom <= m.viewport.h + 1, `${label}: 码头应留在窗口内`);
}

async function main() {
  fs.mkdirSync(work, { recursive: true });
  const pw = library();
  const browser = await pw.chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  });
  const logs = [];
  try {
    const failing = { width: 1280, height: 800, projectCount: 2, hint: true };
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const { context, page } = await openHome(browser, failing);
      const m = await measure(page);
      await page.screenshot({ path: path.join(work, `hint-on-1280x800-run${i + 1}.png`), fullPage: false });
      logs.push(`run ${i + 1}: visible=${m.wrapVisible.toFixed(2)} style=${m.wrapStyle} cover=${m.coverH.toFixed(2)} title=${m.title.height.toFixed(2)} clippedT=${m.title.clipped} clippedB=${m.same.clipped} dock=${m.dockH.toFixed(2)} top=${m.wrapTop.toFixed(2)} hint=${m.hintOn} page=${m.pageText.trim()}`);
      assert.equal(m.hintOn, true, `第 ${i + 1} 次应显示登录轻提示`);
      assertComplete(m, `1280×800 有项目+提示 第${i + 1}次`, { minVisible: 210 });
      // 同一页再连算三次，高度必须稳定
      const again = [];
      for (let j = 0; j < 3; j++) {
        await page.evaluate(() => fillDesktopEmbedHeight());
        again.push(await measure(page));
      }
      const vis = again.map((x) => Math.round(x.wrapVisible));
      assert.ok(Math.max(...vis) - Math.min(...vis) <= 2, `同一页多次布局可见高度应稳定，实际 ${vis.join(',')}`);
      again.forEach((x, j) => assertComplete(x, `同页第${j + 1}次重算`, { minVisible: 210 }));
      runs.push(m);
      await context.close();
    }
    const visibles = runs.map((m) => Math.round(m.wrapVisible));
    const covers = runs.map((m) => Math.round(m.coverH));
    assert.ok(Math.max(...visibles) - Math.min(...visibles) <= 2, `三次独立打开可见高度应稳定，实际 ${visibles.join(',')}`);
    assert.ok(Math.max(...covers) - Math.min(...covers) <= 2, `三次独立打开封面高度应稳定，实际 ${covers.join(',')}`);
    assert.ok(runs.every((m) => m.wrapVisible > 190), '提示开着时可见列表高度不能再掉到约 180px');

    const others = [
      { width: 1280, height: 800, projectCount: 0, hint: false, name: '1280×800 无项目 提示关' },
      { width: 1280, height: 800, projectCount: 2, hint: false, name: '1280×800 有项目 提示关' },
      { width: 1440, height: 900, projectCount: 0, hint: false, name: '1440×900 无项目 提示关' },
      { width: 1440, height: 900, projectCount: 2, hint: false, name: '1440×900 有项目 提示关' },
    ];
    for (const c of others) {
      const { context, page } = await openHome(browser, c);
      const m = await measure(page);
      await page.screenshot({ path: path.join(work, `${c.width}x${c.height}-p${c.projectCount}.png`), fullPage: false });
      logs.push(`${c.name}: visible=${m.wrapVisible.toFixed(2)} cover=${m.coverH.toFixed(2)} title=${m.title.height.toFixed(2)} dock=${m.dockH.toFixed(2)}`);
      assert.equal(m.hintOn, false, `${c.name}: 提示应关闭`);
      assertComplete(m, c.name, { minVisible: 200 });
      await context.close();
    }
    console.log(logs.join('\n'));
    console.log('Home list layout browser: passed');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
