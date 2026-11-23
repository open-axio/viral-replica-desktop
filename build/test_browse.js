// node build/test_browse.js —— 「找爆款」窗口里不依赖 Electron 的部分：认平台、取分享链接、选视频地址
const assert = require('assert');
const Module = require('module');
const realLoad = Module._load;

let windowsCreated = 0;
let lastPartition = '';
const childViews = [];
let currentUrl = '';
const loadedUrls = [];
const boundsHistory = [];
let viewVisible = true;
let inspectSignals = { headerLogin: true };

function makeWebContents() {
  return {
    id: 1,
    isDestroyed: () => false,
    send() {},
    getURL: () => currentUrl,
    isLoading: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack() {},
      goForward() {},
    },
    loadURL(url) { currentUrl = url; loadedUrls.push(url); },
    reload() {},
    setWindowOpenHandler() {},
    on() {},
    executeJavaScript: async () => ({ ...inspectSignals, href: currentUrl }),
  };
}

const viewInstance = {
  webContents: makeWebContents(),
  setVisible(v) { viewVisible = !!v; },
  setBounds(b) { boundsHistory.push({ ...b }); this._bounds = { ...b }; },
};

const mainWebContents = { send() {}, isDestroyed: () => false };
const contentView = {
  addChildView(v) { if (!childViews.includes(v)) childViews.push(v); },
  getChildViews() { return childViews.slice(); },
  removeChildView(v) { const i = childViews.indexOf(v); if (i >= 0) childViews.splice(i, 1); },
};
const mainWindow = {
  isDestroyed: () => false,
  webContents: mainWebContents,
  contentView,
};
const siteSes = {
  setUserAgent() {},
  webRequest: { onBeforeSendHeaders() {}, onCompleted() {} },
};

Module._load = function (request, ...rest) {
  if (request === 'electron') return {
    app: { userAgentFallback: 'Mozilla/5.0 Electron/32.3.3 Safari/537.36' },
    ipcMain: { handle() {} },
    session: { fromPartition(name) { lastPartition = name; return siteSes; } },
    BrowserWindow: function BrowserWindow() { windowsCreated += 1; },
    WebContentsView: function WebContentsView() { return viewInstance; },
  };
  return realLoad.call(this, request, ...rest);
};
const browse = require('./browse');

assert.strictEqual(browse.platformOf('https://www.douyin.com/video/7'), 'douyin');
assert.strictEqual(browse.platformOf('https://v.douyin.com/abc/'), 'douyin');
assert.strictEqual(browse.platformOf('http://xhslink.com/a/xyz'), 'xiaohongshu');
assert.strictEqual(browse.platformOf('https://www.xiaohongshu.com/explore/66aa'), 'xiaohongshu');
assert.strictEqual(browse.platformOf('https://b23.tv/x1'), 'bilibili');
assert.strictEqual(browse.platformOf('https://evil-douyin.com.example.org/'), 'other');
assert.strictEqual(browse.platformOf('not a url'), 'other');

assert.strictEqual(browse.urlFromShareText('3.89 复制打开抖音，看看【老王烤鱼的作品】长沙烤鱼天花板 https://v.douyin.com/iAbCdEf/ 07/12 a@B.xY'), 'https://v.douyin.com/iAbCdEf/');
assert.strictEqual(browse.urlFromShareText('【秋冬显白猫眼】http://xhslink.com/a/Q1w2E3，复制本条信息'), 'http://xhslink.com/a/Q1w2E3');
assert.strictEqual(browse.urlFromShareText('没有链接'), '');

// B 站：页面正在播的那一路排第一；音频没播过时从低码率往高试
const cid = '435';
const u = (n, host = 'a.bilivideo.com') => `https://${host}/upgcxcode/1/2/${cid}/${cid}-1-${n}.m4s?e=x`;
const info = { extra: { cid, dash: {
  video: [{ url: u(30080), id: 80, codecid: 7, height: 1080 }, { url: u(30032), id: 32, codecid: 7, height: 480 }, { url: u(30120), id: 120, codecid: 7, height: 2160 }, { url: u(30077), id: 80, codecid: 12, height: 1080 }],
  audio: [{ url: u(30280), id: 30280 }, { url: u(30216), id: 30216 }, { url: u(30232), id: 30232 }],
} } };
browse.mediaSeen.set(1, [{ url: u(30032), type: 'video/mp4' }]);
let m = browse.chooseMedia('bilibili', info, 1);
assert.strictEqual(m.videos[0], u(30032), '页面在播 480p 就先用它');
assert.ok(!m.videos.includes(u(30120)), '超过 1080p 的不要');
assert.deepStrictEqual(m.audios.slice(0, 3), [u(30216), u(30232), u(30280)]);
browse.mediaSeen.set(2, []);
m = browse.chooseMedia('bilibili', info, 2);
assert.strictEqual(m.videos[0], u(30080), '没播过时 1080p H.264 优先');
// 别的视频的分片不能混进来
m = browse.chooseMedia('bilibili', { extra: { cid: '999', dash: info.extra.dash } }, 2);
assert.strictEqual(m, null);

