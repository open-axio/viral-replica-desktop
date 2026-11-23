/* T1 首页介绍入口：冷启动第一屏没有常驻 hero，顶栏「这是什么」可打开同一份介绍，自动弹出只出现一次。离线 DOM。 */
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

async function setup({ids = [], seen = false} = {}) {
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
  const windowObj = {
    scrollTo() {},
    addEventListener() {},
    __browse: undefined,
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
  const click = async (el) => {
    for (const fn of events.click || []) await fn({target: el, preventDefault() {}, stopPropagation() {}});
  };
  return {run, $, document, storage, projects, click, events};
}

function aboutOpen($) {
  const d = $('#aboutDialog');
  return !!(d && (d.open || d.hasAttribute('open')));
}

const tests = [], test = (name, fn) => tests.push([name, fn]);

test('冷启动无项目：第一屏没有常驻介绍，主舞台是找同行的爆款，介绍会自动弹出且可跳过', async () => {
  const t = await setup({ids: []});
  assert.equal(t.$('#emptyState').hidden, false);
  assert.equal(t.$('.home-hero'), null);
  assert.equal(t.$('#homeBody h1'), null);
  assert.match(t.$('#fvTitle').textContent, /找同行的爆款/);
  assert.equal(t.$('#aboutBtn').textContent, '这是什么');
  assert.equal(aboutOpen(t.$), true);
  assert.equal(t.$('#aboutSkipBtn').hidden, false);
  assert.match(t.$('#aboutTitle').textContent, /看懂一条爆款，再换成你的店、你的人/);
  assert.match(t.$('#aboutDialog').textContent, /先在这里看同行怎么拍/);
  assert.match(t.$('#aboutDialog').textContent, /视频只留在这台电脑上，不会上传到任何服务器/);
  assert.match(t.$('#aboutDialog').textContent, /放进对标视频/);
  assert.match(t.$('#aboutDialog').textContent, /免费拆解/);
  assert.match(t.$('#aboutDialog').textContent, /内容拆解/);
  assert.match(t.$('#aboutDialog').textContent, /复刻成片/);
  await t.click(t.$('#aboutSkipBtn'));
  assert.equal(aboutOpen(t.$), false);
  assert.equal(t.storage.get('vrc.aboutAutoSeen'), '1');
  assert.equal(t.$('#emptyState').hidden, false);
  assert.match(t.$('#fvTitle').textContent, /找同行的爆款/);
  assert.match(t.$('[data-flow-new]').textContent, /自己放一条视频进来/);
});

test('跳过后不再自动弹出；点「这是什么」仍打开同一份介绍', async () => {
  const t = await setup({ids: []});
  await t.click(t.$('#aboutSkipBtn'));
  assert.equal(aboutOpen(t.$), false);
  await t.run('renderHome()');
  assert.equal(aboutOpen(t.$), false);
  await t.click(t.$('#aboutBtn'));
  assert.equal(aboutOpen(t.$), true);
  assert.equal(t.$('#aboutSkipBtn').hidden, true);
  assert.match(t.$('#aboutTitle').textContent, /看懂一条爆款，再换成你的店、你的人/);
  await t.click(t.$('#aboutCloseBtn'));
  assert.equal(aboutOpen(t.$), false);
});

test('已有项目但未看过自动介绍时，冷启动仍弹出一次', async () => {
  const t = await setup({ids: ['A']});
  assert.equal(aboutOpen(t.$), true);
  assert.match(t.document.body.textContent, /最近的项目/);
});

test('已看过自动介绍时冷启动不再弹出', async () => {
  const t = await setup({ids: [], seen: true});
  assert.equal(aboutOpen(t.$), false);
  assert.match(t.$('#fvTitle').textContent, /找同行的爆款/);
});

test('清掉已看过标记后会再自动出现一次', async () => {
  const t = await setup({ids: [], seen: true});
  assert.equal(aboutOpen(t.$), false);
  t.storage.delete('vrc.aboutAutoSeen');
  await t.run('renderHome()');
  assert.equal(aboutOpen(t.$), true);
  await t.click(t.$('[data-about-close]'));
  assert.equal(aboutOpen(t.$), false);
  assert.equal(t.storage.get('vrc.aboutAutoSeen'), '1');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  assert.equal(failed, 0, `${failed} home-about scenarios failed`);
  console.log(`Home about UI: ${tests.length} scenarios passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
