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
  if (id === 'fvEmbed') return { left: 24, top: 280, right: 1000, bottom: 700, width: 976, height: 420 };
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
    onState(cb) { this._onState = cb; },
    onImported() {},
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
        return response([...projects.values()].map((p) => ({id: p.id, name: p.name, created_at: p.created_at})));
      }
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
  return {run, $, document, storage, click, submit, opens, layouts, acts, windowOpens, hidden: () => hidden, browse: browseMock};
}

const tests = [], test = (name, fn) => tests.push([name, fn]);

test('桌面版首页出现内嵌区和工具栏，自动打开当前平台首页，不调 window.open', async () => {
  const t = await setup({desktop: true, seen: true});
  assert.ok(t.$('#fvEmbed'), '应有嵌入占位');
  assert.match(t.$('[data-fv-capture]').textContent, /同款复刻/);
  assert.ok(t.$('[data-fv-back]'));
  assert.ok(t.$('[data-fv-forward]'));
  assert.ok(t.$('[data-fv-reload]'));
  assert.match(t.$('.fv .hint').textContent, /不会新开窗口/);
  assert.equal(t.opens.length, 1);
  assert.equal(t.opens[0].platform, 'douyin');
  assert.equal(t.opens[0].keyword, undefined);
  assert.equal(t.$('#fvEmbed').getAttribute('data-fv-url'), 'https://www.douyin.com/');
  assert.equal(t.windowOpens.length, 0);
  assert.ok(t.layouts.length >= 1);
  await t.run('renderHome()');
  await Promise.resolve();
  assert.equal(t.opens.length, 1, '重新渲染首页不应再加载一次');
});

test('桌面版搜索把当前区域换成平台搜索页，不新开窗口', async () => {
  const t = await setup({desktop: true, seen: true});
  t.$('#fvKeyword').value = '烤鱼';
  await t.submit(t.$('[data-fv-form]'));
  assert.equal(t.windowOpens.length, 0);
  const last = t.opens.at(-1);
  assert.equal(last.platform, 'douyin');
  assert.equal(last.keyword, '烤鱼');
  assert.equal(t.$('#fvEmbed').getAttribute('data-fv-url'), SEARCH.douyin('烤鱼'));
});

test('桌面版切 Tab 更新当前区域：有关键词就搜，没有就打开平台首页', async () => {
  const t = await setup({desktop: true, seen: true});
  await t.click(t.$('[data-fv-platform="xiaohongshu"]'));
  let last = t.opens.at(-1);
  assert.equal(last.platform, 'xiaohongshu');
  assert.equal(last.keyword, undefined);
  assert.equal(t.$('#fvEmbed').getAttribute('data-fv-url'), HOME.xiaohongshu);
  assert.equal(t.windowOpens.length, 0);
  t.$('#fvKeyword').value = '美甲';
  await t.click(t.$('[data-fv-platform="bilibili"]'));
  last = t.opens.at(-1);
  assert.equal(last.platform, 'bilibili');
  assert.equal(last.keyword, '美甲');
  assert.equal(t.$('#fvEmbed').getAttribute('data-fv-url'), SEARCH.bilibili('美甲'));
  assert.equal(t.windowOpens.length, 0);
});

test('桌面版点行业词在当前区域搜索，不新开窗口', async () => {
  const t = await setup({desktop: true, seen: true});
  await t.click(t.$('[data-fv-word="火锅"]'));
  const last = t.opens.at(-1);
  assert.equal(last.platform, 'douyin');
  assert.equal(last.keyword, '火锅');
  assert.equal(t.$('#fvEmbed').getAttribute('data-fv-url'), SEARCH.douyin('火锅'));
  assert.equal(t.windowOpens.length, 0);
});

test('介绍弹层打开时会把原生视图藏起来，关掉后再布局', async () => {
  const t = await setup({desktop: true, seen: true});
  const hiddenAtStart = t.hidden();
  await t.click(t.$('#aboutBtn'));
  assert.ok(t.hidden() > hiddenAtStart, '打开介绍应 hide 嵌入视图');
  await t.click(t.$('#aboutCloseBtn'));
  assert.ok(t.layouts.length >= 2, '关闭介绍后应重新 layout');
  assert.equal(t.$('#fvEmbed').getAttribute('data-fv-url'), 'https://www.douyin.com/');
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

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  assert.equal(failed, 0, `${failed} home-embed scenarios failed`);
  console.log(`Home embed UI: ${tests.length} scenarios passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