// 抖音 / 小红书：页面 <video> 的真实地址优先，其次网络里看到的视频
browse.mediaSeen.set(3, [{ url: 'https://v26-web.douyinvod.com/abc/?a=1', type: 'video/mp4' }, { url: 'https://www.douyin.com/aweme/v1/web/log', type: 'application/json' }]);
m = browse.chooseMedia('douyin', { sources: [] }, 3);
assert.deepStrictEqual(m, { videos: ['https://v26-web.douyinvod.com/abc/?a=1'], audios: [] });
m = browse.chooseMedia('xiaohongshu', { sources: ['https://sns-video-bd.xhscdn.com/x.mp4'] }, 3);
assert.strictEqual(m.videos[0], 'https://sns-video-bd.xhscdn.com/x.mp4');
assert.strictEqual(browse.chooseMedia('douyin', { sources: [] }, 99), null);

// T2：open() 把平台页挂到主窗口，不新建 BrowserWindow，搜索 URL 走对应平台
const noHost = browse.open({ platform: 'douyin', keyword: '烤鱼' });
assert.strictEqual(noHost.ok, false, '主窗口未就绪时应拒绝打开');
assert.strictEqual(noHost.newWindow, false);
assert.strictEqual(windowsCreated, 0, '没有主窗口时也不能新建浏览窗');

browse.init({ port: () => 8765, mainWindow: () => mainWindow });
const search = browse.open({ platform: 'douyin', keyword: '烤鱼' });
assert.strictEqual(search.ok, true);
assert.strictEqual(search.newWindow, false);
assert.strictEqual(search.partition, 'persist:find-viral');
assert.strictEqual(lastPartition, 'persist:find-viral');
assert.ok(search.url.includes('https://www.douyin.com/search/') && search.url.includes(encodeURIComponent('烤鱼')) && search.url.includes('type=video'), search.url);
assert.strictEqual(loadedUrls[0], search.url);
assert.strictEqual(windowsCreated, 0, '搜索不得新建 BrowserWindow');
assert.strictEqual(childViews.length, 1, '只往主窗口挂一个 WebContentsView');
assert.strictEqual(browse.debugInfo().windowsCreated, 0);
assert.strictEqual(browse.debugInfo().url, search.url);

const tab = browse.open({ platform: 'xiaohongshu' });
assert.strictEqual(tab.ok, true);
assert.strictEqual(tab.newWindow, false);
assert.strictEqual(tab.url, 'https://www.xiaohongshu.com/explore');
assert.strictEqual(windowsCreated, 0, '切 Tab 不得新建浏览窗');
assert.strictEqual(childViews.length, 1);
assert.strictEqual(loadedUrls[1], tab.url);

browse.layoutEmbed({ x: 20, y: 80, width: 900, height: 500 });
assert.strictEqual(viewVisible, false, '未确认已登录前不能露出平台页');
assert.deepStrictEqual(viewInstance._bounds, { x: 0, y: 0, width: 0, height: 0 });
assert.strictEqual(windowsCreated, 0);

(async () => {
  inspectSignals = { headerLogin: true };
  const loggedOut = await browse.refreshLoginState();
  assert.strictEqual(loggedOut.loggedIn, false);
  assert.strictEqual(viewVisible, false, '未登录要把内嵌页藏起来');
  assert.strictEqual(windowsCreated, 0, '未登录不得自动弹出登录窗');

  inspectSignals = { userSelfLink: true };
  currentUrl = 'https://www.douyin.com/';
  const loggedIn = await browse.refreshLoginState();
  assert.strictEqual(loggedIn.loggedIn, true);
  assert.strictEqual(loggedIn.platform, 'douyin');
  browse.layoutEmbed({ x: 20, y: 80, width: 900, height: 500 });
  assert.strictEqual(viewVisible, true);
  assert.deepStrictEqual(viewInstance._bounds, { x: 20, y: 80, width: 900, height: 500 });
  assert.strictEqual(windowsCreated, 0);

  inspectSignals = { headerLoginEntry: true };
  currentUrl = 'https://www.bilibili.com/';
  const biliOut = await browse.refreshLoginState();
  assert.strictEqual(biliOut.loggedIn, false);
  assert.strictEqual(biliOut.reason, 'header-login-entry');
  assert.strictEqual(viewVisible, false, 'B 站未登录不能把推荐流当成已登录内容');
  assert.strictEqual(windowsCreated, 0);

  browse.hideEmbed();
  assert.strictEqual(viewVisible, false);
  console.log('browse tests ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
