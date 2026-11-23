// 「找爆款」内置浏览窗口
//
// 用户在这里用自己的账号正常浏览抖音 / 小红书 / B 站（平台要登录就扫码，登录状态保存在
// 独立的 persist:find-viral 分区，和工作台主窗口分开）。看到想做的视频，点顶栏「同款复刻」：
// 从当前页面读出配文、作者、数据、可见的评论，下载页面正在播放的那条视频，交给工作台
// 建一个新项目。
//
// 刻意不做的：不调平台的签名接口、不伪造身份、不在后台批量抓取。只读用户正在看的这一页。

const { BrowserWindow, WebContentsView, session, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { detectLogin, INSPECT } = require('./login-state');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const TOOLBAR_H = 56;
const MAX_BYTES = 1024 * 1024 * 1024;
const REFERER_MARK = 'x-viral-replica-referer';

const PLATFORMS = {
  douyin: {
    name: '抖音', home: 'https://www.douyin.com/',
    search: (kw) => `https://www.douyin.com/search/${encodeURIComponent(kw)}?type=video`,
    hosts: /(^|\.)(douyin\.com|iesdouyin\.com|douyinvod\.com)$/,
  },
  xiaohongshu: {
    name: '小红书', home: 'https://www.xiaohongshu.com/explore',
    search: (kw) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}&source=web_search_result_notes`,
    hosts: /(^|\.)(xiaohongshu\.com|xhslink\.com|xhscdn\.com|rednote\.com)$/,
  },
  bilibili: {
    name: 'B站', home: 'https://www.bilibili.com/',
    search: (kw) => `https://search.bilibili.com/video?keyword=${encodeURIComponent(kw)}`,
    hosts: /(^|\.)(bilibili\.com|b23\.tv|bilivideo\.com|bilivideo\.cn)$/,
  },
};

function platformOf(url) {
  try {
    const host = new URL(url).hostname;
    for (const [key, p] of Object.entries(PLATFORMS)) if (p.hosts.test(host)) return key;
  } catch (e) { /* noop */ }
  return 'other';
}

// 从分享文案里取链接：「3.89 复制打开抖音，看看【xx的作品】... https://v.douyin.com/abc/ xxx」
function urlFromShareText(text) {
  const m = String(text || '').match(/https?:\/\/[^\s，。,；;"'<>【】]+/);
  return m ? m[0] : '';
}

let ctx = { port: () => 8765, mainWindow: () => null };
let win = null;            // 旧的独立浏览窗；T2 起搜索/切 Tab 不再创建
let hostWindow = null;     // 承载内嵌视图的主窗口
let view = null;
let busy = false;
let lastKeyword = '';
let status = { kind: 'idle', text: '' };
let lastEmbedBounds = null;
let windowsCreated = 0;
let loginResult = { loggedIn: false, checking: true, reason: 'pending', platform: '' };
let loginCheckTimer = null;
let loginCheckGen = 0;
let loginWin = null;       // T4：只承担登录的小窗，和搜索窗不是同一个
let pendingAfterLogin = ''; // T6：未登录时先记下分享链接，登完再在内嵌区打开
let holdVisibleAfterLogin = false; // 登完打开分享页时先露出，避免只在隐藏视图里加载
let loginWatchTimer = null;
let loginWatchGen = 0;
const mediaSeen = new Map();   // webContents id -> [{ url, type, at }]

function init(options) { ctx = { ...ctx, ...options }; }

function chromeLikeUA() {
  // 默认 UA 带「Electron/xx」，部分网页会提示浏览器不支持；换成同版本 Chromium 的 UA
  return app.userAgentFallback.replace(/\s(Electron|viral-replica-desktop|ViralReplica)\/\S+/g, '');
}

function siteSession() {
  const ses = session.fromPartition('persist:find-viral');
  if (!ses.__findViralReady) {
    ses.__findViralReady = true;
    ses.setUserAgent(chromeLikeUA(), 'zh-CN,zh;q=0.9');
    // 下载视频时要带上「从哪个页面来」（Referer），和页面自己播放时一样，否则 CDN 返回 403。
    // Electron 不让 fetch 直接设 Referer，这里只把我们自己下载请求上的标记头换成 Referer，别的请求原样放行。
    ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (d, done) => {
      const h = d.requestHeaders;
      const key = Object.keys(h).find((k) => k.toLowerCase() === REFERER_MARK);
      if (key) {
        h.Referer = h[key];
        try { h.Origin = new URL(h[key]).origin; } catch (e) { /* noop */ }
        delete h[key];
      }
      done({ requestHeaders: h });
    });
    // 只记录「这一页自己播放的媒体地址」，用来找页面上正在放的那条视频
    ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (d) => {
      const type = String((d.responseHeaders && (d.responseHeaders['content-type'] || d.responseHeaders['Content-Type']) || [''])[0]).toLowerCase();
      const isMedia = /^(video|audio)\//.test(type) || /\.(mp4|m4s|m4a)(\?|$)/i.test(d.url);
      if (!isMedia || !d.webContentsId) return;
      const list = mediaSeen.get(d.webContentsId) || [];
      const url = d.url;
      const i = list.findIndex((x) => x.url === url);
      if (i >= 0) list.splice(i, 1);
      list.push({ url, type, at: Date.now() });
      while (list.length > 60) list.shift();
      mediaSeen.set(d.webContentsId, list);
    });
  }
  return ses;
}

