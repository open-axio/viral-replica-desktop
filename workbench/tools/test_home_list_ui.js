/* C1+L1–L3 分类树与自有列表。离线 DOM。 */
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
const layoutState = {
  mode: 'mock420',
  width: 1280,
  height: 800,
  naturalDock: 100,
  document: null,
  listTop: 443,
  hintH: 43,
  dockNoProjects: 91,
  dockTwoProjects: 218,
};
function box(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}
function hasClass(cls, name) {
  return String(cls || '').trim().split(/\s+/).includes(name);
}
function homeRects(node) {
  const doc = layoutState.document;
  const W = layoutState.width;
  const H = layoutState.height;
  const left = 24;
  const width = Math.max(0, W - 48);
  const id = node.id || (typeof node.getAttribute === 'function' ? node.getAttribute('id') : '') || '';
  const cls = (node.getAttribute && node.getAttribute('class')) || '';
  const hidden = node.hidden || (node.hasAttribute && node.hasAttribute('hidden'));
  const hint = doc && doc.querySelector && doc.querySelector('#fvCaptureHint');
  const hintOn = !!(hint && !hint.hidden && !(hint.hasAttribute && hint.hasAttribute('hidden')));
  const listTop = layoutState.listTop + (hintOn ? layoutState.hintH : 0);
  const dock = doc && doc.querySelector && doc.querySelector('.home-dock');
  const natural = layoutState.naturalDock;
  const cssCap = Math.floor(H * 0.28);
  const maxStyle = dock && dock.style && parseFloat(dock.style.maxHeight);
  let dockH = natural;
  if (Number.isFinite(maxStyle)) dockH = Math.min(dockH, maxStyle);
  else dockH = Math.min(dockH, cssCap);
  dockH = Math.max(0, dockH);
  const yielded = !!(dock && hasClass((dock.getAttribute && dock.getAttribute('class')) || '', 'is-yielded'));
  if (id === 'homeBody') return box(0, 0, W, H - 12);
  if (hasClass(cls, 'fv') || (node.className === 'fv')) {
    const dockTop = H - 12 - dockH;
    return box(left, 0, width, dockTop);
  }
  if (id === 'fvCaptureHint') {
    if (hidden) return box(0, 0, 0, 0);
    return box(left, listTop - layoutState.hintH, width, layoutState.hintH);
  }
  if (id === 'fvListWrap' || id === 'fvEmbed' || hasClass(cls, 'fv-embed-wrap') || hasClass(cls, 'fv-list-wrap')) {
    const styled = node.style && parseFloat(node.style.height);
    const h = Number.isFinite(styled) ? styled : Math.max(0, H - listTop - dockH - 12);
    return box(left, listTop, width, h);
  }
  if (hasClass(cls, 'home-dock')) {
    return box(left, H - 12 - dockH, width, dockH);
  }
  if (hasClass(cls, 'home-upload-entry')) return box(left, 0, width, (yielded ? 8 : 16) + 32);
  if (hasClass(cls, 'home-recent-head')) return box(left, 0, width, yielded ? 36 : 62);
  if (hasClass(cls, 'home-empty')) return box(left, 0, width, yielded ? 28 : 36);
  const wrap = doc && doc.querySelector && doc.querySelector('#fvListWrap');
  const wrapBox = wrap && wrap !== node ? homeRects(wrap) : box(left, listTop, width, 0);
  const results = doc && doc.querySelector && doc.querySelector('#fvResults');
  const tight = !!(results && hasClass((results.getAttribute && results.getAttribute('class')) || '', 'is-tight'));
  const padY = tight ? 16 : 48;
  const padTop = padY / 2;
  const queryH = 32, noteH = 27, pagerH = 55;
  if (id === 'fvResults' || hasClass(cls, 'fv-results')) return wrapBox;
  if (hasClass(cls, 'fv-results-query')) return box(left + 20, wrapBox.top + padTop, width - 40, queryH);
  if (hasClass(cls, 'fv-pager')) {
    if (hidden) return box(0, 0, 0, 0);
    return box(left + 20, wrapBox.bottom - padTop - pagerH, width - 40, pagerH);
  }
  if (hasClass(cls, 'fv-results-note')) {
    if (hidden) return box(0, 0, 0, 0);
    const pager = doc.querySelector('.fv-pager');
    const ph = pager ? pagerH : 0;
    return box(left + 20, wrapBox.bottom - padTop - ph - noteH, width - 40, noteH);
  }
  if (hasClass(cls, 'fv-grid')) {
    const pager = doc.querySelector('.fv-pager');
    const note = doc.querySelector('.fv-results-note');
    const ph = pager ? pagerH : 0;
    const nh = note && !note.hidden ? noteH : 0;
    const top = wrapBox.top + padTop + queryH;
    const bottom = wrapBox.bottom - padTop - ph - nh;
    return box(left + 20, top, width - 40, Math.max(0, bottom - top));
  }
  const inCard = hasClass(cls, 'fv-card') || hasClass(cls, 'fv-cover') || hasClass(cls, 'fv-same') || hasClass(cls, 'fv-card-meta') || (node.tagName || '').toLowerCase() === 'h3';
  if (inCard) {
    const grid = doc.querySelector('.fv-grid');
    const gridBox = grid ? homeRects(grid) : box(0, 0, 0, 0);
    const compact = !!(grid && hasClass((grid.getAttribute && grid.getAttribute('class')) || '', 'is-compact'));
    const style = (grid && grid.getAttribute && grid.getAttribute('style')) || '';
    const m = /--fv-cover-height:\s*([\d.]+)px/.exec(style);
    const coverH = m ? Number(m[1]) : 0;
    const titleH = compact ? 20 : 40;
    const btnH = compact ? 32 : 34;
    const gap = compact ? 6 : 8;
    const cardPad = compact ? 8 : 12;
    const cards = grid ? [...grid.querySelectorAll('.fv-card')] : [];
    let card = hasClass(cls, 'fv-card') ? node : node.parentNode;
    while (card && !hasClass((card.getAttribute && card.getAttribute('class')) || '', 'fv-card')) card = card.parentNode;
    const idx = Math.max(0, cards.indexOf(card));
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const hasMeta = !!(card && card.querySelector && card.querySelector('.fv-card-meta') && !compact);
    const metaH = hasMeta ? 18 : 0;
    const gaps = 2 + (hasMeta ? 1 : 0);
    const totalCardH = coverH + titleH + metaH + btnH + gap * gaps + cardPad;
    const colW = Math.max(0, (gridBox.width - 12) / 2);
    const x = gridBox.left + col * (colW + 12);
    const y = gridBox.top + row * (totalCardH + 12);
    const cardBox = box(x, y, colW, totalCardH);
    if (hasClass(cls, 'fv-card')) return cardBox;
    if (hasClass(cls, 'fv-cover')) return box(x, y, colW, coverH);
    if ((node.tagName || '').toLowerCase() === 'h3') return box(x + 12, y + coverH + gap, colW - 24, titleH);
    if (hasClass(cls, 'fv-card-meta')) return box(x + 12, y + coverH + gap + titleH + gap, colW - 24, metaH);
    if (hasClass(cls, 'fv-same')) {
      const top = y + coverH + gap + titleH + (hasMeta ? gap + metaH : 0) + gap;
      return box(x + 12, top, colW - 24, btnH);
    }
  }
  return box(0, 0, 0, 0);
}
Node.prototype.getBoundingClientRect = function () {
  if (layoutState.mode === 'home') return homeRects(this);
  const id = this.id || (typeof this.getAttribute === 'function' ? this.getAttribute('id') : '');
  const cls = (this.getAttribute && this.getAttribute('class')) || '';
  if (id === 'fvEmbed' || id === 'fvListWrap') return { left: 24, top: 280, right: 1000, bottom: 700, width: 976, height: 420 };
  if (hasClass(cls, 'home-dock')) return { left: 24, top: 700, right: 1000, bottom: 800, width: 976, height: 100 };
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
  layoutState.mode = 'mock420';
  layoutState.document = null;
  const document = createDocument(), events = {}, requests = [], timers = new Map(), storage = new Map();
  layoutState.document = document;
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
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('分类树固定 8 个二级，顺序正确，没有短剧获客', async () => {
  const t = await setup({desktop: true, seen: true});
  const groups = [...t.document.querySelectorAll('[data-fv-cat-group]')].map((el) => el.getAttribute('data-fv-cat-group') || el.textContent);
  assert.deepEqual(groups, ['本地生活', '电商带货', '美业健康', '知识教育', '房产家装', '穿搭美妆', '生活旅行', '运动健身']);
  assert.equal(t.$('#fvCats').hidden, false);
  assert.doesNotMatch(t.$('#fvCats').textContent, /短剧获客/);
  const items = [...t.document.querySelectorAll('[data-fv-cat-item]')].map((el) => el.getAttribute('data-fv-cat-item'));
  assert.deepEqual(items, ['餐饮美食', '酒店民宿', '门店零售', '宠物服务', '汽车服务']);
  assert.equal(t.$('[data-fv-cat-group="本地生活"]').getAttribute('aria-pressed'), 'true');
  assert.equal(t.$('[data-fv-cat-item="餐饮美食"]').getAttribute('aria-pressed'), 'true');
});

test('点每个二级只出现对应三级', async () => {
  const t = await setup({desktop: true, seen: true});
  await t.click(t.$('[data-fv-cat-group="电商带货"]'));
  const items = [...t.document.querySelectorAll('[data-fv-cat-item]')].map((el) => el.getAttribute('data-fv-cat-item'));
  assert.deepEqual(items, ['服饰鞋包', '美妆个护', '数码家电', '家居日用']);
  assert.doesNotMatch(t.$('#fvCats').textContent, /餐饮美食|短剧获客/);
  await t.click(t.$('[data-fv-cat-group="知识教育"]'));
  assert.deepEqual([...t.document.querySelectorAll('[data-fv-cat-item]')].map((el) => el.getAttribute('data-fv-cat-item')), ['课程招生', '读书讲座', '少儿兴趣']);
});

test('未登录点三级只出去登录，不搜也不出列表', async () => {
  const t = await setup({desktop: true, seen: true});
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: false, loginChecking: false, canBack: false, canForward: false});
  await t.click(t.$('[data-fv-cat-item="酒店民宿"]'));
  await flush();
  assert.equal(t.searches.length, 0);
  assert.equal(t.opens.length, 0);
  assert.equal(t.$('#fvResults').hidden, true);
  assert.equal(t.$('#fvLoginEmpty').hidden, false);
  assert.equal(t.$('#fvLoginBtn').hidden, false);
  assert.equal(t.$('#fvEmbed').hidden, true);
});

