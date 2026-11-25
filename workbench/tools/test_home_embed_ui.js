/* T2 首页内嵌平台浏览：桌面版搜索 / 切 Tab / 行业词走 __browse.open，不调 window.open，首页出现嵌入区和工具栏。离线 DOM。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createDocument, Node} = require('./ui_test_dom');
for (const property of ['hidden', 'disabled']) Object.defineProperty(Node.prototype, property, {
  get() { return this.hasAttribute(property); },
  set(value) { value ? this.setAttribute(property, '') : this.removeAttribute(property); },
  configurable: true,
});
Node.prototype.showModal = function () { this.setAttribute('open', ''); this.open = true; };
Node.prototype.close = function () {
  this.removeAttribute('open');
  this.open = false;
  const ev = { type: 'close', target: this };
  (this._listeners?.close || []).forEach((fn) => fn(ev));
};
Node.prototype.getBoundingClientRect = function () {
  const id = this.id || (typeof this.getAttribute === 'function' ? this.getAttribute('id') : '');
  const cls = (this.getAttribute && this.getAttribute('class')) || '';
  if (id === 'fvEmbed' || id === 'fvListWrap') return { left: 24, top: 280, right: 1000, bottom: 700, width: 976, height: 420 };
  if (/\bhome-dock\b/.test(cls)) return { left: 24, top: 700, right: 1000, bottom: 800, width: 976, height: 100 };
  return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
};
const origAdd = Node.prototype.addEventListener;
Node.prototype.addEventListener = function (name, fn) {
  (this._listeners ||= {})[name] ||= [];
  this._listeners[name].push(fn);
  if (typeof origAdd === 'function') origAdd.call(this, name, fn);
};

const root = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const flowSrc = fs.readFileSync(path.join(root, 'web/flow.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const response = (data, code = 200) => ({ok: code < 400, status: code, statusText: 'OK', json: async () => structuredClone(data), text: async () => JSON.stringify(data)});

const SEARCH = {
  douyin: (k) => `https://www.douyin.com/search/${encodeURIComponent(k)}?type=video`,
  xiaohongshu: (k) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(k)}&source=web_search_result_notes`,
  bilibili: (k) => `https://search.bilibili.com/video?keyword=${encodeURIComponent(k)}`,
};
const HOME = {
  douyin: 'https://www.douyin.com/',
  xiaohongshu: 'https://www.xiaohongshu.com/explore',
  bilibili: 'https://www.bilibili.com/',
};

async function setup({desktop = false, seen = true, ids = []} = {}) {
  const document = createDocument(), events = {}, requests = [], timers = new Map(), storage = new Map();
  const classNames = (node) => (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
  document.body.classList = {
    add(c) { document.body.setAttribute('class', [...new Set([...classNames(document.body), c])].join(' ')); },
    remove(c) { document.body.setAttribute('class', classNames(document.body).filter((x) => x !== c).join(' ')); },
    contains(c) { return classNames(document.body).includes(c); },
    toggle(c, force) {
      const on = force === undefined ? !this.contains(c) : !!force;
      on ? this.add(c) : this.remove(c);
      return on;
    },
  };
  if (seen) storage.set('vrc.aboutAutoSeen', '1');
  document.body.innerHTML = page.replace(/<!doctype[^>]*>/gi, '').replace(/<script[\s\S]*?<\/script>/g, '');
  document.addEventListener = (name, fn) => (events[name] ||= []).push(fn);
  const projects = new Map(ids.map((id) => [id, {id, name: '项目 ' + id, created_at: '2026-11-23'}]));
  let timerId = 0;
  const status = {providers: {}, default_llm: '', runtime: {}, ffmpeg: true, asr: true};
  const opens = [];
  const layouts = [];
  const acts = [];
  const windowOpens = [];
  const probes = [];
  const searches = [];
  const captures = [];
  let hidden = 0;
  const browseMock = desktop ? {
    available: true,
    open(opts) {
      opens.push({...opts});
      let url = '';
      if (opts.url) url = opts.url;
      else if (opts.keyword) url = (SEARCH[opts.platform] || SEARCH.douyin)(opts.keyword);
      else url = HOME[opts.platform] || HOME.douyin;
      return Promise.resolve({ok: true, url, newWindow: false, partition: 'persist:find-viral'});
    },
    layout(b) { layouts.push(b); return Promise.resolve(true); },
    hide() { hidden += 1; return Promise.resolve(true); },
    act(action, arg) { acts.push([action, arg]); return Promise.resolve(true); },
    startLogin(opts) { return Promise.resolve({ok: true, ...(opts || {})}); },
    probeLogin(opts) { probes.push({...(opts || {})}); return Promise.resolve({ok: true, platform: (opts && opts.platform) || 'douyin', loginChecking: true, loggedIn: false}); },
    search(opts) {
      searches.push({...opts});
      return Promise.resolve({ok: true, items: [{id: '1', url: 'https://www.douyin.com/video/1', title: '烤鱼店探店', cover: 'https://example.com/c.jpg'}], note: '目前只展示这一批', platform: opts.platform, keyword: opts.keyword});
    },
    captureItem(opts) { captures.push({...opts}); return Promise.resolve({ok: true, projectId: 'p-new'}); },
    onState(cb) { this._onState = cb; },
    onImported(cb) { this._onImported = cb; },
    onLoggedIn(cb) { this._onLoggedIn = cb; },
    onLoginClosed(cb) { this._onLoginClosed = cb; },
  } : undefined;
  const windowObj = {
    scrollTo() {},
    addEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
    __browse: browseMock,
    open(...args) { windowOpens.push(args); },
    localStorage: null,
  };
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  windowObj.localStorage = localStorage;
  const context = vm.createContext({
    document, console, structuredClone, window: windowObj,
    localStorage,
    setTimeout(fn, ms) { timers.set(++timerId, {fn, ms}); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options = {}) => {
      const route = String(url).replace(/^\/api\//, ''), method = options.method || 'GET';
      requests.push({method, url: route});
      if (method === 'GET' && route === 'status') return response(status);
      if (method === 'GET' && route === 'projects') {
        return response([...projects.values()].map((p) => ({id: p.id, name: p.name, created_at: p.created_at, has_source: p.has_source})));
      }
      const detail = route.match(/^projects\/([^/]+)$/);
      if (method === 'GET' && detail && projects.has(detail[1])) return response(projects.get(detail[1]));
      throw Error('Unexpected offline request: ' + method + ' ' + route);
    },
    URL, URLSearchParams, JSON, Error, Date, Math, Number, String, Boolean, Array, Object, Map, Set, Promise,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, undefined,
  });
  context.window = windowObj;
  context.globalThis = context;
  const run = (code) => vm.runInContext(code, context);
  const $ = (selector) => document.querySelector(selector);
  const bootAt = appSrc.lastIndexOf('boot().catch');
  assert.ok(bootAt > 0, 'app.js boot() call site');
  run(appSrc.slice(0, bootAt));
  run(flowSrc);
  await run('boot()');
  await Promise.resolve();
  await Promise.resolve();
  const click = async (el) => {
    for (const fn of events.click || []) await fn({target: el, preventDefault() {}, stopPropagation() {}});
    await Promise.resolve();
    await Promise.resolve();
  };
  const submit = async (el) => {
    for (const fn of events.submit || []) await fn({target: el, preventDefault() {}, stopPropagation() {}});
    await Promise.resolve();
    await Promise.resolve();
  };
  return {run, $, document, storage, click, submit, opens, layouts, acts, windowOpens, probes, searches, captures, hidden: () => hidden, browse: browseMock, projects};
}

const tests = [], test = (name, fn) => tests.push([name, fn]);

test('桌面版抖音进入时探测登录，不打开平台首页，也不调 window.open', async () => {
  const t = await setup({desktop: true, seen: true});
  assert.ok(t.$('#fvEmbed'), '应有详情占位');
  assert.match(t.$('[data-fv-capture]').textContent, /同款/);
  assert.ok(t.$('[data-fv-back]'));
  assert.ok(t.$('[data-fv-forward]'));
  assert.ok(t.$('[data-fv-reload]'));
  assert.match(t.$('.fv .hint').textContent, /不会把平台网站嵌在这一页/);
  assert.equal(t.opens.length, 0, '抖音不应自动打开官方首页');
  assert.ok(t.probes.length >= 1);
  assert.equal(t.probes[0].platform, 'douyin');
  assert.equal(t.windowOpens.length, 0);
  await t.run('renderHome()');
  await Promise.resolve();
  assert.equal(t.probes.length, 1, '重新渲染首页不应再探测一次');
});

test('桌面版已登录后关键词搜索走后台列表，不新开窗口、不嵌官方搜索页', async () => {
  const t = await setup({desktop: true, seen: true});
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: true, loginChecking: false, canBack: false, canForward: false});
  await Promise.resolve();
  await Promise.resolve();
  t.$('#fvKeyword').value = '烤鱼';
  await t.submit(t.$('[data-fv-form]'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(t.windowOpens.length, 0);
  assert.ok(t.searches.some((s) => s.platform === 'douyin' && s.keyword === '烤鱼'));
  assert.equal(t.$('#fvEmbed').hidden, true);
  assert.match(t.$('#fvResults').textContent, /烤鱼店探店|当前按关键词/);
});

test('桌面版切到小红书只探测登录，切到 B 站仍走内嵌', async () => {
  const t = await setup({desktop: true, seen: true});
  await t.click(t.$('[data-fv-platform="xiaohongshu"]'));
  assert.ok(t.probes.some((p) => p.platform === 'xiaohongshu'));
  assert.equal(t.opens.filter((o) => o.platform === 'xiaohongshu').length, 0);
  assert.equal(t.windowOpens.length, 0);
  t.$('#fvKeyword').value = '美甲';
  await t.click(t.$('[data-fv-platform="bilibili"]'));
  const last = t.opens.at(-1);
  assert.equal(last.platform, 'bilibili');
  assert.equal(last.keyword, '美甲');
  assert.equal(t.$('#fvEmbed').getAttribute('data-fv-url'), SEARCH.bilibili('美甲'));
  assert.equal(t.windowOpens.length, 0);
  assert.equal(t.$('#fvBiliNote').hidden, false);
});

test('桌面版未登录点分类不会打开平台页，也不自动弹登录窗', async () => {
  const t = await setup({desktop: true, seen: true});
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: false, loginChecking: false, canBack: false, canForward: false});
  await t.click(t.$('[data-fv-cat-item="餐饮美食"]'));
  await Promise.resolve();
  assert.equal(t.windowOpens.length, 0);
  assert.equal(t.searches.length, 0, '未登录不得发起后台搜索');
  assert.equal(t.$('#fvResults').hidden, true);
  assert.equal(t.$('#fvLoginEmpty').hidden, false);
});

test('介绍弹层打开时会把原生视图藏起来', async () => {
  const t = await setup({desktop: true, seen: true});
  const hiddenAtStart = t.hidden();
  await t.click(t.$('#aboutBtn'));
  assert.ok(t.hidden() > hiddenAtStart, '打开介绍应 hide 嵌入视图');
  await t.click(t.$('#aboutCloseBtn'));
  assert.ok(t.$('#aboutDialog') && !t.$('#aboutDialog').open);
});

test('桌面版 B 站工具栏后退、前进、刷新和同款都作用在当前内嵌区', async () => {
  const t = await setup({desktop: true, seen: true});
  await t.click(t.$('[data-fv-platform="bilibili"]'));
  const opensBefore = t.opens.length;
  t.browse._onState({
    url: 'https://www.bilibili.com/video/BV1',
    loggedIn: true,
    loginChecking: false,
    canBack: true,
    canForward: true,
  });
  assert.equal(t.$('[data-fv-back]').disabled, false);
  assert.equal(t.$('[data-fv-forward]').disabled, false);
  await t.click(t.$('[data-fv-back]'));
  await t.click(t.$('[data-fv-forward]'));
  await t.click(t.$('[data-fv-reload]'));
  await t.click(t.$('[data-fv-capture]'));
  assert.deepEqual(t.acts, [['back', undefined], ['forward', undefined], ['reload', undefined], ['capture', undefined]]);
  assert.equal(t.windowOpens.length, 0);
  assert.equal(t.opens.length, opensBefore, '工具栏操作不应再调 open 新建浏览');
});

test('同款导入成功后打开项目，并出现在「最近的项目」里', async () => {
  const t = await setup({desktop: true, seen: true});
  assert.equal(typeof t.browse._onImported, 'function');
  t.projects.set('p-new', {
    id: 'p-new',
    name: '长沙烤鱼',
    created_at: '2026-11-23 12:00:00',
    has_source: true,
    source: { file: 'v.mp4', name: 'v.mp4', probe: { duration: 8, width: 1080, height: 1920, ratio_hint: '9:16', fps: 30, audio_stream_count: 1, audio_codec: 'aac', size_bytes: 2048 } },
    origin: { platform: 'douyin', platform_name: '抖音', url: 'https://www.douyin.com/video/123', title: '烤鱼', desc: '长沙烤鱼', author: '老王' },
    jobs: {},
    runs: {},
    images: {},
    assets: [],
  });
  await t.browse._onImported({ id: 'p-new', name: '长沙烤鱼' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(t.run('P && P.id'), 'p-new', '应打开刚建的项目');
  assert.equal(t.$('#workspace').hidden, false);
  assert.equal(t.$('#emptyState').hidden, true);
  const recent = t.$('#recentProjects');
  assert.ok(recent && /长沙烤鱼/.test(recent.textContent), '项目应出现在最近的项目');
  assert.ok(recent.querySelector('[data-open-recent="p-new"]'));
  const toast = t.$('#toast');
  assert.ok(toast && /已建好项目「长沙烤鱼」/.test(toast.textContent));
});

test('浏览器打开工作台不出现嵌入区，搜索仍走新标签页', async () => {
  const t = await setup({desktop: false, seen: true});
  assert.equal(t.$('#fvEmbed'), null);
  assert.equal(t.$('[data-fv-capture]'), null);
  assert.match(t.$('.fv .hint').textContent, /新标签页/);
  t.$('#fvKeyword').value = '烤鱼';
  await t.submit(t.$('[data-fv-form]'));
  assert.equal(t.windowOpens.length, 1);
  assert.equal(t.windowOpens[0][0], SEARCH.douyin('烤鱼'));
  assert.equal(t.windowOpens[0][1], '_blank');
});

test('桌面首页操作区固定、内嵌区高度随剩余窗口空间变化', async () => {
  const t = await setup({desktop: true, seen: true});
  assert.ok(t.$('.fv-chrome'), '搜索和平台 Tab 应在固定操作区');
  assert.ok(t.$('.home-dock'), '最近项目应放在操作区附近的固定区域');
  assert.ok(t.document.documentElement.classList.contains('is-desktop-home'));
  const css = fs.readFileSync(path.join(root, 'web/style.css'), 'utf8');
  assert.match(css, /html\.is-desktop-home[^{]+\{[^}]*overflow:\s*hidden/);
  assert.match(css, /html\.is-desktop-home \.fv-chrome/);
  assert.match(css, /html\.is-desktop-home \.fv-embed/);
  // 窗口 800，占位区顶 280，底部码头 100，再留 12 边距 → 408
  assert.equal(t.$('#fvListWrap').style.height, '408px');
  const chrome = t.$('.fv-chrome');
  const pane = t.$('.fv-pane');
  const dock = t.$('.home-dock');
  assert.ok(chrome && pane && dock);
  assert.equal(chrome.nextElementSibling, pane, '内嵌区应紧跟操作区');
});

test('浏览器打开工作台不启用桌面占满布局', async () => {
  const t = await setup({desktop: false, seen: true});
  assert.equal(t.document.documentElement.classList.contains('is-desktop-home'), false);
  assert.ok(t.$('.fv-chrome'));
  assert.ok(t.$('.home-dock'));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  assert.equal(failed, 0, `${failed} home-embed scenarios failed`);
  console.log(`Home embed UI: ${tests.length} scenarios passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