function statePayload() {
  if (!view || !view.webContents) return null;
  const wc = view.webContents;
  const url = typeof wc.getURL === 'function' ? wc.getURL() : '';
  const nav = wc.navigationHistory || wc;
  return {
    url,
    platform: platformOf(url),
    canBack: nav.canGoBack ? !!nav.canGoBack() : false,
    canForward: nav.canGoForward ? !!nav.canGoForward() : false,
    loading: typeof wc.isLoading === 'function' ? wc.isLoading() : false,
    keyword: lastKeyword,
    busy,
    status,
    embedded: true,
    newWindow: false,
    loggedIn: !!(loginResult && loginResult.loggedIn),
    loginChecking: !!(loginResult && loginResult.checking),
    loginReason: loginResult && loginResult.reason || '',
  };
}

function sendTo(wc, channel, payload) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
  if (typeof wc.send === 'function') wc.send(channel, payload);
}

function sendState() {
  if (!view) return;
  const payload = statePayload();
  if (!payload) return;
  const main = ctx.mainWindow && ctx.mainWindow();
  if (main && !main.isDestroyed()) sendTo(main.webContents, 'browse:state', payload);
  if (win && !win.isDestroyed()) sendTo(win.webContents, 'browse:state', payload);
}

function debugInfo() {
  const wc = view && view.webContents;
  return {
    url: wc && typeof wc.getURL === 'function' ? wc.getURL() : '',
    partition: 'persist:find-viral',
    newWindow: false,
    windowsCreated,
    embedded: !!view,
    bounds: lastEmbedBounds,
    loggedIn: !!(loginResult && loginResult.loggedIn),
    loginChecking: !!(loginResult && loginResult.checking),
    loginReason: loginResult && loginResult.reason || '',
  };
}

function mainHost() {
  const host = ctx.mainWindow && ctx.mainWindow();
  return host && !host.isDestroyed() ? host : null;
}

function setEmbedVisible(visible, bounds) {
  if (!view) return;
  if (bounds) {
    lastEmbedBounds = {
      x: Math.round(bounds.x || 0),
      y: Math.round(bounds.y || 0),
      width: Math.round(Math.max(0, bounds.width || 0)),
      height: Math.round(Math.max(0, bounds.height || 0)),
    };
  }
  if (!visible || !lastEmbedBounds || lastEmbedBounds.width < 8 || lastEmbedBounds.height < 8) {
    if (typeof view.setVisible === 'function') view.setVisible(false);
    if (typeof view.setBounds === 'function') view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    return;
  }
  if (typeof view.setBounds === 'function') view.setBounds(lastEmbedBounds);
  if (typeof view.setVisible === 'function') view.setVisible(true);
}

function wireSiteView(v) {
  const wc = v.webContents;
  if (wc.__findViralWired) return;
  wc.__findViralWired = true;
  if (typeof wc.setWindowOpenHandler === 'function') {
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) wc.loadURL(url);
      return { action: 'deny' };
    });
  }
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
    wc.on(ev, () => {
      if (ev === 'did-navigate' && status.kind !== 'working') status = { kind: 'idle', text: '' };
      if (ev === 'did-start-loading') {
        if (holdVisibleAfterLogin) {
          loginResult = { ...(loginResult || {}), loggedIn: true, checking: true, platform: platformOf(wc.getURL && wc.getURL() || '') };
        } else {
          loginResult = { loggedIn: false, checking: true, reason: 'pending', platform: platformOf(wc.getURL && wc.getURL() || '') };
          applyLoginVisibility();
        }
      }
      if (ev === 'did-stop-loading' || ev === 'did-navigate') scheduleLoginCheck();
      sendState();
    });
  }
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) {
      loginResult = { loggedIn: false, checking: false, reason: 'load-failed', platform: platformOf(url || '') };
      applyLoginVisibility();
      setStatus('error', `页面没打开（${desc}）。检查一下网络，点刷新再试`);
    }
  });
}

function isClearLoginWall(reason) {
  return /^(login-host|login-path|login-wall|header-login|login-modal|sidebar-login|header-login-entry)$/.test(reason || '');
}

function applyLoginVisibility() {
  if (holdVisibleAfterLogin) setEmbedVisible(true, lastEmbedBounds);
  else if (loginResult && loginResult.loggedIn && !loginResult.checking) setEmbedVisible(true, lastEmbedBounds);
  else setEmbedVisible(false);
}