test('已登录进入 Tab 默认本地生活/餐饮美食并自动搜一次', async () => {
  const t = await setup({desktop: true, seen: true});
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: true, loginChecking: false, canBack: false, canForward: false});
  await flush();
  assert.ok(t.searches.length >= 1);
  assert.equal(t.searches[0].platform, 'douyin');
  assert.match(t.searches[0].keyword, /餐饮美食/);
  assert.equal(t.$('#fvResults').hidden, false);
  assert.match(t.$('#fvResults').textContent, /当前按「本地生活 \/ 餐饮美食」搜索/);
  assert.match(t.$('.fv-grid').getAttribute('class') || '', /fv-grid/);
  assert.equal(t.document.querySelectorAll('.fv-card').length, 1);
  assert.equal(t.$('[data-fv-same]').textContent, '同款');
  assert.equal(t.$('#fvEmbed').hidden, true);
});

test('已登录点三级会按分类名搜索', async () => {
  const t = await setup({desktop: true, seen: true});
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: true, loginChecking: false, canBack: false, canForward: false});
  await flush();
  const before = t.searches.length;
  await t.click(t.$('[data-fv-cat-group="美业健康"]'));
  await t.click(t.$('[data-fv-cat-item="美发美甲"]'));
  await flush();
  assert.ok(t.searches.length > before);
  assert.match(t.searches.at(-1).keyword, /美发美甲/);
  assert.match(t.$('#fvResults').textContent, /美发美甲/);
});

