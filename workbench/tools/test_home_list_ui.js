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

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  assert.equal(failed, 0, `${failed} home-list scenarios failed`);
  console.log(`Home list UI: ${tests.length} scenarios passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