async function refreshLoginState() {
  if (!view || !view.webContents) {
    loginResult = { loggedIn: false, checking: false, reason: 'no-view', platform: '' };
    return loginResult;
  }
  const wc = view.webContents;
  const url = typeof wc.getURL === 'function' ? wc.getURL() : '';
  const platform = platformOf(url);
  const src = INSPECT[platform];
  let page = { url };
  if (src && typeof wc.executeJavaScript === 'function') {
    try {
      const collected = await Promise.race([
        wc.executeJavaScript(src, true),
        sleep(3000).then(() => null),
      ]);
      if (collected && typeof collected === 'object') page = { url, ...collected };
    } catch (e) {
      page = { url };
    }
  }
  loginResult = detectLogin(platform, page);
  if (holdVisibleAfterLogin) {
    if (loginResult.loggedIn) holdVisibleAfterLogin = false;
    else if (isClearLoginWall(loginResult.reason)) holdVisibleAfterLogin = false;
    else loginResult = { loggedIn: true, checking: false, reason: 'login-window', platform };
  }
  applyLoginVisibility();
  sendState();
  console.log('[browse] login-state', JSON.stringify({
    platform: loginResult.platform, loggedIn: loginResult.loggedIn, reason: loginResult.reason, url, newWindow: false, windowsCreated,
  }));
  return loginResult;
}

function scheduleLoginCheck() {
  if (holdVisibleAfterLogin) {
    loginResult = { ...(loginResult || {}), loggedIn: true, checking: true, reason: (loginResult && loginResult.reason) || 'login-window', platform: loginResult && loginResult.platform || '' };
  } else {
    loginResult = { loggedIn: false, checking: true, reason: 'pending', platform: loginResult && loginResult.platform || '' };
  }
  applyLoginVisibility();
  sendState();
  const gen = ++loginCheckGen;
  clearTimeout(loginCheckTimer);
  loginCheckTimer = setTimeout(() => {
    if (gen !== loginCheckGen) return;
    refreshLoginState().catch(() => {
      loginResult = { loggedIn: false, checking: false, reason: 'check-failed', platform: '' };
      applyLoginVisibility();
      sendState();
    });
  }, 700);
  if (loginCheckTimer && typeof loginCheckTimer.unref === 'function') loginCheckTimer.unref();
}

function ensureEmbeddedView() {
  const host = mainHost();
  if (!host) return null;
  if (!view) {
    view = new WebContentsView({
      webPreferences: { session: siteSession(), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    wireSiteView(view);
  }
  hostWindow = host;
  const root = host.contentView;
  if (root && typeof root.addChildView === 'function') {
    const kids = typeof root.getChildViews === 'function' ? root.getChildViews() : [];
    if (!kids.includes(view)) root.addChildView(view);
  }
  return view;
}

function setStatus(kind, text, extra) {
  status = { kind, text, ...(extra || {}) };
  sendState();
}

function layout() {
  // 旧独立窗布局，T2 不再走这条路径；登录小窗（T4）如需再用再接。
  if (!win || !view || typeof win.getContentSize !== 'function') return;
  const [w, h] = win.getContentSize();
  view.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: Math.max(0, h - TOOLBAR_H) });
}

function resolveOpenUrl(opts) {
  const o = opts || {};
  let url = '';
  if (o.url) url = urlFromShareText(o.url) || (/^https?:/.test(o.url) ? o.url : '');
  if (!url && o.keyword) {
    const p = PLATFORMS[o.platform] || PLATFORMS.douyin;
    lastKeyword = String(o.keyword).trim().slice(0, 60);
    url = p.search(lastKeyword);
  }
  if (!url) url = (PLATFORMS[o.platform] || PLATFORMS.douyin).home;
  if (!o.keyword && !o.url) lastKeyword = '';
  return url;
}

function open(opts) {
  // T2：把平台页嵌进主窗口，复用 persist:find-viral；搜索 / 切 Tab 不再新建 BrowserWindow。
  const host = mainHost();
  if (!host) return { ok: false, error: '主窗口还没打开', newWindow: false, url: '' };
  if (!ensureEmbeddedView()) return { ok: false, error: '没能挂上平台视图', newWindow: false, url: '' };
  const url = resolveOpenUrl(opts);
  status = { kind: 'idle', text: '' };
  loginResult = { loggedIn: false, checking: true, reason: 'pending', platform: platformOf(url) };
  setEmbedVisible(false);
  view.webContents.loadURL(url);
  scheduleLoginCheck();
  sendState();
  console.log('[browse] embed-load', JSON.stringify({ url, newWindow: false, partition: 'persist:find-viral', windowsCreated, loginChecking: true }));
  return { ok: true, url, newWindow: false, partition: 'persist:find-viral', loginChecking: true };
}

function layoutEmbed(bounds) {
  ensureEmbeddedView();
  if (bounds) setEmbedVisible(false, bounds); // 先记下位置；未登录时保持隐藏，避免露出登录页
  applyLoginVisibility();
  return debugInfo();
}

function hideEmbed() {
  setEmbedVisible(false);
  return debugInfo();
}

function senderAllowed(e) {
  const main = mainHost();
  const fromMain = main && e && e.sender === main.webContents;
  const fromOldWin = win && e && e.sender === win.webContents;
  return !!(fromMain || fromOldWin);
}

function runToolbar(action, arg) {
  const wc = view && view.webContents;
  if (!wc) return null;
  const nav = wc.navigationHistory || wc;
  if (action === 'back' && nav.canGoBack()) nav.goBack();
  else if (action === 'forward' && nav.canGoForward()) nav.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'home') wc.loadURL((PLATFORMS[arg] || PLATFORMS.douyin).home);
  else if (action === 'search' && arg && arg.keyword) {
    lastKeyword = String(arg.keyword).trim().slice(0, 60);
    wc.loadURL((PLATFORMS[arg.platform] || PLATFORMS[platformOf(wc.getURL())] || PLATFORMS.douyin).search(lastKeyword));
  } else if (action === 'capture') capture();
  else if (action === 'show-project') showProject();
  else if (action === 'state') sendState();
  return statePayload() || true;
}