test('只有一个三级的二级，点二级等同选中并搜索', async () => {
  const t = await setup({desktop: true, seen: true});
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: true, loginChecking: false, canBack: false, canForward: false});
  await flush();
  await t.click(t.$('[data-fv-cat-group="运动健身"]'));
  await flush();
  assert.match(t.searches.at(-1).keyword, /健身打卡/);
  assert.equal(t.$('[data-fv-cat-item="健身打卡"]').getAttribute('aria-pressed'), 'true');
});

test('点列表条目进入详情并可返回原列表', async () => {
  const t = await setup({desktop: true, seen: true});
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: true, loginChecking: false, canBack: false, canForward: false});
  await flush();
  await t.click(t.$('[data-fv-item="0"]'));
  await flush();
  assert.ok(t.opens.some((o) => o.url === 'https://www.douyin.com/video/1' && o.detail));
  assert.equal(t.$('#fvEmbed').hidden, false);
  assert.equal(t.$('[data-fv-back-list]').hidden, false);
  assert.equal(t.$('#fvResults').hidden, true);
  await t.click(t.$('[data-fv-back-list]'));
  assert.equal(t.$('#fvResults').hidden, false);
  assert.equal(t.$('#fvEmbed').hidden, true);
  assert.equal(t.$('[data-fv-back-list]').hidden, true);
});

