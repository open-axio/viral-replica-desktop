/* flow.js 的阶段判定：免费在前、Key 墙在 ③ 之前、未解锁的阶段点不动。纯逻辑，不起浏览器。 */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function load(project, status, rows) {
  const ctx = {
    P: project, STATUS: status, projectList: [], console,
    workflowState: () => rows || [{ done: false }, { done: false }, { done: false }, { done: false }, { done: false }],
    document: { addEventListener() {} }, window: { scrollTo() {} },
    $: () => null, $$: () => [], esc: (v) => String(v ?? ''), fmt: (n, d = 2) => Number(n).toFixed(d), updateHtml() {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/flow.js'), 'utf8'), ctx);
  ctx.renderFlow = () => {};
  return ctx;
}

// 没视频：只能在 ①，后面全锁
let c = load({ id: 'p' }, {});
assert.equal(c.autoStage(), 'upload');
assert.equal(c.stageLocked('free'), true);
assert.equal(c.stageLocked('content'), true);

// 有视频、没拆：停在 ②
c = load({ id: 'p', source: { file: 'source/source.mp4' }, analysis: {} }, {});
assert.equal(c.autoStage(), 'free');
assert.equal(c.stageLocked('content'), true, '免费拆解没做完，③ 锁住');

// 免费拆解完成：仍停在 ② 看结果，③ 解锁；没 Key 也一样
const free = { id: 'p', source: { file: 'x' }, analysis: { status: 'free_done', free_finished: 2, started: 1, steps: { boundaries: { status: 'done' } } } };
c = load(free, {});
assert.equal(c.freeDone(), true);
assert.equal(c.autoStage(), 'free', '跑完免费拆解先看结果，不自动跳去要 Key 的那一步');
assert.equal(c.stageLocked('content'), false);
assert.equal(c.hasAnyKey(), false);
c.setStage('content');
assert.equal(c.currentStage(), 'content');
c.setStage('replicate');
assert.equal(c.currentStage(), 'content', '未解锁的阶段点不动');

// 免费拆解进行中：不算完成
c = load({ id: 'p', source: { file: 'x' }, analysis: { status: 'running', steps: {} } }, {});
assert.equal(c.freeRunning(), true);
assert.equal(c.freeDone(), false);

// 旧项目（加入免费模式之前拆完的）：按 03 完成也算免费部分完成
c = load({ id: 'p', source: { file: 'x' }, breakdown: {}, analysis: { status: 'done', steps: { boundaries: { status: 'done' } } } }, { jimmy: true },
  [{ done: true }, { done: false }, { done: false }, { done: false }, { done: false }]);
assert.equal(c.freeDone(), true);
assert.equal(c.autoStage(), 'content', '内容拆解已经开始过，就回到 ③');
assert.equal(c.hasAnyKey(), true);

// Key：任意渠道就绪都算
assert.equal(load(free, { providers: { openai: { ready: true } } }).hasAnyKey(), true);

console.log('PASS flow stages: free first, key gate before content, locked stages stay locked');