// ---------- 读当前页面 ----------

// 在页面里执行：只读 DOM 和页面自己已经加载好的数据，不发任何请求
const EXTRACT = `(() => {
  const txt = (el) => el ? String(el.innerText || el.textContent || '').replace(/\\s+\\n/g, '\\n').trim() : '';
  const meta = (n) => { const m = document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]'); return m ? m.content || '' : ''; };
  const pick = (...sels) => { for (const s of sels) { const el = document.querySelector(s); const t = txt(el); if (t) return t; } return ''; };
  const deepAll = (sel, root = document, out = [], depth = 0) => {
    if (depth > 8) return out;
    root.querySelectorAll(sel).forEach((el) => out.push(el));
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) deepAll(sel, el.shadowRoot, out, depth + 1); });
    return out;
  };
  // 页面上「正在看的那条」视频：优先在播放的，其次可见面积最大的
  const vids = [...document.querySelectorAll('video')].map((v) => {
    const r = v.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return { v, area: w * h, playing: !v.paused && !v.ended };
  }).filter((x) => x.area > 2000).sort((a, b) => (b.playing - a.playing) || (b.area - a.area));
  const v = vids[0] && vids[0].v;
  const sources = v ? [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)].filter((s) => /^https?:/.test(s || '')) : [];
  const host = location.hostname;
  const out = { url: location.href, title: '', desc: '', author: '', stats: {}, comments: [], sources, hasVideo: !!v, extra: {} };
  const comments = (items, userSel, textSel, likeSel) => items.slice(0, 20).map((el) => ({
    user: txt(el.querySelector(userSel)), text: txt(el.querySelector(textSel)) || '', likes: likeSel ? txt(el.querySelector(likeSel)) : '',
  })).filter((c) => c.text);
  if (/douyin\\.com$/.test(host)) {
    const modal = new URLSearchParams(location.search).get('modal_id');
    const idm = location.pathname.match(/\\/video\\/(\\d+)/);
    const id = modal || (idm && idm[1]) || '';
    if (id) out.url = 'https://www.douyin.com/video/' + id;
    out.desc = pick('[data-e2e="detail-video-info"] h1', '[data-e2e="video-desc"]', '[data-e2e="detail-video-info"]') || meta('description');
    out.author = pick('[data-e2e="detail-video-info"] [data-e2e="video-author-title"]', '[data-e2e="user-info"] a span', '[data-e2e="feed-video-nickname"]', '[data-e2e="video-author-title"]');
    out.stats = { likes: pick('[data-e2e="video-player-digg"]'), comments: pick('[data-e2e="feed-comment-icon"]', '[data-e2e="video-player-comment"]'), collects: pick('[data-e2e="video-player-collect"]'), shares: pick('[data-e2e="video-player-share"]') };
    out.comments = comments([...document.querySelectorAll('[data-e2e="comment-item"]')], '[data-e2e="comment-item"] a span, .comment-item-info-wrap a', '.comment-item-content, [data-e2e="comment-item"] p, span[class*="content"]', '');
  } else if (/(xiaohongshu|rednote)\\.com$/.test(host)) {
    out.title = pick('#detail-title', '.note-content .title');
    out.desc = pick('#detail-desc', '.note-content .desc') || meta('description');
    out.author = pick('.author-wrapper .username', '.author-container .name', '.author .name');
    out.stats = { likes: pick('.interact-container .like-wrapper .count', '.engage-bar .like-wrapper .count'), collects: pick('.interact-container .collect-wrapper .count'), comments: pick('.interact-container .chat-wrapper .count') };
    out.comments = comments([...document.querySelectorAll('.comment-item')], '.author .name, .name', '.content .note-text, .content', '.like .count');
    try {
      const st = window.__INITIAL_STATE__;
      const map = st && st.note && st.note.noteDetailMap;
      const nid = (location.pathname.match(/(?:explore|item)\\/([0-9a-f]+)/) || [])[1] || (st && st.note && st.note.currentNoteId);
      const note = map && nid && map[nid] && map[nid].note;
      const raw = note && (note.__v_raw || note);
      const h264 = raw && raw.video && raw.video.media && raw.video.media.stream && raw.video.media.stream.h264;
      if (h264 && h264.length) out.sources.push(...h264.map((s) => s.masterUrl).filter(Boolean));
      if (raw && !out.title) out.title = raw.title || '';
      if (raw && !out.desc) out.desc = raw.desc || '';
    } catch (e) { /* 页面结构变了就靠 DOM 和网络里看到的地址 */ }
  } else if (/bilibili\\.com$/.test(host)) {
    out.title = pick('h1.video-title', '.video-info-title h1') || meta('og:title');
    out.desc = pick('.basic-desc-info', '.desc-info-text') || meta('description');
    out.author = pick('.up-name', '.up-detail-top a');
    out.stats = { views: pick('.view-text', '.view.item'), likes: pick('.video-like-info'), coins: pick('.video-coin-info'), collects: pick('.video-fav-info'), shares: pick('.video-share-info-text') };
    try {
      const st = window.__INITIAL_STATE__ || {};
      out.extra.cid = String((st.videoData && st.videoData.cid) || st.cid || '');
      const pi = window.__playinfo__ && window.__playinfo__.data && window.__playinfo__.data.dash;
      if (pi) out.extra.dash = { video: (pi.video || []).map((x) => ({ url: x.baseUrl || x.base_url, id: x.id, codecid: x.codecid, height: x.height })), audio: (pi.audio || []).map((x) => ({ url: x.baseUrl || x.base_url, id: x.id })) };
    } catch (e) { /* noop */ }
    out.comments = deepAll('bili-comment-renderer').slice(0, 20).map((el) => {
      const r = el.shadowRoot || el;
      const rich = r.querySelector('bili-rich-text');
      const text = rich && rich.shadowRoot ? txt(rich.shadowRoot.querySelector('#contents')) : txt(rich);
      const user = r.querySelector('bili-comment-user-info');
      return { user: user && user.shadowRoot ? txt(user.shadowRoot.querySelector('#user-name')) : '', text, likes: '' };
    }).filter((c) => c.text);
  } else {
    out.title = meta('og:title') || document.title;
    out.desc = meta('og:description') || meta('description');
  }
  if (!out.title) out.title = (document.title || '').replace(/\\s*[-_|].{0,12}$/, '').trim();
  return out;
})()`;