test('点同款会走到导入路径', async () => {
  const t = await setup({desktop: true, seen: true});
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: true, loginChecking: false, canBack: false, canForward: false});
  await flush();
  await t.click(t.$('[data-fv-same="0"]'));
  await flush();
  assert.equal(t.captures.length, 1);
  assert.equal(t.captures[0].url, 'https://www.douyin.com/video/1');
  assert.equal(t.opens.filter((o) => o.url === 'https://www.douyin.com/video/1').length, 0, '点同款不应只去打开详情');
});

test('未登录点分类后登录成功，自动按原分类搜索', async () => {
  const t = await setup({desktop: true, seen: true});
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: false, loginChecking: false, canBack: false, canForward: false});
  await t.click(t.$('[data-fv-cat-item="宠物服务"]'));
  assert.equal(t.searches.length, 0);
  t.browse._onLoggedIn({platform: 'douyin', text: '已登录抖音，下面是你的内容'});
  await flush();
  assert.ok(t.searches.length >= 1);
  assert.match(t.searches.at(-1).keyword, /宠物服务/);
});

test('关键词搜索与分类搜索互斥，列表区显示当前条件', async () => {
  const t = await setup({desktop: true, seen: true});
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: true, loginChecking: false, canBack: false, canForward: false});
  await flush();
  t.$('#fvKeyword').value = '烤鱼店';
  await t.submit(t.$('[data-fv-form]'));
  await flush();
  assert.match(t.searches.at(-1).keyword, /烤鱼店/);
  assert.match(t.$('#fvResults').textContent, /当前按关键词「烤鱼店」搜索/);
  await t.click(t.$('[data-fv-cat-item="门店零售"]'));
  await flush();
  assert.match(t.searches.at(-1).keyword, /门店零售/);
  assert.match(t.$('#fvResults').textContent, /当前按「本地生活 \/ 门店零售」搜索/);
});

