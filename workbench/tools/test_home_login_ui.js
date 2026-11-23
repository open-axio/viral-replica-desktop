/* T3 登录空态：未登录只出示说明和「去登录」，不自动弹窗；已登录才露出嵌入区。离线 DOM。 */
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

async function setup({desktop = true, seen = true} = {}) {
  const document = createDocument(), events = {}, storage = new Map();
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
  const opens = [], layouts = [], windowOpens = [];
  let hidden = 0, startLogin = 0;
  const browseMock = desktop ? {
    available: true,
    open(opts) {
      opens.push({...opts});
      const url = opts.url || (opts.keyword
        ? `https://www.douyin.com/search/${encodeURIComponent(opts.keyword)}?type=video`
        : 'https://www.douyin.com/');
      return Promise.resolve({ok: true, url, newWindow: false, partition: 'persist:find-viral', loginChecking: true});
    },
    layout(b) { layouts.push(b); return Promise.resolve(true); },
    hide() { hidden += 1; return Promise.resolve(true); },
    act() { return Promise.resolve(true); },
    startLogin() { startLogin += 1; },
    onState(cb) { this._onState = cb; },
    onImported() {},
  } : undefined;
  const windowObj = {
    scrollTo() {}, addEventListener() {}, innerWidth: 1280, innerHeight: 800,
    __browse: browseMock, open(...args) { windowOpens.push(args); }, localStorage: null,
  };
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  windowObj.localStorage = localStorage;
  const context = vm.createContext({
    document, console, structuredClone, window: windowObj, localStorage,
    setTimeout() { return 1; }, clearTimeout() {},
    fetch: async (url, options = {}) => {
      const route = String(url).replace(/^\/api\//, ''), method = options.method || 'GET';
      if (method === 'GET' && route === 'status') return response({providers: {}, default_llm: '', runtime: {}, ffmpeg: true, asr: true});
      if (method === 'GET' && route === 'projects') return response([]);
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
  run(appSrc.slice(0, bootAt));
  run(flowSrc);
  await run('boot()');
  await Promise.resolve();
  await Promise.resolve();
  const click = async (el) => {
    for (const fn of events.click || []) await fn({target: el, preventDefault() {}, stopPropagation() {}});
    await Promise.resolve();
  };
  const emitState = (s) => { if (browseMock && browseMock._onState) browseMock._onState(s); };
  return {run, $, document, click, opens, layouts, windowOpens, hidden: () => hidden, startLogin: () => startLogin, emitState, browse: browseMock};
}

const tests = [], test = (name, fn) => tests.push([name, fn]);

test('桌面版刚打开先确认登录态，不出现「去登录」，也不自动弹窗', async () => {
  const t = await setup();
  assert.equal(t.$('#fvLoginEmpty').hidden, false);
  assert.match(t.$('#fvLoginCopy').textContent, /正在确认登录状态/);
  assert.equal(t.$('#fvLoginBtn').hidden, true);
  assert.equal(t.windowOpens.length, 0);
  assert.equal(t.startLogin(), 0);
});

test('判定为未登录时只出空态和「去登录」，并把嵌入视图藏起来', async () => {
  const t = await setup();
  const hiddenBefore = t.hidden();
  t.emitState({url: 'https://www.douyin.com/', loggedIn: false, loginChecking: false, loginReason: 'header-login', canBack: false, canForward: false});
  assert.equal(t.$('#fvLoginEmpty').hidden, false);
  assert.match(t.$('#fvLoginCopy').textContent, /登录后能直接刷到你平时看的内容，不用再复制链接/);
  assert.equal(t.$('#fvLoginBtn').hidden, false);
  assert.equal(t.$('#fvLoginBtn').textContent, '去登录');
  assert.ok(t.hidden() > hiddenBefore, '未登录应 hide 原生视图，避免露出平台登录页');
  assert.equal(t.startLogin(), 0, '判定未登录时不得自动去登录');
  assert.equal(t.windowOpens.length, 0);
});

test('点「去登录」在尚未接上登录窗时不会自己开窗口', async () => {
  const t = await setup();
  t.emitState({url: 'https://www.douyin.com/', loggedIn: false, loginChecking: false, canBack: false, canForward: false});
  delete t.browse.startLogin;
  await t.click(t.$('#fvLoginBtn'));
  assert.equal(t.windowOpens.length, 0);
  assert.equal(t.opens.filter((o) => o && o.login).length, 0);
});

test('已登录时收起空态，露出嵌入区', async () => {
  const t = await setup();
  t.emitState({url: 'https://www.douyin.com/', loggedIn: false, loginChecking: false, canBack: false, canForward: false});
  t.emitState({url: 'https://www.douyin.com/', loggedIn: true, loginChecking: false, loginReason: 'user-self', canBack: false, canForward: false});
  assert.equal(t.$('#fvLoginEmpty').hidden, true);
  assert.equal(t.$('#fvEmbed').getAttribute('data-fv-url'), 'https://www.douyin.com/');
  assert.equal(t.$('#fvLoginBtn').hidden, true);
  assert.ok(t.layouts.length >= 1);
});

test('判定不准（checking 结束但仍未确认）也当成未登录', async () => {
  const t = await setup();
  t.emitState({url: 'https://www.bilibili.com/', loggedIn: false, loginChecking: false, loginReason: 'uncertain', canBack: false, canForward: false});
  assert.equal(t.$('#fvLoginEmpty').hidden, false);
  assert.equal(t.$('#fvLoginBtn').hidden, false);
});

test('浏览器打开工作台没有去登录空态，也不承诺内嵌登录', async () => {
  const t = await setup({desktop: false});
  assert.equal(t.$('#fvLoginEmpty'), null);
  assert.equal(t.$('#fvLoginBtn'), null);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  assert.equal(failed, 0, `${failed} home-login scenarios failed`);
  console.log(`Home login UI: ${tests.length} scenarios passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