// 返回按优先级排好的候选：{ videos: [url...], audios: [url...] }。下载时依次试，前一个失败就用下一个。
function chooseMedia(platform, info, wcId) {
  const seen = (mediaSeen.get(wcId) || []).slice().reverse();   // 新的在前
  const pathOf = (u) => String(u || '').split('?')[0];
  const seenPaths = new Set(seen.map((x) => pathOf(x.url)));
  const uniq = (list) => [...new Set(list.filter(Boolean))];
  if (platform === 'bilibili') {
    const cid = info.extra && info.extra.cid;
    const forThis = (u) => !cid || u.includes(`/${cid}-`) || u.includes(`/${cid}/`);
    const played = (x) => seenPaths.has(pathOf(x.url));
    const dash = (info.extra && info.extra.dash) || {};
    // 视频：先用页面正在播的那一路；否则 1080p 以内、H.264 优先、画质高的在前
    const vids = (dash.video || []).filter((x) => x.url && forThis(x.url) && (!x.height || x.height <= 1080))
      .sort((a, b) => played(b) - played(a) || (b.codecid === 7) - (a.codecid === 7) || (b.height || 0) - (a.height || 0));
    // 音频：先用页面正在播的那一路；否则码率从低到高（高码率音轨有的网络/账号拿不到）
    const auds = (dash.audio || []).filter((x) => x.url && forThis(x.url)).sort((a, b) => played(b) - played(a) || a.id - b.id);
    const num = (u) => Number((u.match(/-1-(\d+)\.m4s/) || [])[1] || 0);
    const isAudio = (u) => num(u) >= 30200 && num(u) < 30300;
    const m4s = seen.map((x) => x.url).filter((u) => /\.m4s(\?|$)/.test(u) && forThis(u));
    const videos = uniq([...vids.map((x) => x.url), ...m4s.filter((u) => !isAudio(u))]);
    const audios = uniq([...auds.map((x) => x.url), ...m4s.filter(isAudio)]);
    return videos.length ? { videos, audios } : null;
  }
  const direct = (info.sources || []).filter((u) => /^https?:/.test(u));
  const heard = seen.filter((x) => /^video\//.test(x.type) || /\.mp4(\?|$)/i.test(x.url)).map((x) => x.url);
  const videos = uniq([...direct, ...heard]);
  return videos.length ? { videos, audios: [] } : null;
}

// 后台直接下载被拒时，改由页面自己去取（和它播放时发出的请求完全一样），再分块交给这边写文件。
// 只用 executeJavaScript 由这边逐块拉取，页面不能主动往应用里推任何东西。
async function downloadViaPage(wc, url, file, label) {
  const key = '__vrDl' + Math.random().toString(36).slice(2);
  const start = await wc.executeJavaScript(`(async () => {
    const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    if (!res.ok) return { ok: false, status: res.status };
    const buf = new Uint8Array(await res.arrayBuffer());
    window[${JSON.stringify(key)}] = buf;
    return { ok: true, size: buf.length };
  })()`, true);
  if (!start || !start.ok) throw new Error(`${label}下载失败（HTTP ${start && start.status}）`);
  if (start.size > MAX_BYTES) throw new Error('视频超过 1GB，换一条短一点的');
  const out = fs.openSync(file, 'w');
  try {
    const CHUNK = 4 * 1024 * 1024;
    for (let off = 0; off < start.size; off += CHUNK) {
      const b64 = await wc.executeJavaScript(`(() => {
        const b = window[${JSON.stringify(key)}].subarray(${off}, ${off + CHUNK});
        let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        return btoa(s);
      })()`, true);
      fs.writeSync(out, Buffer.from(b64, 'base64'));
      setStatus('working', `正在下载${label} ${Math.min(100, Math.floor(((off + CHUNK) / start.size) * 100))}%`);
    }
  } finally {
    fs.closeSync(out);
    wc.executeJavaScript(`delete window[${JSON.stringify(key)}]`, true).catch(() => {});
  }
  if (fs.statSync(file).size !== start.size) throw new Error(`${label}没下载完整，再点一次试试`);
}

async function downloadFirst(wc, urls, referer, file, label) {
  let last = null;
  for (const url of urls.slice(0, 4)) {
    try { await download(wc.session, url, referer, file, label); return url; } catch (err) { last = err; }
    try { await downloadViaPage(wc, url, file, label); return url; } catch (err) { last = err; }
  }
  throw last || new Error(`${label}下载失败`);
}

async function download(ses, url, referer, file, label) {
  const res = await ses.fetch(url, { headers: { [REFERER_MARK]: referer } });
  if (!res.ok) throw new Error(`${label}下载失败（HTTP ${res.status}）`);
  const total = Number(res.headers.get('content-length') || 0);
  if (total > MAX_BYTES) throw new Error('视频超过 1GB，换一条短一点的');
  let got = 0; let lastPct = -1;
  const src = Readable.fromWeb(res.body);
  src.on('data', (chunk) => {
    got += chunk.length;
    if (got > MAX_BYTES) src.destroy(new Error('视频超过 1GB，换一条短一点的'));
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== lastPct && (pct % 5 === 0 || pct < 0)) {
      lastPct = pct;
      setStatus('working', pct >= 0 ? `正在下载${label} ${pct}%` : `正在下载${label} ${(got / 1048576).toFixed(1)} MB`);
    }
  });
  await pipeline(src, fs.createWriteStream(file));
  if (fs.statSync(file).size <= 0) throw new Error('下载到的是空文件');
}