test('搜索失败时给出原因和重试', async () => {
  const t = await setup({desktop: true, seen: true});
  t.browse.search = (opts) => {
    t.searches.push({...opts});
    return Promise.resolve({ok: false, error: '这一页没读到搜索结果。可以重试。', items: []});
  };
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: true, loginChecking: false, canBack: false, canForward: false});
  await flush();
  assert.equal(t.$('#fvListError').hidden, false);
  assert.match(t.$('#fvListError').textContent, /没读到搜索结果|请重试|可以重试/);
  const fullErr = String(t.$('#fvListErrorCopy').textContent || '').trim();
  assert.ok(fullErr);
  const body = String((t.document && t.document.body && t.document.body.textContent) || t.$('body').textContent || '');
  assert.equal(body.split(fullErr).length - 1, 1, '同一句失败文案不得出现两遍');
  assert.ok(!String(t.$('#fvStatus').textContent).includes(fullErr), '状态栏不要再重复完整失败文案');
  assert.ok(t.$('[data-fv-retry]'));
  const before = t.searches.length;
  await t.click(t.$('[data-fv-retry]'));
  await flush();
  assert.ok(t.searches.length > before, '点重试应再搜一次');
});

test('B站不走分类列表', async () => {
  const t = await setup({desktop: true, seen: true});
  await t.click(t.$('[data-fv-platform="bilibili"]'));
  assert.equal(t.$('#fvCats').hidden, true);
  assert.equal(t.$('#fvBiliNote').hidden, false);
  assert.ok(t.opens.some((o) => o.platform === 'bilibili'));
});

function listItems(n) {
  return Array.from({length: n}, (_, i) => ({
    id: String(i + 1),
    url: `https://www.douyin.com/video/${i + 1}`,
    title: `条目${i + 1}`,
    cover: `https://example.com/c${i + 1}.jpg`,
  }));
}
async function loginWithItems(t, n) {
  t.browse.search = (opts) => {
    t.searches.push({...opts});
    return Promise.resolve({ok: true, items: listItems(n), note: '目前只展示这一批', platform: opts.platform, keyword: opts.keyword});
  };
  t.browse._onState({url: 'https://www.douyin.com/', loggedIn: true, loginChecking: false, canBack: false, canForward: false});
  await flush();
}

test('默认列表区高度下一页放不下 16 条时出现分页，翻页不重新搜索', async () => {
  const t = await setup({desktop: true, seen: true});
  await loginWithItems(t, 16);
  const layout = t.run('fvComputeListPage(976, 420, 16, true)');
  assert.equal(layout.pageSize, 2);
  assert.equal(layout.pageCount, 8);
  assert.equal(layout.showPager, true);
  assert.ok(layout.coverH > 0);
  assert.ok(layout.coverH < 616, '封面应缩短以便完整放下一行，而不是继续用 3:4 裁切');
  assert.equal(t.document.querySelectorAll('.fv-card').length, 2);
  assert.match(t.$('#fvResults').textContent, /条目1/);
  assert.match(t.$('#fvResults').textContent, /条目2/);
  assert.doesNotMatch(t.$('#fvResults').textContent, /条目3/);
  assert.ok(t.$('.fv-pager'));
  assert.match(t.$('.fv-page-status').textContent, /第 1 \/ 8 页/);
  assert.equal(t.$('[data-fv-page-prev]').disabled, true);
  assert.equal(t.$('[data-fv-page-next]').disabled, false);
  assert.match(t.$('#fvStatus').textContent, /找到 16 条/);
  assert.equal(t.$('.fv-card h3') && t.$('.fv-card h3').textContent, '条目1');
  assert.equal(t.$('[data-fv-same]').textContent, '同款');
  assert.match(t.$('.fv-grid').getAttribute('style') || '', /--fv-cover-height/);
  const before = t.searches.length;
  await t.click(t.$('[data-fv-page-next]'));
  await flush();
  assert.equal(t.searches.length, before, '翻页不应重新搜索');
  assert.match(t.$('#fvStatus').textContent, /找到 16 条/);
  assert.match(t.$('.fv-page-status').textContent, /第 2 \/ 8 页/);
  assert.match(t.$('#fvResults').textContent, /条目3/);
  assert.match(t.$('#fvResults').textContent, /条目4/);
  assert.doesNotMatch(t.$('#fvResults').textContent, /条目1/);
  assert.equal(t.$('[data-fv-page-prev]').disabled, false);
  await t.click(t.$('[data-fv-page-prev]'));
  await flush();
  assert.match(t.$('.fv-page-status').textContent, /第 1 \/ 8 页/);
  assert.match(t.$('#fvResults').textContent, /条目1/);
  assert.equal(t.searches.length, before);
});

test('全部条目一页能放下时隐藏分页', async () => {
  const t = await setup({desktop: true, seen: true});
  await loginWithItems(t, 2);
  assert.equal(t.document.querySelectorAll('.fv-card').length, 2);
  assert.equal(t.$('.fv-pager'), null);
  assert.doesNotMatch(t.$('#fvResults').textContent, /上一页|下一页|第 1 \/ 1 页/);
  assert.match(t.$('#fvStatus').textContent, /找到 2 条/);
});

test('窗口变高后每页条数增多，尽量保住变化前该页第一张；全部放下时分页消失', async () => {
  const t = await setup({desktop: true, seen: true});
  await loginWithItems(t, 16);
  await t.click(t.$('[data-fv-page-next]'));
  await t.click(t.$('[data-fv-page-next]'));
  await flush();
  assert.match(t.$('.fv-page-status').textContent, /第 3 \/ 8 页/);
  assert.equal(t.$('[data-fv-item="4"]') && t.$('[data-fv-item="4"]').textContent.includes('条目5'), true);
  t.run('window.__fvListWrapRect = { width: 400, height: 900 }');
  t.run('relayoutFvResults()');
  const mid = t.run('fvComputeListPage(400, 900, 16, true)');
  assert.equal(mid.pageSize, 4);
  assert.equal(mid.showPager, true);
  assert.ok(t.$('[data-fv-item="4"]'), '应保住变化前该页第一张');
  assert.match(t.$('#fvResults').textContent, /条目5/);
  assert.match(t.$('.fv-page-status').textContent, /第 2 \/ 4 页/);
  t.run('window.__fvListWrapRect = { width: 400, height: 3200 }');
  t.run('relayoutFvResults()');
  assert.equal(t.$('.fv-pager'), null);
  assert.equal(t.document.querySelectorAll('.fv-card').length, 16);
  assert.ok(t.$('[data-fv-item="4"]'));
  t.run('window.__fvListWrapRect = null');
});

test('从第二页进详情再返回，停留在原页原条', async () => {
  const t = await setup({desktop: true, seen: true});
  await loginWithItems(t, 16);
  await t.click(t.$('[data-fv-page-next]'));
  await flush();
  assert.match(t.$('.fv-page-status').textContent, /第 2 \/ 8 页/);
  await t.click(t.$('[data-fv-item="2"]'));
  await flush();
  assert.equal(t.$('#fvResults').hidden, true);
  assert.ok(t.opens.some((o) => o.url === 'https://www.douyin.com/video/3' && o.detail));
  await t.click(t.$('[data-fv-back-list]'));
  await flush();
  assert.equal(t.$('#fvResults').hidden, false);
  assert.match(t.$('.fv-page-status').textContent, /第 2 \/ 8 页/);
  assert.ok(t.$('[data-fv-item="2"]'));
  assert.match(t.$('#fvResults').textContent, /条目3/);
});