async function api(method, p, body) {
  const base = `http://127.0.0.1:${ctx.port()}/api/`;
  const st = await (await fetch(base + 'status')).json();
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Client-Build': st.build || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `工作台返回 ${res.status}`);
  return data;
}

// 只在用户正在看的这一页里点开 / 滚到评论区，不额外请求任何接口
const REVEAL_COMMENTS = `(() => {
  const host = location.hostname;
  const click = (sel) => { const el = document.querySelector(sel); if (el) { el.click(); return true; } return false; };
  const into = (el) => { if (el) { el.scrollIntoView({ block: 'center' }); return true; } return false; };
  if (/douyin\.com$/.test(host)) {
    if (!document.querySelector('[data-e2e="comment-list"], [data-e2e="comment-item"]')) click('[data-e2e="feed-comment-icon"]') || click('[data-e2e="video-player-comment"]');
    into(document.querySelector('[data-e2e="comment-list"]'));
  } else if (/xiaohongshu\.com$/.test(host)) {
    const box = document.querySelector('.note-scroller, .note-container');
    if (box) box.scrollTop = Math.min(box.scrollHeight, (box.scrollTop || 0) + 600);
    into(document.querySelector('.comments-container, .comment-item'));
  } else if (/bilibili\.com$/.test(host)) {
    into(document.querySelector('bili-comments, #commentapp, .comment-container'));
  }
  return true;
})()`;
const sleep = (ms) => new Promise((r) => {
  const t = setTimeout(r, ms);
  if (t && typeof t.unref === 'function') t.unref();
});