test('换分类重新搜索后从第 1 页展示', async () => {
  const t = await setup({desktop: true, seen: true});
  await loginWithItems(t, 16);
  await t.click(t.$('[data-fv-page-next]'));
  await flush();
  assert.match(t.$('.fv-page-status').textContent, /第 2 \/ 8 页/);
  await t.click(t.$('[data-fv-cat-group="美业健康"]'));
  await t.click(t.$('[data-fv-cat-item="美发美甲"]'));
  await flush();
  assert.match(t.$('.fv-page-status').textContent, /第 1 \/ 8 页/);
  assert.match(t.$('#fvResults').textContent, /条目1/);
  assert.match(t.$('#fvResults').textContent, /当前按「美业健康 \/ 美发美甲」搜索/);
});


async function setupHome({width, height, projects, hint = false, items = 16} = {}) {
  const t = await setup({desktop: true, seen: true, ids: projects ? ['p1', 'p2'] : []});
  layoutState.mode = 'home';
  layoutState.width = width;
  layoutState.height = height;
  layoutState.naturalDock = projects ? layoutState.dockTwoProjects : layoutState.dockNoProjects;
  layoutState.document = t.document;
  if (!hint) t.storage.set('vrc.fvCaptureHintDismissed', '1');
  t.run(`window.innerWidth = ${width}; window.innerHeight = ${height};`);
  t.run('syncDesktopHomeShell()');
  await loginWithItems(t, items);
  t.run('fillDesktopEmbedHeight()');
  return t;
}
function assertCompleteCards(t, label) {
  const grid = t.$('.fv-grid');
  const results = t.$('#fvResults');
  const cards = [...t.document.querySelectorAll('.fv-card')];
  assert.ok(grid && results, label + ': 应渲染列表');
  assert.ok(cards.length >= 2, label + ': 至少完整 1 行 / 2 张卡，实际 ' + cards.length);
  const coverStyle = (grid.getAttribute('style') || '');
  const coverVar = /--fv-cover-height:\s*([\d.]+)px/.exec(coverStyle);
  assert.ok(coverVar && Number(coverVar[1]) > 0, label + ': 封面高度变量应大于 0，实际 ' + coverStyle);
  assert.ok(Number(coverVar[1]) >= 64, label + ': 封面不得再是 0 或 1px，实际 ' + coverVar[1]);
  const gridBox = grid.getBoundingClientRect();
  const resultsBox = results.getBoundingClientRect();
  const clipTop = Math.max(gridBox.top, resultsBox.top);
  const clipBottom = Math.min(gridBox.bottom, resultsBox.bottom);
  for (const card of cards) {
    const cover = card.querySelector('.fv-cover');
    const title = card.querySelector('h3');
    const btn = card.querySelector('.fv-same');
    assert.ok(cover && cover.getBoundingClientRect().height > 0, label + ': 封面可见');
    assert.ok(title && String(title.textContent || '').trim(), label + ': 标题可见');
    assert.ok(btn && String(btn.textContent || '').includes('同款'), label + ': 「同款」可见');
    for (const el of [cover, title, btn]) {
      const r = el.getBoundingClientRect();
      assert.ok(r.height > 0, label + ' 元素高度应大于 0');
      assert.ok(r.top >= clipTop - 1, `${label}: 元素顶部被裁切 ${r.top} < ${clipTop}`);
      assert.ok(r.bottom <= clipBottom + 1, `${label}: 元素底部被裁切 ${r.bottom} > ${clipBottom}`);
    }
  }
  const dock = t.document.querySelector('.home-dock');
  const dockBox = dock.getBoundingClientRect();
  assert.ok(dock && dockBox.height > 0, label + ': 码头仍在窗口内');
  assert.ok(dockBox.top < layoutState.height, label + ': 码头顶部应在窗口内');
  assert.ok(dockBox.bottom <= layoutState.height + 1, label + ': 码头不应被顶出窗口');
  assert.match(dock.textContent, /自己放一条视频进来/);
  assert.match(dock.textContent, /最近的项目|还没有项目/);
  const wrap = t.$('#fvListWrap').getBoundingClientRect();
  const coverBox = t.$('.fv-cover').getBoundingClientRect();
  const page = t.$('.fv-page-status');
  console.log(`  layout ${label}: list ${Math.round(wrap.width)}×${Math.round(wrap.height)} top=${Math.round(wrap.top)}, cover=${Math.round(coverBox.height)}px, dock=${Math.round(dockBox.height)}px, ${page ? page.textContent.trim() : '无分页'}`);
  assert.ok(!t.$('#fvResults').querySelector('.fv-grid') || (t.$('.fv-grid').getBoundingClientRect().height >= t.$('.fv-card').getBoundingClientRect().height), label + ': 网格不应裁切卡片');
}

for (const [width, height] of [[1280, 800], [1440, 900]]) {
  for (const projects of [true, false]) {
    const title = `${width}×${height} ${projects ? '有最近项目' : '无最近项目'} 时卡片完整露出`;
    test(title, async () => {
      const t = await setupHome({width, height, projects, hint: false, items: 16});
      assertCompleteCards(t, title);
      assert.match(t.$('#fvStatus').textContent, /找到 16 条/);
      assert.ok(t.$('.fv-pager'), title + ': 16 条在常见窗口应分页');
      const before = t.searches.length;
      if (t.$('[data-fv-page-next]') && !t.$('[data-fv-page-next]').disabled) {
        await t.click(t.$('[data-fv-page-next]'));
        await flush();
        assert.equal(t.searches.length, before, '翻页不应重新搜索');
        assert.match(t.$('#fvStatus').textContent, /找到 16 条/);
      }
      const dock = t.document.querySelector('.home-dock');
      assert.ok(dock.getBoundingClientRect().height >= 56, title + ': 码头让位后仍保留最小高度');
    });
  }
}

test('登录轻提示出现或关闭后立刻重算列表高度，卡片仍完整', async () => {
  const t = await setupHome({width: 1280, height: 800, projects: true, hint: false, items: 16});
  assertCompleteCards(t, '提示关闭前');
  const wrap1 = t.$('#fvListWrap').getBoundingClientRect();
  const dock1 = t.document.querySelector('.home-dock').getBoundingClientRect().height;
  t.storage.delete('vrc.fvCaptureHintDismissed');
  t.run('syncCaptureHint(true)');
  assert.equal(t.$('#fvCaptureHint').hidden, false);
  const wrap2 = t.$('#fvListWrap').getBoundingClientRect();
  const dock2 = t.document.querySelector('.home-dock').getBoundingClientRect().height;
  assert.ok(wrap2.top > wrap1.top + 20, `提示出现后列表起点应下移（${wrap1.top} -> ${wrap2.top}）`);
  assert.ok(dock2 < dock1 - 1 || wrap2.height < wrap1.height - 1, `提示出现后应立刻重算：码头或列表高度变化（list ${wrap1.height}->${wrap2.height}, dock ${dock1}->${dock2}）`);
  assertCompleteCards(t, '提示出现后');
  await t.click(t.$('[data-fv-hint-close]'));
  await flush();
  assert.equal(t.$('#fvCaptureHint').hidden, true);
  const wrap3 = t.$('#fvListWrap').getBoundingClientRect();
  assert.ok(Math.abs(wrap3.top - wrap1.top) <= 2, `关闭提示后列表起点应恢复（${wrap3.top} vs ${wrap1.top}）`);
  assert.ok(Math.abs(wrap3.height - wrap1.height) <= 2, `关闭提示后列表高度应恢复（${wrap3.height} vs ${wrap1.height}）`);
  assertCompleteCards(t, '提示再次关闭后');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  assert.equal(failed, 0, `${failed} home-list scenarios failed`);
  console.log(`Home list UI: ${tests.length} scenarios passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