async function capture() {
  if (!view || busy) return;
  busy = true;
  const files = [];
  try {
    setStatus('working', '正在读取这条视频…');
    const wc = view.webContents;
    const pageUrl = wc.getURL();
    const platform = platformOf(pageUrl);
    let extractTimer;
    const info = await Promise.race([
      wc.executeJavaScript(EXTRACT, true),
      new Promise((_, reject) => {
        extractTimer = setTimeout(() => reject(new Error('页面没有响应，等它加载完再点一次「同款复刻」')), 15000);
        if (extractTimer && typeof extractTimer.unref === 'function') extractTimer.unref();
      }),
    ]);
    clearTimeout(extractTimer);
    if (!info.hasVideo && !(info.sources || []).length) {
      throw new Error('这一页没找到视频。先点开一条视频，看到它在播放了，再点「同款复刻」');
    }
    if (!(info.comments || []).length) {
      // 评论区多半要滚到或点开才加载：自动帮他打开一次，再读一遍（读不到也不影响导入）
      try {
        setStatus('working', '正在读评论…');
        await Promise.race([wc.executeJavaScript(REVEAL_COMMENTS, true), sleep(3000)]);
        await sleep(2500);
        const again = await Promise.race([wc.executeJavaScript(EXTRACT, true), sleep(5000).then(() => null)]);
        if (again && (again.comments || []).length) info.comments = again.comments;
      } catch (_) { /* 评论只是参考信息 */ }
    }
    const media = chooseMedia(platform, info, wc.id);
    if (!media) {
      throw new Error('这条视频的播放地址拿不到。先让视频播放几秒再点；还不行，就用手机下载后拖进工作台');
    }
    const { dir } = await api('GET', 'import-video/dir');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    const vfile = path.join(dir, `v-${stamp}.${platform === 'bilibili' ? 'm4s' : 'mp4'}`);
    files.push(vfile);
    await downloadFirst(wc, media.videos, pageUrl, vfile, '视频');
    let afile = '';
    if (media.audios.length) {
      afile = path.join(dir, `a-${stamp}.m4s`);
      files.push(afile);
      await downloadFirst(wc, media.audios, pageUrl, afile, '音频');
    }
    setStatus('working', '正在建项目…');
    const origin = {
      platform, url: info.url || pageUrl, title: info.title, desc: info.desc, author: info.author,
      stats: info.stats, comments: info.comments, keyword: lastKeyword,
    };
    const project = await api('POST', 'import-video', { video: vfile, audio: afile || null, origin });
    files.length = 0;   // 工作台已接手（并清理）
    setStatus('done', `已建好项目「${project.name}」`, { projectId: project.id });
    const main = ctx.mainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send('browse:imported', project);
    }
  } catch (err) {
    setStatus('error', String((err && err.message) || err));
  } finally {
    for (const f of files) { try { fs.unlinkSync(f); } catch (e) { /* noop */ } }
    busy = false;
    sendState();
  }
}

function showProject() {
  const main = ctx.mainWindow();
  if (main && !main.isDestroyed()) {
    if (status.projectId) main.webContents.send('browse:imported', { id: status.projectId, focus: true });
    main.show(); main.focus();
  }
}

function loginStartUrl(platform) {
  if (platform === 'xiaohongshu') return 'https://www.xiaohongshu.com/login?redirectPath=%2Fexplore';
  if (platform === 'bilibili') return 'https://passport.bilibili.com/login';
  return (PLATFORMS[platform] || PLATFORMS.douyin).home;
}

function resolveLoginPlatform(opts) {
  const o = opts || {};
  if (o.platform && PLATFORMS[o.platform]) return o.platform;
  if (loginResult && PLATFORMS[loginResult.platform]) return loginResult.platform;
  if (view && view.webContents && typeof view.webContents.getURL === 'function') {
    const p = platformOf(view.webContents.getURL());
    if (PLATFORMS[p]) return p;
  }
  return 'douyin';
}

function closeLoginWindow() {
  loginWatchGen += 1;
  clearTimeout(loginWatchTimer);
  loginWatchTimer = null;
  const w = loginWin;
  loginWin = null;
  if (w && (typeof w.isDestroyed !== 'function' || !w.isDestroyed()) && typeof w.close === 'function') {
    try { w.close(); } catch (e) { /* 窗口已关 */ }
  }
}

function notifyLoggedIn(payload) {
  const main = mainHost();
  if (main && !main.isDestroyed()) sendTo(main.webContents, 'browse:logged-in', payload);
}

async function onLoginSuccess(platform) {
  // 小窗已经判定成功：立刻发短确认并关窗。不要等内嵌区二次加载后再提示，
  // 否则个人入口还没出现时窗已关、提示也出不来。
  const name = (PLATFORMS[platform] || PLATFORMS.douyin).name;
  const text = `已登录${name}，下面是你的内容`;
  setStatus('done', text);
  notifyLoggedIn({ platform, text });
  closeLoginWindow();
  const next = pendingAfterLogin || (PLATFORMS[platform] || PLATFORMS.douyin).home;
  const hold = !!pendingAfterLogin;
  pendingAfterLogin = '';
  if (hold) {
    holdVisibleAfterLogin = true;
    loginResult = { loggedIn: true, checking: false, reason: 'login-window', platform };
    applyLoginVisibility();
    sendState();
  }
  if (view && view.webContents && typeof view.webContents.loadURL === 'function') {
    view.webContents.loadURL(next);
  }
  if (!hold) {
    loginResult = { loggedIn: false, checking: true, reason: 'pending', platform };
    applyLoginVisibility();
    sendState();
  }
  scheduleLoginCheck();
  return { loggedIn: true, checking: true, platform, reason: 'login-window' };
}

async function checkLoginWindow(platform) {
  if (!loginWin || (typeof loginWin.isDestroyed === 'function' && loginWin.isDestroyed())) return null;
  const wc = loginWin.webContents;
  const url = wc && typeof wc.getURL === 'function' ? wc.getURL() : '';
  const detected = platformOf(url);
  const p = PLATFORMS[detected] ? detected : (platform || 'douyin');
  let page = { url };
  const src = INSPECT[p];
  if (src && wc && typeof wc.executeJavaScript === 'function') {
    try {
      const collected = await Promise.race([
        wc.executeJavaScript(src, true),
        sleep(3000).then(() => null),
      ]);
      if (collected && typeof collected === 'object') page = { url, ...collected };
    } catch (e) { /* 判定不准就继续当未登录，保持窗口 */ }
  }
  const result = detectLogin(p, page);
  if (result.loggedIn) return onLoginSuccess(p);
  return result;
}

function scheduleLoginWinCheck(platform) {
  const gen = ++loginWatchGen;
  const tick = () => {
    if (gen !== loginWatchGen) return;
    if (!loginWin || (typeof loginWin.isDestroyed === 'function' && loginWin.isDestroyed())) return;
    checkLoginWindow(platform).catch(() => {}).finally(() => {
      if (gen !== loginWatchGen) return;
      if (loginWin && (typeof loginWin.isDestroyed !== 'function' || !loginWin.isDestroyed())) {
        loginWatchTimer = setTimeout(tick, 700);
        if (loginWatchTimer && typeof loginWatchTimer.unref === 'function') loginWatchTimer.unref();
      }
    });
  };
  clearTimeout(loginWatchTimer);
  loginWatchTimer = setTimeout(tick, 700);
  if (loginWatchTimer && typeof loginWatchTimer.unref === 'function') loginWatchTimer.unref();
}

function rememberAfterLoginUrl(opts) {
  const raw = opts && opts.afterUrl;
  if (!raw) return;
  const url = urlFromShareText(String(raw)) || (/^https?:/.test(String(raw)) ? String(raw) : '');
  if (url) pendingAfterLogin = url;
}

function startLogin(opts) {
  // T4：点「去登录」才新开小窗，只承担登录，不带搜索和同款。分区与内嵌区相同，登完 cookie 才能带到首页。
  // T6：未登录打开分享链接时带 afterUrl，登完在内嵌区打开该链接，而不是只回平台首页。
  rememberAfterLoginUrl(opts);
  const id = resolveLoginPlatform(opts);
  const url = loginStartUrl(id);
  if (loginWin && (typeof loginWin.isDestroyed !== 'function' || !loginWin.isDestroyed())) {
    const wc = loginWin.webContents;
    if (wc && typeof wc.loadURL === 'function') wc.loadURL(url);
    if (typeof loginWin.focus === 'function') loginWin.focus();
    if (typeof loginWin.setTitle === 'function') loginWin.setTitle('登录' + PLATFORMS[id].name);
    scheduleLoginWinCheck(id);
    return { ok: true, reused: true, platform: id, url, newWindow: false, partition: 'persist:find-viral', windowsCreated };
  }
  const host = mainHost();
  loginWin = new BrowserWindow({
    width: 480,
    height: 720,
    title: '登录' + PLATFORMS[id].name,
    parent: host || undefined,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      session: siteSession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowsCreated += 1;
  const opened = loginWin;
  if (typeof opened.on === 'function') {
    opened.on('closed', () => {
      if (loginWin === opened) {
        loginWin = null;
        loginWatchGen += 1;
        clearTimeout(loginWatchTimer);
        loginWatchTimer = null;
      }
    });
  }
  const wc = opened.webContents;
  if (wc && typeof wc.setWindowOpenHandler === 'function') {
    wc.setWindowOpenHandler(({ url: next }) => {
      if (/^https?:/.test(next)) wc.loadURL(next);
      return { action: 'deny' };
    });
  }
  if (wc) {
    for (const ev of ['did-stop-loading', 'did-navigate', 'did-navigate-in-page']) {
      if (typeof wc.on === 'function') wc.on(ev, () => scheduleLoginWinCheck(id));
    }
    if (typeof wc.loadURL === 'function') wc.loadURL(url);
  }
  scheduleLoginWinCheck(id);
  console.log('[browse] start-login', JSON.stringify({ url, platform: id, newWindow: true, partition: 'persist:find-viral', windowsCreated }));
  return { ok: true, reused: false, platform: id, url, newWindow: true, partition: 'persist:find-viral', windowsCreated };
}

function register() {
  ipcMain.handle('browse:open', (_e, opts) => open(opts));
  ipcMain.handle('browse:layout', (_e, bounds) => layoutEmbed(bounds));
  ipcMain.handle('browse:hide', () => hideEmbed());
  ipcMain.handle('browse:debug', () => debugInfo());
  ipcMain.handle('browse:toolbar', (e, action, arg) => {
    if (!senderAllowed(e)) return null;
    return runToolbar(action, arg);
  });
  ipcMain.handle('browse:startLogin', (e, opts) => {
    if (!senderAllowed(e)) return null;
    return startLogin(opts);
  });
}

module.exports = {
  mediaSeen, init, register, open, capture, platformOf, urlFromShareText, chooseMedia,
  PLATFORMS, EXTRACT, debugInfo, layoutEmbed, hideEmbed, runToolbar, resolveOpenUrl,
  refreshLoginState, detectLogin, startLogin, checkLoginWindow, closeLoginWindow, loginStartUrl,
};
